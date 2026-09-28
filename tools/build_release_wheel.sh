#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/release/wheels"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PYTHON_BIN="${PYTHON:-}"
if [[ -z "${PYTHON_BIN}" ]]; then
  if [[ -x "${ROOT_DIR}/.venv/bin/python" ]]; then
    PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi

VERSION="$(
  cd "${ROOT_DIR}"
  "${PYTHON_BIN}" - <<'PY'
import tomllib
from pathlib import Path

with Path("pyproject.toml").open("rb") as f:
    print(tomllib.load(f)["project"]["version"])
PY
)"

mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}"/ksher_agent_data_mcp-*.whl

(
  cd "${ROOT_DIR}"
  "${PYTHON_BIN}" -m pip wheel --no-deps --wheel-dir "${TMP_DIR}" .
)

WHEEL="${TMP_DIR}/ksher_agent_data_mcp-${VERSION}-py3-none-any.whl"
if [[ ! -f "${WHEEL}" ]]; then
  echo "Expected wheel not found: ${WHEEL}" >&2
  exit 1
fi

cp "${WHEEL}" "${OUT_DIR}/"
printf '%s\n' "ksher_agent_data_mcp-${VERSION}-py3-none-any.whl" > "${OUT_DIR}/latest.txt"
shasum -a 256 "${OUT_DIR}/ksher_agent_data_mcp-${VERSION}-py3-none-any.whl"
