from __future__ import annotations

import sqlite3
import base64
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from ksher_agent_data_mcp.amber_api import (
    AmberQueryRequest,
    AmberRuntime,
    amber_app,
    get_amber_runtime,
)
from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.models.contracts import Status
from tests.amber_helpers import sign_token, write_jwks


class FakeService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def validate_sql_for_user(self, *args, **kwargs):
        self.calls.append(("validate", args, kwargs))
        return {"status": "success", "query_plan_id": "qplan_test"}

    def run_query_for_user(self, *args, **kwargs):
        self.calls.append(("run", args, kwargs))
        return {"status": "success", "row_count": 1, "rows": [{"one": 1}]}


def build_runtime(tmp_path):
    private_key = Ed25519PrivateKey.generate()
    jwks = tmp_path / "amber.jwks.json"
    kid = write_jwks(jwks, private_key)
    audit_key = tmp_path / "audit.key"
    audit_key.write_bytes(base64.urlsafe_b64encode(b"k" * 32).rstrip(b"="))
    audit_key.chmod(0o600)
    settings = Settings(
        DATA_MCP_AMBER_ENABLED=True,
        DATA_MCP_AMBER_JWKS_FILE=jwks,
        DATA_MCP_AMBER_STATE_DB=tmp_path / "state" / "amber.db",
        DATA_MCP_AMBER_AUDIT_KEY_FILE=audit_key,
        DATA_MCP_AMBER_TRUST_DOMAIN="test-host:service-user:amber",
    )
    service = FakeService()
    runtime = AmberRuntime(settings, service=service)  # type: ignore[arg-type]
    return runtime, service, private_key, kid


def test_amber_query_uses_only_signed_identity_and_exact_sql(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)
    amber_app.dependency_overrides[get_amber_runtime] = lambda: runtime
    sql = "SELECT 1 /* byte-exact */"
    token = sign_token(private_key, kid)
    try:
        response = TestClient(amber_app).post(
            "/amber/query",
            headers={"Authorization": f"Amber {token}"},
            json={"sql": sql, "datasource": "tchouse-c"},
        )
    finally:
        amber_app.dependency_overrides.clear()

    assert response.status_code == 200
    assert [call[0] for call in service.calls] == ["validate", "run"]
    validate, run = service.calls
    assert validate[1][0] == "on_test_user"
    assert validate[1][1] is None
    assert validate[1][2] == sql
    assert run[1][2] == sql
    assert validate[2]["audit_context"]["trust_domain"] == "test-host:service-user:amber"
    assert validate[2]["audit_context"]["amber_call"] == "1/1"
    assert sql.encode() not in runtime.state.database.read_bytes()


def test_amber_query_rejects_replay_unknown_key_and_body_identity(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)
    amber_app.dependency_overrides[get_amber_runtime] = lambda: runtime
    client = TestClient(amber_app)
    token = sign_token(private_key, kid)
    try:
        first = client.post(
            "/amber/query",
            headers={"Authorization": f"Amber {token}"},
            json={"sql": "SELECT 1"},
        )
        replay = client.post(
            "/amber/query",
            headers={"Authorization": f"Amber {token}"},
            json={"sql": "SELECT 1"},
        )
        injected = client.post(
            "/amber/query",
            headers={
                "Authorization": f"Amber {sign_token(private_key, kid, overrides={'jti': 'new'})}"
            },
            json={"sql": "SELECT 1", "request_user_union_id": "on_attacker"},
        )
        foreign_key = Ed25519PrivateKey.generate()
        unknown = client.post(
            "/amber/query",
            headers={
                "Authorization": f"Amber {sign_token(foreign_key, 'foreign', overrides={'jti': 'foreign'})}"
            },
            json={"sql": "SELECT 1"},
        )
    finally:
        amber_app.dependency_overrides.clear()

    assert first.status_code == 200
    assert replay.status_code == 409
    assert replay.json()["detail"] == "amber_token_replayed"
    assert injected.status_code == 422
    assert unknown.status_code == 401
    assert unknown.json()["detail"] == "unknown_amber_key"
    assert len(service.calls) == 2


def test_validation_failure_consumes_token_and_does_not_run(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)
    service.validate_sql_for_user = lambda *args, **kwargs: {
        "status": "validation_error",
        "issues": [{"code": "readonly_query_required"}],
    }
    amber_app.dependency_overrides[get_amber_runtime] = lambda: runtime
    token = sign_token(private_key, kid)
    client = TestClient(amber_app)
    try:
        first = client.post(
            "/amber/query",
            headers={"Authorization": f"Amber {token}"},
            json={"sql": "DROP TABLE x"},
        )
        replay = client.post(
            "/amber/query",
            headers={"Authorization": f"Amber {token}"},
            json={"sql": "DROP TABLE x"},
        )
    finally:
        amber_app.dependency_overrides.clear()

    assert first.status_code == 200
    assert first.json()["issues"][0]["code"] == "readonly_query_required"
    assert replay.status_code == 409
    assert service.calls == []


def test_enum_status_is_persisted_as_wire_value(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)
    service.run_query_for_user = lambda *args, **kwargs: {
        "status": Status.SUCCESS,
        "row_count": 0,
    }

    runtime.execute(
        f"Amber {sign_token(private_key, kid)}",
        AmberQueryRequest(sql="SELECT 1"),
    )

    with sqlite3.connect(runtime.state.database) as connection:
        stored = connection.execute("SELECT status FROM amber_sql_audit").fetchone()
    assert stored == ("success",)


def test_schedule_uses_schedule_identity_and_persistent_rate_limit(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)
    runtime.settings.amber_schedule_max_runs_per_minute = 1
    amber_app.dependency_overrides[get_amber_runtime] = lambda: runtime
    client = TestClient(amber_app)
    try:
        first = client.post(
            "/amber/query",
            headers={
                "Authorization": f"Amber {sign_token(private_key, kid, overrides={'channel': 'schedule'})}"
            },
            json={"sql": "SELECT 1"},
        )
        second = client.post(
            "/amber/query",
            headers={
                "Authorization": f"Amber {sign_token(private_key, kid, overrides={'channel': 'schedule', 'jti': 'schedule-2', 'run': 'run_other'})}"
            },
            json={"sql": "SELECT 1"},
        )
    finally:
        amber_app.dependency_overrides.clear()

    assert first.status_code == 200
    assert second.status_code == 429
    context = service.calls[0][2]["audit_context"]
    assert context["sender_type"] == "bot"
    assert context["caller_source"] == "schedule_creator"
    assert context["task_id"] == "amber:cmd_test"
    assert len(service.calls) == 2


def test_schedule_calls_from_one_run_count_once(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)
    runtime.settings.amber_schedule_max_runs_per_minute = 1

    for call_index in range(1, 16):
        result = runtime.execute(
            f"Amber {sign_token(private_key, kid, overrides={'channel': 'schedule', 'jti': f'schedule-{call_index}', 'call_index': call_index, 'call_count': 15})}",
            AmberQueryRequest(sql="SELECT 1"),
        )
        assert result["status"] == "success"

    assert len(service.calls) == 30


def test_trial_channel_sets_restricted_query_limit(tmp_path) -> None:
    runtime, service, private_key, kid = build_runtime(tmp_path)

    runtime.execute(
        f"Amber {sign_token(private_key, kid, overrides={'channel': 'bot.trial'})}",
        AmberQueryRequest(sql="SELECT 1"),
    )

    context = service.calls[0][2]["audit_context"]
    assert context["sender_type"] == "user"
    assert context["query_max_rows"] == "20"


def test_trial_limit_is_applied_again_by_run_guard(tmp_path, monkeypatch) -> None:
    configured, _, private_key, kid = build_runtime(tmp_path)
    settings = configured.settings.model_copy(
        update={
            "credential_memory_file": Path("examples/credentials.example.json"),
            "require_partition_filter": False,
        }
    )
    runtime = AmberRuntime(settings)
    guard_calls: list[int | None] = []
    guard_type = type(runtime.service.container.sql_guard)
    original_validate = guard_type.validate

    def validate_without_network_probe(
        self, user, sql, datasource="tchouse-c", credential=None, max_rows=None
    ):
        guard_calls.append(max_rows)
        return original_validate(
            self,
            user,
            sql,
            datasource,
            credential=None,
            max_rows=max_rows,
        )

    monkeypatch.setattr(guard_type, "validate", validate_without_network_probe)

    result = runtime.execute(
        f"Amber {sign_token(private_key, kid, overrides={'sub': 'on_example_user', 'channel': 'bot.trial'})}",
        AmberQueryRequest(sql="SELECT 1 LIMIT 500"),
    )

    assert result["status"] == Status.SUCCESS
    assert result["sql"].endswith("LIMIT 20")
    assert guard_calls == [20, 20]


def test_runtime_rejects_replay_grace_shorter_than_skew_margin(tmp_path) -> None:
    configured, service, _, _ = build_runtime(tmp_path)
    unsafe = configured.settings.model_copy(
        update={
            "amber_clock_skew_seconds": 120,
            "amber_replay_grace_seconds": 60,
        }
    )

    with pytest.raises(ValueError, match="amber_replay_grace_too_short"):
        AmberRuntime(unsafe, service=service)  # type: ignore[arg-type]


def test_amber_app_does_not_publish_api_schema() -> None:
    client = TestClient(amber_app)
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404
