#!/usr/bin/env python3
"""Fail when public source or reachable Git history contains private material."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".venv", "node_modules", "dist", "build", "target", ".pytest_cache"}
MAX_FILE_BYTES = 10 * 1024 * 1024

RULES = {
    "private IPv4 address": re.compile(
        rb"(?<!\d)(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|"
        rb"172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?!\d)"
    ),
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "AWS access key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "GitHub token": re.compile(rb"gh" + rb"[pousr]_[A-Za-z0-9]{30,}"),
    "Slack token": re.compile(rb"xo" + rb"[xbaprs]-[A-Za-z0-9-]{10,}"),
    "credential-like env assignment": re.compile(
        rb"(?im)^\s*(?:password|passwd|secret|token|app_secret)\s*=\s*"
        rb"(?!\s*(?:$|<[^>]+>|example|test|dummy))[A-Za-z0-9_+/=-]{8,}\s*$"
    ),
    "credential-like structured value": re.compile(
        rb"(?im)['\"](?:password|passwd|secret|token|app_secret)['\"]\s*:\s*['\"]"
        rb"(?!<[^>]+>|example|test|dummy)[^'\"\r\n]{8,}['\"]"
    ),
    "company domain": re.compile(rb"ksherpay[.]com", re.IGNORECASE),
    "company email": re.compile(rb"@ksher[.]com", re.IGNORECASE),
    "private Feishu document": re.compile(rb"(?:feishu[.]cn|larksuite[.]com)/(?:docx|wiki)/"),
    "local user path": re.compile(rb"/(?:Users|home)/barry(?:/|$)"),
    "internal schema": re.compile(rb"ksher_" + rb"bi_dense", re.IGNORECASE),
    "internal credential table": re.compile(rb"dim_agent_" + rb"ck_user_info", re.IGNORECASE),
    "internal metadata table": re.compile(rb"s_indicator_" + rb"dict_detail_info", re.IGNORECASE),
}


def _scan(label: str, payload: bytes) -> list[str]:
    if len(payload) > MAX_FILE_BYTES or b"\x00" in payload[:8192]:
        return []
    return [f"{label}: {name}" for name, pattern in RULES.items() if pattern.search(payload)]


def scan_worktree() -> list[str]:
    findings: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        findings.extend(_scan(str(path.relative_to(ROOT)), path.read_bytes()))
    return findings


def scan_history() -> list[str]:
    findings: list[str] = []
    objects = subprocess.run(
        ["git", "rev-list", "--objects", "--all"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    for line in objects:
        object_id, _, path = line.partition(" ")
        if not path:
            continue
        object_type = subprocess.run(
            ["git", "cat-file", "-t", object_id],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if object_type != "blob":
            continue
        payload = subprocess.run(
            ["git", "cat-file", "blob", object_id],
            cwd=ROOT,
            check=True,
            capture_output=True,
        ).stdout
        findings.extend(_scan(f"{object_id[:12]}:{path}", payload))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", action="store_true", help="also scan every reachable Git blob")
    args = parser.parse_args()
    findings = scan_worktree()
    if args.history:
        findings.extend(scan_history())
    if findings:
        print("Public-source safety scan failed:")
        for finding in sorted(set(findings)):
            print(f"- {finding}")
        return 1
    print("Public-source safety scan passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
