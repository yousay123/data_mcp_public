import os
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from pydantic import Field

from ksher_agent_data_mcp import __version__
from ksher_agent_data_mcp.config import get_settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.identity import extract_hidden_identity, identity_contract
from ksher_agent_data_mcp.tools.service import DataMcpService

ENABLE_STANDALONE_STDIO_ENV = "KSHER_AGENT_DATA_MCP_ENABLE_STANDALONE_STDIO"
settings = get_settings()
mcp = MCPServer(settings.server_name, version=__version__)
service = DataMcpService(build_container(settings))
_original_mcp_run = mcp.run


def _assert_standalone_stdio_enabled() -> None:
    if os.getenv(ENABLE_STANDALONE_STDIO_ENV) in {"1", "true", "TRUE", "yes", "YES"}:
        return
    raise SystemExit(
        "Refusing to start standalone Python Data MCP stdio server. "
        f"Use the BotMux Data MCP wrapper, or set {ENABLE_STANDALONE_STDIO_ENV}=1 "
        "only for local compatibility tests."
    )


def _guarded_mcp_run(*args: Any, **kwargs: Any) -> Any:
    _assert_standalone_stdio_enabled()
    return _original_mcp_run(*args, **kwargs)


mcp.run = _guarded_mcp_run


def _hidden_identity_arguments(ctx: Context) -> dict[str, str | None]:
    input_params = getattr(ctx, "_input_params", None)
    raw_arguments = getattr(input_params, "arguments", None) or {}
    if not isinstance(raw_arguments, dict):
        raw_arguments = {}

    return extract_hidden_identity(raw_arguments)


def _required_hidden_identity(ctx: Context | None) -> dict[str, str | None]:
    identity = _hidden_identity_arguments(ctx) if ctx is not None else {}
    if not identity.get("request_user_union_id"):
        raise ValueError(
            "missing_trusted_identity: standalone Python MCP calls must use the "
            "BotMux Data MCP wrapper"
        )
    return identity


def _audit_context(identity: dict[str, str | None]) -> dict[str, str | None]:
    return {
        "caller_source": identity.get("caller_source"),
        "sender_type": identity.get("caller_sender_type"),
        "session_id": identity.get("caller_session_id"),
        "task_id": identity.get("caller_task_id"),
        "turn_id": identity.get("caller_turn_id"),
        "captured_at": identity.get("caller_captured_at"),
    }


@mcp.tool()
def validate_sql_for_user(
    sql: str,
    datasource: Literal["tchouse-c"] = "tchouse-c",
    repair_chain_id: str | None = None,
    execution_mode: Literal["single", "compare"] = "single",
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Validate read-only SQL using the turn-snapshot identity injected by the agent host."""
    identity = _required_hidden_identity(ctx)
    return service.validate_sql_for_user(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        sql=sql,
        datasource=datasource,
        audit_context=_audit_context(identity),
        repair_chain_id=repair_chain_id,
        execution_mode=execution_mode,
    )


@mcp.tool()
def run_query_for_user(
    sql: str,
    query_plan_id: str,
    datasource: Literal["tchouse-c"] = "tchouse-c",
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Execute read-only SQL using the turn-snapshot identity injected by the agent host."""
    identity = _required_hidden_identity(ctx)
    return service.run_query_for_user(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        sql=sql,
        datasource=datasource,
        query_plan_id=query_plan_id,
        audit_context=_audit_context(identity),
    )


@mcp.tool()
def export_query_to_excel_file(
    sql: str,
    query_plan_id: str,
    datasource: Literal["tchouse-c"] = "tchouse-c",
    filename: str | None = None,
    max_export_rows: Annotated[int, Field(ge=1)] | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Export a validated read-only query to a local Excel file artifact."""
    identity = _required_hidden_identity(ctx)
    return service.export_query_to_excel_file(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        sql=sql,
        datasource=datasource,
        filename=filename,
        max_export_rows=max_export_rows,
        query_plan_id=query_plan_id,
        audit_context=_audit_context(identity),
    )


@mcp.tool()
def refresh_metadata_snapshot(ctx: Context | None = None) -> dict[str, Any]:
    """Refresh the signed local metadata snapshot from a schedule_creator turn only."""
    identity = _required_hidden_identity(ctx)
    return service.refresh_metadata_snapshot_for_owner(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        audit_context=_audit_context(identity),
    )


@mcp.tool()
def search_metadata_snapshot(
    query: str,
    limit: int = 20,
    priority: str | None = None,
) -> dict[str, Any]:
    """Search the signed local metadata snapshot for candidate recall only."""
    return service.search_metadata_snapshot(query=query, limit=limit, priority=priority)


@mcp.tool()
def inspect_ck_subjects_by_table(
    target_tables: list[str], ctx: Context | None = None
) -> dict[str, Any]:
    """List direct/inherited ClickHouse access holders for explicit tables."""
    identity = _required_hidden_identity(ctx)
    return service.inspect_ck_subjects_by_table(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        target_tables=target_tables,
        audit_context=_audit_context(identity),
    )


@mcp.tool()
def inspect_ck_resources_by_subject(
    target_accounts: list[str] | None = None,
    target_roles: list[str] | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List direct/inherited ClickHouse resources for explicit accounts or roles."""
    identity = _required_hidden_identity(ctx)
    return service.inspect_ck_resources_by_subject(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        target_accounts=target_accounts or [],
        target_roles=target_roles or [],
        audit_context=_audit_context(identity),
    )


@mcp.tool()
def audit_ck_default_role_baseline(ctx: Context | None = None) -> dict[str, Any]:
    """Schedule-only entry-point DEFAULT ROLE ALL baseline; returns anomalies only."""
    identity = _required_hidden_identity(ctx)
    return service.audit_ck_default_role_baseline(
        request_user_union_id=identity["request_user_union_id"],
        request_user_open_id=identity.get("request_user_open_id"),
        request_lark_app_id=identity.get("request_lark_app_id"),
        audit_context=_audit_context(identity),
    )


def get_runtime_diagnostics() -> dict[str, Any]:
    """Redacted runtime contract for ops/BotMux identity-chain checks.

    NOT registered as an MCP tool on purpose: exposing accepted_argument_aliases /
    hidden_schema_fields to the model would hand a prompt-injection attacker the exact
    field names to stuff into a tool call. Keep this diagnostic behind an authenticated
    operator path; the public HTTP /health endpoint intentionally omits these details.
    """
    return {
        "status": "ok",
        "service": settings.server_name,
        "version": __version__,
        "env": settings.env,
        "metadata_provider": settings.metadata_provider,
        "credential_provider": settings.credential_provider,
        "query_executor": settings.query_executor,
        "mcp_identity_contract": identity_contract(),
        "stdio": {
            "server": "python-mcp-sdk",
            "botmux_proxy_required_for_identity": True,
            "protocol_compatibility_owner": "botmux_identity_proxy",
        },
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
