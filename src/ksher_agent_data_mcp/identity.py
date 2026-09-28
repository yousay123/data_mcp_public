from __future__ import annotations

from typing import Any

INJECT_TOOLS = (
    "validate_sql_for_user",
    "run_query_for_user",
    "export_query_to_excel_file",
    "refresh_metadata_snapshot",
)
AGENT_VISIBLE_ARGUMENTS = (
    "sql",
    "datasource",
    "execution_mode",
    "filename",
    "max_export_rows",
    "query",
    "limit",
    "priority",
)
REQUIRED_IDENTITY_FIELDS = ("request_user_union_id",)
OPTIONAL_IDENTITY_FIELDS = (
    "request_user_open_id",
    "request_lark_app_id",
    "caller_source",
    "caller_sender_type",
    "caller_session_id",
    "caller_task_id",
    "caller_turn_id",
    "caller_captured_at",
)
HIDDEN_IDENTITY_FIELDS = (
    "request_user_union_id",
    "request_user_open_id",
    "request_lark_app_id",
    "caller_source",
    "caller_sender_type",
    "caller_session_id",
    "caller_task_id",
    "caller_turn_id",
    "caller_captured_at",
    "request_user_tchouse_account",
    "requestUserUnionId",
    "requestUserOpenId",
    "requestLarkAppId",
    "callerSource",
    "callerSenderType",
    "callerSessionId",
    "callerTaskId",
    "callerTurnId",
    "callerCapturedAt",
    "source",
    "senderType",
    "session_id",
    "sessionId",
    "taskId",
    "turnId",
    "capturedAt",
    "requestUserTchouseAccount",
    "union_id",
    "unionId",
    "open_id",
    "openId",
    "lark_app_id",
    "larkAppId",
    "request_app_id",
    "requestAppId",
    "app_id",
    "appId",
    "tchouse_account",
)

IDENTITY_ARGUMENT_ALIASES = {
    "request_user_union_id": (
        "request_user_union_id",
        "requestUserUnionId",
        "union_id",
        "unionId",
    ),
    "request_user_open_id": (
        "request_user_open_id",
        "requestUserOpenId",
        "open_id",
        "openId",
    ),
    "request_lark_app_id": (
        "request_lark_app_id",
        "requestLarkAppId",
        "lark_app_id",
        "larkAppId",
        "request_app_id",
        "requestAppId",
        "app_id",
        "appId",
    ),
    # Audit-only caller fields are accepted only from BotMux-injected hidden
    # arguments. Remove these aliases before any model-writable stdio identity
    # path is enabled again.
    "caller_source": ("caller_source", "callerSource", "source"),
    "caller_sender_type": ("caller_sender_type", "callerSenderType", "sender_type", "senderType"),
    "caller_session_id": ("caller_session_id", "callerSessionId", "session_id", "sessionId"),
    "caller_task_id": ("caller_task_id", "callerTaskId", "task_id", "taskId"),
    "caller_turn_id": ("caller_turn_id", "callerTurnId", "turn_id", "turnId"),
    "caller_captured_at": ("caller_captured_at", "callerCapturedAt", "captured_at", "capturedAt"),
}


def extract_hidden_identity(arguments: dict[str, Any]) -> dict[str, str | None]:
    return {
        canonical: _first_string(arguments, *aliases)
        for canonical, aliases in IDENTITY_ARGUMENT_ALIASES.items()
    }


def identity_contract() -> dict[str, Any]:
    return {
        "identity_source": "botmux_trusted_turn_hidden_arguments",
        "inject_tools": list(INJECT_TOOLS),
        "required_identity_fields": list(REQUIRED_IDENTITY_FIELDS),
        "optional_identity_fields": list(OPTIONAL_IDENTITY_FIELDS),
        "accepted_argument_aliases": {
            key: list(value) for key, value in IDENTITY_ARGUMENT_ALIASES.items()
        },
        "hidden_schema_fields": list(HIDDEN_IDENTITY_FIELDS),
        "agent_visible_arguments": list(AGENT_VISIBLE_ARGUMENTS),
        "fail_closed_error_codes": [
            "missing_union_id",
            "query_plan_session_required",
            "query_plan_app_required",
        ],
        "notes": [
            "Data MCP trusts only hidden arguments injected by BotMux or its identity proxy.",
            "The model-visible tool schema must not expose identity fields.",
            "Database credentials are resolved server-side from union_id and are never accepted from the model.",
        ],
    }


def _first_string(arguments: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = arguments.get(name)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
    return None
