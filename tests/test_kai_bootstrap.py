import os

from ksher_agent_data_mcp import kai_bootstrap


def test_kai_bootstrap_loads_private_env_file(tmp_path, monkeypatch) -> None:
    env_file = tmp_path / "env"
    env_file.write_text(
        "\n".join(
            [
                "TCHOUSE_D_USERNAME='agent_user'",
                'TCHOUSE_D_PASSWORD="agent_password"',
                "export QUERY_TIMEOUT_SECONDS=45",
            ]
        ),
        encoding="utf-8",
    )

    for key in ["TCHOUSE_D_USERNAME", "TCHOUSE_D_PASSWORD", "QUERY_TIMEOUT_SECONDS"]:
        monkeypatch.delenv(key, raising=False)

    kai_bootstrap._load_env_file(env_file)

    assert os.environ["TCHOUSE_D_USERNAME"] == "agent_user"
    assert os.environ["TCHOUSE_D_PASSWORD"] == "agent_password"
    assert os.environ["QUERY_TIMEOUT_SECONDS"] == "45"


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
