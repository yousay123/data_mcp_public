import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from urllib.error import HTTPError, URLError

import sqlglot
from sqlglot import exp

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db.query_executor import (
    execute_clickhouse_json,
    parse_clickhouse_jdbc_url,
    sanitize_clickhouse_error,
)
from ksher_agent_data_mcp.metadata.catalog import (
    MetadataAccessDenied,
    MetadataCatalog,
    MetadataLookupError,
    TChouseCMetadataCatalog,
)
from ksher_agent_data_mcp.models.contracts import (
    CredentialRef,
    SqlValidationResult,
    Status,
    TableMeta,
    UserContext,
    ValidationIssue,
)

SUPPORTED_DATASOURCE = "tchouse-c"
SQL_DIALECT = "clickhouse"

CLICKHOUSE_PERMISSION_ERROR_NAMES = frozenset(
    {
        "ACCESS_DENIED",
        "AUTHENTICATION_FAILED",
        "IP_ADDRESS_NOT_ALLOWED",
        "UNKNOWN_USER",
    }
)

CLICKHOUSE_SQL_ERROR_NAMES = frozenset(
    {
        "AMBIGUOUS_COLUMN_NAME",
        "BAD_ARGUMENTS",
        "CANNOT_PARSE_DATE",
        "CANNOT_PARSE_DATETIME",
        "CANNOT_PARSE_TEXT",
        "DUPLICATE_COLUMN",
        "ILLEGAL_AGGREGATION",
        "ILLEGAL_COLUMN",
        "ILLEGAL_TYPE_OF_ARGUMENT",
        "INVALID_JOIN_ON_EXPRESSION",
        "MISSING_COLUMNS",
        "MULTIPLE_EXPRESSIONS_FOR_ALIAS",
        "NOT_AN_AGGREGATE",
        "NO_SUCH_COLUMN_IN_TABLE",
        "NUMBER_OF_ARGUMENTS_DOESNT_MATCH",
        "SYNTAX_ERROR",
        "TYPE_MISMATCH",
        "UNKNOWN_AGGREGATE_FUNCTION",
        "UNKNOWN_DATABASE",
        "UNKNOWN_FORMAT",
        "UNKNOWN_FUNCTION",
        "UNKNOWN_IDENTIFIER",
        "UNKNOWN_STORAGE",
        "UNKNOWN_TABLE",
        "UNKNOWN_TYPE",
        "UNSUPPORTED_JOIN_KEYS",
        "UNSUPPORTED_METHOD",
    }
)

CLICKHOUSE_ERROR_NAME_PATTERN = re.compile(r"\(([A-Z][A-Z0-9_]+)\)(?=\s*(?:\(version\b|$))")

BLOCKED_READONLY_EXPRESSIONS = (
    exp.Delete,
    exp.Drop,
    exp.Insert,
    exp.Update,
    exp.Create,
    exp.Alter,
)

SYSTEM_USERS_ALLOWED_COLUMNS = frozenset(
    {"name", "default_roles_all", "default_roles_list", "default_roles_except"}
)

RESTRICTED_ACCESS_SYSTEM_TABLES = frozenset(
    {
        "system.current_roles",
        "system.enabled_roles",
        "system.grants",
        "system.quota_limits",
        "system.quotas",
        "system.quota_usage",
        "system.role_grants",
        "system.roles",
        "system.row_policies",
        "system.row_policy_usage",
        "system.settings_profile_elements",
        "system.settings_profiles",
        "system.users_directories",
    }
)

ALLOWED_SHOW_PREFIX = re.compile(
    r"^(?:DATABASES|TABLES|COLUMNS|FUNCTIONS|CREATE\s+(?:TABLE|VIEW))\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SqlGuard:
    settings: Settings
    catalog: MetadataCatalog

    def validate(
        self,
        user: UserContext,
        sql: str,
        datasource: str = "tchouse-c",
        credential: CredentialRef | None = None,
    ) -> SqlValidationResult:
        issues: list[ValidationIssue] = []
        datasource = datasource.lower()
        if datasource != SUPPORTED_DATASOURCE:
            issues.append(
                ValidationIssue(
                    code="unsupported_datasource",
                    severity="error",
                    message=f"当前 MCP 仅支持 {SUPPORTED_DATASOURCE} SELECT / SHOW 查询：{datasource}",
                )
            )
            return self._finish(datasource, None, [], [], issues)

        if len(sql.encode("utf-8")) > self.settings.max_sql_bytes:
            issues.append(
                ValidationIssue(
                    code="sql_too_large",
                    severity="error",
                    message="SQL 文本超过服务允许的最大长度",
                )
            )
            return self._finish(datasource, None, [], [], issues)

        try:
            expressions = sqlglot.parse(sql, read=SQL_DIALECT)
        except Exception as exc:
            issues.append(
                ValidationIssue(
                    code="parse_error",
                    severity="error",
                    message=f"SQL 解析失败：{exc}",
                )
            )
            return self._finish(datasource, None, [], [], issues)

        if len(expressions) != 1:
            issues.append(
                ValidationIssue(
                    code="multiple_statements",
                    severity="error",
                    message="一次只允许提交一条 SQL",
                )
            )
            return self._finish(datasource, None, [], [], issues)

        expression = expressions[0]
        if self._is_show_command(expression):
            if not _is_allowed_show_command(expression):
                issues.append(
                    ValidationIssue(
                        code="restricted_access_metadata",
                        severity="error",
                        message=(
                            "通用查询接口仅开放库表结构类 SHOW；"
                            "账号、角色、授权、策略和配额元数据请使用受限权限审计工具"
                        ),
                    )
                )
            return self._finish(datasource, self._normalize_sql(expression), [], [], issues)

        if not isinstance(expression, exp.Select) and not expression.find(exp.Select):
            issues.append(
                ValidationIssue(
                    code="not_select",
                    severity="error",
                    message="只允许执行只读 SELECT 或 SHOW 查询",
                )
            )

        for blocked in BLOCKED_READONLY_EXPRESSIONS:
            if expression.find(blocked):
                issues.append(
                    ValidationIssue(
                        code="dangerous_statement",
                        severity="error",
                        message=f"禁止执行危险 SQL 类型：{blocked.__name__}",
                    )
                )

        if any(issue.severity == "error" for issue in issues):
            return self._finish(datasource, None, [], [], issues)

        columns = sorted({column.name for column in expression.find_all(exp.Column) if column.name})
        tables, table_function_issues = _query_tables(expression)
        issues.extend(table_function_issues)
        restricted_access_tables = sorted(set(tables) & RESTRICTED_ACCESS_SYSTEM_TABLES)
        if restricted_access_tables:
            issues.append(
                ValidationIssue(
                    code="restricted_access_metadata",
                    severity="error",
                    message=(
                        "通用查询接口不开放账号、角色、授权、策略或配额系统表；"
                        "请使用受限权限审计工具"
                    ),
                )
            )
        if "system.users" in tables:
            restricted_columns = sorted(set(columns) - SYSTEM_USERS_ALLOWED_COLUMNS)
            unsafe_projection = _has_unsafe_system_users_projection(expression)
            if unsafe_projection or restricted_columns:
                issues.append(
                    ValidationIssue(
                        code="restricted_system_columns",
                        severity="error",
                        message=(
                            "system.users 仅允许查询 name、default_roles_all、"
                            "default_roles_list、default_roles_except；禁止 SELECT * 或认证/来源限制元数据"
                        ),
                        suggested_action="权限一致性核验请改用固定模板审计工具",
                    )
                )
        if any(issue.severity == "error" for issue in issues):
            return self._finish(datasource, None, tables, columns, issues)

        if self._should_probe_query_access(credential):
            query_access_issues = self._probe_query_access(expression, credential)
            if query_access_issues:
                return self._finish(datasource, None, tables, columns, query_access_issues)
            table_metas = {table: _minimal_table_meta(table) for table in tables}
            failed_tables: set[str] = set()
            table_issues = []
        else:
            table_metas, failed_tables, table_issues = self._describe_tables(tables, credential)
        issues.extend(table_issues)
        missing_tables = [
            table for table in tables if table not in table_metas and table not in failed_tables
        ]
        for table in missing_tables:
            candidates = _candidate_tables(self.catalog, table, credential)
            suggested_action = (
                "请向用户确认要查询的表和业务口径后再执行；候选表：" + "、".join(candidates)
                if candidates
                else "请让智能体先查询元数据字典确认表名；如果候选表不唯一，请向用户追问表和口径"
            )
            issues.append(
                ValidationIssue(
                    code="unknown_table",
                    severity="error",
                    message=f"元数据字典中找不到表：{table}",
                    suggested_action=suggested_action,
                )
            )

        if self.settings.require_partition_filter:
            issues.extend(self._partition_issues(expression, datasource, tables, table_metas))

        normalized_sql, limit_was_injected, limit_was_capped = self._bounded_sql(expression)
        if limit_was_injected:
            issues.append(
                ValidationIssue(
                    code="limit_injected",
                    severity="warning",
                    message=(
                        "SQL 未显式限制返回行数，服务将追加 LIMIT "
                        f"{min(self.settings.default_limit, self.settings.max_rows)}"
                    ),
                )
            )
        elif limit_was_capped:
            issues.append(
                ValidationIssue(
                    code="limit_capped",
                    severity="warning",
                    message=f"SQL 返回行数上限已收敛为 LIMIT {self.settings.max_rows}",
                )
            )

        return self._finish(datasource, normalized_sql, tables, columns, issues)

    def _describe_tables(
        self,
        tables: list[str],
        credential: CredentialRef | None,
    ) -> tuple[dict[str, TableMeta], set[str], list[ValidationIssue]]:
        if not tables:
            return {}, set(), []

        max_workers = min(len(tables), 8)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                table: executor.submit(self.catalog.describe_table, table, credential)
                for table in tables
            }

            table_metas: dict[str, TableMeta] = {}
            failed_tables: set[str] = set()
            issues: list[ValidationIssue] = []
            for table in tables:
                try:
                    table_meta = futures[table].result()
                except MetadataAccessDenied:
                    failed_tables.add(table)
                    account = credential.tchouse_account if credential else "当前账号"
                    issues.append(
                        ValidationIssue(
                            code="permission_denied",
                            severity="error",
                            message=f"数据库账号 {account} 没有访问表 {table} 的权限",
                            suggested_action="请确认当前提问人的 TChouse-C 账号已被授权该表 SELECT 权限",
                        )
                    )
                    continue
                except MetadataLookupError:
                    failed_tables.add(table)
                    issues.append(
                        ValidationIssue(
                            code="metadata_lookup_error",
                            severity="error",
                            message=f"无法完成表目录预检：{table}",
                            suggested_action="请稍后重试；若持续失败，请联系维护方检查 TChouse-C 元数据探测链路",
                        )
                    )
                    continue

                if table_meta is not None:
                    table_metas[table] = table_meta

        return table_metas, failed_tables, issues

    def _should_probe_query_access(self, credential: CredentialRef | None) -> bool:
        return (
            isinstance(self.catalog, TChouseCMetadataCatalog)
            and credential is not None
            and credential.datasource == SUPPORTED_DATASOURCE
        )

    def _probe_query_access(
        self,
        expression: exp.Expression,
        credential: CredentialRef,
    ) -> list[ValidationIssue]:
        target = parse_clickhouse_jdbc_url(credential.jdbc_url)
        probe_sql = f"SELECT * FROM ({self._normalize_sql(expression)}) AS _mcp_query_probe LIMIT 0"
        try:
            execute_clickhouse_json(
                target=target,
                sql=probe_sql,
                query_id="metadata_probe_query",
                timeout_seconds=min(self.settings.query_timeout_seconds, 15),
            )
        except HTTPError as exc:
            message = sanitize_clickhouse_error(exc, target.password)
            return [_classify_clickhouse_probe_error(credential, message)]
        except URLError:
            return [
                ValidationIssue(
                    code="datasource_unreachable",
                    severity="error",
                    message="TChouse-C 网络连接失败",
                    suggested_action="请检查 TChouse-C 网络、地址和服务状态后重试",
                )
            ]
        except Exception:
            return [
                ValidationIssue(
                    code="internal_error",
                    severity="error",
                    message="TChouse-C 查询级预检发生内部错误",
                    suggested_action="请联系 Data MCP 维护方检查查询级预检服务",
                )
            ]
        else:
            return []

    def _partition_issues(
        self,
        expression: exp.Expression,
        datasource: str,
        tables: list[str],
        table_metas: dict[str, TableMeta],
    ) -> list[ValidationIssue]:
        sql_text = expression.sql(dialect=SQL_DIALECT).lower()
        issues: list[ValidationIssue] = []
        for table_name in tables:
            table = table_metas.get(table_name)
            if not table or not table.partition_fields:
                continue
            if not any(f"{field.lower()}" in sql_text for field in table.partition_fields):
                issues.append(
                    ValidationIssue(
                        code="missing_partition_filter",
                        severity="error",
                        message=f"{table_name} 必须带分区过滤条件：{', '.join(table.partition_fields)}",
                        suggested_action="补充明确的业务日期或分区范围",
                    )
                )
        return issues

    def _finish(
        self,
        datasource: str,
        normalized_sql: str | None,
        tables: list[str],
        columns: list[str],
        issues: list[ValidationIssue],
    ) -> SqlValidationResult:
        has_error = any(issue.severity == "error" for issue in issues)
        return SqlValidationResult(
            status=Status.VALIDATION_ERROR if has_error else Status.SUCCESS,
            datasource=datasource,
            normalized_sql=None if has_error else normalized_sql,
            tables=tables,
            columns=columns,
            issues=issues,
        )

    def _bounded_sql(self, expression: exp.Expression) -> tuple[str, bool, bool]:
        bounded = expression.copy()
        root_limit = bounded.args.get("limit")
        if root_limit is None:
            output_limit = min(self.settings.default_limit, self.settings.max_rows)
            bounded.set("limit", exp.Limit(expression=exp.Literal.number(output_limit)))
            return self._normalize_sql(bounded), True, False

        limit_expression = root_limit.args.get("expression")
        limit_value: int | None = None
        if isinstance(limit_expression, exp.Literal) and not limit_expression.is_string:
            try:
                limit_value = int(limit_expression.this)
            except (TypeError, ValueError):
                limit_value = None
        if limit_value is not None and 0 <= limit_value <= self.settings.max_rows:
            return self._normalize_sql(bounded), False, False

        root_limit.set("expression", exp.Literal.number(self.settings.max_rows))
        return self._normalize_sql(bounded), False, True

    @staticmethod
    def _normalize_sql(expression: exp.Expression) -> str:
        return expression.sql(dialect=SQL_DIALECT, pretty=False)

    @staticmethod
    def _is_show_command(expression: exp.Expression) -> bool:
        return isinstance(expression, exp.Command) and str(expression.this).upper() == "SHOW"


def _table_name(table: exp.Table) -> str:
    database = table.db
    if database:
        return f"{database}.{table.name}".lower()
    return table.name.lower()


def _minimal_table_meta(full_name: str) -> TableMeta:
    if "." in full_name:
        database, table = full_name.rsplit(".", maxsplit=1)
    else:
        database, table = "", full_name
    return TableMeta(database=database, table=table)


def _is_allowed_show_command(expression: exp.Expression) -> bool:
    suffix = expression.args.get("expression")
    raw_suffix = str(suffix.this) if isinstance(suffix, exp.Literal) else str(suffix or "")
    without_comments = re.sub(r"/\*.*?\*/|--[^\r\n]*", " ", raw_suffix, flags=re.DOTALL)
    normalized_suffix = " ".join(without_comments.split())
    return ALLOWED_SHOW_PREFIX.match(normalized_suffix) is not None


def _has_unsafe_system_users_projection(expression: exp.Expression) -> bool:
    if expression.find(exp.Columns) is not None or expression.find(exp.Apply) is not None:
        return True
    for star in expression.find_all(exp.Star):
        if not isinstance(star.parent, exp.Count):
            return True
    return False


def _classify_clickhouse_probe_error(
    credential: CredentialRef,
    message: str,
) -> ValidationIssue:
    error_name = _clickhouse_error_name(message)
    if error_name in CLICKHOUSE_PERMISSION_ERROR_NAMES:
        return ValidationIssue(
            code="permission_denied",
            severity="error",
            message=(
                f"数据库账号 {credential.tchouse_account} 无法通过当前 SQL 的只读权限预检："
                f"{message}"
            ),
            suggested_action=(
                "请确认当前提问人的 TChouse-C 账号已被授权 SQL 涉及表和字段的 SELECT 权限"
            ),
        )

    if error_name in CLICKHOUSE_SQL_ERROR_NAMES:
        return ValidationIssue(
            code="sql_error",
            severity="error",
            message=f"当前 SQL 未通过 TChouse-C 引擎校验：{message}",
            suggested_action="请修正 SQL 的语法、字段引用或聚合规则后重新校验",
        )

    return ValidationIssue(
        code="datasource_error",
        severity="error",
        message=f"TChouse-C 无法完成当前 SQL 的只读预检：{message}",
        suggested_action="请稍后重试；若持续失败，请联系维护方根据错误详情检查数据源",
    )


def _clickhouse_error_name(message: str) -> str | None:
    matches = CLICKHOUSE_ERROR_NAME_PATTERN.findall(message)
    return matches[-1] if matches else None


def _query_tables(expression: exp.Expression) -> tuple[list[str], list[ValidationIssue]]:
    cte_names = {cte.alias.lower() for cte in expression.find_all(exp.CTE) if cte.alias}
    tables: set[str] = set()
    issues: list[ValidationIssue] = []
    unsupported_functions: list[str] = []

    for table in expression.find_all(exp.Table):
        if not table.name:
            unsupported_functions.append(table.sql(dialect=SQL_DIALECT))
            continue
        if not table.db and table.name.lower() in cte_names:
            continue
        tables.add(_table_name(table))

    if unsupported_functions:
        issues.append(
            ValidationIssue(
                code="unsupported_table_function",
                severity="error",
                message="暂不支持在 FROM/JOIN 中使用 ClickHouse 表函数",
                suggested_action=(
                    "请改为查询已授权的物理表或视图；当前表函数："
                    + "、".join(unsupported_functions)
                ),
            )
        )

    return sorted(tables), issues


def _candidate_tables(
    catalog: MetadataCatalog, table: str, credential: CredentialRef | None
) -> list[str]:
    candidates = catalog.suggest_tables(table, limit=5, credential=credential)
    return [candidate.full_name for candidate in candidates]
