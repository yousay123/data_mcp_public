import hmac
import os
import socket
import stat
from pathlib import Path
from typing import Any, Literal

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from ksher_agent_data_mcp import __version__
from ksher_agent_data_mcp.config import get_settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.tools.service import DataMcpService

settings = get_settings()
service = DataMcpService(build_container(settings))
app = FastAPI(title=settings.server_name, version=__version__)

INTERNAL_AUTH_HEADER = "X-Internal-Auth"
INTERNAL_AUTH_ENV = "DATA_MCP_INTERNAL_AUTH_TOKEN"
SOCKET_PATH_ENV = "DATA_MCP_HTTP_SOCKET_PATH"
TCP_BIND_ENV = "DATA_MCP_HTTP_BIND_TCP"
_SERVING_UNIX_SOCKET = False


class AgentSqlRequestBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_user_union_id: str
    request_user_open_id: str | None = None
    request_lark_app_id: str | None = None
    caller_source: str | None = None
    caller_sender_type: str | None = None
    caller_session_id: str | None = None
    caller_task_id: str | None = None
    caller_turn_id: str | None = None
    caller_captured_at: str | None = None
    request_user_tchouse_account: str | None = None
    sql: str
    datasource: str = "tchouse-c"

    def audit_context(self) -> dict[str, str | None]:
        return {
            "caller_source": self.caller_source,
            "sender_type": self.caller_sender_type,
            "session_id": self.caller_session_id,
            "task_id": self.caller_task_id,
            "turn_id": self.caller_turn_id,
            "captured_at": self.caller_captured_at,
        }


class AgentSqlValidationRequest(AgentSqlRequestBase):
    repair_chain_id: str | None = None
    execution_mode: Literal["single", "compare"] = "single"


class AgentSqlRequest(AgentSqlRequestBase):
    query_plan_id: str


class AgentExportRequest(AgentSqlRequest):
    filename: str | None = None
    max_export_rows: int | None = Field(default=None, ge=1)
    expected_source_version: str | None = Field(default=None, min_length=1, max_length=256)


class MetadataSnapshotRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_user_union_id: str
    request_user_open_id: str | None = None
    request_lark_app_id: str | None = None
    caller_source: str | None = None
    caller_sender_type: str | None = None
    caller_task_id: str | None = None
    caller_turn_id: str | None = None
    caller_captured_at: str | None = None

    def audit_context(self) -> dict[str, str | None]:
        return {
            "caller_source": self.caller_source,
            "sender_type": self.caller_sender_type,
            "task_id": self.caller_task_id,
            "turn_id": self.caller_turn_id,
            "captured_at": self.caller_captured_at,
        }


class MetadataSnapshotSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    limit: int = 20
    priority: str | None = None


class SubjectsByTableRequest(MetadataSnapshotRefreshRequest):
    target_tables: list[str]


class ResourcesBySubjectRequest(MetadataSnapshotRefreshRequest):
    target_accounts: list[str] = Field(default_factory=list)
    target_roles: list[str] = Field(default_factory=list)


def require_internal_http_auth(
    request: Request,
    x_internal_auth: str | None = Header(default=None, alias=INTERNAL_AUTH_HEADER),
) -> None:
    """HTTP identity endpoints are not the production agent trust boundary."""
    if _SERVING_UNIX_SOCKET:
        return
    expected = os.getenv(INTERNAL_AUTH_ENV)
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "HTTP identity endpoints disabled: set DATA_MCP_INTERNAL_AUTH_TOKEN "
                "for service-to-service use"
            ),
        )
    if not hmac.compare_digest(x_internal_auth or "", expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid internal auth"
        )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.server_name,
        "version": __version__,
        "env": settings.env,
        "credential_provider": settings.credential_provider,
        "query_executor": settings.query_executor,
        "metadata_provider": settings.metadata_provider,
        "stdio": {
            "standalone_enabled_by_default": False,
            "botmux_proxy_required_for_identity": True,
        },
        "http_identity": {
            "transport": "tcp" if _tcp_bind_enabled() else "unix_socket",
            "socket_path_configured": bool(_socket_path()),
            "enabled": _tcp_bind_enabled() or bool(_socket_path()),
            "auth": "unix-socket-permission" if not _tcp_bind_enabled() else "x-internal-auth",
            "dev_insecure_override": False,
            "dev_insecure_override_supported": False,
        },
        "sql_guard": {
            "cte_alias_filter": "enabled",
            "table_function_policy": "reject",
            "show_command_policy": "allow_readonly_show",
        },
        "query_resource_limits": {
            "timeout_seconds": settings.query_timeout_seconds,
            "max_rows_to_read": settings.query_max_rows_to_read,
            "max_bytes_to_read": settings.query_max_bytes_to_read,
            "max_memory_bytes": settings.query_max_memory_bytes,
            "max_concurrency": settings.query_max_concurrency,
            "repair_max_failures": settings.query_repair_max_failures,
            "query_plan_single_ttl_seconds": service.query_plans.ttl_seconds,
            "query_plan_compare_ttl_seconds": service.query_plans.compare_ttl_seconds,
        },
        "export_receipt": {
            "schema_version": 1,
            "atomic_sidecar": True,
            "source_version_provider": "unavailable",
            "read_isolation": False,
            "trust_boundary": "tamper_evidence_only",
        },
        "access_audit": {
            "enabled": service.container.access_auditor_factory is not None,
            "execution_identity": "caller_bound",
            "general_query_identity": "caller_bound",
            "caller_allowlist_configured": bool(settings.access_audit_allowed_union_ids.strip()),
            "table_function_policy": "reject",
        },
    }


def _socket_path() -> str:
    return os.getenv(SOCKET_PATH_ENV) or str(
        Path.home() / ".cache" / "ksher-agent-data-mcp" / "run" / "api.sock"
    )


def _tcp_bind_enabled() -> bool:
    return os.getenv(TCP_BIND_ENV) in {"1", "true", "TRUE", "yes", "YES"}


def _prepare_socket_path(path: str) -> None:
    socket_path = Path(path)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(socket_path.parent, 0o700)
    if not socket_path.exists():
        return
    mode = socket_path.stat().st_mode
    if stat.S_ISSOCK(mode):
        socket_path.unlink()
        return
    raise RuntimeError(f"Refusing to replace non-socket path: {socket_path}")


def _bind_unix_socket(path: str) -> socket.socket:
    _prepare_socket_path(path)
    server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous_umask = os.umask(0o177)
    try:
        server_socket.bind(path)
        os.chmod(path, 0o600)
        server_socket.listen(2048)
    except Exception:
        server_socket.close()
        raise
    finally:
        os.umask(previous_umask)
    return server_socket


@app.post("/agent/validate-sql", dependencies=[Depends(require_internal_http_auth)])
def agent_validate_sql(request: AgentSqlValidationRequest) -> dict[str, Any]:
    return service.validate_sql_for_user(
        request.request_user_union_id,
        request.request_user_open_id,
        request.sql,
        request.datasource,
        request.request_lark_app_id,
        request.request_user_tchouse_account,
        audit_context=request.audit_context(),
        repair_chain_id=request.repair_chain_id,
        execution_mode=request.execution_mode,
    )


@app.post("/agent/run-query", dependencies=[Depends(require_internal_http_auth)])
def agent_run_query(request: AgentSqlRequest) -> dict[str, Any]:
    return service.run_query_for_user(
        request.request_user_union_id,
        request.request_user_open_id,
        request.sql,
        request.datasource,
        request.request_lark_app_id,
        request.request_user_tchouse_account,
        audit_context=request.audit_context(),
        query_plan_id=request.query_plan_id,
    )


@app.post("/agent/export-query-excel-file", dependencies=[Depends(require_internal_http_auth)])
def agent_export_query_excel_file(request: AgentExportRequest) -> dict[str, Any]:
    return service.export_query_to_excel_file(
        request.request_user_union_id,
        request.request_user_open_id,
        request.sql,
        request.datasource,
        request.request_lark_app_id,
        request.request_user_tchouse_account,
        request.filename,
        request.max_export_rows,
        audit_context=request.audit_context(),
        query_plan_id=request.query_plan_id,
        expected_source_version=request.expected_source_version,
    )


@app.post("/agent/refresh-metadata-snapshot", dependencies=[Depends(require_internal_http_auth)])
def agent_refresh_metadata_snapshot(request: MetadataSnapshotRefreshRequest) -> dict[str, Any]:
    return service.refresh_metadata_snapshot_for_owner(
        request.request_user_union_id,
        request.request_user_open_id,
        request.request_lark_app_id,
        audit_context=request.audit_context(),
    )


@app.post("/agent/search-metadata-snapshot", dependencies=[Depends(require_internal_http_auth)])
def agent_search_metadata_snapshot(request: MetadataSnapshotSearchRequest) -> dict[str, Any]:
    return service.search_metadata_snapshot(
        query=request.query,
        limit=request.limit,
        priority=request.priority,
    )


@app.post("/agent/inspect-ck-subjects-by-table", dependencies=[Depends(require_internal_http_auth)])
def agent_inspect_ck_subjects_by_table(request: SubjectsByTableRequest) -> dict[str, Any]:
    return service.inspect_ck_subjects_by_table(
        request.request_user_union_id,
        request.request_user_open_id,
        request.request_lark_app_id,
        request.target_tables,
        audit_context=request.audit_context(),
    )


@app.post(
    "/agent/inspect-ck-resources-by-subject", dependencies=[Depends(require_internal_http_auth)]
)
def agent_inspect_ck_resources_by_subject(request: ResourcesBySubjectRequest) -> dict[str, Any]:
    return service.inspect_ck_resources_by_subject(
        request.request_user_union_id,
        request.request_user_open_id,
        request.request_lark_app_id,
        request.target_accounts,
        request.target_roles,
        audit_context=request.audit_context(),
    )


@app.post(
    "/agent/audit-ck-default-role-baseline", dependencies=[Depends(require_internal_http_auth)]
)
def agent_audit_ck_default_role_baseline(
    request: MetadataSnapshotRefreshRequest,
) -> dict[str, Any]:
    return service.audit_ck_default_role_baseline(
        request.request_user_union_id,
        request.request_user_open_id,
        request.request_lark_app_id,
        audit_context=request.audit_context(),
    )


def main() -> None:
    global _SERVING_UNIX_SOCKET
    if _tcp_bind_enabled():
        _SERVING_UNIX_SOCKET = False
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=8765,
            reload=False,
        )
        return

    socket_path = _socket_path()
    server_socket = _bind_unix_socket(socket_path)
    _SERVING_UNIX_SOCKET = True
    try:
        uvicorn.run(
            app,
            fd=server_socket.fileno(),
            reload=False,
        )
    finally:
        server_socket.close()


if __name__ == "__main__":
    main()
