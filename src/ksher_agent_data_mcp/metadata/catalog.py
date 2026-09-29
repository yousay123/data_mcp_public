from abc import ABC, abstractmethod
from urllib.error import HTTPError

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db.query_executor import (
    execute_clickhouse_json,
    parse_clickhouse_jdbc_url,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef, TableMeta


class MetadataAccessDenied(Exception):
    """The current database account cannot access a table."""


class MetadataLookupError(Exception):
    """The catalog could not complete a metadata lookup."""


class MetadataCatalog(ABC):
    @abstractmethod
    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        """Return allowed TChouse-C table metadata."""

    @abstractmethod
    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        """Return nearby allowed tables for user-facing clarification."""


class MemoryMetadataCatalog(MetadataCatalog):
    def __init__(self, tables: list[TableMeta] | None = None) -> None:
        self._tables = {_table_key(table.full_name): table for table in tables or _default_tables()}

    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        return self._tables.get(_table_key(full_name))

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        tokens = _table_tokens(full_name)
        if not tokens:
            return list(self._tables.values())[:limit]

        scored: list[tuple[int, TableMeta]] = []
        for table in self._tables.values():
            haystack = f"{table.full_name} {table.description or ''}".lower()
            score = sum(1 for token in tokens if token in haystack)
            if score:
                scored.append((score, table))

        return [table for _, table in sorted(scored, key=lambda row: row[0], reverse=True)[:limit]]


class TChouseCMetadataCatalog(MetadataCatalog):
    """Probe table access from TChouse-C with the current user's credential."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._cache: dict[tuple[str, str, str], TableMeta | None] = {}

    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        if credential is None or credential.datasource != "tchouse-c":
            raise MetadataAccessDenied("missing TChouse-C credential")

        database, table = _split_table_name(full_name, credential)
        cache_key = (credential.tchouse_account, database, table)
        if cache_key in self._cache:
            return self._cache[cache_key]

        target = parse_clickhouse_jdbc_url(credential.jdbc_url)
        sql = f"SELECT 1 FROM {_identifier(database)}.{_identifier(table)} LIMIT 0"
        try:
            execute_clickhouse_json(
                target=target,
                sql=sql,
                query_id="metadata_probe_table",
                timeout_seconds=min(self.settings.query_timeout_seconds, 15),
            )
        except HTTPError as exc:
            message = _read_http_error(exc)
            raise MetadataAccessDenied(message) from exc
        except Exception as exc:
            raise MetadataLookupError(str(exc)) from exc

        meta = TableMeta(database=database, table=table)
        self._cache[cache_key] = meta
        return meta

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        if credential is None or credential.datasource != "tchouse-c":
            return []

        target = parse_clickhouse_jdbc_url(credential.jdbc_url)
        tokens = _table_tokens(full_name)
        if not tokens:
            return []

        predicates = [
            f"(database ILIKE {_quote(f'%{token}%')} OR name ILIKE {_quote(f'%{token}%')})"
            for token in tokens[:4]
        ]
        sql = (
            "SELECT database, name AS table "
            "FROM system.tables "
            f"WHERE {' OR '.join(predicates)} "
            f"ORDER BY database, name LIMIT {limit}"
        )
        try:
            payload = execute_clickhouse_json(
                target=target,
                sql=sql,
                query_id="metadata_suggest_tables",
                timeout_seconds=min(self.settings.query_timeout_seconds, 15),
            )
        except Exception:
            return []

        return [
            TableMeta(database=str(row.get("database")), table=str(row.get("table")))
            for row in payload.get("data", [])
            if row.get("database") and row.get("table")
        ]


def _default_tables() -> list[TableMeta]:
    return [
        TableMeta(
            database="analytics",
            table="metadata_dictionary",
            description="数仓元数据字典明细表",
            partition_fields=["ds"],
            columns=[
                {"name": "type_classify", "type": "Nullable(String)"},
                {"name": "source_type", "type": "Nullable(String)"},
                {"name": "biz_domain", "type": "Nullable(String)"},
                {"name": "database_name", "type": "Nullable(String)"},
                {"name": "table_name", "type": "String"},
                {"name": "table_comment", "type": "Nullable(String)"},
                {"name": "column_name", "type": "String"},
                {"name": "column_comment", "type": "Nullable(String)"},
                {"name": "biz_definition", "type": "Nullable(String)"},
                {"name": "sensitive_level", "type": "Nullable(String)"},
                {"name": "ds", "type": "String"},
            ],
        ),
        TableMeta(
            database="analytics",
            table="merchant_dimension",
            description="商户维度表",
            columns=[
                {"name": "merchant_id", "type": "String"},
            ],
        ),
        TableMeta(
            database="analytics",
            table="merchant_shop_dimension",
            description="商户&账户-商户店铺维度表",
            columns=[
                {"name": "merchant_code", "type": "String"},
                {"name": "shop_id", "type": "String"},
                {"name": "shop_no", "type": "String"},
                {"name": "shop_name", "type": "String"},
                {"name": "status", "type": "String"},
                {"name": "business_scope", "type": "String"},
                {"name": "agency_group", "type": "String"},
                {"name": "agent_name", "type": "String"},
                {"name": "bd_name", "type": "String"},
                {"name": "create_time", "type": "DateTime"},
                {"name": "update_time", "type": "DateTime"},
            ],
        ),
        TableMeta(
            database="dwd",
            table="dwd_payment_order_di",
            description="支付订单明细日分区表",
            partition_fields=["dt"],
            columns=[
                {"name": "dt", "type": "String"},
                {"name": "merchant_id", "type": "String"},
                {"name": "order_id", "type": "String", "sensitive": True},
                {"name": "status", "type": "String"},
                {"name": "amount", "type": "Decimal(18,2)"},
                {"name": "channel", "type": "String"},
            ],
        ),
    ]


def _table_key(full_name: str) -> str:
    return full_name.lower()


def _table_tokens(full_name: str) -> list[str]:
    return [token for token in full_name.lower().replace(".", "_").split("_") if token]


def _split_table_name(full_name: str, credential: CredentialRef) -> tuple[str, str]:
    parts = [part.strip("` ").lower() for part in full_name.split(".") if part.strip("` ")]
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    target = parse_clickhouse_jdbc_url(credential.jdbc_url)
    return target.database.lower(), parts[0]


def _quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _identifier(value: str) -> str:
    return "`" + value.replace("`", "``") + "`"


def _read_http_error(exc: HTTPError) -> str:
    body = exc.read().decode("utf-8", errors="replace")
    first_line = body.strip().splitlines()[0] if body.strip() else str(exc.reason)
    return first_line
