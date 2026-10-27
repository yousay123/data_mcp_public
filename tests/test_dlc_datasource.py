import base64
import json
import subprocess
from pathlib import Path

import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.datasources.dlc import (
    DlcApiClient,
    DlcApiError,
    DlcMetadataCatalog,
    DlcPrincipalResolver,
    DlcQueryExecutor,
)
from ksher_agent_data_mcp.credentials.base import (
    CredentialBackendUnavailable,
    CredentialConfigurationMissing,
    CredentialMappingUnavailable,
)
from ksher_agent_data_mcp.datasources.registry import DataSourceAdapter, DataSourceRegistry
from ksher_agent_data_mcp.db.sql_guard import SqlGuard
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.metadata.catalog import MetadataAccessDenied
from ksher_agent_data_mcp.models.contracts import ResultClass, Status, UserContext


class FakeDlcClient:
    def __init__(
        self,
        *,
        row_filter: bool = False,
        engine_type: str = "presto",
        task_state: int = 2,
    ) -> None:
        self.calls = []
        self.row_filter = row_filter
        self.engine_type = engine_type
        self.task_state = task_state

    def call(self, action, payload, timeout=90):
        self.calls.append((action, payload, timeout))
        if action == "DescribeUserInfo":
            info_type = payload["Type"]
            policy = {
                "Catalog": "DataLakeCatalog",
                "Database": "analytics",
                "Table": "orders",
                "Operation": "SELECT",
                "PolicyType": "TABLE",
                "Source": "USER",
            }
            engine = {
                "DataEngine": "shared-presto",
                "Operation": "USE",
                "PolicyType": "ENGINE",
            }
            key = {
                "DataAuth": "DataPolicyInfo",
                "EngineAuth": "EnginePolicyInfo",
                "RowFilter": "RowFilterInfo",
            }[info_type]
            rows = (
                [policy]
                if info_type == "DataAuth"
                else [engine]
                if info_type == "EngineAuth"
                else [{"Database": "analytics", "Table": "orders"}]
                if self.row_filter
                else []
            )
            return {
                "UserInfo": {
                    "UserType": "COMMON",
                    key: {"PolicySet": rows, "TotalCount": len(rows)},
                }
            }
        if action == "DescribeDataEngines":
            return {
                "DataEngines": [
                    {
                        "DataEngineName": "shared-presto",
                        "EngineType": self.engine_type,
                    }
                ],
                "TotalCount": 1,
            }
        if action == "DescribeTable":
            return {
                "Table": {
                    "TableBaseInfo": {"TableComment": "orders"},
                    "Columns": [{"Name": "order_id", "Type": "bigint"}],
                    "Partitions": [{"Name": "dt", "Type": "string"}],
                }
            }
        if action == "CreateTasks":
            assert base64.b64decode(payload["Tasks"]["SQL"]).decode().startswith("SELECT")
            return {"BatchId": "batch-1", "TaskIdSet": ["task-1"]}
        if action == "DescribeTasks":
            return {
                "TaskList": [
                    {"Id": "task-1", "State": self.task_state, "DataAmount": 12}
                ]
            }
        if action == "DescribeTaskResult":
            return {
                "TaskInfo": {
                    "State": 2,
                    "DataAmount": 12,
                    "ResultSchema": [{"Name": "order_id", "Type": "BIGINT"}],
                    "ResultSet": '[["42"]]',
                    "NextToken": "",
                }
            }
        raise AssertionError(action)


def dlc_settings(tmp_path):
    mapping = tmp_path / "principals.json"
    mapping.write_text(
        json.dumps(
            {
                "principals": [
                    {
                        "user_union_id": "on_user",
                        "cam_uin": "700000000001",
                        "enabled": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return Settings(
        DATA_MCP_DLC_DEFAULT_DATABASE="analytics",
        DATA_MCP_DLC_DATA_ENGINE_NAME="shared-presto",
        DATA_MCP_DLC_PRINCIPAL_MAPPING_FILE=mapping,
        REQUIRE_PARTITION_FILTER=False,
    )


def test_registry_rejects_duplicate_datasource(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient()
    catalog = DlcMetadataCatalog(settings, client)
    adapter = DataSourceAdapter(
        datasource="dlc",
        adapter="tencent_dlc",
        credentials=DlcPrincipalResolver(settings, client),
        sql_guard=SqlGuard(settings, catalog, datasource="dlc", dialect="presto"),
        executor=DlcQueryExecutor(settings, client),
    )
    with pytest.raises(ValueError, match="Duplicate"):
        DataSourceRegistry([adapter, adapter])


def test_static_mapping_skips_blank_and_disabled_rows(tmp_path):
    settings = dlc_settings(tmp_path)
    mapping = tmp_path / "principals.json"
    mapping.write_text(
        json.dumps(
            {
                "principals": [
                    {"user_union_id": "on_blank", "cam_uin": "700000000001"},
                    {
                        "user_union_id": "on_disabled",
                        "cam_uin": "700000000002",
                        "status": "停用",
                    },
                    {
                        "union_id": "on_enabled",
                        "cam_uin": "700000000003",
                        "status": "启用",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    settings = settings.model_copy(update={"dlc_principal_mapping_file": mapping})
    resolver = DlcPrincipalResolver(settings, FakeDlcClient())

    with pytest.raises(CredentialMappingUnavailable):
        resolver.resolve(UserContext(union_id="on_blank"))
    with pytest.raises(CredentialMappingUnavailable):
        resolver.resolve(UserContext(union_id="on_disabled"))
    assert resolver.resolve(UserContext(union_id="on_enabled")).cam_uin == "700000000003"


@pytest.mark.parametrize(
    "rows",
    [
        [
            {"user_union_id": "on_same", "cam_uin": "700000000001", "enabled": True},
            {"user_union_id": "on_same", "cam_uin": "700000000002", "enabled": True},
        ],
        [
            {"user_union_id": "on_first", "cam_uin": "700000000001", "enabled": True},
            {"user_union_id": "on_second", "cam_uin": "700000000001", "enabled": True},
        ],
    ],
)
def test_static_mapping_rejects_ambiguous_active_identity(rows, tmp_path):
    settings = dlc_settings(tmp_path)
    mapping = tmp_path / "principals.json"
    mapping.write_text(json.dumps({"principals": rows}), encoding="utf-8")
    settings = settings.model_copy(update={"dlc_principal_mapping_file": mapping})

    with pytest.raises(CredentialConfigurationMissing, match="conflicting|multiple"):
        DlcPrincipalResolver(settings, FakeDlcClient())


def test_build_container_loads_only_configured_adapters(tmp_path):
    settings = dlc_settings(tmp_path)
    token_file = tmp_path / "signer.token"
    token_file.write_text("test-token", encoding="utf-8")
    settings = settings.model_copy(
        update={
            "enabled_datasources": "tchouse-c,dlc",
            "dlc_signer_token_file": token_file,
        }
    )

    container = build_container(settings)

    assert container.data_sources is not None
    assert container.data_sources.ids == ("tchouse-c", "dlc")
    assert container.data_sources.require("dlc").adapter == "tencent_dlc"


def test_dlc_resolves_caller_permissions_validates_and_executes(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient()
    resolver = DlcPrincipalResolver(settings, client)
    principal = resolver.resolve(UserContext(union_id="on_user"))
    assert principal is not None
    assert principal.cam_uin == "700000000001"
    assert principal.engine_allowed is True
    assert principal.data_engine_type == "presto"

    catalog = DlcMetadataCatalog(settings, client)
    guard = SqlGuard(settings, catalog, datasource="dlc", dialect="presto")
    validation = guard.validate(
        UserContext(union_id="on_user"),
        "SELECT order_id FROM analytics.orders",
        datasource="dlc",
        credential=principal,
    )
    assert validation.status == Status.SUCCESS
    assert validation.tables == ["analytics.orders"]

    result = DlcQueryExecutor(settings, client).run(
        principal,
        validation.normalized_sql or "",
        timeout_seconds=10,
    )
    assert result.status == Status.SUCCESS
    assert result.rows == [{"order_id": "42"}]
    assert result.read_bytes == 12
    actions = [action for action, _, _ in client.calls]
    assert actions.index("CreateTasks") < actions.index("DescribeTasks")
    assert actions.index("DescribeTasks") < actions.index("DescribeTaskResult")
    create_payload = next(payload for action, payload, _ in client.calls if action == "CreateTasks")
    assert create_payload["Tasks"]["TaskType"] == "SQLTask"
    assert create_payload["Tasks"]["FailureTolerance"] == "Terminate"


def test_dlc_uses_spark_sql_task_for_spark_engine(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient(engine_type="spark")
    principal = DlcPrincipalResolver(settings, client).resolve(UserContext(union_id="on_user"))

    result = DlcQueryExecutor(settings, client).run(
        principal,
        "SELECT order_id FROM analytics.orders",
        timeout_seconds=10,
    )

    assert result.status == Status.SUCCESS
    create_payload = next(payload for action, payload, _ in client.calls if action == "CreateTasks")
    assert create_payload["Tasks"]["TaskType"] == "SparkSQLTask"


def test_dlc_fails_closed_for_unknown_engine_type(tmp_path):
    settings = dlc_settings(tmp_path)

    with pytest.raises(CredentialBackendUnavailable, match="unsupported_engine_type"):
        DlcPrincipalResolver(settings, FakeDlcClient(engine_type="hive")).resolve(
            UserContext(union_id="on_user")
        )


def test_dlc_failed_task_does_not_fetch_result(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient(task_state=-1)
    principal = DlcPrincipalResolver(settings, client).resolve(UserContext(union_id="on_user"))

    result = DlcQueryExecutor(settings, client).run(
        principal,
        "SELECT order_id FROM analytics.orders",
        timeout_seconds=10,
    )

    assert result.status == Status.ERROR
    assert result.error_code == "query_failed"
    assert not any(action == "DescribeTaskResult" for action, _, _ in client.calls)


def test_dlc_denies_unlisted_table_before_describe(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient()
    principal = DlcPrincipalResolver(settings, client).resolve(UserContext(union_id="on_user"))
    catalog = DlcMetadataCatalog(settings, client)

    with pytest.raises(MetadataAccessDenied):
        catalog.describe_table("analytics.payments", principal)
    assert not any(action == "DescribeTable" for action, _, _ in client.calls)


def test_dlc_rejects_cross_catalog_sql(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient()
    principal = DlcPrincipalResolver(settings, client).resolve(UserContext(union_id="on_user"))
    catalog = DlcMetadataCatalog(settings, client)
    guard = SqlGuard(settings, catalog, datasource="dlc", dialect="presto")

    result = guard.validate(
        UserContext(union_id="on_user"),
        "SELECT order_id FROM OtherCatalog.analytics.orders",
        datasource="dlc",
        credential=principal,
    )

    assert result.status == Status.VALIDATION_ERROR
    assert "dlc_catalog_mismatch" in {issue.code for issue in result.issues}


def test_dlc_fails_closed_for_row_filter(tmp_path):
    settings = dlc_settings(tmp_path)
    client = FakeDlcClient(row_filter=True)
    principal = DlcPrincipalResolver(settings, client).resolve(UserContext(union_id="on_user"))
    assert principal is not None and principal.has_row_filters

    result = DlcQueryExecutor(settings, client).run(principal, "SELECT 1", timeout_seconds=10)
    assert result.status == Status.ERROR
    assert result.result_class == ResultClass.POLICY_ERROR
    assert result.error_code == "fine_grained_policy_not_supported"
    assert not any(action == "CreateTasks" for action, _, _ in client.calls)


def test_skill_tc_call_mode_fails_closed_for_invalid_skill_response(tmp_path, monkeypatch):
    settings = dlc_settings(tmp_path).model_copy(
        update={"dlc_auth_mode": "skill_tc_call", "dlc_tc_call_path": Path(__file__)}
    )
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args, returncode=1, stdout='{"SignerError":{"code":"no_credentials"}}', stderr=""
        ),
    )

    with pytest.raises(DlcApiError, match="Skill 鉴权失败"):
        DlcApiClient(settings).call("DescribeUsers", {})


def test_skill_tc_call_uses_private_payload_file_not_command_line(tmp_path, monkeypatch):
    script = tmp_path / "tc_call.py"
    script.write_text("# test fixture\n", encoding="utf-8")
    settings = dlc_settings(tmp_path).model_copy(
        update={
            "dlc_auth_mode": "skill_tc_call",
            "dlc_tc_call_path": script,
        }
    )
    monkeypatch.setenv("TENCENTCLOUD_SECRET_ID", "inherited-secret-id")
    monkeypatch.setenv("TENCENTCLOUD_SECRET_KEY", "inherited-secret-key")
    captured = {}

    def fake_run(args, **kwargs):
        payload_arg = args[args.index("--payload") + 1]
        payload_path = Path(payload_arg.removeprefix("@"))
        captured["args"] = args
        captured["payload"] = json.loads(payload_path.read_text(encoding="utf-8"))
        captured["mode"] = payload_path.stat().st_mode & 0o777
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout='{"Response":{"Users":[]}}', stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    response = DlcApiClient(settings).call("DescribeUsers", {"Filter": "SELECT secret"})

    assert response == {"Users": []}
    assert captured["payload"] == {"Filter": "SELECT secret"}
    assert captured["mode"] == 0o600
    assert "SELECT secret" not in " ".join(captured["args"])
    assert captured["env"]["TENCENTCLOUD_SECRET_ID"] == "inherited-secret-id"
    assert captured["env"]["TENCENTCLOUD_SECRET_KEY"] == "inherited-secret-key"
    assert "TC_SIGNER_TOKEN_FILE" not in captured["env"]


def test_skill_tc_call_can_load_existing_interactive_zsh_environment(tmp_path, monkeypatch):
    script = tmp_path / "tc_call.py"
    script.write_text("# test fixture\n", encoding="utf-8")
    settings = dlc_settings(tmp_path).model_copy(
        update={
            "dlc_auth_mode": "skill_tc_call",
            "dlc_tc_call_path": script,
            "dlc_tc_call_env_mode": "zsh_interactive",
            "dlc_tc_call_shell": Path("/bin/zsh"),
        }
    )
    captured = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout='{"Response":{"Users":[]}}', stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    DlcApiClient(settings).call("DescribeUsers", {})

    assert captured["args"][:4] == ["/bin/zsh", "-ic", 'exec "$@"', "data-mcp-tc-call"]
    assert captured["args"][4] == __import__("sys").executable
    assert captured["args"][5] == str(script)


def test_build_container_accepts_static_mapping_with_skill_tc_call(tmp_path):
    settings = dlc_settings(tmp_path).model_copy(
        update={
            "enabled_datasources": "dlc",
            "dlc_auth_mode": "skill_tc_call",
            "dlc_tc_call_path": Path(__file__),
        }
    )

    container = build_container(settings)

    assert container.data_sources is not None
    assert container.data_sources.ids == ("dlc",)
