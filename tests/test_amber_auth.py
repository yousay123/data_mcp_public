from __future__ import annotations

import sqlite3
import base64
from concurrent.futures import ThreadPoolExecutor

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ksher_agent_data_mcp.amber_auth import (
    AmberAuthError,
    AmberReplayError,
    AmberStateStore,
    AmberTokenVerifier,
)
from tests.amber_helpers import sign_token, write_jwks


def build_verifier(tmp_path):
    private_key = Ed25519PrivateKey.generate()
    jwks = tmp_path / "amber.jwks.json"
    kid = write_jwks(jwks, private_key)
    verifier = AmberTokenVerifier(
        jwks,
        issuer="amber",
        audience="data-mcp",
        clock_skew_seconds=30,
        max_lifetime_seconds=300,
    )
    return private_key, kid, verifier


def build_store(tmp_path, *, replay_grace_seconds: int = 120):
    key = tmp_path / "audit.key"
    key.write_bytes(base64.urlsafe_b64encode(b"a" * 32).rstrip(b"="))
    key.chmod(0o600)
    return AmberStateStore(
        tmp_path / "state" / "amber.db",
        key,
        replay_grace_seconds=replay_grace_seconds,
    )


def test_verifier_accepts_pinned_eddsa_token_and_required_claims(tmp_path) -> None:
    private_key, kid, verifier = build_verifier(tmp_path)

    claims = verifier.verify(sign_token(private_key, kid))

    assert claims.subject == "on_test_user"
    assert claims.call_index == 1
    assert claims.call_count == 1
    assert claims.kid == kid


@pytest.mark.parametrize(
    ("overrides", "header_overrides", "error"),
    [
        ({"iss": "other"}, None, "invalid_token_audience_or_issuer"),
        ({"aud": "other"}, None, "invalid_token_audience_or_issuer"),
        ({"sub": "ou_not_union"}, None, "invalid_claim_sub"),
        ({"channel": "unknown"}, None, "invalid_claim_channel"),
        ({"call_index": 2, "call_count": 1}, None, "invalid_call_claims"),
        ({"call_count": 21}, None, "invalid_call_claims"),
        (None, {"alg": "none"}, "invalid_token_header"),
        (None, {"kid": "unknown"}, "unknown_amber_key"),
    ],
)
def test_verifier_fails_closed_for_invalid_claims(
    tmp_path, overrides, header_overrides, error
) -> None:
    private_key, kid, verifier = build_verifier(tmp_path)

    with pytest.raises(AmberAuthError, match=error):
        verifier.verify(
            sign_token(
                private_key,
                kid,
                overrides=overrides,
                header_overrides=header_overrides,
            )
        )


def test_verifier_rejects_expired_future_and_overlong_tokens(tmp_path) -> None:
    private_key, kid, verifier = build_verifier(tmp_path)
    now = 2_000_000_000

    with pytest.raises(AmberAuthError, match="token_expired"):
        verifier.verify(
            sign_token(private_key, kid, now=now - 400, overrides={"exp": now - 31}),
            now=now,
        )
    with pytest.raises(AmberAuthError, match="token_not_yet_valid"):
        verifier.verify(sign_token(private_key, kid, now=now + 31), now=now)
    with pytest.raises(AmberAuthError, match="invalid_token_lifetime"):
        verifier.verify(
            sign_token(private_key, kid, now=now, overrides={"exp": now + 301}),
            now=now,
        )


def test_pinned_jwks_rejects_unsafe_permissions(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    jwks = tmp_path / "amber.jwks.json"
    write_jwks(jwks, private_key)
    jwks.chmod(0o666)

    with pytest.raises(AmberAuthError, match="amber_jwks_file_unsafe"):
        AmberTokenVerifier(
            jwks,
            issuer="amber",
            audience="data-mcp",
            clock_skew_seconds=30,
            max_lifetime_seconds=300,
        )


def test_replay_is_persistent_atomic_and_sql_is_not_plaintext(tmp_path) -> None:
    private_key, kid, verifier = build_verifier(tmp_path)
    claims = verifier.verify(sign_token(private_key, kid))
    store = build_store(tmp_path)
    sql = "SELECT secret_value FROM private_table"

    outcomes = []

    def consume() -> None:
        try:
            outcomes.append(store.consume_and_record(claims, sql, "tchouse-c"))
        except AmberReplayError:
            outcomes.append("replayed")

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: consume(), range(2)))

    assert len([value for value in outcomes if value != "replayed"]) == 1
    assert outcomes.count("replayed") == 1
    assert sql.encode() not in store.database.read_bytes()
    assert store.database.stat().st_mode & 0o777 == 0o600
    assert store.database.parent.stat().st_mode & 0o777 == 0o700

    recreated = build_store(tmp_path)
    with pytest.raises(AmberReplayError, match="amber_token_replayed"):
        recreated.consume_and_record(claims, sql, "tchouse-c")
    with sqlite3.connect(store.database) as connection:
        row = connection.execute(
            "SELECT sql_sha256, status FROM amber_sql_audit"
        ).fetchone()
    assert row is not None
    assert row[1] == "started"


def test_replay_record_outlives_token_clock_skew_window(tmp_path, monkeypatch) -> None:
    private_key, kid, verifier = build_verifier(tmp_path)
    now = 2_000_000_000
    claims = verifier.verify(sign_token(private_key, kid, now=now), now=now)
    store = build_store(tmp_path)
    monkeypatch.setattr("ksher_agent_data_mcp.amber_auth.time.time", lambda: now)
    store.consume_and_record(claims, "SELECT 1", "tchouse-c")

    monkeypatch.setattr(
        "ksher_agent_data_mcp.amber_auth.time.time",
        lambda: claims.expires_at + 1,
    )
    with pytest.raises(AmberReplayError, match="amber_token_replayed"):
        store.consume_and_record(claims, "SELECT 1", "tchouse-c")


def test_replay_race_at_last_valid_second_is_rejected(tmp_path, monkeypatch) -> None:
    private_key, kid, verifier = build_verifier(tmp_path)
    issued_at = 2_000_000_000
    token = sign_token(private_key, kid, now=issued_at)
    claims = verifier.verify(token, now=issued_at)
    store = build_store(tmp_path, replay_grace_seconds=90)
    monkeypatch.setattr("ksher_agent_data_mcp.amber_auth.time.time", lambda: issued_at)
    store.consume_and_record(claims, "SELECT 1", "tchouse-c")

    verifier.verify(token, now=claims.expires_at + 30)
    monkeypatch.setattr(
        "ksher_agent_data_mcp.amber_auth.time.time",
        lambda: claims.expires_at + 31,
    )
    with pytest.raises(AmberReplayError, match="amber_token_replayed"):
        store.consume_and_record(claims, "SELECT 1", "tchouse-c")


def test_audit_key_requires_base64url_not_raw_text(tmp_path) -> None:
    key = tmp_path / "audit.key"
    key.write_text("a" * 32, encoding="ascii")
    key.chmod(0o600)

    with pytest.raises(AmberAuthError, match="amber_audit_key_invalid"):
        AmberStateStore(tmp_path / "state" / "amber.db", key)
