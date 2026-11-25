import os
import subprocess
import sys
from pathlib import Path


def test_exact_clickhouse_result_reaches_isolated_agent_artifacts() -> None:
    repository_root = Path(__file__).resolve().parents[1]
    script = (
        repository_root
        / "botmux-plugin-data-mcp"
        / "scripts"
        / "test-exact-result-chain.mjs"
    )
    completed = subprocess.run(
        ["node", str(script)],
        cwd=repository_root / "botmux-plugin-data-mcp",
        env={**os.environ, "DATA_MCP_TEST_PYTHON": sys.executable},
        check=False,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert completed.returncode == 0, completed.stderr
    assert "exact ClickHouse-to-isolated-Agent delivery chain passed" in completed.stdout
