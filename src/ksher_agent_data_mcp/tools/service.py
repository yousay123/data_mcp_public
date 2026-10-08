import hashlib
from collections import OrderedDict
from threading import Lock
from typing import Any

from pydantic import ValidationError

from ksher_agent_data_mcp.audit.logger import AuditEvent, audit_logger
from ksher_agent_data_mcp.credentials.base import (
    CredentialConfigurationMissing,
    CredentialMappingUnavailable,
    UnsupportedCredentialDatasource,
)
from ksher_agent_data_mcp.dependencies import Container
from ksher_agent_data_mcp.export import (
    ExportError,
    LocalExportWriter,
    build_xlsx_bytes,
    export_validation_error,
    new_export_id,
    sanitize_excel_filename,
)
from ksher_agent_data_mcp.metadata.snapshot import (
    SnapshotError,
    refresh_metadata_snapshot,
    search_metadata_snapshot,
)
from ksher_agent_data_mcp.models.contracts import (
    CredentialRef,
    Status,
    UserContext,
    ValidationIssue,
)
from ksher_agent_data_mcp.query_plan import (
    EXECUTION_MODE_MAX_RUNS,
    EXECUTION_MODE_SINGLE,
    QueryPlanRun,
    QueryPlanStore,
    RepairChainStore,
)

AuditContext = dict[str, str | None]


class DataMcpService:
    def __init__(self, container: Container) -> None:
        self.container = container
        # This process is intentionally single-worker; a multi-worker deploy
        # must move plans to shared storage before enabling this contract.
        self.query_plans = QueryPlanStore(
            compare_ttl_seconds=container.settings.query_plan_compare_ttl_seconds
        )
        self.repair_chains = RepairChainStore(container.settings.query_repair_max_failures)
        self._inspection_calls: OrderedDict[tuple[str, str], int] = OrderedDict()
        self._inspection_calls_lock = Lock()

    def inspect_ck_subjects_by_table(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        request_lark_app_id: str | None,
        target_tables: list[str],
        audit_context: AuditContext | None = None,
    ) -> dict[str, Any]:
        """Return scoped access holders without exposing arbitrary access-metadata SQL."""
        user_or_error = self._build_user_context(
            request_user_union_id, request_user_open_id, request_lark_app_id
        )
        if isinstance(user_or_error, dict):
            return self._with_result_class(user_or_error, "policy_error")
        policy_error = self._validate_access_audit_policy(
            user_or_error.union_id, audit_context, schedule_only=False
        )
        if policy_error is not None:
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_subjects_by_table",
                policy_error,
                audit_context,
                target_tables=target_tables,
            )
            return policy_error
        rate_error = self._validate_access_inspection_rate(user_or_error.union_id, audit_context)
        if rate_error is not None:
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_subjects_by_table",
                rate_error,
                audit_context,
                target_tables=target_tables,
            )
            return rate_error
        auditor_or_error = self._access_auditor_for_user(user_or_error)
        if isinstance(auditor_or_error, dict):
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_subjects_by_table",
                auditor_or_error,
                audit_context,
                target_tables=target_tables,
            )
            return auditor_or_error
        auditor = auditor_or_error
        try:
            result = auditor.subjects_by_table(target_tables=target_tables)
        except (TypeError, ValueError) as exc:
            invalid = self._access_audit_input_error("invalid_access_inspection_scope", str(exc))
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_subjects_by_table",
                invalid,
                audit_context,
                target_tables=target_tables,
            )
            return invalid
        self._emit_access_inspection_audit(
            user_or_error,
            "ck_access_subjects_by_table",
            result,
            audit_context,
            target_tables=target_tables,
        )
        return result

    def inspect_ck_resources_by_subject(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        request_lark_app_id: str | None,
        target_accounts: list[str],
        target_roles: list[str],
        audit_context: AuditContext | None = None,
    ) -> dict[str, Any]:
        """Return scoped direct/inherited resources for explicit account/role names."""
        user_or_error = self._build_user_context(
            request_user_union_id, request_user_open_id, request_lark_app_id
        )
        if isinstance(user_or_error, dict):
            return self._with_result_class(user_or_error, "policy_error")
        policy_error = self._validate_access_audit_policy(
            user_or_error.union_id, audit_context, schedule_only=False
        )
        if policy_error is not None:
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_resources_by_subject",
                policy_error,
                audit_context,
                target_accounts=target_accounts,
                target_roles=target_roles,
            )
            return policy_error
        rate_error = self._validate_access_inspection_rate(user_or_error.union_id, audit_context)
        if rate_error is not None:
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_resources_by_subject",
                rate_error,
                audit_context,
                target_accounts=target_accounts,
                target_roles=target_roles,
            )
            return rate_error
        auditor_or_error = self._access_auditor_for_user(user_or_error)
        if isinstance(auditor_or_error, dict):
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_resources_by_subject",
                auditor_or_error,
                audit_context,
                target_accounts=target_accounts,
                target_roles=target_roles,
            )
            return auditor_or_error
        auditor = auditor_or_error
        try:
            result = auditor.resources_by_subject(
                target_accounts=target_accounts,
                target_roles=target_roles,
            )
        except (TypeError, ValueError) as exc:
            invalid = self._access_audit_input_error("invalid_access_inspection_scope", str(exc))
            self._emit_access_inspection_audit(
                user_or_error,
                "ck_access_resources_by_subject",
                invalid,
                audit_context,
                target_accounts=target_accounts,
                target_roles=target_roles,
            )
            return invalid
        self._emit_access_inspection_audit(
            user_or_error,
            "ck_access_resources_by_subject",
            result,
            audit_context,
            target_accounts=target_accounts,
            target_roles=target_roles,
        )
        return result

    def _emit_access_inspection_audit(
        self,
        user: UserContext,
        event_type: str,
        result: dict[str, Any],
        audit_context: AuditContext | None,
        **scope: Any,
    ) -> None:
        audit_logger.emit(
            AuditEvent(
                event_type=event_type,
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=Status.SUCCESS if result.get("status") == "success" else Status.ERROR,
                detail={
                    "audit_id": result.get("audit_id"),
                    "scope": result.get("scope"),
                    "mode": result.get("mode"),
                    "verdict": result.get("verdict"),
                    "error_code": result.get("error_code"),
                    "observed_nodes": result.get("observed_nodes"),
                    "ck_version": result.get("ck_version"),
                    "schema_fingerprint": result.get("schema_fingerprint"),
                    "result_count": len(result.get("results", [])),
                    "difference_count": len(result.get("differences", [])),
                    **scope,
                    **self._audit_detail(audit_context),
                },
            )
        )

    def _validate_access_inspection_rate(
        self, union_id: str, audit_context: AuditContext | None
    ) -> dict[str, Any] | None:
        turn_id = self._audit_detail(audit_context).get("turn_id")
        if not turn_id:
            return self._access_audit_policy_error("access_inspection_turn_required")
        key = (union_id, turn_id)
        limit = self.container.settings.access_inspection_max_calls_per_turn
        with self._inspection_calls_lock:
            count = self._inspection_calls.get(key, 0)
            if count >= limit:
                return self._access_audit_policy_error("access_inspection_rate_limit")
            self._inspection_calls[key] = count + 1
            self._inspection_calls.move_to_end(key)
            while len(self._inspection_calls) > 4096:
                self._inspection_calls.popitem(last=False)
        return None

    def audit_ck_default_role_baseline(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        request_lark_app_id: str | None,
        audit_context: AuditContext | None = None,
    ) -> dict[str, Any]:
        """Schedule-only baseline; returns only accounts that violate DEFAULT ROLE ALL."""
        user_or_error = self._build_user_context(
            request_user_union_id, request_user_open_id, request_lark_app_id
        )
        if isinstance(user_or_error, dict):
            return self._with_result_class(user_or_error, "policy_error")
        policy_error = self._validate_access_audit_policy(
            user_or_error.union_id,
            audit_context,
            schedule_only=True,
        )
        if policy_error is not None:
            self._emit_default_role_baseline_audit(
                user_or_error,
                policy_error,
                audit_context,
            )
            return policy_error
        auditor_or_error = self._access_auditor_for_user(user_or_error)
        if isinstance(auditor_or_error, dict):
            return auditor_or_error
        auditor = auditor_or_error
        result = auditor.default_role_baseline()
        self._emit_default_role_baseline_audit(user_or_error, result, audit_context)
        return result

    def _emit_default_role_baseline_audit(
        self,
        user: UserContext,
        result: dict[str, Any],
        audit_context: AuditContext | None,
    ) -> None:
        audit_logger.emit(
            AuditEvent(
                event_type="ck_default_role_baseline",
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=Status.SUCCESS if result.get("status") == "success" else Status.ERROR,
                detail={
                    "audit_id": result.get("audit_id"),
                    "scope": result.get("scope"),
                    "verdict": result.get("verdict"),
                    "error_code": result.get("error_code"),
                    "observed_nodes": result.get("observed_nodes"),
                    "ck_version": result.get("ck_version"),
                    "schema_fingerprint": result.get("schema_fingerprint"),
                    "anomaly_count": len(result.get("anomalies", [])),
                    **self._audit_detail(audit_context),
                },
            )
        )

    def validate_sql_for_user(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        sql: str,
        datasource: str = "tchouse-c",
        request_lark_app_id: str | None = None,
        request_user_tchouse_account: str | None = None,
        audit_context: AuditContext | None = None,
        repair_chain_id: str | None = None,
        execution_mode: str = EXECUTION_MODE_SINGLE,
    ) -> dict[str, Any]:
        user_or_error = self._build_user_context(
            request_user_union_id=request_user_union_id,
            request_user_open_id=request_user_open_id,
            request_lark_app_id=request_lark_app_id,
        )
        if isinstance(user_or_error, dict):
            return user_or_error
        user = user_or_error
        datasource_error = self._validate_public_query_datasource(datasource)
        if datasource_error is not None:
            self._audit_query_plan_rejection(
                user, None, datasource, datasource_error, audit_context
            )
            return datasource_error
        if execution_mode not in EXECUTION_MODE_MAX_RUNS:
            mode_error = self._query_plan_error(
                "query_plan_execution_mode_invalid",
                "execution_mode 仅支持 single 或 compare",
            )
            self._audit_query_plan_rejection(
                user, None, datasource, mode_error, audit_context
            )
            return mode_error
        plan_scope: tuple[str, str, str | None] | None = None
        if self._is_trusted_human_or_schedule(audit_context):
            scope_or_error = self._query_plan_scope(user, audit_context)
            if isinstance(scope_or_error, dict):
                self._audit_query_plan_rejection(
                    user, None, datasource, scope_or_error, audit_context
                )
                return scope_or_error
            plan_scope = scope_or_error
        repair_scope_id = self._audit_detail(audit_context).get("turn_id") or user.union_id
        chain_ok, chain_code, active_chain_id = self.repair_chains.prepare(
            user.union_id,
            repair_chain_id.strip() if isinstance(repair_chain_id, str) else None,
            scope_id=repair_scope_id,
        )
        if not chain_ok:
            message = (
                f"本轮 SQL 查询错误已达到上限；修正链在首次创建后 "
                f"{self.repair_chains.ttl_seconds} 秒过期，过期后可重新验证"
                if chain_code == "repair_chain_failure_limit"
                else "SQL 修正链已失效或与当前身份/turn 不匹配"
            )
            chain_error = self._query_plan_error(
                chain_code,
                message,
            )
            if chain_code == "repair_chain_failure_limit":
                chain_error["repair_chain_id"] = active_chain_id
                chain_error["repair_attempts_remaining"] = 0
                chain_error["retry_after_seconds"] = self.repair_chains.ttl_seconds
            self._audit_query_plan_rejection(
                user,
                None,
                datasource,
                chain_error,
                audit_context,
            )
            return chain_error
        credential = self._resolve_validation_credential(user, datasource)
        if isinstance(credential, dict):
            self._audit_query_plan_rejection(
                user,
                None,
                datasource,
                credential,
                audit_context,
            )
            return credential
        account_error = self._validate_expected_account(credential, request_user_tchouse_account)
        if account_error is not None:
            self._audit_query_plan_rejection(
                user,
                None,
                datasource,
                account_error,
                audit_context,
                extra_detail={
                    "injected_account_ref": _account_audit_ref(
                        request_user_tchouse_account or ""
                    ),
                    "resolved_account_ref": _account_audit_ref(
                        credential.tchouse_account if credential else ""
                    ),
                },
            )
            return account_error

        result = self.container.sql_guard.validate(
            user,
            sql,
            datasource,
            credential=credential,
            max_rows=self._query_max_rows(audit_context),
        )
        audit_logger.emit(
            AuditEvent(
                event_type="validate_sql",
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=result.status,
                detail={
                    "tables": result.tables,
                    "datasource": result.datasource,
                    "credential": credential.masked() if credential else None,
                    "issue_codes": [issue.code for issue in result.issues],
                    "repair_chain_id": active_chain_id,
                    "execution_mode": execution_mode,
                    "query_plan_max_runs": EXECUTION_MODE_MAX_RUNS[execution_mode],
                    **self._audit_detail(audit_context),
                },
            )
        )
        response = result.model_dump()
        response["result_class"] = "success" if result.status == Status.SUCCESS else "policy_error"
        response["repair_chain_id"] = active_chain_id
        response["repair_attempts_remaining"] = self.repair_chains.remaining(active_chain_id)
        self._attach_sql_account_binding(response, credential)
        if not self._is_trusted_human_or_schedule(audit_context):
            return self._redact_validation_schema_detail(response, audit_context)
        if result.status == Status.SUCCESS and result.normalized_sql is not None:
            assert plan_scope is not None
            session_id, trust_domain, task_id = plan_scope
            response["query_plan_id"] = self.query_plans.issue(
                user.union_id,
                sql,
                datasource,
                active_chain_id,
                session_id=session_id,
                trust_domain=trust_domain,
                task_id=task_id,
                execution_mode=execution_mode,
            )
            response["query_plan_execution_mode"] = execution_mode
            response["query_plan_max_runs"] = EXECUTION_MODE_MAX_RUNS[execution_mode]
            response["query_plan_ttl_seconds"] = (
                self.query_plans.compare_ttl_seconds
                if execution_mode != EXECUTION_MODE_SINGLE
                else self.query_plans.ttl_seconds
            )
        return response

    def run_query_for_user(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        sql: str,
        datasource: str = "tchouse-c",
        request_lark_app_id: str | None = None,
        request_user_tchouse_account: str | None = None,
        audit_context: AuditContext | None = None,
        *,
        query_plan_id: str,
    ) -> dict[str, Any]:
        user_or_error = self._build_user_context(
            request_user_union_id=request_user_union_id,
            request_user_open_id=request_user_open_id,
            request_lark_app_id=request_lark_app_id,
        )
        if isinstance(user_or_error, dict):
            return user_or_error
        policy_error = self._validate_caller_policy(audit_context)
        if policy_error is not None:
            self._audit_rejected_caller(
                "select_blocked",
                request_user_union_id,
                request_user_open_id,
                request_lark_app_id,
                audit_context,
                policy_error,
            )
            return policy_error
        user = user_or_error
        datasource_error = self._validate_public_query_datasource(datasource)
        if datasource_error is not None:
            self._audit_query_plan_rejection(
                user, query_plan_id, datasource, datasource_error, audit_context
            )
            return datasource_error
        scope_or_error = self._query_plan_scope(user, audit_context)
        if isinstance(scope_or_error, dict):
            self._audit_query_plan_rejection(
                user, query_plan_id, datasource, scope_or_error, audit_context
            )
            return scope_or_error
        session_id, trust_domain, task_id = scope_or_error
        plan_error, plan_run = self._consume_query_plan(
            query_plan_id,
            session_id,
            user.union_id,
            sql,
            datasource,
            trust_domain,
            task_id,
        )
        if plan_error is not None:
            self._audit_query_plan_rejection(
                user, query_plan_id, datasource, plan_error, audit_context
            )
            return plan_error
        assert plan_run is not None
        response = self._execute_sql_for_user(
            user,
            sql,
            datasource,
            request_user_tchouse_account,
            audit_context,
            plan_run.repair_chain_id,
        )
        response = self._attach_repair_chain(response, plan_run.repair_chain_id)
        self._audit_query_plan_execution(
            user,
            query_plan_id,
            datasource,
            plan_run,
            response,
            audit_context,
        )
        return self._attach_query_plan_run(response, plan_run)

    def export_query_to_excel_file(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        sql: str,
        datasource: str = "tchouse-c",
        request_lark_app_id: str | None = None,
        request_user_tchouse_account: str | None = None,
        filename: str | None = None,
        max_export_rows: int | None = None,
        audit_context: AuditContext | None = None,
        *,
        query_plan_id: str,
    ) -> dict[str, Any]:
        user_or_error = self._build_user_context(
            request_user_union_id=request_user_union_id,
            request_user_open_id=request_user_open_id,
            request_lark_app_id=request_lark_app_id,
        )
        if isinstance(user_or_error, dict):
            return user_or_error
        policy_error = self._validate_caller_policy(audit_context)
        if policy_error is not None:
            self._audit_rejected_caller(
                "excel_export_blocked",
                request_user_union_id,
                request_user_open_id,
                request_lark_app_id,
                audit_context,
                policy_error,
            )
            return policy_error
        user = user_or_error
        datasource_error = self._validate_public_query_datasource(datasource)
        if datasource_error is not None:
            self._audit_query_plan_rejection(
                user, query_plan_id, datasource, datasource_error, audit_context
            )
            return datasource_error
        scope_or_error = self._query_plan_scope(user, audit_context)
        if isinstance(scope_or_error, dict):
            self._audit_query_plan_rejection(
                user, query_plan_id, datasource, scope_or_error, audit_context
            )
            return scope_or_error
        session_id, trust_domain, task_id = scope_or_error
        plan_error, plan_run = self._consume_query_plan(
            query_plan_id,
            session_id,
            user.union_id,
            sql,
            datasource,
            trust_domain,
            task_id,
        )
        if plan_error is not None:
            self._audit_query_plan_rejection(
                user, query_plan_id, datasource, plan_error, audit_context
            )
            return plan_error
        assert plan_run is not None
        result = self._execute_sql_for_user(
            user,
            sql,
            datasource,
            request_user_tchouse_account,
            audit_context,
            plan_run.repair_chain_id,
        )
        result = self._attach_repair_chain(result, plan_run.repair_chain_id)
        self._audit_query_plan_execution(
            user, query_plan_id, datasource, plan_run, result, audit_context
        )
        result = self._attach_query_plan_run(result, plan_run)
        if result.get("status") != Status.SUCCESS:
            return result
        if result.get("truncated"):
            return export_validation_error(
                "查询结果已被截断，拒绝导出不完整 Excel；请缩小查询范围或补充更严格过滤条件",
                "query_result_truncated",
            )

        row_count = int(result.get("row_count") or 0)
        limit = max_export_rows or self.container.settings.export_max_rows
        if row_count > limit:
            return export_validation_error(
                f"导出行数 {row_count} 超过当前上限 {limit}，请缩小范围或由运维调整 DATA_MCP_EXPORT_MAX_ROWS",
                "export_row_limit_exceeded",
            )

        export_id = new_export_id()
        export_filename = sanitize_excel_filename(filename, export_id)
        try:
            content = build_xlsx_bytes(result.get("columns", []), result.get("rows", []))
            artifact = LocalExportWriter(self.container.settings).write_excel(
                export_filename, content
            )
        except ExportError as exc:
            audit_logger.emit(
                AuditEvent(
                    event_type="excel_export_failed",
                    union_id=user.union_id,
                    feishu_user_id=user.feishu_user_id,
                    lark_app_id=user.lark_app_id,
                    email=user.email,
                    status=Status.ERROR,
                    detail={
                        "query_id": result.get("query_id"),
                        "export_id": export_id,
                        "error_code": exc.code,
                        "tables": result.get("tables", []),
                        "datasource": datasource,
                        **self._audit_detail(audit_context),
                    },
                )
            )
            return {
                "status": Status.ERROR,
                "message": _safe_export_error_message(exc.code),
                "error_code": exc.code,
                "query_id": result.get("query_id"),
            }

        audit_logger.emit(
            AuditEvent(
                event_type="excel_export",
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=Status.SUCCESS,
                detail={
                    "query_id": result.get("query_id"),
                    "export_id": export_id,
                    "filename": export_filename,
                    "row_count": row_count,
                    "tables": result.get("tables", []),
                    "datasource": datasource,
                    "file_bytes": artifact.bytes,
                    "file_sha256": artifact.sha256,
                    "file_expires_at": artifact.expires_at,
                    **self._audit_detail(audit_context),
                },
            )
        )

        return {
            "status": Status.SUCCESS,
            "query_id": result.get("query_id"),
            "datasource": result.get("datasource", datasource),
            "sql": result.get("sql"),
            "tables": result.get("tables", []),
            "query_plan_execution_mode": result.get("query_plan_execution_mode"),
            "query_plan_run_index": result.get("query_plan_run_index"),
            "query_plan_max_runs": result.get("query_plan_max_runs"),
            "sql_account_binding": _export_sql_account_binding(result.get("sql_account_binding")),
            "file": {
                "export_id": export_id,
                "file_type": "xlsx",
                "path": artifact.path,
                "filename": export_filename,
                "bytes": artifact.bytes,
                "sha256": artifact.sha256,
                "mime": artifact.mime,
                "expires_at": artifact.expires_at,
                "row_count": row_count,
            },
        }

    def refresh_metadata_snapshot_for_owner(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        request_lark_app_id: str | None,
        audit_context: AuditContext | None = None,
    ) -> dict[str, Any]:
        detail = self._audit_detail(audit_context)
        if (
            detail["caller_source"] != "schedule_creator"
            or not detail["task_id"]
            or not request_user_open_id
            or not request_user_open_id.strip()
            or not request_lark_app_id
            or not request_lark_app_id.strip()
        ):
            response = {
                "status": Status.VALIDATION_ERROR,
                "message": "元数据快照刷新只允许带 task/app 绑定的 schedule_creator 任务触发",
                "issues": [
                    ValidationIssue(
                        code="metadata_snapshot_schedule_identity_required",
                        severity="error",
                        message=(
                            "刷新身份必须由宿主注入 schedule_creator、task_id、app_id "
                            "与 owner open_id/union_id"
                        ),
                        suggested_action="请由任务创建者通过目标 Bot 的飞书原生 /schedule 创建固定刷新任务",
                    ).model_dump()
                ],
                "permission_scope": "metadata_snapshot_refresh",
            }
            self._audit_rejected_caller(
                "metadata_snapshot_refresh_blocked",
                request_user_union_id,
                request_user_open_id,
                request_lark_app_id,
                audit_context,
                response,
            )
            return response

        user_or_error = self._build_user_context(
            request_user_union_id=request_user_union_id,
            request_user_open_id=request_user_open_id,
            request_lark_app_id=request_lark_app_id,
        )
        if isinstance(user_or_error, dict):
            return user_or_error
        credential = self._resolve_credential(user_or_error, "tchouse-c")
        if isinstance(credential, dict):
            return credential

        try:
            result = refresh_metadata_snapshot(
                self.container.settings,
                credential,
                owner_union_id=user_or_error.union_id,
                task_id=detail["task_id"] or "",
                lark_app_id=user_or_error.lark_app_id or "",
            )
        except SnapshotError as exc:
            audit_logger.emit(
                AuditEvent(
                    event_type="metadata_snapshot_refresh_failed",
                    union_id=user_or_error.union_id,
                    feishu_user_id=user_or_error.feishu_user_id,
                    lark_app_id=user_or_error.lark_app_id,
                    email=user_or_error.email,
                    status=Status.ERROR,
                    detail={"error_code": exc.code, **detail},
                )
            )
            return {
                "status": Status.ERROR,
                "error_code": exc.code,
                "message": str(exc),
                "permission_scope": "metadata_snapshot",
                "suggested_action": "停止生成 SQL；请维护方恢复可验证快照后重试，不得改用在线元数据或模型猜表",
            }

        audit_logger.emit(
            AuditEvent(
                event_type="metadata_snapshot_refresh",
                union_id=user_or_error.union_id,
                feishu_user_id=user_or_error.feishu_user_id,
                lark_app_id=user_or_error.lark_app_id,
                email=user_or_error.email,
                status=Status.SUCCESS,
                detail={
                    "source_table": result.get("source_table"),
                    "partition": result.get("partition"),
                    "row_count": result.get("row_count"),
                    "snapshot_version": result.get("version"),
                    **detail,
                },
            )
        )
        return result

    def search_metadata_snapshot(
        self,
        query: str,
        limit: int = 20,
        priority: str | None = None,
    ) -> dict[str, Any]:
        try:
            return search_metadata_snapshot(
                self.container.settings,
                query=query,
                limit=limit,
                priority=priority,
            )
        except SnapshotError as exc:
            return {
                "status": Status.ERROR,
                "error_code": exc.code,
                "message": str(exc),
                "permission_scope": "metadata_snapshot",
                "suggested_action": "停止生成 SQL；请维护方恢复可验证快照后重试，不得改用在线元数据或模型猜表",
            }

    def _consume_query_plan(
        self,
        query_plan_id: str | None,
        session_id: str,
        union_id: str,
        sql: str,
        datasource: str,
        trust_domain: str,
        task_id: str | None,
    ) -> tuple[dict[str, Any] | None, QueryPlanRun | None]:
        if not isinstance(query_plan_id, str) or not query_plan_id.strip():
            return (
                self._query_plan_error(
                    "query_plan_required", "必须先 validate SQL 并携带 query_plan_id"
                ),
                None,
            )
        ok, code, plan_run = self.query_plans.consume_for_run(
            query_plan_id.strip(),
            session_id=session_id,
            union_id=union_id,
            sql=sql,
            datasource=datasource,
            trust_domain=trust_domain,
            task_id=task_id,
        )
        if ok:
            return None, plan_run
        return self._query_plan_error(code, "query_plan 校验失败，拒绝执行"), None

    def _query_plan_scope(
        self,
        user: UserContext,
        audit_context: AuditContext | None,
    ) -> tuple[str, str, str | None] | dict[str, Any]:
        detail = self._audit_detail(audit_context)
        session_id = detail["session_id"]
        if not session_id:
            return self._query_plan_error(
                "query_plan_session_required",
                "查询计划必须绑定 BotMux session_id",
            )
        trust_domain = detail.get("trust_domain")
        if not trust_domain and user.lark_app_id:
            trust_domain = f"lark:{user.lark_app_id}"
        if not trust_domain:
            return self._query_plan_error(
                "query_plan_app_required",
                "查询计划必须绑定宿主注入的飞书应用身份",
            )
        task_id = (
            detail["task_id"] if detail["caller_source"] == "schedule_creator" else None
        )
        return session_id, trust_domain, task_id

    def _validate_public_query_datasource(self, datasource: str) -> dict[str, Any] | None:
        if datasource == "tchouse-c":
            return None
        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "message": "当前公开查询入口仅支持 tchouse-c 数据源",
            "issues": [
                ValidationIssue(
                    code="unsupported_datasource",
                    severity="error",
                    message="validate/run/export 仅允许 tchouse-c，已在凭证解析前拒绝",
                    suggested_action="请将 datasource 改为 tchouse-c",
                ).model_dump()
            ],
            "permission_scope": "datasource",
        }

    def _attach_query_plan_run(
        self,
        response: dict[str, Any],
        plan_run: QueryPlanRun,
    ) -> dict[str, Any]:
        response["query_plan_execution_mode"] = plan_run.execution_mode
        response["query_plan_run_index"] = plan_run.run_index
        response["query_plan_max_runs"] = plan_run.max_runs
        return response

    def _audit_query_plan_execution(
        self,
        user: UserContext,
        query_plan_id: str,
        datasource: str,
        plan_run: QueryPlanRun,
        response: dict[str, Any],
        audit_context: AuditContext | None,
    ) -> None:
        audit_logger.emit(
            AuditEvent(
                event_type="query_plan_execution",
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=response.get("status", Status.ERROR),
                detail={
                    "query_plan_ref": _query_plan_audit_ref(query_plan_id),
                    "execution_mode": plan_run.execution_mode,
                    "run_index": plan_run.run_index,
                    "max_runs": plan_run.max_runs,
                    "query_id": response.get("query_id"),
                    "datasource": datasource,
                    "tables": response.get("tables", []),
                    "result_class": response.get("result_class"),
                    "error_code": response.get("error_code"),
                    **self._audit_detail(audit_context),
                },
            )
        )

    def _audit_query_plan_rejection(
        self,
        user: UserContext,
        query_plan_id: str | None,
        datasource: str,
        response: dict[str, Any],
        audit_context: AuditContext | None,
        *,
        extra_detail: dict[str, Any] | None = None,
    ) -> None:
        issue_codes = [
            issue.get("code")
            for issue in response.get("issues", [])
            if isinstance(issue, dict)
        ]
        audit_logger.emit(
            AuditEvent(
                event_type="query_plan_rejected",
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=Status.VALIDATION_ERROR,
                detail={
                    "query_plan_ref": _query_plan_audit_ref(query_plan_id),
                    "datasource": datasource,
                    "issue_codes": issue_codes,
                    "error_code": issue_codes[0] if len(issue_codes) == 1 else None,
                    **self._audit_detail(audit_context),
                    **(extra_detail or {}),
                },
            )
        )

    def _attach_repair_chain(
        self, response: dict[str, Any], repair_chain_id: str | None
    ) -> dict[str, Any]:
        if repair_chain_id:
            failure_counted = response.get("result_class") == "ck_query_error"
            if failure_counted:
                self.repair_chains.record_failure(repair_chain_id)
            response["repair_chain_id"] = repair_chain_id
            response["repair_attempts_remaining"] = self.repair_chains.remaining(repair_chain_id)
            response["repair_failure_counted"] = failure_counted
        return response

    def _query_plan_error(self, code: str, message: str) -> dict[str, Any]:
        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "message": message,
            "issues": [
                ValidationIssue(
                    code=code,
                    severity="error",
                    message=message,
                    suggested_action="重新调用 validate_sql_for_user 获取新的 query_plan_id",
                ).model_dump()
            ],
            "permission_scope": "query_plan",
        }

    def _execute_sql_for_user(
        self,
        user: UserContext,
        sql: str,
        datasource: str,
        request_user_tchouse_account: str | None,
        audit_context: AuditContext | None,
        repair_chain_id: str | None = None,
    ) -> dict[str, Any]:
        credential = self._resolve_credential(user, datasource)
        if isinstance(credential, dict):
            return credential
        account_error = self._validate_expected_account(credential, request_user_tchouse_account)
        if account_error is not None:
            return account_error

        validation = self.container.sql_guard.validate(
            user,
            sql,
            datasource,
            credential=credential,
            max_rows=self._query_max_rows(audit_context),
        )
        if validation.status != Status.SUCCESS or validation.normalized_sql is None:
            audit_logger.emit(
                AuditEvent(
                    event_type="select_blocked",
                    union_id=user.union_id,
                    feishu_user_id=user.feishu_user_id,
                    lark_app_id=user.lark_app_id,
                    email=user.email,
                    status=validation.status,
                    detail={
                        "tables": validation.tables,
                        "datasource": validation.datasource,
                        "credential": credential.masked(),
                        "issue_codes": [issue.code for issue in validation.issues],
                        **self._audit_detail(audit_context),
                    },
                )
            )
            response = validation.model_dump()
            response["result_class"] = "policy_error"
            self._attach_sql_account_binding(response, credential)
            return response

        result = self.container.executor.run(
            credential=credential,
            sql=validation.normalized_sql,
            timeout_seconds=self.container.settings.query_timeout_seconds,
        )
        audit_logger.emit(
            AuditEvent(
                event_type="select",
                union_id=user.union_id,
                feishu_user_id=user.feishu_user_id,
                lark_app_id=user.lark_app_id,
                email=user.email,
                status=result.status,
                detail={
                    "query_id": result.query_id,
                    "credential": credential.masked(),
                    "tables": validation.tables,
                    "datasource": validation.datasource,
                    "row_count": result.row_count,
                    "read_rows": result.read_rows,
                    "read_bytes": result.read_bytes,
                    "truncated": result.truncated,
                    "execution_ms": result.execution_ms,
                    "result_class": result.result_class,
                    "error_code": result.error_code,
                    "repair_chain_id": repair_chain_id,
                    **self._audit_detail(audit_context),
                },
            )
        )
        response = result.model_dump()
        response["tables"] = validation.tables
        self._attach_sql_account_binding(response, credential)
        return response

    def _attach_sql_account_binding(
        self,
        response: dict[str, Any],
        credential: CredentialRef | None,
    ) -> None:
        if credential is None:
            return

        response["sql_account_binding"] = {
            "datasource": credential.datasource,
            "tables": response.get("tables", []),
            "resolved_by": _credential_resolution_source(credential),
            "account_bound": True,
        }

    def _validate_expected_account(
        self,
        credential: CredentialRef | None,
        expected_account: str | None,
    ) -> dict[str, Any] | None:
        if credential is None or not expected_account or not expected_account.strip():
            return None

        expected = expected_account.strip().lower()
        actual = credential.tchouse_account.strip().lower()
        if expected == actual:
            return None

        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "message": "当前提问人的数据库账号与 MCP 解析出的账号不一致，拒绝执行",
            "issues": [
                ValidationIssue(
                    code="account_mismatch",
                    severity="error",
                    message=(
                        "request_user_tchouse_account 与 union_id 映射出的 TChouse-C 账号不一致"
                    ),
                    suggested_action="请确认 BotMux 注入的是当前提问人本人的数据库账号，不能复用他人账号",
                ).model_dump()
            ],
            "permission_scope": "user_identity",
        }

    def _resolve_validation_credential(
        self, user: UserContext, datasource: str
    ) -> CredentialRef | None | dict[str, Any]:
        if self.container.settings.metadata_provider != "tchouse_c":
            return None

        return self._resolve_credential(user, datasource, for_catalog_probe=True)

    def _resolve_credential(
        self,
        user: UserContext,
        datasource: str,
        *,
        for_catalog_probe: bool = False,
    ) -> CredentialRef | dict[str, Any]:
        try:
            credential = self.container.credentials.resolve(user, datasource)
        except CredentialMappingUnavailable:
            return self._credential_resolution_error(
                datasource,
                code="account_mapping_unavailable",
                message=(
                    f"当前用户没有可用的 {datasource} 数据账号映射"
                    + ("，无法执行表目录预检" if for_catalog_probe else "")
                ),
                suggested_action=f"确认飞书 union_id 和 {datasource} 账号映射是否存在",
                required_permission=f"{datasource} account mapping",
            )
        except CredentialConfigurationMissing:
            return self._credential_resolution_error(
                datasource,
                code="credential_config_missing",
                message=f"Data MCP 缺少 {datasource} 凭证配置，无法解析数据库账号",
                suggested_action="请联系 Data MCP 维护方检查服务端凭证配置",
            )
        except UnsupportedCredentialDatasource:
            return self._credential_resolution_error(
                datasource,
                code="unsupported_datasource",
                message=f"当前 MCP 不支持数据源：{datasource}",
                suggested_action="请改用当前 MCP 支持的 tchouse-c 数据源",
            )

        if credential is not None:
            return credential

        return self._credential_resolution_error(
            datasource,
            code="account_mapping_unavailable",
            message=(
                f"当前用户没有可用的 {datasource} 数据账号映射"
                + ("，无法执行表目录预检" if for_catalog_probe else "")
            ),
            suggested_action=f"确认飞书 union_id 和 {datasource} 账号映射是否存在",
            required_permission=f"{datasource} account mapping",
        )

    def _credential_resolution_error(
        self,
        datasource: str,
        *,
        code: str,
        message: str,
        suggested_action: str,
        required_permission: str | None = None,
    ) -> dict[str, Any]:
        response: dict[str, Any] = {
            "status": Status.NOT_FOUND,
            "result_class": "policy_error",
            "message": message,
            "suggested_action": suggested_action,
            "issues": [
                ValidationIssue(
                    code=code,
                    severity="error",
                    message=message,
                    suggested_action=suggested_action,
                ).model_dump()
            ],
            "sql_account_binding": {
                "datasource": datasource,
                "tables": [],
                "resolved_by": None,
                "account_bound": False,
                "unresolved_reason": code,
            },
        }
        if required_permission is not None:
            response["required_permission"] = required_permission
        return response

    def _build_user_context(
        self,
        request_user_union_id: str,
        request_user_open_id: str | None,
        request_lark_app_id: str | None,
    ) -> UserContext | dict[str, Any]:
        try:
            return UserContext(
                union_id=request_user_union_id.strip(),
                feishu_user_id=request_user_open_id.strip() if request_user_open_id else None,
                lark_app_id=request_lark_app_id.strip() if request_lark_app_id else None,
            )
        except (AttributeError, ValidationError):
            return {
                "status": Status.VALIDATION_ERROR,
                "result_class": "policy_error",
                "message": "无法确认当前提问人的 union_id，拒绝执行数据查询",
                "issues": [
                    ValidationIssue(
                        code="missing_union_id",
                        severity="error",
                        message="request_user_union_id 为空或无效",
                        suggested_action="请确认 BotMux 已按本次 agent turn 快照注入 caller union_id",
                    ).model_dump()
                ],
                "permission_scope": "user_identity",
            }

    def _validate_caller_policy(
        self,
        audit_context: AuditContext | None,
    ) -> dict[str, Any] | None:
        # This is not an independent identity trust boundary: audit_context is
        # supplied by the caller that holds the internal HTTP token. The real
        # boundary is Botmux Gateway `_meta`, plugin-side hidden argument
        # injection, and keeping the internal token out of model reach. This
        # check keeps normal plugin forwarding from returning extra detail.
        if not self._is_trusted_human_or_schedule(audit_context):
            return self._caller_policy_error(
                "当前调用方不是受信任的真实用户或定时任务来源，拒绝执行数据查询"
            )

        return None

    def _validate_access_audit_policy(
        self,
        request_user_union_id: str,
        audit_context: AuditContext | None,
        *,
        schedule_only: bool,
    ) -> dict[str, Any] | None:
        detail = self._audit_detail(audit_context)
        is_schedule = detail["caller_source"] == "schedule_creator" and bool(detail["task_id"])
        if schedule_only and not is_schedule:
            return self._access_audit_policy_error("access_audit_schedule_required")
        if not schedule_only and not (
            detail["sender_type"] == "user" or is_schedule
        ):
            return self._access_audit_policy_error("access_audit_human_or_schedule_required")
        allowed_union_ids = {
            value.strip()
            for value in self.container.settings.access_audit_allowed_union_ids.split(",")
            if value.strip()
        }
        if request_user_union_id not in allowed_union_ids:
            return self._access_audit_policy_error("access_audit_union_id_not_allowed")
        return None

    def _access_audit_policy_error(self, code: str) -> dict[str, Any]:
        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "verdict": "inconclusive",
            "error_code": code,
            "message": "当前可信调用身份无权使用权限审计接口",
            "permission_scope": "ck_access_consistency_audit",
        }

    def _access_audit_input_error(self, code: str, detail: str | None = None) -> dict[str, Any]:
        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "verdict": "inconclusive",
            "error_code": code,
            "message": detail or "权限审计申请上下文或目标范围无效",
            "permission_scope": "ck_access_consistency_audit",
        }

    def _access_audit_unavailable(self) -> dict[str, Any]:
        return {
            "status": Status.ERROR,
            "result_class": "inconclusive",
            "verdict": "inconclusive",
            "error_code": "access_audit_not_configured",
            "message": "权限审计调用身份或入口配置不完整",
            "permission_scope": "ck_access_consistency_audit",
        }

    def _access_auditor_for_user(
        self, user: UserContext
    ) -> Any:
        factory = self.container.access_auditor_factory
        if factory is None:
            return self._access_audit_unavailable()
        credential_or_error = self._resolve_credential(user, "tchouse-c")
        if isinstance(credential_or_error, dict):
            return {
                "status": Status.ERROR,
                "result_class": "inconclusive",
                "verdict": "inconclusive",
                "error_code": "access_audit_caller_credential_unavailable",
                "message": "无法解析当前调用人的 TChouse-C 凭证，权限审计未执行",
                "permission_scope": "ck_access_consistency_audit",
            }
        try:
            return factory(credential_or_error)
        except (TypeError, ValueError):
            return {
                "status": Status.ERROR,
                "result_class": "inconclusive",
                "verdict": "inconclusive",
                "error_code": "access_audit_caller_credential_invalid",
                "message": "当前调用人的 TChouse-C 凭证无法用于权限审计",
                "permission_scope": "ck_access_consistency_audit",
            }

    @staticmethod
    def _with_result_class(response: dict[str, Any], result_class: str) -> dict[str, Any]:
        response["result_class"] = result_class
        response["verdict"] = "inconclusive"
        return response

    def _is_trusted_human_or_schedule(self, audit_context: AuditContext | None) -> bool:
        detail = self._audit_detail(audit_context)
        # `schedule_creator` is the forward-compatible Botmux scheduled-turn leg.
        # On the current Barry host it is unreachable until the runtime includes
        # the upstream commits that inject caller source/task id.
        return detail["sender_type"] == "user" or (
            detail["caller_source"] == "schedule_creator" and bool(detail["task_id"])
        )

    def _redact_validation_schema_detail(
        self,
        response: dict[str, Any],
        audit_context: AuditContext | None,
    ) -> dict[str, Any]:
        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "datasource": response.get("datasource"),
            "schema_detail_redacted": True,
            "permission_scope": "user_identity",
            "issues": [
                ValidationIssue(
                    code="trusted_human_or_schedule_required",
                    severity="error",
                    message=(
                        "validate_sql_for_user 在非受信任真实用户或定时任务来源下不会返回"
                        "表权限、表名、列名或 SQL 归一化结果"
                    ),
                    suggested_action=(
                        "请由真实用户重新触发；旧宿主 sender_type=unknown_legacy 时 "
                        "validate 只返回固定拒绝形态"
                    ),
                ).model_dump()
            ],
            "audit_context": self._audit_detail(audit_context),
        }

    def _caller_policy_error(self, message: str) -> dict[str, Any]:
        return {
            "status": Status.VALIDATION_ERROR,
            "result_class": "policy_error",
            "message": message,
            "issues": [
                ValidationIssue(
                    code="trusted_human_or_schedule_required",
                    severity="error",
                    message="查询/导出工具只允许 sender_type=user，或 caller_source=schedule_creator 且 caller_task_id 非空",
                    suggested_action="请由真实用户重新触发；旧宿主 sender_type=unknown_legacy 时不会执行明细查询或导出",
                ).model_dump()
            ],
            "permission_scope": "user_identity",
        }

    def _audit_rejected_caller(
        self,
        event_type: str,
        request_user_union_id: str,
        request_user_open_id: str | None,
        request_lark_app_id: str | None,
        audit_context: AuditContext | None,
        policy_error: dict[str, Any],
    ) -> None:
        audit_logger.emit(
            AuditEvent(
                event_type=event_type,
                union_id=(request_user_union_id or "").strip() or None,
                feishu_user_id=request_user_open_id.strip() if request_user_open_id else None,
                lark_app_id=request_lark_app_id.strip() if request_lark_app_id else None,
                email=None,
                status=Status.VALIDATION_ERROR,
                detail={
                    "issue_codes": [
                        issue.get("code")
                        for issue in policy_error.get("issues", [])
                        if isinstance(issue, dict)
                    ],
                    **self._audit_detail(audit_context),
                },
            )
        )

    def _audit_detail(self, audit_context: AuditContext | None) -> dict[str, str | None]:
        context = audit_context or {}
        sender_type = _clean_string(context.get("sender_type")) or "unknown_legacy"
        return {
            "sender_type": sender_type,
            "session_id": _clean_string(context.get("session_id")),
            "task_id": _clean_string(context.get("task_id")),
            "turn_id": _clean_string(context.get("turn_id")),
            "captured_at": _clean_string(context.get("captured_at")),
            "caller_source": _clean_string(context.get("caller_source")),
            "trust_domain": _clean_string(context.get("trust_domain")),
            "amber_cmd": _clean_string(context.get("amber_cmd")),
            "amber_rev": _clean_string(context.get("amber_rev")),
            "amber_run": _clean_string(context.get("amber_run")),
            "amber_channel": _clean_string(context.get("amber_channel")),
            "amber_jti_ref": _clean_string(context.get("amber_jti_ref")),
            "amber_call": _clean_string(context.get("amber_call")),
            "query_max_rows": _clean_string(context.get("query_max_rows")),
        }

    def _query_max_rows(self, audit_context: AuditContext | None) -> int | None:
        value = self._audit_detail(audit_context).get("query_max_rows")
        if not value:
            return None
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed > 0 else None


def _safe_export_error_message(error_code: str) -> str:
    if error_code == "missing_export_outbox_dir":
        return "Data MCP 导出服务未配置本机 outbox 目录"
    if error_code == "invalid_export_filename":
        return "Excel 导出文件名无效"
    if error_code == "export_file_size_limit_exceeded":
        return "Excel 已生成，但文件超过当前导出大小上限"
    if error_code in {"local_export_write_failed", "local_export_size_mismatch"}:
        return "Excel 已生成，但写入本机导出目录失败"
    return "Excel 导出失败"


def _query_plan_audit_ref(query_plan_id: str | None) -> str | None:
    if not isinstance(query_plan_id, str) or not query_plan_id.strip():
        return None
    return hashlib.sha256(query_plan_id.strip().encode("utf-8")).hexdigest()[:16]


def _account_audit_ref(account: str) -> str | None:
    normalized = account.strip().lower()
    if not normalized:
        return None
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _export_sql_account_binding(binding: Any) -> dict[str, Any] | None:
    if not isinstance(binding, dict):
        return None
    exported = {
        "datasource": binding.get("datasource"),
        "tables": binding.get("tables", []),
        "resolved_by": binding.get("resolved_by"),
        "account_bound": bool(binding.get("account_bound") or binding.get("tchouse_account")),
    }
    if "unresolved_reason" in binding:
        exported["unresolved_reason"] = binding.get("unresolved_reason")
    return exported


def _credential_resolution_source(credential: CredentialRef) -> str:
    if credential.datasource == "tchouse-d":
        return "configured_env_credential"
    return "mcp_union_id_mapping"


def _clean_string(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
