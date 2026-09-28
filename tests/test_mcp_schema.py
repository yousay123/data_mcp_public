import os
import subprocess
import sys
from pathlib import Path

import anyio
from fastapi.testclient import TestClient
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from ksher_agent_data_mcp.api import app

SMOKE_TEST_SQL = (
    "SELECT count() AS cnt FROM analytics.metadata_dictionary "
    "WHERE ds = (SELECT max(ds) FROM analytics.metadata_dictionary)"
)
REPO_ROOT = Path(__file__).resolve().parents[1]


def test_tools_list_hides_injected_identity_fields() -> None:
    async def run() -> None:
        async with stdio_client(_server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools

        hidden_fields = {
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
            "open_id",
            "tchouse_account",
        }
        query_tools = [
            tool
            for tool in tools
            if tool.name
            in {
                "validate_sql_for_user",
                "run_query_for_user",
                "export_query_to_excel_file",
                "refresh_metadata_snapshot",
                "search_metadata_snapshot",
            }
        ]
        assert len(query_tools) == 5
        for tool in query_tools:
            properties = tool.input_schema["properties"]
            assert set(properties).isdisjoint(hidden_fields)
            if tool.name == "validate_sql_for_user":
                assert set(properties) == {
                    "sql",
                    "datasource",
                    "repair_chain_id",
                    "execution_mode",
                }
                assert tool.input_schema["required"] == ["sql"]
            elif tool.name == "run_query_for_user":
                assert set(properties) == {"sql", "datasource", "query_plan_id"}
                assert tool.input_schema["required"] == ["sql", "query_plan_id"]
            elif tool.name == "export_query_to_excel_file":
                assert set(properties) == {
                    "sql",
                    "datasource",
                    "query_plan_id",
                    "filename",
                    "max_export_rows",
                }
                assert tool.input_schema["required"] == ["sql", "query_plan_id"]
            elif tool.name == "refresh_metadata_snapshot":
                assert properties == {}
            else:
                assert set(properties) == {"query", "limit", "priority"}
                assert tool.input_schema["required"] == ["query"]

            if tool.name in {
                "validate_sql_for_user",
                "run_query_for_user",
                "export_query_to_excel_file",
            }:
                assert properties["datasource"]["const"] == "tchouse-c"
        validate_tool = next(tool for tool in tools if tool.name == "validate_sql_for_user")
        assert validate_tool.input_schema["properties"]["execution_mode"]["enum"] == [
            "single",
            "compare",
        ]
        removed_tool_name = "audit_ck_" + "access_consistency"
        assert removed_tool_name not in {tool.name for tool in tools}

        baseline_tool = next(
            tool for tool in tools if tool.name == "audit_ck_default_role_baseline"
        )
        assert baseline_tool.input_schema["properties"] == {}
        subjects_tool = next(tool for tool in tools if tool.name == "inspect_ck_subjects_by_table")
        assert set(subjects_tool.input_schema["properties"]) == {"target_tables"}
        assert subjects_tool.input_schema["required"] == ["target_tables"]
        resources_tool = next(
            tool for tool in tools if tool.name == "inspect_ck_resources_by_subject"
        )
        assert set(resources_tool.input_schema["properties"]) == {
            "target_accounts",
            "target_roles",
        }
        for tool in (subjects_tool, resources_tool):
            assert "sql" not in tool.input_schema["properties"]
            assert set(tool.input_schema["properties"]).isdisjoint(hidden_fields)

    anyio.run(run)


def test_tool_call_uses_hidden_identity_arguments() -> None:
    async def run() -> None:
        async with stdio_client(_server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                validate_result = await session.call_tool(
                    "validate_sql_for_user",
                    {
                        "request_user_union_id": "on_example_user",
                        "request_user_open_id": "ou_example_user",
                        "request_lark_app_id": "cli_example",
                        "caller_sender_type": "user",
                        "caller_session_id": "session_example",
                        "sql": SMOKE_TEST_SQL,
                    },
                )
                assert validate_result.structured_content is not None
                query_plan_id = validate_result.structured_content["query_plan_id"]
                result = await session.call_tool(
                    "run_query_for_user",
                    {
                        "request_user_union_id": "on_example_user",
                        "request_user_open_id": "ou_example_user",
                        "request_lark_app_id": "cli_example",
                        "caller_sender_type": "user",
                        "caller_session_id": "session_example",
                        "sql": SMOKE_TEST_SQL,
                        "query_plan_id": query_plan_id,
                    },
                )

        assert result.structured_content is not None
        assert result.structured_content["status"] == "success"
        assert result.structured_content["sql_account_binding"] == {
            "datasource": "tchouse-c",
            "tables": ["analytics.metadata_dictionary"],
            "resolved_by": "mcp_union_id_mapping",
            "account_bound": True,
        }
        assert "demo_tchouse_user" not in str(result.structured_content)

    anyio.run(run)


def test_tool_call_exposes_unresolved_credential_reason() -> None:
    async def run() -> None:
        async with stdio_client(_server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                validate_result = await session.call_tool(
                    "validate_sql_for_user",
                    {
                        "request_user_union_id": "on_missing_user",
                        "request_user_open_id": "ou_missing_user",
                        "request_lark_app_id": "cli_example",
                        "caller_sender_type": "user",
                        "caller_session_id": "session_example",
                        "sql": SMOKE_TEST_SQL,
                    },
                )
                assert validate_result.structured_content is not None
                query_plan_id = validate_result.structured_content["query_plan_id"]
                result = await session.call_tool(
                    "run_query_for_user",
                    {
                        "request_user_union_id": "on_missing_user",
                        "request_user_open_id": "ou_missing_user",
                        "request_lark_app_id": "cli_example",
                        "caller_sender_type": "user",
                        "caller_session_id": "session_example",
                        "sql": SMOKE_TEST_SQL,
                        "query_plan_id": query_plan_id,
                    },
                )

        assert result.structured_content is not None
        assert result.structured_content["status"] == "not_found"
        assert result.structured_content["issues"][0]["code"] == "account_mapping_unavailable"
        assert result.structured_content["sql_account_binding"] == {
            "datasource": "tchouse-c",
            "tables": [],
            "resolved_by": None,
            "account_bound": False,
            "unresolved_reason": "account_mapping_unavailable",
        }

    anyio.run(run)


def test_tool_call_accepts_request_app_id_alias() -> None:
    async def run() -> None:
        async with stdio_client(_server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "validate_sql_for_user",
                    {
                        "request_user_union_id": "on_example_user",
                        "request_user_open_id": "ou_example_user",
                        "request_app_id": "cli_example",
                        "caller_sender_type": "user",
                        "caller_session_id": "session_example",
                        "sql": SMOKE_TEST_SQL,
                    },
                )

        assert result.structured_content is not None
        assert result.structured_content["status"] == "success"

    anyio.run(run)


def test_runtime_diagnostics_is_not_agent_visible_and_health_hides_aliases() -> None:
    async def run() -> None:
        async with stdio_client(_server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools
        assert {tool.name for tool in tools}.isdisjoint({"get_runtime_diagnostics"})

        response = TestClient(app).get("/health")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert "mcp_identity_contract" not in payload
        assert payload["stdio"]["standalone_enabled_by_default"] is False

        serialized = str(payload)
        for blocked in (
            "password",
            "jdbc:",
            "192.0.2.",
            "user_credential_mapping",
            "example_sensitive_field",
            "requestUserUnionId",
            "union_id",
            "senderType",
            "tchouse_account",
        ):
            assert blocked not in serialized

    anyio.run(run)


def test_standalone_stdio_refuses_to_start_without_opt_in() -> None:
    env = os.environ.copy()
    env.pop("KSHER_AGENT_DATA_MCP_ENABLE_STANDALONE_STDIO", None)

    proc = subprocess.run(
        [sys.executable, "-m", "ksher_agent_data_mcp.server"],
        input="",
        text=True,
        capture_output=True,
        timeout=5,
        env={
            **env,
            "PYTHONPATH": "src",
            "MCP_ENV": "dev",
            "CREDENTIAL_PROVIDER": "memory",
            "METADATA_PROVIDER": "memory",
            "QUERY_EXECUTOR": "dry_run",
        },
    )

    assert proc.returncode != 0
    assert "Refusing to start standalone Python Data MCP stdio server" in proc.stderr


def test_tool_call_missing_identity_does_not_disclose_field_names() -> None:
    async def run() -> None:
        async with stdio_client(_server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "validate_sql_for_user",
                    {
                        "sql": SMOKE_TEST_SQL,
                    },
                )

        text = str(result)
        assert result.is_error is True
        assert "Error executing tool validate_sql_for_user" in text
        assert "request_user_union_id" not in text
        assert "union_id" not in text

    anyio.run(run)


def test_imported_mcp_run_refuses_without_opt_in() -> None:
    env = os.environ.copy()
    env.pop("KSHER_AGENT_DATA_MCP_ENABLE_STANDALONE_STDIO", None)

    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "from ksher_agent_data_mcp.server import mcp; mcp.run()",
        ],
        text=True,
        capture_output=True,
        timeout=5,
        env={
            **env,
            "PYTHONPATH": "src",
            "MCP_ENV": "dev",
            "CREDENTIAL_PROVIDER": "memory",
            "METADATA_PROVIDER": "memory",
            "QUERY_EXECUTOR": "dry_run",
        },
    )

    assert proc.returncode != 0
    assert "Refusing to start standalone Python Data MCP stdio server" in proc.stderr


def _server_params() -> StdioServerParameters:
    return StdioServerParameters(
        command=str(REPO_ROOT / ".venv" / "bin" / "python"),
        args=["-m", "ksher_agent_data_mcp.server"],
        cwd=str(REPO_ROOT),
        env={
            "PYTHONPATH": "src",
            "KSHER_AGENT_DATA_MCP_ENABLE_STANDALONE_STDIO": "1",
            "MCP_ENV": "dev",
            "CREDENTIAL_PROVIDER": "memory",
            "CREDENTIAL_MEMORY_FILE": "examples/credentials.example.json",
            "METADATA_PROVIDER": "memory",
            "QUERY_EXECUTOR": "dry_run",
        },
    )
