#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${KSHER_AGENT_DATA_MCP_ENV_FILE:-$HOME/.config/ksher-agent-data-mcp/env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

export MCP_ENV="${MCP_ENV:-prod}"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
export METADATA_PROVIDER="${METADATA_PROVIDER:-tchouse_c}"
export CREDENTIAL_PROVIDER="${CREDENTIAL_PROVIDER:-tchouse_d}"
export QUERY_EXECUTOR="${QUERY_EXECUTOR:-tchouse_c_http}"
export MAX_ROWS="${MAX_ROWS:-1000}"
export DEFAULT_LIMIT="${DEFAULT_LIMIT:-200}"
export QUERY_TIMEOUT_SECONDS="${QUERY_TIMEOUT_SECONDS:-60}"
export MAX_SQL_BYTES="${MAX_SQL_BYTES:-20000}"
export REQUIRE_PARTITION_FILTER="${REQUIRE_PARTITION_FILTER:-true}"

is_python_311_plus() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

PYTHON_BIN="${KSHER_AGENT_DATA_MCP_PYTHON:-}"
if [[ -n "${PYTHON_BIN}" ]]; then
  if ! is_python_311_plus "${PYTHON_BIN}"; then
    echo "KSHER_AGENT_DATA_MCP_PYTHON must point to Python >=3.11: ${PYTHON_BIN}" >&2
    exit 1
  fi
else
  DARWIN_X86_64="0"
  if [[ "$(uname -s 2>/dev/null || true)" = "Darwin" && "$(uname -m 2>/dev/null || true)" = "x86_64" ]]; then
    DARWIN_X86_64="1"
  fi

  for candidate in \
    python3.13 python3.12 python3.11 python3 \
    /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3 \
    /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3
  do
    if ! command -v "${candidate}" >/dev/null 2>&1 && [[ ! -x "${candidate}" ]]; then
      continue
    fi
    resolved="$(command -v "${candidate}" 2>/dev/null || printf '%s' "${candidate}")"
    if [[ "${DARWIN_X86_64}" = "1" ]] && "${resolved}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 13) else 1)' >/dev/null 2>&1; then
      continue
    fi
    if is_python_311_plus "${resolved}"; then
      PYTHON_BIN="${resolved}"
      break
    fi
  done
fi

if [[ -z "${PYTHON_BIN}" ]]; then
  echo "Python >=3.11 is required. Install Python 3.11+ or set KSHER_AGENT_DATA_MCP_PYTHON." >&2
  exit 1
fi

PACKAGE_REF="${KSHER_AGENT_DATA_MCP_PACKAGE_REF:-}"
if [[ -z "${PACKAGE_REF}" ]]; then
  for dir in \
    "$HOME/.config/ksher-agent-data-mcp/packages" \
    "$HOME/Downloads" \
    "/opt/botmux/mcp/ksher-agent-data-mcp/packages" \
    "/opt/botmux/mcp/ksher-agent-data-mcp"
  do
    if [[ -d "${dir}" ]]; then
      found="$(find "${dir}" -maxdepth 1 -type f -name 'ksher_agent_data_mcp-*.whl' | sort | tail -n 1)"
      if [[ -n "${found}" ]]; then
        PACKAGE_REF="${found}"
        break
      fi
    fi
  done
fi

if [[ -n "${PACKAGE_REF}" ]]; then
  RUNTIME_HOME="${KSHER_AGENT_DATA_MCP_RUNTIME_HOME:-$HOME/.cache/ksher-agent-data-mcp/runtime}"
  VENV_DIR="${RUNTIME_HOME}/.venv"
  mkdir -p "${RUNTIME_HOME}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}" >&2
  "${VENV_DIR}/bin/python" -m pip install --upgrade "${PACKAGE_REF}" >&2
  exec "${VENV_DIR}/bin/python" -m ksher_agent_data_mcp.kai_bootstrap
fi

if "${PYTHON_BIN}" -c 'import ksher_agent_data_mcp' >/dev/null 2>&1; then
  exec "${PYTHON_BIN}" -m ksher_agent_data_mcp.kai_bootstrap
fi

echo "ksher-agent-data-mcp Python package is not installed and no wheel was found." >&2
echo "Put ksher_agent_data_mcp-*.whl under ~/.config/ksher-agent-data-mcp/packages or /opt/botmux/mcp/ksher-agent-data-mcp/packages." >&2
echo "Alternatively set KSHER_AGENT_DATA_MCP_PACKAGE_REF to a real local wheel/source path." >&2
exit 1
