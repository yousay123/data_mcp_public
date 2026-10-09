import os
import tempfile
import tomllib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ksher_agent_data_mcp import __version__
from ksher_agent_data_mcp import api as api_module
from ksher_agent_data_mcp.api import _bind_unix_socket, app, health, settings

REMOVED_INSECURE_ENV = "DATA_MCP_ALLOW" + "_INSECURE" + "_HTTP" + "_IDENTITY"


def test_runtime_version_matches_project_metadata() -> None:
    with Path("pyproject.toml").open("rb") as f:
        project_version = tomllib.load(f)["project"]["version"]
    assert __version__ == project_version


def test_fastapi_app_uses_package_version() -> None:
    assert app.version == __version__


def test_health_exposes_runtime_version_and_sql_guard_capabilities() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    payload = response.json()

    assert payload["version"] == __version__
    assert payload["credential_provider"] == settings.credential_provider
    assert payload["query_executor"] == settings.query_executor
    assert payload["metadata_provider"] == settings.metadata_provider
    assert payload["sql_guard"] == {
        "cte_alias_filter": "enabled",
        "table_function_policy": "reject",
        "show_command_policy": "allow_readonly_show",
    }
    assert payload["access_audit"]["general_query_identity"] == "caller_bound"
    assert payload["access_audit"]["table_function_policy"] == "reject"
    assert payload["query_resource_limits"]["clickhouse_read_and_memory_limits"] == (
        "cluster_profile"
    )
    assert payload["query_resource_limits"]["max_concurrency"] >= 1
    assert "max_rows_to_read" not in payload["query_resource_limits"]
    assert "max_bytes_to_read" not in payload["query_resource_limits"]
    assert "max_memory_bytes" not in payload["query_resource_limits"]
    assert payload["query_resource_limits"]["query_plan_single_ttl_seconds"] == 300
    assert payload["query_resource_limits"]["query_plan_compare_ttl_seconds"] <= 900
    assert payload["export_receipt"] == {
        "schema_version": 1,
        "atomic_sidecar": True,
        "source_version_provider": "unavailable",
        "read_isolation": False,
        "trust_boundary": "tamper_evidence_only",
    }
    assert payload["http_identity"]["dev_insecure_override"] is False
    assert payload["http_identity"]["dev_insecure_override_supported"] is False
    serialized = str(payload)
    for hidden in (
        "accepted_argument_aliases",
        "hidden_schema_fields",
        "requestUserUnionId",
        "union_id",
        "senderType",
        "tchouse_account",
    ):
        assert hidden not in serialized


def test_http_identity_endpoint_is_disabled_without_internal_auth(monkeypatch) -> None:
    monkeypatch.delenv("DATA_MCP_INTERNAL_AUTH_TOKEN", raising=False)
    monkeypatch.delenv(REMOVED_INSECURE_ENV, raising=False)

    response = TestClient(app).post(
        "/agent/validate-sql",
        json={
            "request_user_union_id": "on_spoofed_user",
            "sql": "SELECT 1",
        },
    )

    assert response.status_code == 503
    assert "HTTP identity endpoints disabled" in response.text


def test_http_identity_endpoint_rejects_wrong_internal_auth(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "expected-token")
    monkeypatch.delenv(REMOVED_INSECURE_ENV, raising=False)

    response = TestClient(app).post(
        "/agent/run-query",
        headers={"X-Internal-Auth": "wrong-token"},
        json={
            "request_user_union_id": "on_spoofed_user",
            "sql": "SELECT 1",
        },
    )

    assert response.status_code == 401


@pytest.mark.parametrize("max_export_rows", [0, -1])
def test_export_endpoint_rejects_nonpositive_row_limit(
    monkeypatch, max_export_rows: int
) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")

    response = TestClient(app).post(
        "/agent/export-query-excel-file",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_example_user",
            "sql": "SELECT 1",
            "query_plan_id": "plan_example",
            "max_export_rows": max_export_rows,
        },
    )

    assert response.status_code == 422


def test_export_endpoint_forwards_expected_source_version(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    captured: dict[str, Any] = {}

    def fake_export(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return {"status": "success"}

    monkeypatch.setattr(api_module.service, "export_query_to_excel_file", fake_export)
    response = TestClient(app).post(
        "/agent/export-query-excel-file",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_user",
            "request_user_open_id": "ou_user",
            "request_lark_app_id": "cli_app",
            "caller_sender_type": "user",
            "caller_session_id": "session_bound",
            "sql": "SELECT 1",
            "query_plan_id": "plan_example",
            "expected_source_version": "parts:v1",
        },
    )

    assert response.status_code == 200
    assert captured["kwargs"]["expected_source_version"] == "parts:v1"


def test_http_identity_endpoint_ignores_removed_insecure_override(monkeypatch) -> None:
    monkeypatch.delenv("DATA_MCP_INTERNAL_AUTH_TOKEN", raising=False)
    monkeypatch.setenv(REMOVED_INSECURE_ENV, "1")

    response = TestClient(app).post(
        "/agent/validate-sql",
        json={
            "request_user_union_id": "on_spoofed_user",
            "sql": "SELECT 1",
        },
    )

    assert response.status_code == 503
    assert health()["http_identity"]["dev_insecure_override"] is False


def test_validate_endpoint_forwards_session_and_execution_mode(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    captured: dict[str, Any] = {}

    def fake_validate(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return {"status": "success"}

    monkeypatch.setattr(api_module.service, "validate_sql_for_user", fake_validate)
    response = TestClient(app).post(
        "/agent/validate-sql",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_user",
            "request_user_open_id": "ou_user",
            "request_lark_app_id": "cli_app",
            "caller_sender_type": "user",
            "caller_session_id": "session_bound",
            "sql": "SELECT 1",
            "execution_mode": "compare",
        },
    )

    assert response.status_code == 200
    assert captured["kwargs"]["execution_mode"] == "compare"
    assert captured["kwargs"]["audit_context"]["session_id"] == "session_bound"


def test_validate_endpoint_rejects_caller_defined_run_count_or_invalid_mode(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    client = TestClient(app)

    invalid_mode = client.post(
        "/agent/validate-sql",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_user",
            "sql": "SELECT 1",
            "execution_mode": "triple",
        },
    )
    caller_run_count = client.post(
        "/agent/validate-sql",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_user",
            "sql": "SELECT 1",
            "execution_mode": "compare",
            "max_runs": 99,
        },
    )

    assert invalid_mode.status_code == 422
    assert caller_run_count.status_code == 422


def test_unix_socket_bind_creates_private_socket_and_parent() -> None:
    socket_dir = Path(tempfile.mkdtemp(prefix="data-mcp-socket-"))
    os.chmod(socket_dir, 0o755)
    socket_path = socket_dir / "api.sock"

    server_socket = _bind_unix_socket(str(socket_path))
    try:
        assert oct(socket_path.parent.stat().st_mode & 0o777) == "0o700"
        assert oct(socket_path.stat().st_mode & 0o777) == "0o600"
    finally:
        server_socket.close()
        socket_path.unlink(missing_ok=True)
        socket_dir.rmdir()


def test_snapshot_search_endpoint_uses_internal_service(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    monkeypatch.setattr(
        api_module.service,
        "search_metadata_snapshot",
        lambda query, limit, priority: {
            "status": "success",
            "query": query,
            "limit": limit,
            "priority": priority,
        },
    )

    response = TestClient(app).post(
        "/agent/search-metadata-snapshot",
        headers={"X-Internal-Auth": "test-token"},
        json={"query": "账单", "limit": 3, "priority": "1"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "success",
        "query": "账单",
        "limit": 3,
        "priority": "1",
    }


def test_snapshot_refresh_endpoint_forwards_only_trusted_context(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    captured = {}

    def fake_refresh(union_id, open_id, app_id, audit_context):
        captured.update(
            union_id=union_id,
            open_id=open_id,
            app_id=app_id,
            audit_context=audit_context,
        )
        return {"status": "success"}

    monkeypatch.setattr(api_module.service, "refresh_metadata_snapshot_for_owner", fake_refresh)
    response = TestClient(app).post(
        "/agent/refresh-metadata-snapshot",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_owner",
            "request_user_open_id": "ou_owner",
            "request_lark_app_id": "cli_test",
            "caller_source": "schedule_creator",
            "caller_task_id": "task_test",
        },
    )

    assert response.status_code == 200
    assert captured == {
        "union_id": "on_owner",
        "open_id": "ou_owner",
        "app_id": "cli_test",
        "audit_context": {
            "caller_source": "schedule_creator",
            "sender_type": None,
            "task_id": "task_test",
            "turn_id": None,
            "captured_at": None,
        },
    }


def test_snapshot_refresh_endpoint_rejects_sql_or_table_arguments(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")

    response = TestClient(app).post(
        "/agent/refresh-metadata-snapshot",
        headers={"X-Internal-Auth": "test-token"},
        json={
            "request_user_union_id": "on_owner",
            "request_user_open_id": "ou_owner",
            "request_lark_app_id": "cli_test",
            "caller_source": "schedule_creator",
            "caller_task_id": "task_test",
            "sql": "SELECT * FROM another_table",
        },
    )

    assert response.status_code == 422


def test_removed_cluster_comparison_route_is_not_registered(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    removed_path = "/agent/" + "audit-ck-" + "access-consistency"

    response = TestClient(app).post(
        removed_path,
        headers={"X-Internal-Auth": "test-token"},
        json={},
    )

    assert response.status_code == 404


def test_access_inspection_endpoints_forward_explicit_scopes(monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    captured: dict[str, Any] = {}

    def fake_subjects(*args, audit_context):
        captured["subjects"] = (args, audit_context)
        return {"status": "success", "verdict": "consistent"}

    def fake_resources(*args, audit_context):
        captured["resources"] = (args, audit_context)
        return {"status": "success", "verdict": "consistent"}

    monkeypatch.setattr(api_module.service, "inspect_ck_subjects_by_table", fake_subjects)
    monkeypatch.setattr(api_module.service, "inspect_ck_resources_by_subject", fake_resources)
    common = {
        "request_user_union_id": "on_user",
        "request_user_open_id": "ou_user",
        "request_lark_app_id": "cli_allowed",
        "caller_sender_type": "user",
    }
    client = TestClient(app)
    subjects = client.post(
        "/agent/inspect-ck-subjects-by-table",
        headers={"X-Internal-Auth": "test-token"},
        json={**common, "target_tables": ["demo.orders"]},
    )
    resources = client.post(
        "/agent/inspect-ck-resources-by-subject",
        headers={"X-Internal-Auth": "test-token"},
        json={**common, "target_accounts": ["reader"], "target_roles": ["role_reader"]},
    )

    assert subjects.status_code == 200
    assert resources.status_code == 200
    assert captured["subjects"][0] == ("on_user", "ou_user", "cli_allowed", ["demo.orders"])
    assert captured["resources"][0] == (
        "on_user",
        "ou_user",
        "cli_allowed",
        ["reader"],
        ["role_reader"],
    )
    assert captured["subjects"][1]["sender_type"] == "user"


@pytest.mark.parametrize(
    ("path", "scope"),
    [
        ("/agent/inspect-ck-subjects-by-table", {"target_tables": ["demo.orders"]}),
        (
            "/agent/inspect-ck-resources-by-subject",
            {"target_accounts": ["reader"], "target_roles": []},
        ),
    ],
)
def test_access_inspection_endpoints_reject_sql(path, scope, monkeypatch) -> None:
    monkeypatch.setenv("DATA_MCP_INTERNAL_AUTH_TOKEN", "test-token")
    response = TestClient(app).post(
        path,
        headers={"X-Internal-Auth": "test-token"},
        json={"request_user_union_id": "on_user", **scope, "sql": "SELECT 1"},
    )
    assert response.status_code == 422
