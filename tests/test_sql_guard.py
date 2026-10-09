import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from urllib.error import HTTPError, URLError

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db import sql_guard as sql_guard_module
from ksher_agent_data_mcp.db.sql_guard import SqlGuard
from ksher_agent_data_mcp.metadata.catalog import (
    MemoryMetadataCatalog,
    MetadataAccessDenied,
    MetadataCatalog,
    TChouseCMetadataCatalog,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef, Status, TableMeta, UserContext


def _guard(require_partition_filter: bool = True) -> SqlGuard:
    settings = Settings(
        REQUIRE_PARTITION_FILTER=require_partition_filter,
        DEFAULT_LIMIT=100,
    )
    return SqlGuard(
        settings=settings,
        catalog=MemoryMetadataCatalog(),
    )


def _user() -> UserContext:
    return UserContext(
        union_id="on_example_user",
        feishu_user_id="ou_example_user",
    )


def _credential() -> CredentialRef:
    return CredentialRef(
        user_union_id="on_example_user",
        user_email="demo@example.com",
        tchouse_account="demo_user",
        jdbc_url=(
            "jdbc:clickhouse://tchouse-c.example.invalid:8123/example_db;"
            "user=demo_user;password=demo_password"
        ),
        password_secret_ref="secret://demo",
        datasource="tchouse-c",
    )


def _clickhouse_http_error(
    error_name: str,
    *,
    password: str | None = None,
    http_status: int = 500,
    detail: str = "simulated failure",
) -> HTTPError:
    detail = f"DB::Exception: {detail} ({error_name}) (version 23.8.9.1)"
    if password is not None:
        detail = f"DB::Exception: leaked password {password} ({error_name}) (version 23.8.9.1)"
    return HTTPError(
        url="http://clickhouse/",
        code=http_status,
        msg="Internal Server Error",
        hdrs=None,
        fp=BytesIO(detail.encode("utf-8")),
    )


def _query_probe_result(monkeypatch, failure: Exception):
    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        raise failure

    monkeypatch.setattr(sql_guard_module, "execute_clickhouse_json", fake_execute_clickhouse_json)
    guard = SqlGuard(
        settings=Settings(METADATA_PROVIDER="tchouse_c", REQUIRE_PARTITION_FILTER=False),
        catalog=DenyingTChouseCMetadataCatalog(),
    )
    return guard.validate(
        _user(),
        "SELECT * FROM analytics.payment_order_daily LIMIT 1",
        credential=_credential(),
    )


class CredentialAwareCatalog(MetadataCatalog):
    def __init__(self) -> None:
        self.seen_credentials: list[CredentialRef | None] = []

    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        self.seen_credentials.append(credential)
        if full_name == "analytics.payment_order_daily" and credential is not None:
            return TableMeta(database="analytics", table="payment_order_daily")
        return None

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        return []


class AccessDeniedCatalog(MetadataCatalog):
    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        raise MetadataAccessDenied("not enough privileges")

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        return []


class SlowCredentialAwareCatalog(MetadataCatalog):
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active = 0
        self.max_active = 0

    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        with self._lock:
            self._active += 1
            self.max_active = max(self.max_active, self._active)
        try:
            time.sleep(0.05)
            return TableMeta(database=full_name.split(".")[0], table=full_name.split(".")[1])
        finally:
            with self._lock:
                self._active -= 1

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        return []


class RequiresCredentialCatalog(MetadataCatalog):
    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        if credential is None:
            raise MetadataAccessDenied("missing credential")
        return TableMeta(database=full_name.split(".")[0], table=full_name.split(".")[1])

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        return []


class DenyingTChouseCMetadataCatalog(TChouseCMetadataCatalog):
    def __init__(self) -> None:
        super().__init__(Settings())
        self.describe_called = False

    def describe_table(
        self, full_name: str, credential: CredentialRef | None = None
    ) -> TableMeta | None:
        self.describe_called = True
        raise MetadataAccessDenied("per-table probe denied")

    def suggest_tables(
        self, full_name: str, limit: int = 5, credential: CredentialRef | None = None
    ) -> list[TableMeta]:
        return []


def test_validate_select_injects_limit() -> None:
    result = _guard().validate(
        _user(),
        "select dt, count(*) from dwd.dwd_payment_order_di where dt = '2026-08-03' group by dt",
    )

    assert result.status == Status.SUCCESS
    assert result.normalized_sql is not None
    assert "LIMIT 100" in result.normalized_sql
    assert any(issue.code == "limit_injected" for issue in result.issues)


def test_validate_show_access_is_rejected_by_general_executor() -> None:
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=AccessDeniedCatalog(),
    )

    result = guard.validate(_user(), "SHOW ACCESS", credential=_credential())

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "restricted_access_metadata" for issue in result.issues)


def test_validate_show_grants_is_rejected_by_general_executor() -> None:
    result = _guard(require_partition_filter=False).validate(
        _user(),
        "SHOW GRANTS FOR arry_kangzhiping",
        credential=_credential(),
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "restricted_access_metadata" for issue in result.issues)


def test_validate_show_table_metadata_remains_available() -> None:
    guard = _guard(require_partition_filter=False)
    for sql in (
        "SHOW DATABASES",
        "SHOW TABLES",
        "SHOW COLUMNS FROM demo.orders",
        "SHOW CREATE TABLE demo.orders",
        "SHOW CREATE VIEW demo.orders_view",
        "SHOW FUNCTIONS",
    ):
        result = guard.validate(_user(), sql)
        assert result.status == Status.SUCCESS, sql


def test_rejects_settings_clause_in_every_select_scope() -> None:
    guard = _guard(require_partition_filter=False)
    for sql in (
        "SELECT 1 SETTINGS max_memory_usage=1",
        "SELECT * FROM (SELECT 1 SETTINGS max_memory_usage=1)",
        "WITH q AS (SELECT 1 SETTINGS max_memory_usage=1) SELECT * FROM q",
        "SELECT 1 UNION ALL SELECT 2 SETTINGS max_memory_usage=1",
        "SELECT 1 WHERE 1 IN (SELECT 1 SETTINGS max_memory_usage=1)",
        "SELECT 1 SETTINGS max_memory_usage=1 FORMAT JSON",
        "(SELECT 1) SETTINGS max_result_rows=0",
        "(SELECT 1 UNION ALL SELECT 2) SETTINGS max_result_rows=0",
        "SELECT 1 UNION ALL (SELECT 2) SETTINGS max_result_rows=0",
        "(SELECT 1) UNION ALL (SELECT 2) SETTINGS max_result_rows=0",
    ):
        result = guard.validate(_user(), sql)

        assert result.status == Status.VALIDATION_ERROR, sql
        assert result.normalized_sql is None
        assert any(issue.code == "query_settings_not_allowed" for issue in result.issues)


def test_rejects_settings_clause_in_show_commands() -> None:
    guard = _guard(require_partition_filter=False)
    for sql in (
        "SHOW TABLES FROM dwd SETTINGS max_threads=1",
        "SHOW CREATE TABLE x SETTINGS max_execution_time=999",
        "SHOW TABLES SETTINGS /* comment */ max_threads = 1",
        "SHOW TABLES FROM dwd SETTINGS `max_threads`=1",
        'SHOW TABLES FROM dwd SETTINGS "max_threads"=1',
    ):
        result = guard.validate(_user(), sql)

        assert result.status == Status.VALIDATION_ERROR, sql
        assert result.normalized_sql is None
        assert any(issue.code == "query_settings_not_allowed" for issue in result.issues)


def test_settings_word_in_identifiers_strings_and_comments_is_not_rejected() -> None:
    guard = _guard(require_partition_filter=False)
    for sql in (
        "SELECT 1 AS settings",
        "SELECT 'SETTINGS max_memory_usage=1' AS note",
        "SELECT 1 /* SETTINGS max_memory_usage=1 */ AS value",
        "SHOW TABLES LIKE '%settings%'",
        "SHOW TABLES /* SETTINGS max_threads=1 */",
        "SHOW CREATE TABLE settings",
        "SHOW CREATE TABLE `settings`",
        'SHOW CREATE TABLE "settings"',
    ):
        result = guard.validate(_user(), sql)

        assert not any(issue.code == "query_settings_not_allowed" for issue in result.issues), sql

    table_result = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=SlowCredentialAwareCatalog(),
    ).validate(_user(), "SELECT value FROM demo.settings LIMIT 1")
    assert table_result.status == Status.SUCCESS


def test_blocks_non_show_command() -> None:
    result = _guard(require_partition_filter=False).validate(_user(), "EXPLAIN SELECT 1")

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "not_select" for issue in result.issues)


def test_blocks_show_plus_second_statement() -> None:
    result = _guard(require_partition_filter=False).validate(_user(), "SHOW ACCESS; SELECT 1")

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "multiple_statements" for issue in result.issues)


def test_blocks_delete() -> None:
    result = _guard().validate(
        _user(), "delete from dwd.dwd_payment_order_di where dt='2026-08-03'"
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code in {"not_select", "dangerous_statement"} for issue in result.issues)


def test_requires_partition_filter() -> None:
    result = _guard().validate(_user(), "select count(*) from dwd.dwd_payment_order_di")

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "missing_partition_filter" for issue in result.issues)


def test_blocks_unknown_table() -> None:
    result = _guard(require_partition_filter=False).validate(
        _user(), "select * from dwd.unknown_table"
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "unknown_table" for issue in result.issues)


def test_unknown_table_suggests_nearby_candidates() -> None:
    result = _guard(require_partition_filter=False).validate(
        _user(),
        "select * from analytics.s_indicator_dict_details",
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(
        "metadata_dictionary" in (issue.suggested_action or "") for issue in result.issues
    )


def test_dynamic_catalog_receives_user_credential() -> None:
    catalog = CredentialAwareCatalog()
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=catalog,
    )

    result = guard.validate(
        _user(),
        "SELECT toTypeName(stl_finished_time) FROM analytics.payment_order_daily LIMIT 1",
        credential=_credential(),
    )

    assert result.status == Status.SUCCESS
    assert result.tables == ["analytics.payment_order_daily"]
    assert catalog.seen_credentials == [_credential()]


def test_cte_alias_is_not_checked_as_physical_table() -> None:
    catalog = CredentialAwareCatalog()
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=catalog,
    )

    result = guard.validate(
        _user(),
        """
        WITH base AS (
          SELECT stl_finished_time
          FROM analytics.payment_order_daily
          WHERE toDate(stl_finished_time) >= toDate('2026-08-01')
        )
        SELECT toTypeName(stl_finished_time) AS t
        FROM base
        LIMIT 1
        """,
        credential=_credential(),
    )

    assert result.status == Status.SUCCESS
    assert result.tables == ["analytics.payment_order_daily"]
    assert catalog.seen_credentials == [_credential()]


def test_multiple_cte_aliases_are_not_checked_as_physical_tables() -> None:
    catalog = SlowCredentialAwareCatalog()
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=catalog,
    )

    result = guard.validate(
        _user(),
        """
        WITH a AS (
          SELECT id FROM analytics.table_a
        ), b AS (
          SELECT a.id FROM a JOIN analytics.table_b b ON a.id = b.id
        )
        SELECT count() FROM b
        LIMIT 1
        """,
        credential=_credential(),
    )

    assert result.status == Status.SUCCESS
    assert result.tables == ["analytics.table_a", "analytics.table_b"]


def test_clickhouse_table_function_is_rejected_instead_of_checked_as_empty_table() -> None:
    catalog = CredentialAwareCatalog()
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=catalog,
    )

    result = guard.validate(
        _user(),
        "SELECT number FROM numbers(10) LIMIT 1",
        credential=_credential(),
    )

    assert result.status == Status.VALIDATION_ERROR
    assert result.tables == []
    assert any(issue.code == "unsupported_table_function" for issue in result.issues)
    assert not any(issue.code in {"unknown_table", "permission_denied"} for issue in result.issues)
    assert catalog.seen_credentials == []


def test_cluster_and_external_table_functions_remain_rejected() -> None:
    guard = _guard(require_partition_filter=False)
    for sql in (
        "SELECT * FROM clusterAllReplicas('default_cluster', system.grants)",
        "SELECT * FROM remote('127.0.0.1', system, grants)",
        "SELECT * FROM url('https://example.invalid/data.csv')",
        "SELECT * FROM s3('https://example.invalid/object')",
        "SELECT * FROM file('/tmp/data.csv')",
    ):
        result = guard.validate(_user(), sql)
        assert result.status == Status.VALIDATION_ERROR
        assert any(issue.code == "unsupported_table_function" for issue in result.issues)


def test_system_users_rejects_dynamic_projection_and_configuration_columns_in_production_probe(
    monkeypatch,
) -> None:
    monkeypatch.setattr(SqlGuard, "_probe_query_access", lambda *args, **kwargs: [])
    guard = SqlGuard(
        settings=Settings(METADATA_PROVIDER="tchouse_c", REQUIRE_PARTITION_FILTER=False),
        catalog=DenyingTChouseCMetadataCatalog(),
    )
    for sql in (
        "SELECT * FROM system.users",
        "SELECT name, auth_params FROM system.users",
        "SELECT name, host_ip FROM system.users",
        "SELECT COLUMNS('.*') FROM system.users",
        "SELECT COLUMNS('auth') FROM system.users",
        "SELECT * APPLY(toString) FROM system.users",
        "SELECT * EXCEPT (auth_params) FROM system.users",
    ):
        result = guard.validate(_user(), sql, credential=_credential())
        assert result.status == Status.VALIDATION_ERROR
        assert any(issue.code == "restricted_system_columns" for issue in result.issues)


def test_system_users_allows_count_star_without_exposing_columns(monkeypatch) -> None:
    monkeypatch.setattr(SqlGuard, "_probe_query_access", lambda *args, **kwargs: [])
    guard = SqlGuard(
        settings=Settings(METADATA_PROVIDER="tchouse_c", REQUIRE_PARTITION_FILTER=False),
        catalog=DenyingTChouseCMetadataCatalog(),
    )

    result = guard.validate(
        _user(), "SELECT count(*) FROM system.users", credential=_credential()
    )

    assert result.status == Status.SUCCESS


def test_access_system_tables_are_rejected_by_general_executor(monkeypatch) -> None:
    monkeypatch.setattr(SqlGuard, "_probe_query_access", lambda *args, **kwargs: [])
    guard = SqlGuard(
        settings=Settings(METADATA_PROVIDER="tchouse_c", REQUIRE_PARTITION_FILTER=False),
        catalog=DenyingTChouseCMetadataCatalog(),
    )
    for table in (
        "system.current_roles",
        "system.enabled_roles",
        "system.grants",
        "system.quota_limits",
        "system.role_grants",
        "system.row_policy_usage",
        "system.settings_profiles",
        "system.users_directories",
    ):
        result = guard.validate(_user(), f"SELECT * FROM {table}", credential=_credential())
        assert result.status == Status.VALIDATION_ERROR
        assert any(issue.code == "restricted_access_metadata" for issue in result.issues)


def test_show_create_user_is_rejected_by_general_executor() -> None:
    guard = _guard(require_partition_filter=False)
    for sql in (
        "SHOW/*c*/CREATE USER demo",
        "SHOW  CREATE   USER demo",
        "SHOW ACCESS",
        "SHOW GRANTS FOR demo",
        "SHOW CREATE ROLE r",
        "SHOW ROW POLICIES",
    ):
        result = guard.validate(_user(), sql)
        assert result.status == Status.VALIDATION_ERROR, sql
        assert any(issue.code == "restricted_access_metadata" for issue in result.issues)


def test_user_limit_is_capped_to_service_max_rows() -> None:
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False, DEFAULT_LIMIT=100, MAX_ROWS=1000),
        catalog=MemoryMetadataCatalog(),
    )

    result = guard.validate(
        _user(), "SELECT dt FROM dwd.dwd_payment_order_di LIMIT 5000"
    )

    assert result.status == Status.SUCCESS
    assert result.normalized_sql is not None
    assert result.normalized_sql.endswith("LIMIT 1000")
    assert any(issue.code == "limit_capped" for issue in result.issues)


def test_caller_specific_limit_is_stricter_than_service_max_rows() -> None:
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False, DEFAULT_LIMIT=100, MAX_ROWS=1000),
        catalog=MemoryMetadataCatalog(),
    )

    result = guard.validate(
        _user(),
        "SELECT dt FROM dwd.dwd_payment_order_di LIMIT 500",
        max_rows=20,
    )

    assert result.status == Status.SUCCESS
    assert result.normalized_sql is not None
    assert result.normalized_sql.endswith("LIMIT 20")


def test_explicit_service_ceiling_can_raise_only_the_internal_export_limit() -> None:
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False, DEFAULT_LIMIT=100, MAX_ROWS=1000),
        catalog=MemoryMetadataCatalog(),
    )

    normal = guard.validate(
        _user(), "SELECT dt FROM dwd.dwd_payment_order_di LIMIT 100001"
    )
    export = guard.validate(
        _user(),
        "SELECT dt FROM dwd.dwd_payment_order_di LIMIT 100001",
        max_rows_ceiling=100001,
    )

    assert normal.normalized_sql is not None
    assert normal.normalized_sql.endswith("LIMIT 1000")
    assert export.normalized_sql is not None
    assert export.normalized_sql.endswith("LIMIT 100001")

    export_without_limit = guard.validate(
        _user(),
        "SELECT dt FROM dwd.dwd_payment_order_di",
        max_rows_ceiling=100001,
        default_rows=100001,
    )
    assert export_without_limit.normalized_sql is not None
    assert export_without_limit.normalized_sql.endswith("LIMIT 100001")


def test_dynamic_catalog_access_denied_returns_permission_denied() -> None:
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=AccessDeniedCatalog(),
    )

    result = guard.validate(
        _user(),
        "SELECT * FROM analytics.payment_order_daily LIMIT 1",
        credential=_credential(),
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "permission_denied" for issue in result.issues)
    assert not any(issue.code == "unknown_table" for issue in result.issues)


def test_dynamic_catalog_missing_credential_does_not_return_unknown_table() -> None:
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=RequiresCredentialCatalog(),
    )

    result = guard.validate(
        _user(),
        "SELECT * FROM analytics.payment_order_daily LIMIT 1",
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code == "permission_denied" for issue in result.issues)
    assert not any(issue.code == "unknown_table" for issue in result.issues)


def test_multi_table_permission_checks_run_concurrently() -> None:
    catalog = SlowCredentialAwareCatalog()
    guard = SqlGuard(
        settings=Settings(REQUIRE_PARTITION_FILTER=False),
        catalog=catalog,
    )

    result = guard.validate(
        _user(),
        (
            "SELECT * "
            "FROM analytics.table_a a "
            "JOIN analytics.table_b b ON a.id = b.id "
            "JOIN analytics.table_c c ON b.id = c.id "
            "LIMIT 1"
        ),
        credential=_credential(),
    )

    assert result.status == Status.SUCCESS
    assert catalog.max_active > 1


def test_dynamic_catalog_uses_query_level_probe_for_union_all(monkeypatch) -> None:
    catalog = DenyingTChouseCMetadataCatalog()
    seen_sql: list[str] = []

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        seen_sql.append(sql)
        return {"meta": [], "data": [], "rows": 0}

    monkeypatch.setattr(sql_guard_module, "execute_clickhouse_json", fake_execute_clickhouse_json)
    guard = SqlGuard(
        settings=Settings(METADATA_PROVIDER="tchouse_c", REQUIRE_PARTITION_FILTER=False),
        catalog=catalog,
    )

    result = guard.validate(
        _user(),
        """
        SELECT ds, 'bill' AS metric, sum(bill_amount_suc_usd) AS amount
        FROM analytics.billing_detail_daily
        WHERE ds BETWEEN '20260807' AND '20260813'
        GROUP BY ds
        UNION ALL
        SELECT ds, 'wd' AS metric, sum(wd_amount_suc_usd) AS amount
        FROM analytics.payment_order_daily
        WHERE ds BETWEEN '20260807' AND '20260813'
        GROUP BY ds
        UNION ALL
        SELECT ds, 'fx' AS metric, sum(fx_amount_usd) AS amount
        FROM analytics.fx_order_detail_daily
        WHERE ds BETWEEN '20260807' AND '20260813'
          AND fx_order_status_code IN ('settled', 'success')
        GROUP BY ds
        """,
        credential=_credential(),
    )

    assert result.status == Status.SUCCESS
    assert result.tables == [
        "analytics.billing_detail_daily",
        "analytics.fx_order_detail_daily",
        "analytics.payment_order_daily",
    ]
    assert any(issue.code == "limit_injected" for issue in result.issues)
    assert len(seen_sql) == 1
    assert seen_sql[0].startswith("SELECT * FROM (SELECT ds, 'bill' AS metric")
    assert "UNION ALL SELECT ds, 'wd' AS metric" in seen_sql[0]
    assert "UNION ALL SELECT ds, 'fx' AS metric" in seen_sql[0]
    assert seen_sql[0].endswith(") AS _mcp_query_probe LIMIT 0")
    assert catalog.describe_called is False


def test_concurrent_validations_use_distinct_query_probe_ids(monkeypatch) -> None:
    active_query_ids: set[str] = set()
    seen_query_ids: list[str] = []
    lock = threading.Lock()
    both_started = threading.Event()

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        with lock:
            duplicate = query_id in active_query_ids
            seen_query_ids.append(query_id)
            if not duplicate:
                active_query_ids.add(query_id)
            if len(seen_query_ids) == 2:
                both_started.set()

        if duplicate:
            raise _clickhouse_http_error("QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING")

        try:
            assert both_started.wait(timeout=1)
            return {"meta": [], "data": [], "rows": 0}
        finally:
            with lock:
                active_query_ids.remove(query_id)

    monkeypatch.setattr(sql_guard_module, "execute_clickhouse_json", fake_execute_clickhouse_json)
    guard = SqlGuard(
        settings=Settings(METADATA_PROVIDER="tchouse_c", REQUIRE_PARTITION_FILTER=False),
        catalog=DenyingTChouseCMetadataCatalog(),
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                guard.validate,
                _user(),
                "SELECT * FROM analytics.payment_order_daily LIMIT 1",
                credential=_credential(),
            )
            for _ in range(2)
        ]
        results = [future.result() for future in futures]

    assert [result.status for result in results] == [Status.SUCCESS, Status.SUCCESS]
    assert len(seen_query_ids) == 2
    assert len(set(seen_query_ids)) == 2
    assert all(query_id.startswith("metadata_probe_query_") for query_id in seen_query_ids)


def test_query_probe_not_an_aggregate_returns_sql_error(monkeypatch) -> None:
    result = _query_probe_result(monkeypatch, _clickhouse_http_error("NOT_AN_AGGREGATE"))

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "sql_error"
    assert result.issues[0].suggested_action is not None
    assert "修正 SQL" in result.issues[0].suggested_action


def test_query_probe_unknown_identifier_returns_sql_error(monkeypatch) -> None:
    result = _query_probe_result(monkeypatch, _clickhouse_http_error("UNKNOWN_IDENTIFIER"))

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "sql_error"


def test_query_probe_uses_structured_error_name_instead_of_echoed_sql_text(
    monkeypatch,
) -> None:
    result = _query_probe_result(
        monkeypatch,
        _clickhouse_http_error(
            "SYNTAX_ERROR",
            detail=("failed near SELECT 'ACCESS_DENIED', 'not enough privileges' AS marker"),
        ),
    )

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "sql_error"


def test_query_probe_access_denied_returns_permission_denied(monkeypatch) -> None:
    result = _query_probe_result(monkeypatch, _clickhouse_http_error("ACCESS_DENIED"))

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "permission_denied"
    assert result.issues[0].suggested_action is not None
    assert "SELECT 权限" in result.issues[0].suggested_action


def test_query_probe_url_error_returns_datasource_unreachable(monkeypatch) -> None:
    result = _query_probe_result(monkeypatch, URLError("connection refused"))

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "datasource_unreachable"
    assert result.issues[0].suggested_action is not None
    assert "网络" in result.issues[0].suggested_action


def test_query_probe_url_error_does_not_expose_connection_details(monkeypatch) -> None:
    result = _query_probe_result(
        monkeypatch,
        URLError("jdbc:clickhouse://internal.example/db;password=demo_password"),
    )

    assert "jdbc:" not in result.issues[0].message
    assert "internal.example" not in result.issues[0].message
    assert "demo_password" not in result.issues[0].message


def test_query_probe_unknown_clickhouse_error_returns_datasource_error(monkeypatch) -> None:
    result = _query_probe_result(monkeypatch, _clickhouse_http_error("UNKNOWN_TEST_FAILURE"))

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "datasource_error"
    assert result.issues[0].code != "permission_denied"


def test_query_probe_http_403_without_permission_signal_returns_datasource_error(
    monkeypatch,
) -> None:
    result = _query_probe_result(
        monkeypatch,
        _clickhouse_http_error("UNKNOWN_TEST_FAILURE", http_status=403),
    )

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "datasource_error"
    assert result.issues[0].code != "permission_denied"


def test_query_probe_unexpected_exception_returns_internal_error(monkeypatch) -> None:
    result = _query_probe_result(monkeypatch, RuntimeError("simulated implementation failure"))

    assert result.status == Status.VALIDATION_ERROR
    assert result.issues[0].code == "internal_error"
    assert result.issues[0].suggested_action is not None
    assert "维护方" in result.issues[0].suggested_action


def test_query_probe_internal_error_does_not_expose_exception_details(monkeypatch) -> None:
    result = _query_probe_result(
        monkeypatch,
        RuntimeError("jdbc:clickhouse://internal.example/db;password=demo_password"),
    )

    assert "jdbc:" not in result.issues[0].message
    assert "internal.example" not in result.issues[0].message
    assert "demo_password" not in result.issues[0].message


def test_query_probe_http_error_redacts_password(monkeypatch) -> None:
    password = _credential().jdbc_url.rsplit("password=", maxsplit=1)[1]
    result = _query_probe_result(
        monkeypatch,
        _clickhouse_http_error("UNKNOWN_TEST_FAILURE", password=password),
    )

    assert result.status == Status.VALIDATION_ERROR
    assert password not in result.issues[0].message
    assert "***" in result.issues[0].message


def test_blocks_non_tchouse_c_datasource() -> None:
    result = _guard(require_partition_filter=False).validate(
        _user(),
        "select id, query_id from agent_data.query_audit",
        datasource="mysql",
    )

    assert result.status == Status.VALIDATION_ERROR
    assert result.datasource == "mysql"
    assert any(issue.code == "unsupported_datasource" for issue in result.issues)


def test_blocks_create_table() -> None:
    result = _guard(require_partition_filter=False).validate(
        _user(),
        "create table tmp.agent_tmp_result (id String, amount Decimal(18, 2))",
        datasource="tchouse-c",
    )

    assert result.status == Status.VALIDATION_ERROR
    assert any(issue.code in {"not_select", "dangerous_statement"} for issue in result.issues)
