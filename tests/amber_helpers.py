from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def write_jwks(path: Path, private_key: Ed25519PrivateKey, kid: str = "amber-test") -> str:
    public = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    path.write_text(
        json.dumps(
            {
                "keys": [
                    {
                        "kty": "OKP",
                        "crv": "Ed25519",
                        "alg": "EdDSA",
                        "use": "sig",
                        "kid": kid,
                        "x": b64url(public),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    path.chmod(0o644)
    return kid


def sign_token(
    private_key: Ed25519PrivateKey,
    kid: str,
    *,
    now: int | None = None,
    overrides: dict[str, Any] | None = None,
    header_overrides: dict[str, Any] | None = None,
) -> str:
    issued_at = int(time.time()) if now is None else now
    header: dict[str, Any] = {"alg": "EdDSA", "typ": "JWT", "kid": kid}
    payload: dict[str, Any] = {
        "iss": "amber",
        "aud": "data-mcp",
        "sub": "on_test_user",
        "cmd": "cmd_test",
        "rev": "rev_test",
        "run": "run_test",
        "chat": "oc_test",
        "channel": "bot",
        "iat": issued_at,
        "exp": issued_at + 300,
        "jti": "jti_test",
        "call_index": 1,
        "call_count": 1,
    }
    header.update(header_overrides or {})
    payload.update(overrides or {})
    encoded_header = b64url(json.dumps(header, separators=(",", ":")).encode())
    encoded_payload = b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    return f"{encoded_header}.{encoded_payload}.{b64url(private_key.sign(signing_input))}"
