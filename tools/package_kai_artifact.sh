#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
NAME="ksher-agent-data-mcp"
OUT_DIR="dist"

if [[ -z "${VERSION}" ]]; then
  VERSION="$(python3 - <<'PY'
import tomllib
from pathlib import Path

with Path("pyproject.toml").open("rb") as f:
    print(tomllib.load(f)["project"]["version"])
PY
)"
fi

OUT_FILE="${OUT_DIR}/${NAME}-${VERSION}.tgz"
STAGE_DIR="${OUT_DIR}/${NAME}-${VERSION}"

mkdir -p "${OUT_DIR}"

if [[ -e "${STAGE_DIR}" ]]; then
  echo "${STAGE_DIR} already exists; remove it before rebuilding" >&2
  exit 1
fi

mkdir -p "${STAGE_DIR}"

tar \
  --exclude=".git" \
  --exclude=".DS_Store" \
  --exclude=".env" \
  --exclude=".venv" \
  --exclude=".pytest_cache" \
  --exclude="dist" \
  --exclude="build" \
  --exclude="*.egg-info" \
  --exclude="__pycache__" \
  --exclude="*.pyc" \
  --exclude="java-gateway/target" \
  --exclude="audit/*.jsonl" \
  --exclude="docs/*.feishu.xml" \
  -cf - \
  README.md \
  pyproject.toml \
  bin \
  src \
  tests \
  java-gateway \
  docs \
  examples \
  kai \
  tools \
  | tar -xf - -C "${STAGE_DIR}"

cp kai/mcp.manifest.json "${STAGE_DIR}/manifest.json"

PYTHON_BIN="${PYTHON:-}"
if [[ -z "${PYTHON_BIN}" ]]; then
  if [[ -x ".venv/bin/python" ]]; then
    PYTHON_BIN=".venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi

mkdir -p "${STAGE_DIR}/wheels"

REQUIREMENTS_FILE="${STAGE_DIR}/requirements.runtime.txt"
"${PYTHON_BIN}" - <<'PY' > "${REQUIREMENTS_FILE}"
import tomllib
from pathlib import Path

with Path("pyproject.toml").open("rb") as f:
    project = tomllib.load(f)["project"]

for dependency in project.get("dependencies", []):
    print(dependency)
PY

"${PYTHON_BIN}" -m pip wheel --no-deps --wheel-dir "${STAGE_DIR}/wheels" . >&2

WHEEL_PLATFORMS="${KSHER_AGENT_DATA_MCP_WHEEL_PLATFORMS:-macosx_11_0_arm64 macosx_10_12_x86_64 manylinux2014_x86_64 manylinux2014_aarch64}"
WHEEL_PYTHONS="${KSHER_AGENT_DATA_MCP_WHEEL_PYTHONS:-3.11 3.12 3.13}"

for platform in ${WHEEL_PLATFORMS}; do
  platform_pythons="${WHEEL_PYTHONS}"
  if [[ -z "${KSHER_AGENT_DATA_MCP_WHEEL_PYTHONS:-}" && "${platform}" == "macosx_10_12_x86_64" ]]; then
    platform_pythons="3.11 3.12"
  fi
  for python_version in ${platform_pythons}; do
    abi="cp${python_version/./}"
    download_requirements="${REQUIREMENTS_FILE}"
    if [[ "${platform}" == "macosx_10_12_x86_64" ]]; then
      download_requirements="${STAGE_DIR}/requirements.runtime.${platform}.txt"
      cp "${REQUIREMENTS_FILE}" "${download_requirements}"
      printf '%s\n' "cryptography==46.0.0" >> "${download_requirements}"
    fi
    "${PYTHON_BIN}" -m pip download \
      --dest "${STAGE_DIR}/wheels" \
      --only-binary=:all: \
      --platform "${platform}" \
      --implementation cp \
      --python-version "${python_version}" \
      --abi "${abi}" \
      -r "${download_requirements}" >&2
  done
done

tar -czf "${OUT_FILE}" -C "${STAGE_DIR}" .
echo "${STAGE_DIR}"
echo "${OUT_FILE}"
