from __future__ import annotations

import os
import sys
from pathlib import Path

from ksher_agent_data_mcp.config import PRIVATE_ENV_FILE_ENV


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


def _apply_runtime_defaults() -> None:
    for key, value in PRODUCTION_DEFAULT_ENV.items():
        os.environ.setdefault(key, value)


def _configure_private_env_file() -> Path:
    env_file = Path(os.environ.get(PRIVATE_ENV_FILE_ENV, DEFAULT_ENV_FILE)).expanduser()
    os.environ[PRIVATE_ENV_FILE_ENV] = str(env_file)
    return env_file


def _ensure_supported_python() -> None:
    if sys.version_info < MIN_PYTHON:
        print(
            "Python >=3.11 is required. Set KSHER_AGENT_DATA_MCP_PYTHON to a valid interpreter.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def main() -> None:
    _ensure_supported_python()
    _configure_private_env_file()
    _apply_runtime_defaults()

    from ksher_agent_data_mcp.server import main as server_main

    server_main()


if __name__ == "__main__":
    main()
