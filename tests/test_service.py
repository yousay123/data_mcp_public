import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.credentials.base import CredentialMappingUnavailable
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.models.contracts import CredentialRef, Status
from ksher_agent_data_mcp.tools import service as service_module
from ksher_agent_data_mcp.tools.service import DataMcpService

SMOKE_TEST_SQL = (
    "SELECT count() AS cnt FROM analytics.metadata_dictionary "
    "WHERE ds = (SELECT max(ds) FROM analytics.metadata_dictionary)"
)
APP_ID = "cli_example"
SESSION_ID = "session_example"
HUMAN_AUDIT_CONTEXT = {"sender_type": "user", "session_id": SESSION_ID}


def issue_plan(
    service: DataMcpService,
    sql: str,
    datasource: str = "tchouse-c",
    union_id: str = "on_example_user",
) -> str:
    return service.query_plans.issue(
        union_id,
        sql,
        datasource,
        session_id=SESSION_ID,
        lark_app_id=APP_ID,
    )


def _validation_with_resolution_failure(monkeypatch, failure: Exception, datasource: str):
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="tchouse_c", CREDENTIAL_PROVIDER="memory"))
    )

    def fail_resolution(user, requested_datasource):
        assert requested_datasource == datasource
        raise failure

    monkeypatch.setattr(service.container.credentials, "resolve", fail_resolution)
    return service.validate_sql_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
        datasource=datasource,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )


def test_validate_sql_for_user_accepts_indicator_dictionary_table(monkeypatch) -> None:
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )
    monkeypatch.setattr(
        service,
        "_resolve_validation_credential",
        lambda *args, **kwargs: CredentialRef(
            user_union_id="on_example_user",
            datasource="tchouse-c",
            tchouse_account="demo_tchouse_user",
            jdbc_url="clickhouse://example.internal:9440",
            password_secret_ref="memory://demo",
        ),
    )

    result = service.validate_sql_for_user(
        "on_example_user",
        "ou_example_user",
        SMOKE_TEST_SQL,
        request_lark_app_id=APP_ID,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert result["tables"] == ["analytics.metadata_dictionary"]
    assert result["sql_account_binding"] == {
        "datasource": "tchouse-c",
        "tables": ["analytics.metadata_dictionary"],
        "resolved_by": "mcp_union_id_mapping",
        "account_bound": True,
    }
    assert "demo_tchouse_user" not in str(result)
    assert "on_example_user" not in str(result)
    assert "tchouse_account" not in result["sql_account_binding"]


def test_validate_sql_for_user_rejects_indicator_dictionary_without_partition() -> None:
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )

    result = service.validate_sql_for_user(
        "on_example_user",
        "ou_example_user",
        "SELECT count() AS cnt FROM analytics.metadata_dictionary",
        request_lark_app_id=APP_ID,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert any(issue["code"] == "missing_partition_filter" for issue in result["issues"])


def test_run_query_for_user_uses_supplied_verified_identity() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
        query_plan_id=issue_plan(service, SMOKE_TEST_SQL),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert result["datasource"] == "tchouse-c"
    assert result["tables"] == ["analytics.metadata_dictionary"]
    assert result["sql_account_binding"] == {
        "datasource": "tchouse-c",
        "tables": ["analytics.metadata_dictionary"],
        "resolved_by": "mcp_union_id_mapping",
        "account_bound": True,
    }
    assert "demo_tchouse_user" not in str(result)
    assert "on_example_user" not in str(result["sql_account_binding"])


def test_run_query_for_user_rejects_mismatched_tchouse_account() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        request_user_tchouse_account="other_user",
        sql=SMOKE_TEST_SQL,
        query_plan_id=issue_plan(service, SMOKE_TEST_SQL),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert any(issue["code"] == "account_mismatch" for issue in result["issues"])


def test_run_query_for_user_accepts_matching_tchouse_account() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        request_user_tchouse_account="demo_tchouse_user",
        sql=SMOKE_TEST_SQL,
        query_plan_id=issue_plan(service, SMOKE_TEST_SQL),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert result["sql_account_binding"]["account_bound"] is True
    assert "tchouse_account" not in result["sql_account_binding"]


def test_run_query_for_user_rejects_missing_union_id() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id=" ",
        request_user_open_id="ou_example_user",
        sql=SMOKE_TEST_SQL,
        query_plan_id="",
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert any(issue["code"] == "missing_union_id" for issue in result["issues"])


def test_validate_sql_for_user_rejects_missing_union_id() -> None:
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )

    result = service.validate_sql_for_user(
        request_user_union_id=" ",
        request_user_open_id="ou_example_user",
        sql=SMOKE_TEST_SQL,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert any(issue["code"] == "missing_union_id" for issue in result["issues"])


def test_validate_sql_for_user_does_not_cache_identity(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )

    first = service.validate_sql_for_user(
        request_user_union_id="on_first_user",
        request_user_open_id="ou_first_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )
    second = service.validate_sql_for_user(
        request_user_union_id="on_second_user",
        request_user_open_id="ou_second_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert first["status"] == Status.SUCCESS
    assert second["status"] == Status.SUCCESS
    assert [event.union_id for event in events] == ["on_first_user", "on_second_user"]
    assert [event.feishu_user_id for event in events] == ["ou_first_user", "ou_second_user"]


def test_validate_sql_for_user_audits_lark_app_id(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )

    result = service.validate_sql_for_user(
        request_user_union_id=" on_example_user ",
        request_user_open_id=" ou_example_user ",
        request_lark_app_id=" cli_example ",
        sql=SMOKE_TEST_SQL,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert events
    assert events[0].union_id == "on_example_user"
    assert events[0].feishu_user_id == "ou_example_user"
    assert events[0].lark_app_id == "cli_example"


def test_validate_sql_for_user_audits_caller_context(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )

    result = service.validate_sql_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id="cli_example",
        sql=SMOKE_TEST_SQL,
        audit_context={
            "caller_source": "schedule_creator",
            "sender_type": "bot",
            "session_id": SESSION_ID,
            "task_id": "task_123",
            "captured_at": "2026-09-01T10:00:00Z",
        },
    )

    assert result["status"] == Status.SUCCESS
    assert events[0].detail["caller_source"] == "schedule_creator"
    assert events[0].detail["sender_type"] == "bot"
    assert events[0].detail["task_id"] == "task_123"
    assert events[0].detail["captured_at"] == "2026-09-01T10:00:00Z"


def test_run_query_for_user_rejects_explicit_bot_without_schedule(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="memory", CREDENTIAL_PROVIDER="memory"))
    )

    result = service.run_query_for_user(
        request_user_union_id="on_bot_user",
        request_user_open_id="ou_bot_user",
        sql=SMOKE_TEST_SQL,
        query_plan_id="",
        audit_context={"sender_type": "bot"},
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert any(issue["code"] == "trusted_human_or_schedule_required" for issue in result["issues"])
    assert events
    assert events[0].detail["sender_type"] == "bot"


def test_run_query_for_user_rejects_unknown_legacy_identity(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = DataMcpService(
        build_container(
            Settings(
                METADATA_PROVIDER="memory",
                CREDENTIAL_PROVIDER="memory",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id="on_legacy_sender",
        request_user_open_id="ou_legacy_sender",
        sql=SMOKE_TEST_SQL,
        query_plan_id="",
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert any(issue["code"] == "trusted_human_or_schedule_required" for issue in result["issues"])
    assert events[0].detail["sender_type"] == "unknown_legacy"


def test_validate_sql_for_user_redacts_schema_detail_for_unknown_legacy_sender() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
            )
        )
    )

    result = service.validate_sql_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert result["schema_detail_redacted"] is True
    assert result["permission_scope"] == "user_identity"
    assert [issue["code"] for issue in result["issues"]] == [
        "trusted_human_or_schedule_required"
    ]
    assert "table_access_allowed" not in result
    assert "tables" not in result
    assert "columns" not in result
    assert "normalized_sql" not in result
    assert "sql_account_binding" not in result


def test_run_query_for_user_allows_schedule_creator_with_task_id() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
        audit_context={
            "caller_source": "schedule_creator",
            "sender_type": "bot",
            "session_id": SESSION_ID,
            "task_id": "task_123",
        },
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            SMOKE_TEST_SQL,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
            task_id="task_123",
        ),
    )

    assert result["status"] == Status.SUCCESS


def test_run_query_for_user_returns_not_found_when_credential_mapping_missing() -> None:
    service = DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )

    result = service.run_query_for_user(
        request_user_union_id="on_missing_user",
        request_user_open_id="ou_missing_user",
        request_lark_app_id=APP_ID,
        sql=SMOKE_TEST_SQL,
        query_plan_id=issue_plan(service, SMOKE_TEST_SQL, union_id="on_missing_user"),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.NOT_FOUND
    assert "账号映射" in result["message"]
    assert result["issues"][0]["code"] == "account_mapping_unavailable"
    assert result["sql_account_binding"]["unresolved_reason"] == "account_mapping_unavailable"


def test_validation_reports_account_mapping_unavailable(monkeypatch) -> None:
    result = _validation_with_resolution_failure(
        monkeypatch,
        CredentialMappingUnavailable("tchouse-c"),
        "tchouse-c",
    )

    assert result["status"] == Status.NOT_FOUND
    assert result["issues"][0]["code"] == "account_mapping_unavailable"
    assert result["sql_account_binding"] == {
        "datasource": "tchouse-c",
        "tables": [],
        "resolved_by": None,
        "account_bound": False,
        "unresolved_reason": "account_mapping_unavailable",
    }


@pytest.mark.parametrize("operation", ["validate", "run", "export"])
def test_public_query_entry_rejects_tchouse_d_before_credential_resolution(
    monkeypatch, operation: str
) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = DataMcpService(
        build_container(Settings(METADATA_PROVIDER="tchouse_c", CREDENTIAL_PROVIDER="memory"))
    )
    resolver_calls = 0

    def record_resolution(*args, **kwargs):
        nonlocal resolver_calls
        resolver_calls += 1
        raise AssertionError("public datasource allowlist must run before credentials.resolve")

    monkeypatch.setattr(service.container.credentials, "resolve", record_resolution)
    common = {
        "request_user_union_id": "on_example_user",
        "request_user_open_id": "ou_example_user",
        "request_lark_app_id": APP_ID,
        "sql": SMOKE_TEST_SQL,
        "datasource": "tchouse-d",
        "audit_context": HUMAN_AUDIT_CONTEXT,
    }
    unsupported_plan = service.query_plans.issue(
        "on_example_user",
        SMOKE_TEST_SQL,
        "tchouse-d",
        session_id=SESSION_ID,
        lark_app_id=APP_ID,
    )
    if operation == "validate":
        result = service.validate_sql_for_user(**common)
    elif operation == "run":
        result = service.run_query_for_user(**common, query_plan_id=unsupported_plan)
    else:
        result = service.export_query_to_excel_file(**common, query_plan_id=unsupported_plan)

    assert result["status"] == Status.VALIDATION_ERROR
    assert result["issues"][0]["code"] == "unsupported_datasource"
    assert resolver_calls == 0
    rejection_events = [event for event in events if event.event_type == "query_plan_rejected"]
    assert len(rejection_events) == 1
    assert rejection_events[0].detail["issue_codes"] == ["unsupported_datasource"]
