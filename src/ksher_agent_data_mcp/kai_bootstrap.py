from __future__ import annotations

import os
import sys
from pathlib import Path


MIN_PYTHON = (3, 11)
DEFAULT_ENV_FILE = "~/.config/ksher-agent-data-mcp/env"

PRODUCTION_DEFAULT_ENV = {
    "MCP_ENV": "prod",
    "LOG_LEVEL": "INFO",
    "METADATA_PROVIDER": "tchouse_c",
    "CREDENTIAL_PROVIDER": "tchouse_d",
    "QUERY_EXECUTOR": "tchouse_c_http",
    "MAX_ROWS": "1000",
    "DEFAULT_LIMIT": "200",
    "QUERY_TIMEOUT_SECONDS": "60",
    "MAX_SQL_BYTES": "20000",
    "REQUIRE_PARTITION_FILTER": "true",
}


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
            continue
        os.environ[key] = _strip_quotes(value.strip())


def _apply_runtime_defaults() -> None:
    for key, value in PRODUCTION_DEFAULT_ENV.items():
        os.environ.setdefault(key, value)


def _ensure_supported_python() -> None:
    if sys.version_info < MIN_PYTHON:
        print(
            "Python >=3.11 is required. Set KSHER_AGENT_DATA_MCP_PYTHON to a valid interpreter.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def main() -> None:
    _ensure_supported_python()
    env_file = Path(os.environ.get("KSHER_AGENT_DATA_MCP_ENV_FILE", DEFAULT_ENV_FILE)).expanduser()
    _load_env_file(env_file)
    _apply_runtime_defaults()

    from ksher_agent_data_mcp.server import main as server_main

    server_main()


if __name__ == "__main__":
    main()
