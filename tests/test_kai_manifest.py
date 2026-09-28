import json
from pathlib import Path


def test_manifest_declares_botmux_hidden_identity_contract() -> None:
    manifest = json.loads(Path("kai/mcp.manifest.json").read_text())

    expected_command = "/bin/bash"
    expected_args = [
        "-lc",
        (
            'launcher="${KSHER_AGENT_DATA_MCP_LAUNCHER:-$HOME/.config/ksher-agent-data-mcp/launcher.sh}"; '
            'if [ ! -x "$launcher" ]; then echo "ksher-agent-data-mcp launcher not found or not executable: $launcher" >&2; exit 1; fi; '
            'exec "$launcher"'
        ),
    ]
    assert manifest["command"] == expected_command
    assert manifest["args"] == expected_args
    assert manifest["mcpServers"]["ksher-agent-data-mcp"]["command"] == expected_command
    assert manifest["args"] == manifest["mcpServers"]["ksher-agent-data-mcp"]["args"]
    manifest_text = json.dumps(manifest, ensure_ascii=False)
    assert "git+ssh://git@git.example.internal" not in manifest_text
    assert "launcher.sh" in manifest_text
    assert "ksher_agent_data_mcp.kai_bootstrap" not in manifest_text
    assert "KAI_INSTALL_DIR" not in manifest_text
    assert "KSHER_AGENT_DATA_MCP_ARTIFACT_DIR" not in manifest_text
    assert "Kai artifact runtime not found" not in manifest_text
    assert "STAMP_FILE" not in manifest_text
    assert "wheels" not in manifest_text
    assert "--find-links" not in manifest_text
    assert "--no-index" not in manifest_text
    assert "install --upgrade pip" not in manifest_text
    assert "${secret:" not in manifest_text
    assert "PACKAGE_REF" not in manifest_text
    assert "KSHER_AGENT_DATA_MCP_ENV_FILE" not in manifest_text
    assert "~/.config/ksher-agent-data-mcp/env" not in manifest_text
    assert "TCHOUSE_D_USERNAME" not in manifest
    assert "TCHOUSE_D_PASSWORD" not in manifest
    assert "env" not in manifest
    assert "env" not in manifest["mcpServers"]["ksher-agent-data-mcp"]

    botmux = manifest["botmux"]
    assert botmux["requiresSandbox"] is True
    assert botmux["downstream"]["type"] == "stdio"
    assert botmux["downstream"]["command"] == expected_command
    assert botmux["downstream"]["args"] == manifest["args"]
    assert botmux["injectedArguments"] == {
        "unionId": "request_user_union_id",
        "openId": "request_user_open_id",
        "larkAppId": "request_lark_app_id",
    }
    assert "request_user_union_id" in botmux["listToolsSchemaStrip"]
    assert "request_lark_app_id" in botmux["listToolsSchemaStrip"]
    assert "request_user_tchouse_account" in botmux["listToolsSchemaStrip"]
    assert "requestAppId" in botmux["listToolsSchemaStrip"]
    assert "appId" in botmux["listToolsSchemaStrip"]
    assert "unionId" in botmux["listToolsSchemaStrip"]
    assert botmux["agentVisibleArguments"] == ["sql", "datasource"]


def test_kai_artifact_declares_runtime_entrypoint() -> None:
    launcher = Path("bin/ksher-agent-data-mcp")
    kai_launcher = Path("kai/launcher.sh").read_text()
    readme = Path("kai/README.md").read_text()
    package_script = Path("tools/package_kai_artifact.sh").read_text()

    assert launcher.exists()
    assert "-m ksher_agent_data_mcp.server" in launcher.read_text()
    assert "--manifest kai/mcp.manifest.json" in readme
    assert "--artifact" not in readme
    assert "--from-dir" not in readme
    assert "--exclude=\"docs/*.feishu.xml\"" in package_script
    assert "command -v ksher-agent-data-mcp" not in readme
    assert "KSHER_AGENT_DATA_MCP_WHEEL_PYTHONS:-3.11 3.12 3.13" in package_script
    assert (
        "KSHER_AGENT_DATA_MCP_WHEEL_PLATFORMS:-macosx_11_0_arm64 "
        "macosx_10_12_x86_64 manylinux2014_x86_64 manylinux2014_aarch64"
    ) in package_script
    assert "cryptography==46.0.0" in package_script
    assert 'platform_pythons="3.11 3.12"' in package_script
    assert "requirements.runtime.${platform}.txt" in package_script
    assert "--python-version" in package_script
    assert "--only-binary=:all:" in package_script
    assert 'export METADATA_PROVIDER="${METADATA_PROVIDER:-tchouse_c}"' in kai_launcher
    assert kai_launcher.index('PACKAGE_REF="${KSHER_AGENT_DATA_MCP_PACKAGE_REF:-}"') < (
        kai_launcher.index("import ksher_agent_data_mcp")
    )
    assert kai_launcher.index('"${VENV_DIR}/bin/python" -m pip install --upgrade "${PACKAGE_REF}"') < (
        kai_launcher.index('exec "${PYTHON_BIN}" -m ksher_agent_data_mcp.kai_bootstrap')
    )


def test_botmux_docs_do_not_claim_secret_interpolation() -> None:
    docs = [
        Path("README.md").read_text(),
        Path("kai/README.md").read_text(),
    ]

    for content in docs:
        assert '"TCHOUSE_D_USERNAME": "${secret:' not in content
        assert '"TCHOUSE_D_PASSWORD": "${secret:' not in content
        assert "Kai secret" not in content


def test_manifest_does_not_expose_internal_topology_or_identity_field_in_usage() -> None:
    manifest_text = Path("kai/mcp.manifest.json").read_text()
    manifest = json.loads(manifest_text)

    for blocked in [
        "192.0.2.",
        "jdbc:mysql://",
        "jdbc:clickhouse://",
        "user_credential_mapping",
        "example_sensitive_field",
        "TCHOUSE_D_CREDENTIAL_SQL",
    ]:
        assert blocked not in manifest_text

    usage_text = json.dumps(manifest["usage"], ensure_ascii=False)
    assert "union_id" not in usage_text
    assert "request_user_union_id" not in usage_text


def test_runtime_readme_documents_private_configuration_without_values() -> None:
    readme = Path("README.md").read_text()

    for blocked in [
        "192.0.2.",
        "jdbc:mysql://",
        "jdbc:clickhouse://",
        "user_credential_mapping",
        "example_sensitive_field",
    ]:
        assert blocked not in readme

    assert "TCHOUSE_D_CREDENTIAL_SQL" in readme
    assert "TCHOUSE_C_JDBC_BASE_URL" in readme
    assert "不要把凭证落入源码目录" in readme
