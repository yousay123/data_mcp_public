from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class AmberAuthError(ValueError):
    pass


class AmberReplayError(AmberAuthError):
    pass


@dataclass(frozen=True)
class AmberClaims:
    issuer: str
    audience: str
    subject: str
    command: str
    revision: str
    run: str
    chat: str
    channel: str
    issued_at: int
    expires_at: int
    jti: str
    call_index: int
    call_count: int
    kid: str

    @property
    def jti_ref(self) -> str:
        return hashlib.sha256(self.jti.encode("utf-8")).hexdigest()[:16]


def _b64url_decode(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as exc:
        raise AmberAuthError("invalid_token_encoding") from exc


def _required_string(payload: dict[str, Any], name: str, *, maximum: int = 256) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise AmberAuthError(f"invalid_claim_{name}")
    return value


def _required_int(payload: dict[str, Any], name: str) -> int:
    value = payload.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise AmberAuthError(f"invalid_claim_{name}")
    return value


class AmberTokenVerifier:
    def __init__(
        self,
        jwks_file: Path,
        *,
        issuer: str,
        audience: str,
        clock_skew_seconds: int,
        max_lifetime_seconds: int,
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.clock_skew_seconds = clock_skew_seconds
        self.max_lifetime_seconds = max_lifetime_seconds
        self.keys = self._load_pinned_keys(jwks_file)

    @staticmethod
    def _load_pinned_keys(path: Path) -> dict[str, Ed25519PublicKey]:
        try:
            metadata = path.lstat()
        except OSError as exc:
            raise AmberAuthError("amber_jwks_file_unavailable") from exc
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022:
            raise AmberAuthError("amber_jwks_file_unsafe")
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise AmberAuthError("amber_jwks_file_invalid") from exc
        keys: dict[str, Ed25519PublicKey] = {}
        for item in document.get("keys", []) if isinstance(document, dict) else []:
            if not isinstance(item, dict):
                continue
            if item.get("kty") != "OKP" or item.get("crv") != "Ed25519":
                continue
            kid = item.get("kid")
            encoded = item.get("x")
            if not isinstance(kid, str) or not kid or not isinstance(encoded, str):
                continue
            try:
                keys[kid] = Ed25519PublicKey.from_public_bytes(_b64url_decode(encoded))
            except (ValueError, AmberAuthError):
                continue
        if not keys:
            raise AmberAuthError("amber_jwks_has_no_usable_keys")
        return keys

    def verify(self, token: str, *, now: int | None = None) -> AmberClaims:
        parts = token.split(".")
        if len(parts) != 3:
            raise AmberAuthError("invalid_token_format")
        encoded_header, encoded_payload, encoded_signature = parts
        try:
            header = json.loads(_b64url_decode(encoded_header))
            payload = json.loads(_b64url_decode(encoded_payload))
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            raise AmberAuthError("invalid_token_json") from exc
        if not isinstance(header, dict) or not isinstance(payload, dict):
            raise AmberAuthError("invalid_token_json")
        if header.get("alg") != "EdDSA" or header.get("typ") != "JWT":
            raise AmberAuthError("invalid_token_header")
        kid = header.get("kid")
        key = self.keys.get(kid) if isinstance(kid, str) else None
        if key is None:
            raise AmberAuthError("unknown_amber_key")
        try:
            key.verify(
                _b64url_decode(encoded_signature),
                f"{encoded_header}.{encoded_payload}".encode("ascii"),
            )
        except Exception as exc:
            raise AmberAuthError("invalid_token_signature") from exc

        issuer = _required_string(payload, "iss")
        audience = _required_string(payload, "aud")
        if issuer != self.issuer or audience != self.audience:
            raise AmberAuthError("invalid_token_audience_or_issuer")
        subject = _required_string(payload, "sub")
        if not subject.startswith("on_"):
            raise AmberAuthError("invalid_claim_sub")
        command = _required_string(payload, "cmd", maximum=128)
        revision = _required_string(payload, "rev", maximum=128)
        run = _required_string(payload, "run", maximum=128)
        chat = _required_string(payload, "chat", maximum=128)
        channel = _required_string(payload, "channel", maximum=32)
        if not re.fullmatch(r"(?:bot|web|agent|schedule)(?:\.trial)?", channel):
            raise AmberAuthError("invalid_claim_channel")
        issued_at = _required_int(payload, "iat")
        expires_at = _required_int(payload, "exp")
        jti = _required_string(payload, "jti", maximum=128)
        call_index = _required_int(payload, "call_index")
        call_count = _required_int(payload, "call_count")
        if call_count < 1 or call_count > 20 or call_index < 1 or call_index > call_count:
            raise AmberAuthError("invalid_call_claims")
        current = int(time.time()) if now is None else now
        if issued_at > current + self.clock_skew_seconds:
            raise AmberAuthError("token_not_yet_valid")
        if expires_at < current - self.clock_skew_seconds:
            raise AmberAuthError("token_expired")
        if expires_at <= issued_at or expires_at - issued_at > self.max_lifetime_seconds:
            raise AmberAuthError("invalid_token_lifetime")
        return AmberClaims(
            issuer=issuer,
            audience=audience,
            subject=subject,
            command=command,
            revision=revision,
            run=run,
            chat=chat,
            channel=channel,
            issued_at=issued_at,
            expires_at=expires_at,
            jti=jti,
            call_index=call_index,
            call_count=call_count,
            kid=kid,
        )


class AmberStateStore:
    """Persistent replay protection and encrypted, restricted SQL audit storage."""

    def __init__(
        self,
        database: Path,
        audit_key_file: Path,
        *,
        replay_grace_seconds: int = 120,
    ) -> None:
        if replay_grace_seconds < 0:
            raise ValueError("replay_grace_seconds must not be negative")
        self.database = database
        self.replay_grace_seconds = replay_grace_seconds
        self.audit_key, self.audit_key_id = self._load_audit_key(audit_key_file)
        database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(database.parent, 0o700)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS amber_replay (
                  issuer TEXT NOT NULL, jti TEXT NOT NULL, expires_at INTEGER NOT NULL,
                  PRIMARY KEY (issuer, jti)
                );
                CREATE TABLE IF NOT EXISTS amber_sql_audit (
                  audit_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
                  union_id TEXT NOT NULL, command_id TEXT NOT NULL, revision TEXT NOT NULL,
                  run_id TEXT NOT NULL, jti_ref TEXT NOT NULL, channel TEXT NOT NULL,
                  call_index INTEGER NOT NULL, call_count INTEGER NOT NULL,
                  datasource TEXT NOT NULL, sql_sha256 TEXT NOT NULL,
                  key_id TEXT NOT NULL, nonce BLOB NOT NULL, encrypted_sql BLOB NOT NULL,
                  status TEXT NOT NULL, error_code TEXT, row_count INTEGER
                );
                """
            )
        os.chmod(database, 0o600)

    @staticmethod
    def _load_audit_key(path: Path) -> tuple[bytes, str]:
        try:
            metadata = path.lstat()
        except OSError as exc:
            raise AmberAuthError("amber_audit_key_unavailable") from exc
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise AmberAuthError("amber_audit_key_unsafe")
        raw = path.read_bytes().strip()
        if len(raw) != 32:
            try:
                raw = base64.urlsafe_b64decode(raw + b"=" * (-len(raw) % 4))
            except Exception as exc:
                raise AmberAuthError("amber_audit_key_invalid") from exc
        if len(raw) != 32:
            raise AmberAuthError("amber_audit_key_invalid")
        return raw, hashlib.sha256(raw).hexdigest()[:16]

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database, timeout=5)

    def consume_and_record(self, claims: AmberClaims, sql: str, datasource: str) -> str:
        audit_id = f"amber_audit_{secrets.token_hex(16)}"
        sql_digest = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        nonce = os.urandom(12)
        aad = json.dumps(
            {
                "audit_id": audit_id,
                "union_id": claims.subject,
                "command": claims.command,
                "revision": claims.revision,
                "run": claims.run,
                "jti_ref": claims.jti_ref,
                "datasource": datasource,
                "sql_sha256": sql_digest,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        encrypted = AESGCM(self.audit_key).encrypt(nonce, sql.encode("utf-8"), aad)
        now = int(time.time())
        with self._connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "DELETE FROM amber_replay WHERE expires_at < ?", (now,)
                )
                connection.execute(
                    "INSERT INTO amber_replay (issuer, jti, expires_at) VALUES (?, ?, ?)",
                    (
                        claims.issuer,
                        claims.jti,
                        claims.expires_at + self.replay_grace_seconds,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO amber_sql_audit (
                      audit_id, created_at, union_id, command_id, revision, run_id,
                      jti_ref, channel, call_index, call_count, datasource, sql_sha256,
                      key_id, nonce, encrypted_sql, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')
                    """,
                    (
                        audit_id,
                        now,
                        claims.subject,
                        claims.command,
                        claims.revision,
                        claims.run,
                        claims.jti_ref,
                        claims.channel,
                        claims.call_index,
                        claims.call_count,
                        datasource,
                        sql_digest,
                        self.audit_key_id,
                        nonce,
                        encrypted,
                    ),
                )
                connection.commit()
            except sqlite3.IntegrityError as exc:
                connection.rollback()
                raise AmberReplayError("amber_token_replayed") from exc
        return audit_id

    def finish(
        self,
        audit_id: str,
        *,
        status: str,
        error_code: str | None = None,
        row_count: int | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE amber_sql_audit
                SET status = ?, error_code = ?, row_count = ?
                WHERE audit_id = ?
                """,
                (status, error_code, row_count, audit_id),
            )
