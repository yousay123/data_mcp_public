import os

from ksher_agent_data_mcp import kai_bootstrap


def test_kai_bootstrap_passes_only_private_env_file_path(tmp_path, monkeypatch) -> None:
    env_file = tmp_path / "env"
    env_file.write_text(
        "DATA_MCP_INTERNAL_AUTH_TOKEN='internal-canary'\n"
        "TCHOUSE_D_PASSWORD='database-canary'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("KSHER_AGENT_DATA_MCP_ENV_FILE", str(env_file))
    monkeypatch.delenv("DATA_MCP_INTERNAL_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("TCHOUSE_D_PASSWORD", raising=False)

    selected = kai_bootstrap._configure_private_env_file()

    assert selected == env_file
    assert os.environ["KSHER_AGENT_DATA_MCP_ENV_FILE"] == str(env_file)
    assert "DATA_MCP_INTERNAL_AUTH_TOKEN" not in os.environ
    assert "TCHOUSE_D_PASSWORD" not in os.environ


def test_kai_bootstrap_applies_production_defaults_without_overriding() -> None:
    tracked_keys = set(kai_bootstrap.PRODUCTION_DEFAULT_ENV)
    original = {key: os.environ.get(key) for key in tracked_keys}
    try:
        for key in tracked_keys:
            os.environ.pop(key, None)
        os.environ["DEFAULT_LIMIT"] = "50"

        kai_bootstrap._apply_runtime_defaults()

        assert os.environ["MCP_ENV"] == "prod"
        assert os.environ["CREDENTIAL_PROVIDER"] == "tchouse_d"
        assert os.environ["QUERY_EXECUTOR"] == "tchouse_c_http"
        assert os.environ["DEFAULT_LIMIT"] == "50"
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
