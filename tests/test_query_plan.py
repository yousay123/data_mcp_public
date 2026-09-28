import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.models.contracts import (
    CredentialRef,
    QueryResult,
    ResultClass,
    SqlValidationResult,
    Status,
    ValidationIssue,
)
from ksher_agent_data_mcp.query_plan import QueryPlanStore, RepairChainStore
from ksher_agent_data_mcp.tools import service as service_module
from ksher_agent_data_mcp.tools.service import DataMcpService

SQL = "SELECT 1"
UNION_ID = "on_example_user"
OPEN_ID = "ou_example_user"
DATASOURCE = "tchouse-c"
SESSION_ID = "session_example"
APP_ID = "cli_example"
HUMAN_AUDIT_CONTEXT = {"sender_type": "user", "session_id": SESSION_ID}
SCHEDULE_AUDIT_CONTEXT = {
    "sender_type": "bot",
    "caller_source": "schedule_creator",
    "session_id": SESSION_ID,
    "task_id": "task_example",
    "turn_id": "turn_example",
}


def build_service() -> DataMcpService:
    return DataMcpService(
        build_container(
            Settings(
                CREDENTIAL_PROVIDER="memory",
                CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
                METADATA_PROVIDER="memory",
                QUERY_EXECUTOR="dry_run",
            )
        )
    )


def issue_baseline_plan(
    service: DataMcpService,
    *,
    execution_mode: str = "single",
    task_id: str | None = None,
) -> str:
    return service.query_plans.issue(
        UNION_ID,
        SQL,
        DATASOURCE,
        session_id=SESSION_ID,
        lark_app_id=APP_ID,
        task_id=task_id,
        execution_mode=execution_mode,
    )


def run_with_plan(
    service: DataMcpService,
    query_plan_id: str,
    *,
    union_id: str = UNION_ID,
    sql: str = SQL,
    datasource: str = DATASOURCE,
    app_id: str = APP_ID,
    audit_context: dict | None = None,
) -> dict:
    return service.run_query_for_user(
        request_user_union_id=union_id,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=app_id,
        sql=sql,
        datasource=datasource,
        query_plan_id=query_plan_id,
        audit_context=audit_context or HUMAN_AUDIT_CONTEXT,
    )


def assert_plan_error(result: dict, expected_code: str) -> None:
    assert result["status"] == Status.VALIDATION_ERROR
    assert [issue["code"] for issue in result["issues"]] == [expected_code]
    assert SQL not in str(result)


def test_query_plan_accepts_unchanged_context() -> None:
    service = build_service()
    result = run_with_plan(service, issue_baseline_plan(service))

    assert result["status"] == Status.SUCCESS


def test_validate_issues_compare_plan_with_fixed_server_limits() -> None:
    service = build_service()

    result = service.validate_sql_for_user(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=APP_ID,
        sql=SQL,
        datasource=DATASOURCE,
        execution_mode="compare",
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert result["query_plan_execution_mode"] == "compare"
    assert result["query_plan_max_runs"] == 2
    assert result["query_plan_ttl_seconds"] == 900


def test_validate_requires_session_and_app_before_issuing_plan(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = build_service()

    missing_session = service.validate_sql_for_user(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=APP_ID,
        sql=SQL,
        audit_context={"sender_type": "user"},
    )
    missing_app = service.validate_sql_for_user(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        sql=SQL,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert_plan_error(missing_session, "query_plan_session_required")
    assert_plan_error(missing_app, "query_plan_app_required")
    assert service.query_plans._plans == {}
    rejection_events = [event for event in events if event.event_type == "query_plan_rejected"]
    assert [event.detail["issue_codes"] for event in rejection_events] == [
        ["query_plan_session_required"],
        ["query_plan_app_required"],
    ]


def test_service_rejects_invalid_execution_mode_without_key_error() -> None:
    service = build_service()

    result = service.validate_sql_for_user(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=APP_ID,
        sql=SQL,
        execution_mode="triple",
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert_plan_error(result, "query_plan_execution_mode_invalid")


def test_human_plan_ignores_task_id_at_issue_time() -> None:
    service = build_service()
    validation = service.validate_sql_for_user(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=APP_ID,
        sql=SQL,
        audit_context={
            "sender_type": "user",
            "session_id": SESSION_ID,
            "task_id": "task_human_noise",
        },
    )

    result = run_with_plan(service, validation["query_plan_id"])

    assert result["status"] == Status.SUCCESS


def test_human_plan_ignores_task_id_at_consume_time() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    result = run_with_plan(
        service,
        plan_id,
        audit_context={
            "sender_type": "user",
            "session_id": SESSION_ID,
            "task_id": "task_human_noise",
        },
    )

    assert result["status"] == Status.SUCCESS


def test_bot_validate_does_not_issue_query_plan() -> None:
    service = build_service()

    result = service.validate_sql_for_user(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=APP_ID,
        sql=SQL,
        datasource=DATASOURCE,
        audit_context={"sender_type": "bot"},
    )

    assert "query_plan_id" not in result
    assert service.query_plans._plans == {}


def test_query_plan_rejects_missing_id_only() -> None:
    service = build_service()
    issued_plan_id = issue_baseline_plan(service)

    result = run_with_plan(service, "")

    assert issued_plan_id in service.query_plans._plans
    assert_plan_error(result, "query_plan_required")


def test_export_query_plan_rejects_missing_id_only() -> None:
    service = build_service()
    issued_plan_id = issue_baseline_plan(service)

    result = service.export_query_to_excel_file(
        request_user_union_id=UNION_ID,
        request_user_open_id=OPEN_ID,
        request_lark_app_id=APP_ID,
        sql=SQL,
        datasource=DATASOURCE,
        query_plan_id="",
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert issued_plan_id in service.query_plans._plans
    assert_plan_error(result, "query_plan_required")


def test_query_plan_rejects_expired_plan_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)
    service.query_plans._plans[plan_id].issued_at = (
        time.time() - service.query_plans.ttl_seconds - 1
    )

    result = run_with_plan(service, plan_id)

    assert_plan_error(result, "query_plan_not_found_or_expired")


def test_query_plan_rejects_changed_union_id_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    result = run_with_plan(service, plan_id, union_id="on_other_user")

    assert_plan_error(result, "query_plan_identity_mismatch")


def test_query_plan_rejects_one_character_sql_change_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    result = run_with_plan(service, plan_id, sql=f"{SQL} ")

    assert_plan_error(result, "query_plan_sql_mismatch")


def test_query_plan_rejects_changed_datasource_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    ok, code, _ = service.query_plans.consume_for_run(
        plan_id,
        session_id=SESSION_ID,
        union_id=UNION_ID,
        sql=SQL,
        datasource="tchouse-d",
        lark_app_id=APP_ID,
    )

    assert not ok
    assert code == "query_plan_datasource_mismatch"


def test_query_plan_allows_first_consumer_and_rejects_second() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    first = run_with_plan(service, plan_id)
    second = run_with_plan(service, plan_id)

    assert first["status"] == Status.SUCCESS
    assert_plan_error(second, "query_plan_already_consumed")


def test_query_plan_rejects_unknown_id() -> None:
    service = build_service()

    result = run_with_plan(service, "qplan_missing")

    assert_plan_error(result, "query_plan_not_found_or_expired")


def test_query_plan_rejects_changed_session_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    result = run_with_plan(
        service,
        plan_id,
        audit_context={"sender_type": "user", "session_id": "session_other"},
    )

    assert_plan_error(result, "query_plan_session_mismatch")


def test_query_plan_rejects_changed_app_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service)

    result = run_with_plan(service, plan_id, app_id="cli_other")

    assert_plan_error(result, "query_plan_app_mismatch")


def test_schedule_query_plan_rejects_changed_task_only() -> None:
    service = build_service()
    plan_id = issue_baseline_plan(service, task_id="task_first")

    result = run_with_plan(
        service,
        plan_id,
        audit_context={
            "caller_source": "schedule_creator",
            "sender_type": "bot",
            "session_id": SESSION_ID,
            "task_id": "task_other",
        },
    )

    assert_plan_error(result, "query_plan_task_mismatch")


def test_compare_plan_allows_exactly_two_runs_and_audits_each_run(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = build_service()
    plan_id = issue_baseline_plan(service, execution_mode="compare")

    first = run_with_plan(service, plan_id)
    second = run_with_plan(service, plan_id)
    third = run_with_plan(service, plan_id)

    assert first["query_plan_run_index"] == 1
    assert second["query_plan_run_index"] == 2
    assert first["query_plan_max_runs"] == second["query_plan_max_runs"] == 2
    assert_plan_error(third, "query_plan_run_limit_exceeded")
    execution_events = [event for event in events if event.event_type == "query_plan_execution"]
    observed_runs = [
        (event.detail["run_index"], event.detail["max_runs"])
        for event in execution_events
    ]
    assert observed_runs == [
        (1, 2),
        (2, 2),
    ]
    assert all(
        event.detail["query_plan_ref"] != plan_id
        and len(event.detail["query_plan_ref"]) == 16
        for event in execution_events
    )
    assert any(
        event.event_type == "query_plan_rejected"
        and event.detail["issue_codes"] == ["query_plan_run_limit_exceeded"]
        for event in events
    )


def test_compare_plan_uses_independent_bounded_ttl() -> None:
    store = QueryPlanStore(ttl_seconds=300, compare_ttl_seconds=900)
    single = store.issue(
        UNION_ID,
        SQL,
        DATASOURCE,
        session_id=SESSION_ID,
        lark_app_id=APP_ID,
    )
    compare = store.issue(
        UNION_ID,
        SQL,
        DATASOURCE,
        session_id=SESSION_ID,
        lark_app_id=APP_ID,
        execution_mode="compare",
    )
    store._plans[single].issued_at = time.time() - 301
    store._plans[compare].issued_at = time.time() - 301

    single_ok, single_code, _ = store.consume_for_run(
        single,
        session_id=SESSION_ID,
        union_id=UNION_ID,
        sql=SQL,
        datasource=DATASOURCE,
        lark_app_id=APP_ID,
    )
    compare_ok, compare_code, _ = store.consume_for_run(
        compare,
        session_id=SESSION_ID,
        union_id=UNION_ID,
        sql=SQL,
        datasource=DATASOURCE,
        lark_app_id=APP_ID,
    )

    assert not single_ok
    assert single_code == "query_plan_not_found_or_expired"
    assert compare_ok
    assert compare_code == "ok"

    store._plans[compare].issued_at = time.time() - 901
    expired_ok, expired_code, _ = store.consume_for_run(
        compare,
        session_id=SESSION_ID,
        union_id=UNION_ID,
        sql=SQL,
        datasource=DATASOURCE,
        lark_app_id=APP_ID,
    )
    assert not expired_ok
    assert expired_code == "query_plan_not_found_or_expired"


def test_compare_plan_store_rejects_ttl_above_server_cap() -> None:
    try:
        QueryPlanStore(compare_ttl_seconds=901)
    except ValueError as exc:
        assert "server-side maximum" in str(exc)
    else:
        raise AssertionError("compare TTL above 15 minutes must be rejected")


def test_compare_plan_atomic_counter_allows_only_two_concurrent_consumers() -> None:
    store = QueryPlanStore()
    plan_id = store.issue(
        UNION_ID,
        SQL,
        DATASOURCE,
        session_id=SESSION_ID,
        lark_app_id=APP_ID,
        execution_mode="compare",
    )

    def consume() -> tuple[bool, str]:
        ok, code, _ = store.consume_for_run(
            plan_id,
            session_id=SESSION_ID,
            union_id=UNION_ID,
            sql=SQL,
            datasource=DATASOURCE,
            lark_app_id=APP_ID,
        )
        return ok, code

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: consume(), range(8)))

    assert sum(ok for ok, _ in results) == 2
    assert [code for ok, code in results if not ok] == ["query_plan_run_limit_exceeded"] * 6


def test_compare_plan_rechecks_guard_after_permissions_change(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = build_service()
    plan_id = issue_baseline_plan(service, execution_mode="compare")

    first = run_with_plan(service, plan_id)
    guard_calls = 0

    def deny_after_permission_change(*args, **kwargs):
        nonlocal guard_calls
        guard_calls += 1
        return SqlValidationResult(
            status=Status.VALIDATION_ERROR,
            datasource=DATASOURCE,
            issues=[
                ValidationIssue(
                    code="table_access_denied",
                    severity="error",
                    message="permission changed",
                )
            ],
        )

    class _DenyGuard:
        validate = staticmethod(deny_after_permission_change)

    service.container = replace(service.container, sql_guard=_DenyGuard())
    second = run_with_plan(service, plan_id)

    assert first["status"] == Status.SUCCESS
    assert guard_calls == 1
    assert second["status"] == Status.VALIDATION_ERROR
    assert second["issues"][0]["code"] == "table_access_denied"
    assert second["query_plan_run_index"] == 2
    execution_events = [event for event in events if event.event_type == "query_plan_execution"]
    assert [event.detail["run_index"] for event in execution_events] == [1, 2]
    assert execution_events[1].status == Status.VALIDATION_ERROR


class _SqlErrorExecutor:
    def __init__(self, error_name: str) -> None:
        self.error_name = error_name

    def run(self, credential, sql, timeout_seconds):
        return QueryResult(
            status=Status.ERROR,
            result_class=ResultClass.CK_QUERY_ERROR,
            query_id="q_failed",
            datasource="tchouse-c",
            sql=sql,
            error_code="ck_test",
            error_name=self.error_name,
            retryable=True,
        )


def _service_with_sql_error(error_name: str) -> DataMcpService:
    base = build_container(
        Settings(
            CREDENTIAL_PROVIDER="memory",
            CREDENTIAL_MEMORY_FILE="examples/credentials.example.json",
            METADATA_PROVIDER="memory",
            QUERY_EXECUTOR="dry_run",
            QUERY_REPAIR_MAX_FAILURES=3,
        )
    )
    return DataMcpService(replace(base, executor=_SqlErrorExecutor(error_name)))


def test_repair_chain_counts_only_explicit_failed_repair_chain() -> None:
    service = _service_with_sql_error("UNKNOWN_IDENTIFIER")
    chain_id = None
    for expected_remaining in (2, 1, 0):
        validation = service.validate_sql_for_user(
            UNION_ID,
            OPEN_ID,
            SQL,
            request_lark_app_id=APP_ID,
            audit_context=HUMAN_AUDIT_CONTEXT,
            repair_chain_id=chain_id,
        )
        chain_id = validation["repair_chain_id"]
        result = run_with_plan(service, validation["query_plan_id"])
        assert result["repair_chain_id"] == chain_id
        assert result["repair_attempts_remaining"] == expected_remaining
        assert result["repair_failure_counted"] is True

    blocked = service.validate_sql_for_user(
        UNION_ID,
        OPEN_ID,
        SQL,
        request_lark_app_id=APP_ID,
        audit_context=HUMAN_AUDIT_CONTEXT,
        repair_chain_id=chain_id,
    )
    assert [issue["code"] for issue in blocked["issues"]] == ["repair_chain_failure_limit"]

    reset_attempt = service.validate_sql_for_user(
        UNION_ID,
        OPEN_ID,
        "SELECT 2",
        request_lark_app_id=APP_ID,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )
    assert reset_attempt["status"] == Status.VALIDATION_ERROR
    assert [issue["code"] for issue in reset_attempt["issues"]] == [
        "repair_chain_failure_limit"
    ]


@pytest.mark.parametrize(
    "audit_context",
    [HUMAN_AUDIT_CONTEXT, SCHEDULE_AUDIT_CONTEXT],
)
def test_rewritten_sql_without_chain_id_cannot_reset_failure_limit(
    audit_context,
    monkeypatch,
) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = _service_with_sql_error("UNKNOWN_TABLE")
    chain_ids = []

    for value in (1, 2, 3):
        sql = f"SELECT {value} AS probe"
        validation = service.validate_sql_for_user(
            UNION_ID,
            OPEN_ID,
            sql,
            request_lark_app_id=APP_ID,
            audit_context=audit_context,
        )
        chain_ids.append(validation["repair_chain_id"])
        result = run_with_plan(
            service,
            validation["query_plan_id"],
            sql=sql,
            audit_context=audit_context,
        )
        assert result["repair_failure_counted"] is True

    blocked = service.validate_sql_for_user(
        UNION_ID,
        OPEN_ID,
        "SELECT 4 AS probe",
        request_lark_app_id=APP_ID,
        audit_context=audit_context,
    )

    assert len(set(chain_ids)) == 1
    assert [issue["code"] for issue in blocked["issues"]] == [
        "repair_chain_failure_limit"
    ]
    assert blocked["repair_attempts_remaining"] == 0
    assert blocked["retry_after_seconds"] == 300
    assert "300 秒" in blocked["message"]
    rejection = [event for event in events if event.event_type == "query_plan_rejected"][-1]
    assert rejection.detail["issue_codes"] == ["repair_chain_failure_limit"]
    assert rejection.detail["error_code"] == "repair_chain_failure_limit"


def test_validate_audits_credential_resolution_failure(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = build_service()
    credential_error = service._credential_resolution_error(
        DATASOURCE,
        code="account_mapping_unavailable",
        message="mapping unavailable",
        suggested_action="check mapping",
    )
    monkeypatch.setattr(
        service,
        "_resolve_validation_credential",
        lambda user, datasource: credential_error,
    )

    result = service.validate_sql_for_user(
        UNION_ID,
        OPEN_ID,
        SQL,
        request_lark_app_id=APP_ID,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    rejection = [event for event in events if event.event_type == "query_plan_rejected"]
    assert result["issues"][0]["code"] == "account_mapping_unavailable"
    assert len(rejection) == 1
    assert rejection[0].detail["error_code"] == "account_mapping_unavailable"


def test_validate_audits_account_mismatch(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = build_service()
    credential = CredentialRef(
        user_union_id=UNION_ID,
        tchouse_account="resolved_account",
        jdbc_url=(
            "jdbc:clickhouse://example.invalid:8123/default;"
            "user=resolved_account;password=secret"
        ),
        password_secret_ref="memory://credential",
    )
    monkeypatch.setattr(
        service,
        "_resolve_validation_credential",
        lambda user, datasource: credential,
    )

    result = service.validate_sql_for_user(
        UNION_ID,
        OPEN_ID,
        SQL,
        request_lark_app_id=APP_ID,
        request_user_tchouse_account="injected_other_account",
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    rejection = [event for event in events if event.event_type == "query_plan_rejected"]
    assert result["issues"][0]["code"] == "account_mismatch"
    assert len(rejection) == 1
    assert rejection[0].detail["error_code"] == "account_mismatch"
    assert rejection[0].detail["injected_account_ref"].startswith("sha256:")
    assert rejection[0].detail["resolved_account_ref"].startswith("sha256:")
    assert len(rejection[0].detail["injected_account_ref"]) == 71
    assert len(rejection[0].detail["resolved_account_ref"]) == 71
    assert (
        rejection[0].detail["injected_account_ref"]
        != rejection[0].detail["resolved_account_ref"]
    )
    audit_values = str(tuple(rejection[0].detail.values()))
    assert "injected_other_account" not in audit_values
    assert "resolved_account" not in audit_values


def test_repair_chain_omission_reuses_server_bound_scope_without_consuming_success() -> None:
    store = RepairChainStore(max_failures=3)

    ok, _, first = store.prepare(UNION_ID, None, scope_id="turn-a")
    assert ok
    store.record_failure(first)

    ok, _, reused = store.prepare(UNION_ID, None, scope_id="turn-a")
    assert ok
    assert reused == first
    assert store.remaining(reused) == 2

    ok, _, next_turn = store.prepare(UNION_ID, None, scope_id="turn-b")
    assert ok
    assert next_turn != first
    assert store.remaining(next_turn) == 3


def test_repair_chain_rejects_explicit_chain_from_another_turn() -> None:
    store = RepairChainStore(max_failures=3)

    ok, _, first = store.prepare(UNION_ID, None, scope_id="turn-a")
    assert ok

    ok, code, rejected = store.prepare(UNION_ID, first, scope_id="turn-b")

    assert not ok
    assert code == "repair_chain_scope_mismatch"
    assert rejected == first
    assert store.remaining(first) == 3


def test_repair_chain_unknown_id_is_rejected_with_zero_remaining() -> None:
    store = RepairChainStore(max_failures=3)

    ok, code, chain_id = store.prepare(
        UNION_ID,
        "repair_missing",
        scope_id="turn-a",
    )

    assert not ok
    assert code == "repair_chain_not_found_or_expired"
    assert chain_id == "repair_missing"
    assert store.remaining(chain_id) == 0
