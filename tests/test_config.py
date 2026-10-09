import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.models.contracts import CredentialRef

PROD_SETTINGS = {
    "MCP_ENV": "prod",
    "CREDENTIAL_PROVIDER": "tchouse_d",
    "QUERY_EXECUTOR": "tchouse_c_http",
    "METADATA_PROVIDER": "tchouse_c",
    "TCHOUSE_C_JDBC_BASE_URL": "jdbc:clickhouse://example.invalid:8123",
    "TCHOUSE_D_JDBC_URL": "jdbc:mysql://example.invalid:3306/metadata",
}


def test_settings_do_not_read_dotenv_file(tmp_path, monkeypatch) -> None:
    (tmp_path / ".env").write_text("TCHOUSE_D_USERNAME=from_dotenv\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TCHOUSE_D_USERNAME", raising=False)

    settings = Settings()

    assert settings.tchouse_d_username is None
    assert settings.metadata_provider == "tchouse_c"


def test_settings_do_not_default_warehouse_endpoints(monkeypatch) -> None:
    monkeypatch.delenv("TCHOUSE_C_JDBC_BASE_URL", raising=False)
    monkeypatch.delenv("TCHOUSE_D_JDBC_URL", raising=False)

    settings = Settings()

    assert settings.tchouse_c_jdbc_base_url is None
    assert settings.tchouse_d_jdbc_url is None


def test_snapshot_configuration_keeps_online_metadata_provider_separate() -> None:
    settings = Settings()
    aliases = {field.alias for field in Settings.model_fields.values()}

    assert settings.metadata_provider == "tchouse_c"
    assert settings.metadata_snapshot_max_age_seconds == 36 * 3600
    assert settings.metadata_snapshot_limit == 500_000
    assert "DATA_MCP_SEARCH_METADATA_SNAPSHOT_ENDPOINT" not in aliases


def test_query_read_limit_defaults_to_ten_gibibytes() -> None:
    assert Settings().query_max_bytes_to_read == 10 * 1024 * 1024 * 1024


def test_query_memory_limit_defaults_to_two_gibibytes() -> None:
    assert Settings().query_max_memory_bytes == 2 * 1024 * 1024 * 1024


def test_compare_query_plan_ttl_has_independent_server_side_cap() -> None:
    assert Settings().query_plan_compare_ttl_seconds == 900
    shortened = Settings(DATA_MCP_QUERY_PLAN_COMPARE_TTL_SECONDS=600)
    assert shortened.query_plan_compare_ttl_seconds == 600

    with pytest.raises(ValueError):
        Settings(DATA_MCP_QUERY_PLAN_COMPARE_TTL_SECONDS=901)


def test_tchouse_d_provider_requires_explicit_warehouse_endpoints(monkeypatch) -> None:
    monkeypatch.delenv("TCHOUSE_C_JDBC_BASE_URL", raising=False)
    monkeypatch.delenv("TCHOUSE_D_JDBC_URL", raising=False)

    with pytest.raises(ValueError) as exc_info:
        build_container(
            Settings(
                MCP_ENV="prod",
                CREDENTIAL_PROVIDER="tchouse_d",
                QUERY_EXECUTOR="tchouse_c_http",
                METADATA_PROVIDER="tchouse_c",
            )
        )

    message = str(exc_info.value)
    assert "TCHOUSE_C_JDBC_BASE_URL" in message
    assert "TCHOUSE_D_JDBC_URL" in message


def test_prod_runtime_profile_accepts_production_backends() -> None:
    container = build_container(Settings(**PROD_SETTINGS))

    assert container.settings.env == "prod"


@pytest.mark.parametrize(
    ("override", "expected_key"),
    [
        ({"CREDENTIAL_PROVIDER": "memory"}, "CREDENTIAL_PROVIDER"),
        ({"QUERY_EXECUTOR": "dry_run"}, "QUERY_EXECUTOR"),
        ({"METADATA_PROVIDER": "memory"}, "METADATA_PROVIDER"),
    ],
)
def test_prod_runtime_profile_rejects_each_nonproduction_backend(
    override: dict[str, str], expected_key: str
) -> None:
    with pytest.raises(ValueError) as exc_info:
        build_container(Settings(**(PROD_SETTINGS | override)))

    message = str(exc_info.value)
    assert "Invalid Data MCP runtime profile" in message
    assert expected_key in message


def test_prod_runtime_profile_reports_all_invalid_backends() -> None:
    with pytest.raises(ValueError) as exc_info:
        build_container(
            Settings(
                **(
                    PROD_SETTINGS
                    | {
                        "CREDENTIAL_PROVIDER": "memory",
                        "QUERY_EXECUTOR": "dry_run",
                    }
                )
            )
        )

    message = str(exc_info.value)
    assert "CREDENTIAL_PROVIDER='memory'" in message
    assert "QUERY_EXECUTOR='dry_run'" in message


def test_dev_runtime_profile_accepts_development_backends() -> None:
    container = build_container(
        Settings(
            MCP_ENV="dev",
            CREDENTIAL_PROVIDER="memory",
            QUERY_EXECUTOR="dry_run",
            METADATA_PROVIDER="memory",
        )
    )

    assert container.settings.env == "dev"


@pytest.mark.parametrize(
    ("override", "expected_key"),
    [
        ({"CREDENTIAL_PROVIDER": "tchouse_d"}, "CREDENTIAL_PROVIDER='tchouse_d'"),
        ({"QUERY_EXECUTOR": "tchouse_c_http"}, "QUERY_EXECUTOR='tchouse_c_http'"),
    ],
)
def test_production_backend_requires_prod_environment(
    override: dict[str, str], expected_key: str
) -> None:
    settings_data = {
        "MCP_ENV": "dev",
        "CREDENTIAL_PROVIDER": "memory",
        "QUERY_EXECUTOR": "dry_run",
        "METADATA_PROVIDER": "memory",
        "TCHOUSE_C_JDBC_BASE_URL": "jdbc:clickhouse://example.invalid:8123",
        "TCHOUSE_D_JDBC_URL": "jdbc:mysql://example.invalid:3306/metadata",
    }

    with pytest.raises(ValueError) as exc_info:
        build_container(Settings(**(settings_data | override)))

    message = str(exc_info.value)
    assert "MCP_ENV='dev'" in message
    assert expected_key in message


def test_access_inspection_factory_is_available_without_extra_topology() -> None:
    container = build_container(Settings(METADATA_PROVIDER="memory"))

    assert container.access_auditor_factory is not None


def test_access_inspection_factory_reuses_caller_credential_endpoint() -> None:
    container = build_container(Settings(METADATA_PROVIDER="memory"))
    credential = CredentialRef(
        user_union_id="on_user",
        tchouse_account="caller_ck",
        jdbc_url=(
            "jdbc:clickhouse://query.example.invalid:8123/default;"
            "user=caller_ck;password=caller_secret"
        ),
        password_secret_ref="memory://on_user",
    )

    assert container.access_auditor_factory is not None
    auditor = container.access_auditor_factory(credential)
    assert auditor.target.endpoint == "http://query.example.invalid:8123/"
    assert auditor.target.user == "caller_ck"
    assert auditor.target.password == "caller_secret"
