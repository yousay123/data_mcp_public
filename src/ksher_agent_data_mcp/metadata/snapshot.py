from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db.query_executor import (
    execute_clickhouse_json,
    parse_clickhouse_jdbc_url,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef

SNAPSHOT_SCHEMA_VERSION = 1
MANIFEST_NAME = "manifest.json"
CATALOG_NAME = "metadata-dict.jsonl"
RAW_NAME = "source-raw.jsonl"
PUBLIC_KEY_NAME = "manifest.public"
PRIVATE_KEY_NAME = "manifest.secret"
CURRENT_NAME = "current"
PREVIOUS_GOOD_NAME = "previous-good"
LOCK_NAME = "refresh.lock"
MAX_CLOCK_SKEW_SECONDS = 300
QUALIFIED_TABLE_PATTERN = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$"
)
WHITELIST_FIELDS = (
    "priority",
    "full_path",
    "backend_name",
    "type_classify",
    "source_type",
    "biz_domain",
    "database_name",
    "table_name",
    "table_comment",
    "column_name",
    "column_comment",
    "biz_definition",
    "sensitive_level",
    "ds",
)
REQUIRED_FIELDS = ("table_name", "ds")


class SnapshotError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SnapshotPaths:
    private_dir: Path
    consumer_dir: Path

    @property
    def versions_dir(self) -> Path:
        return self.private_dir / "versions"

    @property
    def staging_dir(self) -> Path:
        return self.private_dir / "staging"

    @property
    def secret_key_path(self) -> Path:
        return self.private_dir / PRIVATE_KEY_NAME

    @property
    def public_key_path(self) -> Path:
        return self.consumer_dir / PUBLIC_KEY_NAME

    @property
    def current_link(self) -> Path:
        return self.consumer_dir / CURRENT_NAME

    @property
    def previous_good_link(self) -> Path:
        return self.private_dir / PREVIOUS_GOOD_NAME

    @property
    def lock_path(self) -> Path:
        return self.private_dir / LOCK_NAME


def refresh_metadata_snapshot(
    settings: Settings,
    credential: CredentialRef,
    *,
    owner_union_id: str,
    task_id: str,
    lark_app_id: str,
) -> dict[str, Any]:
    if credential.datasource != "tchouse-c":
        raise SnapshotError(
            "metadata_snapshot_unsupported_datasource",
            "元数据快照刷新只支持 datasource=tchouse-c",
        )

    source_table = _source_table(settings)
    paths = _paths(settings)
    _validate_root_separation(paths)
    _ensure_base_dirs(paths)
    with _refresh_lock(paths):
        signing_key = _load_or_create_signing_key(paths)
        signing_public_key = signing_key.public_key()
        if paths.current_link.is_symlink():
            previous = _safe_link_target(paths.current_link, paths.versions_dir, "current")
            _verify_version_dir(
                previous,
                signing_public_key,
                expected_version=previous.name,
                expected_source_table=source_table,
                max_age_seconds=None,
                max_partition_age_days=None,
            )
        elif paths.current_link.exists():
            raise SnapshotError(
                "metadata_snapshot_unsafe_path",
                "metadata current 不是受控符号链接",
            )
        _publish_public_key(paths, signing_public_key)
        rows = _fetch_dictionary_rows(settings, credential)
        if not rows:
            raise SnapshotError("metadata_snapshot_empty", "元数据字典返回零行，拒绝发布快照")
        if len(rows) > settings.metadata_snapshot_limit:
            raise SnapshotError(
                "metadata_snapshot_row_limit_exceeded",
                "元数据字典超过快照行数上限，拒绝发布可能被截断的快照",
            )

        partition = _single_partition(rows)
        _validate_partition(partition, settings.metadata_snapshot_max_partition_age_days)
        version = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        version = f"{version}-{secrets.token_hex(4)}"
        version_dir = paths.versions_dir / version
        staging_dir = paths.staging_dir / version
        _private_mkdir(staging_dir)

        try:
            raw_path = staging_dir / RAW_NAME
            catalog_path = staging_dir / CATALOG_NAME
            _write_jsonl(raw_path, rows, normalize=False)
            row_count = _write_jsonl(catalog_path, rows, normalize=True)
            generated_at = int(time.time())
            manifest = {
                "schema_version": SNAPSHOT_SCHEMA_VERSION,
                "snapshot_version": version,
                "generated_at": generated_at,
                "owner_union_id_hash": _hash_identity(owner_union_id),
                "task_id_hash": _hash_identity(task_id),
                "lark_app_id_hash": _hash_identity(lark_app_id),
                "source_table": source_table,
                "partition": partition,
                "raw_file": RAW_NAME,
                "raw_sha256": _sha256_file(raw_path),
                "catalog_file": CATALOG_NAME,
                "catalog_sha256": _sha256_file(catalog_path),
                "row_count": row_count,
                "required_fields": list(REQUIRED_FIELDS),
                "whitelist_fields": list(WHITELIST_FIELDS),
            }
            manifest["signature"] = _sign_manifest(manifest, signing_key)
            _atomic_write_json(staging_dir / MANIFEST_NAME, manifest)
            _verify_version_dir(
                staging_dir,
                signing_public_key,
                expected_version=version,
                expected_source_table=source_table,
                max_age_seconds=settings.metadata_snapshot_max_age_seconds,
                max_partition_age_days=settings.metadata_snapshot_max_partition_age_days,
            )

            os.replace(staging_dir, version_dir)
            _publish_current(paths, version_dir, signing_public_key, source_table)
            return {
                "status": "success",
                "version": version,
                "row_count": row_count,
                "partition": partition,
                "catalog_sha256": manifest["catalog_sha256"],
                "source_table": source_table,
            }
        except SnapshotError:
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise SnapshotError(
                "metadata_snapshot_publish_failed",
                "元数据快照发布失败，current 保持不变",
            ) from exc


def search_metadata_snapshot(
    settings: Settings,
    *,
    query: str,
    limit: int = 20,
    priority: str | None = None,
) -> dict[str, Any]:
    if not isinstance(query, str):
        raise SnapshotError("metadata_snapshot_query_required", "元数据检索 query 必须是字符串")
    terms = [part.casefold() for part in re.split(r"\s+", query.strip()) if part]
    if not terms:
        raise SnapshotError("metadata_snapshot_query_required", "元数据检索 query 不能为空")

    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > 50:
        raise SnapshotError(
            "metadata_snapshot_limit_invalid",
            "元数据检索 limit 必须是 1 到 50 的整数",
        )
    if priority is not None and not isinstance(priority, str):
        raise SnapshotError(
            "metadata_snapshot_priority_invalid",
            "元数据检索 priority 必须是字符串",
        )
    source_table = _source_table(settings)
    paths = _paths(settings)
    _validate_root_separation(paths)
    _validate_private_dir(paths.consumer_dir)
    current = _safe_link_target(paths.current_link, paths.versions_dir, "current")
    public_key = _load_public_key(paths)
    manifest = _verify_version_dir(
        current,
        public_key,
        expected_version=current.name,
        expected_source_table=source_table,
        max_age_seconds=settings.metadata_snapshot_max_age_seconds,
        max_partition_age_days=settings.metadata_snapshot_max_partition_age_days,
    )
    wanted_priority = priority.strip() if isinstance(priority, str) and priority.strip() else None
    max_results = limit
    matches: list[tuple[int, tuple[int, int, str], dict[str, Any]]] = []
    for row in _read_catalog(current / CATALOG_NAME):
        row_priority = str(row.get("priority") or "").strip()
        if wanted_priority is not None and row_priority != wanted_priority:
            continue
        haystack = " ".join(str(row.get(field) or "") for field in WHITELIST_FIELDS).casefold()
        score = sum(1 for term in terms if term in haystack)
        if score:
            matches.append((score, _priority_key(row_priority), row))
    matches.sort(key=lambda item: (item[1], -item[0], _stable_row_key(item[2])))
    results = [row for _, _, row in matches[:max_results]]
    if not results:
        return {
            "status": "not_found",
            "error_code": "metadata_snapshot_no_match",
            "message": "当前签名元数据快照没有匹配候选，禁止据此猜测表名",
            "suggested_action": "请补充业务域、指标名、表名或字段名后重新检索本地快照",
            "snapshot": _snapshot_summary(current, manifest),
            "results": [],
        }
    return {
        "status": "success",
        "snapshot": _snapshot_summary(current, manifest),
        "results": results,
    }


def _paths(settings: Settings) -> SnapshotPaths:
    return SnapshotPaths(
        private_dir=settings.metadata_snapshot_private_dir.expanduser(),
        consumer_dir=settings.metadata_snapshot_consumer_dir.expanduser(),
    )


def _ensure_base_dirs(paths: SnapshotPaths) -> None:
    for directory in (paths.private_dir, paths.versions_dir, paths.staging_dir, paths.consumer_dir):
        _private_mkdir(directory)


def _private_mkdir(path: Path) -> None:
    try:
        if path.is_symlink():
            raise SnapshotError("metadata_snapshot_unsafe_path", "元数据快照目录不能是符号链接")
        if path.exists():
            _validate_private_dir(path)
            return
        try:
            path.mkdir(parents=True, mode=0o700, exist_ok=False)
        except FileExistsError:
            # A concurrent first refresh may have created it before either
            # process acquired the refresh lock. Validate rather than chmod it.
            pass
        else:
            os.chmod(path, 0o700)
        _validate_private_dir(path)
    except SnapshotError:
        raise
    except OSError as exc:
        raise SnapshotError(
            "metadata_snapshot_directory_unavailable",
            "元数据快照目录无法安全创建或访问",
        ) from exc


def _validate_root_separation(paths: SnapshotPaths) -> None:
    private = paths.private_dir.resolve(strict=False)
    consumer = paths.consumer_dir.resolve(strict=False)
    if private == consumer or private.is_relative_to(consumer) or consumer.is_relative_to(private):
        raise SnapshotError(
            "metadata_snapshot_root_overlap",
            "元数据快照私有发布根与消费根必须彼此独立",
        )


def _validate_private_dir(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise SnapshotError("metadata_snapshot_missing", "元数据快照目录缺失") from exc
    except OSError as exc:
        raise SnapshotError("metadata_snapshot_directory_unavailable", "元数据快照目录不可访问") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SnapshotError("metadata_snapshot_unsafe_path", "元数据快照目录类型不安全")
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SnapshotError("metadata_snapshot_dir_permissions", "元数据快照目录属主或权限不符合 0700")


@contextmanager
def _refresh_lock(paths: SnapshotPaths) -> Iterator[None]:
    try:
        fd = os.open(paths.lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError as exc:
        raise SnapshotError(
            "metadata_snapshot_lock_unavailable",
            "元数据快照刷新锁无法安全打开",
        ) from exc
    try:
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SnapshotError(
                "metadata_snapshot_refresh_in_progress",
                "已有元数据快照刷新正在运行，本次未执行",
            ) from exc
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _fetch_dictionary_rows(settings: Settings, credential: CredentialRef) -> list[dict[str, Any]]:
    source_table = _source_table(settings)
    database, table = source_table.split(".", maxsplit=1)
    quoted_source_table = f"{_identifier(database)}.{_identifier(table)}"
    fields = ", ".join(_identifier(field) for field in WHITELIST_FIELDS)
    sql = (
        f"SELECT {fields} FROM {quoted_source_table} "
        f"WHERE ds = (SELECT max(ds) FROM {quoted_source_table}) "
        f"LIMIT {settings.metadata_snapshot_limit + 1}"
    )
    try:
        payload = execute_clickhouse_json(
            target=parse_clickhouse_jdbc_url(credential.jdbc_url),
            sql=sql,
            query_id=f"metadata_snapshot_refresh_{secrets.token_hex(8)}",
            timeout_seconds=min(settings.query_timeout_seconds, 60),
        )
        data = payload.get("data", [])
        if not isinstance(data, list) or not all(isinstance(row, dict) for row in data):
            raise TypeError("unexpected ClickHouse JSON data shape")
        return [dict(row) for row in data]
    except SnapshotError:
        raise
    except Exception as exc:
        raise SnapshotError(
            "metadata_snapshot_source_query_failed",
            "固定元数据字典查询失败，current 保持不变",
        ) from exc


def _write_jsonl(path: Path, rows: list[dict[str, Any]], *, normalize: bool) -> int:
    lines: list[bytes] = []
    for row in rows:
        value = _normalize_row(row) if normalize else {key: _clean_value(value) for key, value in row.items()}
        lines.append(
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            + b"\n"
        )
    _atomic_write(path, b"".join(lines))
    return len(lines)


def _normalize_row(row: dict[str, Any]) -> dict[str, str | None]:
    clean = {field: _clean_value(row.get(field)) for field in WHITELIST_FIELDS}
    missing = [field for field in REQUIRED_FIELDS if clean.get(field) in (None, "")]
    if missing:
        raise SnapshotError(
            "metadata_snapshot_required_field_missing",
            f"元数据快照记录缺少必需字段：{','.join(missing)}",
        )
    return clean


def _read_catalog(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    raise ValueError(f"blank line at {line_number}")
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise TypeError(f"non-object at {line_number}")
                if set(value) != set(WHITELIST_FIELDS):
                    raise ValueError(f"schema mismatch at {line_number}")
                if any(item is not None and not isinstance(item, str) for item in value.values()):
                    raise ValueError(f"field type mismatch at {line_number}")
                _normalize_row(value)
                rows.append(value)
    except SnapshotError:
        raise
    except Exception as exc:
        raise SnapshotError(
            "metadata_snapshot_catalog_invalid",
            "元数据快照 JSONL 解析或字段校验失败",
        ) from exc
    return rows


def _single_partition(rows: list[dict[str, Any]]) -> str:
    partitions = {str(row.get("ds") or "").strip() for row in rows}
    partitions.discard("")
    if len(partitions) != 1:
        raise SnapshotError(
            "metadata_snapshot_partition_invalid",
            "元数据快照必须且只能包含一个非空 ds 分区",
        )
    return next(iter(partitions))


def _validate_partition(partition: str, max_age_days: int) -> None:
    try:
        if not re.fullmatch(r"\d{8}", partition):
            raise ValueError("partition must contain exactly eight digits")
        partition_date = date(int(partition[:4]), int(partition[4:6]), int(partition[6:]))
    except (TypeError, ValueError) as exc:
        raise SnapshotError(
            "metadata_snapshot_partition_invalid",
            "元数据快照 ds 分区必须使用 YYYYMMDD 格式",
        ) from exc
    age_days = (datetime.now(UTC).date() - partition_date).days
    if age_days < 0 or age_days > max_age_days:
        raise SnapshotError(
            "metadata_snapshot_partition_stale",
            "元数据快照源分区超出允许的新鲜度范围",
        )


def _load_or_create_signing_key(paths: SnapshotPaths) -> Ed25519PrivateKey:
    if paths.secret_key_path.exists() or paths.secret_key_path.is_symlink():
        _validate_private_file(paths.secret_key_path)
        try:
            raw = base64.b64decode(paths.secret_key_path.read_bytes(), validate=True)
            key = Ed25519PrivateKey.from_private_bytes(raw)
        except Exception as exc:
            raise SnapshotError(
                "metadata_snapshot_signing_key_invalid",
                "元数据快照签名私钥无效",
            ) from exc
    else:
        if paths.current_link.exists() or paths.current_link.is_symlink():
            raise SnapshotError(
                "metadata_snapshot_signing_key_missing",
                "已有 current 时签名私钥不可重新生成，拒绝刷新",
            )
        key = Ed25519PrivateKey.generate()
        raw = key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        _atomic_write(paths.secret_key_path, base64.b64encode(raw))

    return key


def _publish_public_key(paths: SnapshotPaths, public_key: Ed25519PublicKey) -> None:
    public_raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    _atomic_write(paths.public_key_path, base64.b64encode(public_raw))


def _load_public_key(paths: SnapshotPaths) -> Ed25519PublicKey:
    try:
        _validate_private_file(paths.public_key_path)
        raw = base64.b64decode(paths.public_key_path.read_bytes(), validate=True)
        return Ed25519PublicKey.from_public_bytes(raw)
    except SnapshotError:
        raise
    except Exception as exc:
        raise SnapshotError(
            "metadata_snapshot_public_key_invalid",
            "元数据快照公钥缺失或无效",
        ) from exc


def _validate_private_file(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise SnapshotError("metadata_snapshot_file_missing", "元数据快照文件缺失") from exc
    except OSError as exc:
        raise SnapshotError("metadata_snapshot_file_unavailable", "元数据快照文件不可访问") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise SnapshotError("metadata_snapshot_unsafe_path", "元数据快照文件类型不安全")
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise SnapshotError("metadata_snapshot_file_permissions", "元数据快照文件属主或权限不符合 0600")


def _sign_manifest(manifest: dict[str, Any], key: Ed25519PrivateKey) -> str:
    return base64.b64encode(key.sign(_manifest_bytes(manifest))).decode("ascii")


def _manifest_bytes(manifest: dict[str, Any]) -> bytes:
    payload = {key: value for key, value in manifest.items() if key != "signature"}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _verify_version_dir(
    version_dir: Path,
    public_key: Ed25519PublicKey,
    *,
    expected_version: str,
    expected_source_table: str,
    max_age_seconds: int | None,
    max_partition_age_days: int | None,
) -> dict[str, Any]:
    try:
        _validate_private_dir(version_dir)
        manifest_path = version_dir / MANIFEST_NAME
        catalog_path = version_dir / CATALOG_NAME
        raw_path = version_dir / RAW_NAME
        for path in (manifest_path, catalog_path, raw_path):
            _validate_private_file(path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise TypeError("manifest is not an object")
        signature = manifest.get("signature")
        if not isinstance(signature, str):
            raise InvalidSignature
        public_key.verify(base64.b64decode(signature, validate=True), _manifest_bytes(manifest))
    except SnapshotError:
        raise
    except InvalidSignature as exc:
        raise SnapshotError(
            "metadata_snapshot_signature_invalid",
            "元数据快照 manifest 验签失败",
        ) from exc
    except Exception as exc:
        raise SnapshotError(
            "metadata_snapshot_manifest_invalid",
            "元数据快照 manifest 缺失或格式无效",
        ) from exc

    if manifest.get("schema_version") != SNAPSHOT_SCHEMA_VERSION:
        raise SnapshotError("metadata_snapshot_schema_unsupported", "元数据快照 schema version 不受支持")
    if manifest.get("snapshot_version") != expected_version:
        raise SnapshotError("metadata_snapshot_version_mismatch", "元数据快照版本目录与 manifest 不一致")
    if manifest.get("source_table") != expected_source_table:
        raise SnapshotError("metadata_snapshot_source_mismatch", "元数据快照来源表与当前配置不一致")
    if manifest.get("catalog_file") != CATALOG_NAME or manifest.get("raw_file") != RAW_NAME:
        raise SnapshotError("metadata_snapshot_manifest_invalid", "元数据快照文件清单无效")
    if manifest.get("required_fields") != list(REQUIRED_FIELDS):
        raise SnapshotError("metadata_snapshot_schema_mismatch", "元数据快照必需字段清单不一致")
    if manifest.get("whitelist_fields") != list(WHITELIST_FIELDS):
        raise SnapshotError("metadata_snapshot_schema_mismatch", "元数据快照字段白名单不一致")

    try:
        generated_at = int(manifest["generated_at"])
        row_count = int(manifest["row_count"])
        partition = str(manifest["partition"])
    except (KeyError, TypeError, ValueError) as exc:
        raise SnapshotError("metadata_snapshot_manifest_invalid", "元数据快照 manifest 字段类型无效") from exc
    now = time.time()
    if generated_at <= 0 or generated_at > now + MAX_CLOCK_SKEW_SECONDS:
        raise SnapshotError("metadata_snapshot_timestamp_invalid", "元数据快照生成时间无效")
    if max_age_seconds is not None and now - generated_at > max_age_seconds:
        raise SnapshotError("metadata_snapshot_stale", "元数据快照已过期")
    if max_partition_age_days is not None:
        _validate_partition(partition, max_partition_age_days)
    if row_count <= 0:
        raise SnapshotError("metadata_snapshot_empty", "元数据快照行数必须大于零")
    if _sha256_file(catalog_path) != manifest.get("catalog_sha256"):
        raise SnapshotError("metadata_snapshot_hash_mismatch", "元数据快照 catalog hash 不一致")
    if _sha256_file(raw_path) != manifest.get("raw_sha256"):
        raise SnapshotError("metadata_snapshot_hash_mismatch", "元数据快照 raw hash 不一致")
    rows = _read_catalog(catalog_path)
    if len(rows) != row_count:
        raise SnapshotError("metadata_snapshot_row_count_mismatch", "元数据快照实际行数与 manifest 不一致")
    if {str(row.get("ds") or "") for row in rows} != {partition}:
        raise SnapshotError("metadata_snapshot_partition_mismatch", "元数据快照记录分区与 manifest 不一致")
    return manifest


def _publish_current(
    paths: SnapshotPaths,
    version_dir: Path,
    public_key: Ed25519PublicKey,
    source_table: str,
) -> None:
    current = paths.current_link
    if current.is_symlink():
        previous = _safe_link_target(current, paths.versions_dir, "current")
        _verify_version_dir(
            previous,
            public_key,
            expected_version=previous.name,
            expected_source_table=source_table,
            max_age_seconds=None,
            max_partition_age_days=None,
        )
        _replace_symlink(paths.previous_good_link, previous)
    elif current.exists():
        raise SnapshotError("metadata_snapshot_unsafe_path", "metadata current 不是受控符号链接")
    _replace_symlink(current, version_dir)


def _replace_symlink(link: Path, target: Path) -> None:
    temporary = link.with_name(f".{link.name}.tmp-{secrets.token_hex(4)}")
    try:
        os.symlink(target, temporary)
        os.replace(temporary, link)
    except OSError as exc:
        raise SnapshotError(
            "metadata_snapshot_pointer_write_failed",
            "元数据快照指针无法安全更新",
        ) from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            # The primary operation already succeeded or raised a classified
            # error. A best-effort cleanup must not replace that result.
            pass


def _safe_link_target(link: Path, versions_dir: Path, label: str) -> Path:
    try:
        link_info = link.lstat()
    except FileNotFoundError as exc:
        raise SnapshotError("metadata_snapshot_missing", f"元数据快照 {label} 指针缺失") from exc
    except OSError as exc:
        raise SnapshotError("metadata_snapshot_missing", f"元数据快照 {label} 指针不可访问") from exc
    if not stat.S_ISLNK(link_info.st_mode):
        raise SnapshotError("metadata_snapshot_missing", f"元数据快照 {label} 指针缺失")
    if link_info.st_uid != os.getuid():
        raise SnapshotError("metadata_snapshot_unsafe_path", f"元数据快照 {label} 指针属主无效")
    try:
        _validate_private_dir(versions_dir)
        target = link.resolve(strict=True)
        root = versions_dir.resolve(strict=True)
    except OSError as exc:
        raise SnapshotError("metadata_snapshot_missing", f"元数据快照 {label} 指针无效") from exc
    if target.parent != root:
        raise SnapshotError("metadata_snapshot_unsafe_path", f"元数据快照 {label} 指针越界")
    _validate_private_dir(target)
    return target


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    _atomic_write(path, payload)


def _atomic_write(path: Path, payload: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{secrets.token_hex(4)}")
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            os.close(fd)
    except OSError as exc:
        raise SnapshotError(
            "metadata_snapshot_file_write_failed",
            "元数据快照文件无法安全写入",
        ) from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            # Do not mask the classified write failure above.
            pass


def _sha256_file(path: Path) -> str:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError as exc:
        raise SnapshotError(
            "metadata_snapshot_file_unavailable",
            "元数据快照文件无法读取",
        ) from exc


def _hash_identity(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _identifier(value: str) -> str:
    return "`" + value.replace("`", "``") + "`"


def _source_table(settings: Settings) -> str:
    value = (settings.metadata_snapshot_source_table or "").strip()
    if not value:
        raise SnapshotError(
            "metadata_snapshot_source_table_missing",
            "请通过 DATA_MCP_METADATA_SNAPSHOT_TABLE 配置元数据来源表",
        )
    if not QUALIFIED_TABLE_PATTERN.fullmatch(value):
        raise SnapshotError(
            "metadata_snapshot_source_table_invalid",
            "DATA_MCP_METADATA_SNAPSHOT_TABLE 必须是 database.table 格式的安全标识符",
        )
    return value


def _clean_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _priority_key(priority: str) -> tuple[int, int, str]:
    if priority == "1":
        return (0, 1, "")
    if priority == "2":
        return (1, 2, "")
    try:
        return (2, int(priority), "")
    except ValueError:
        return (2, 2**31 - 1, priority)


def _stable_row_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("full_path") or ""),
        str(row.get("table_name") or ""),
        str(row.get("column_name") or ""),
    )


def _snapshot_summary(current: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": current.name,
        "generated_at": manifest["generated_at"],
        "partition": manifest["partition"],
        "row_count": manifest["row_count"],
        "source_table": manifest["source_table"],
    }
