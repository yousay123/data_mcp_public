from __future__ import annotations

import sqlite3
from typing import Any

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
    audit_key.write_bytes(b"k" * 32)
    audit_key.chmod(0o600)
    settings = Settings(
        DATA_MCP_AMBER_ENABLED=True,
        DATA_MCP_AMBER_JWKS_FILE=jwks,
        DATA_MCP_AMBER_STATE_DB=tmp_path / "state" / "amber.db",
        DATA_MCP_AMBER_AUDIT_KEY_FILE=audit_key,
        DATA_MCP_AMBER_TRUST_DOMAIN="dev-beta:ksher:amber",
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
    assert validate[2]["audit_context"]["trust_domain"] == "dev-beta:ksher:amber"
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
