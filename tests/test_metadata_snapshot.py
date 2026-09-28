from __future__ import annotations

import fcntl
import hashlib
import json
import os
from datetime import UTC, datetime

import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.metadata import snapshot as snapshot_module
from ksher_agent_data_mcp.metadata.snapshot import (
    CATALOG_NAME,
    MANIFEST_NAME,
    RAW_NAME,
    SnapshotError,
    refresh_metadata_snapshot,
    search_metadata_snapshot,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef
from ksher_agent_data_mcp.tools import service as service_module
from ksher_agent_data_mcp.tools.service import DataMcpService

SOURCE_TABLE = "analytics.metadata_dictionary"


def _settings(tmp_path, **extra) -> Settings:
    values = {
        "MCP_ENV": "dev",
        "CREDENTIAL_PROVIDER": "memory",
        "QUERY_EXECUTOR": "dry_run",
        "METADATA_PROVIDER": "memory",
        "DATA_MCP_METADATA_SNAPSHOT_PRIVATE_DIR": tmp_path / "private",
        "DATA_MCP_METADATA_SNAPSHOT_CONSUMER_DIR": tmp_path / "consumer",
        "DATA_MCP_METADATA_SNAPSHOT_MAX_PARTITION_AGE_DAYS": 2,
        "DATA_MCP_METADATA_SNAPSHOT_TABLE": SOURCE_TABLE,
    }
    values.update(extra)
    return Settings(**values)


def _credential() -> CredentialRef:
    return CredentialRef(
        user_union_id="on_owner",
        tchouse_account="owner_ck",
        jdbc_url="jdbc:clickhouse://ck.example:8123/analytics;user=owner_ck;password=test",
        password_secret_ref="test",
        datasource="tchouse-c",
    )


def _row(*, priority: str = "1", table: str = "dwd_bill_di", column: str = "merchant_id"):
    return {
        "priority": priority,
        "full_path": f"/billing/{table}/{column}",
        "backend_name": "billing",
        "type_classify": "明细",
        "source_type": "ck",
        "biz_domain": "billing",
        "database_name": "analytics",
        "table_name": table,
        "table_comment": "账单明细",
        "column_name": column,
        "column_comment": "商户号",
        "biz_definition": "商户账单指标",
        "sensitive_level": "L1",
        "ds": datetime.now(UTC).strftime("%Y%m%d"),
    }


def _install_source(monkeypatch, rows):
    def fake_execute(*, target, sql, query_id, timeout_seconds):
        assert "`analytics`.`metadata_dictionary`" in sql
        assert "SELECT max(ds)" in sql
        assert query_id.startswith("metadata_snapshot_refresh_")
        return {"data": rows, "rows": len(rows)}

    monkeypatch.setattr(snapshot_module, "execute_clickhouse_json", fake_execute)


def _refresh(settings: Settings):
    return refresh_metadata_snapshot(
        settings,
        _credential(),
        owner_union_id="on_owner",
        task_id="task_test",
        lark_app_id="cli_test",
    )


def _current(tmp_path):
    return (tmp_path / "consumer" / "current").resolve(strict=True)


def test_refresh_publishes_signed_private_snapshot_and_searches(tmp_path, monkeypatch) -> None:
    rows = [
        _row(priority="10", table="table_ten"),
        _row(priority="2", table="table_two"),
        _row(priority="1", table="table_one"),
    ]
    _install_source(monkeypatch, rows)
    settings = _settings(tmp_path)

    result = _refresh(settings)
    found = search_metadata_snapshot(settings, query="账单", limit=10)

    assert result["status"] == "success"
    assert result["row_count"] == 3
    assert [item["priority"] for item in found["results"]] == ["1", "2", "10"]
    assert found["snapshot"]["version"] == result["version"]
    current = _current(tmp_path)
    assert current.parent == (tmp_path / "private" / "versions").resolve()
    for path in (
        tmp_path / "private" / "manifest.secret",
        tmp_path / "consumer" / "manifest.public",
        current / MANIFEST_NAME,
        current / CATALOG_NAME,
        current / RAW_NAME,
    ):
        assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_priority_order_precedes_text_match_score(tmp_path, monkeypatch) -> None:
    high_priority = _row(priority="1", table="preferred", column="other")
    lower_priority = _row(priority="2", table="secondary", column="merchant_id")
    lower_priority["biz_definition"] = "商户 merchant_id 商户"
    _install_source(monkeypatch, [lower_priority, high_priority])
    settings = _settings(tmp_path)
    _refresh(settings)

    found = search_metadata_snapshot(settings, query="商户 merchant_id", limit=10)

    assert [item["table_name"] for item in found["results"]] == ["preferred", "secondary"]


def test_refresh_uses_limit_plus_one_and_rejects_truncated_snapshot(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path, DATA_MCP_METADATA_SNAPSHOT_LIMIT=2)
    seen_sql = ""

    def fake_execute(*, target, sql, query_id, timeout_seconds):
        nonlocal seen_sql
        seen_sql = sql
        return {"data": [_row(table="one"), _row(table="two"), _row(table="three")]}

    monkeypatch.setattr(snapshot_module, "execute_clickhouse_json", fake_execute)

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_row_limit_exceeded"
    assert "LIMIT 3" in seen_sql
    assert not (tmp_path / "consumer" / "current").exists()


def test_failed_refresh_does_not_replace_existing_current(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row(table="good")])
    first = _refresh(settings)
    current_link = tmp_path / "consumer" / "current"
    first_target = current_link.resolve(strict=True)

    _install_source(monkeypatch, [{**_row(table="bad"), "ds": "not-a-date"}])
    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_partition_invalid"
    assert current_link.resolve(strict=True) == first_target
    assert first_target.name == first["version"]


def test_refresh_rejects_missing_required_field_without_publishing(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    invalid = _row()
    invalid["table_name"] = ""
    _install_source(monkeypatch, [invalid])

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_required_field_missing"
    assert not (tmp_path / "consumer" / "current").exists()


def test_refresh_rejects_multiple_partitions_without_publishing(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    second = _row(table="other")
    second["ds"] = "20260907"
    _install_source(monkeypatch, [_row(), second])

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_partition_invalid"
    assert not (tmp_path / "consumer" / "current").exists()


def test_second_refresh_preserves_verified_previous_good(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row(table="first")])
    first = _refresh(settings)
    first_target = _current(tmp_path)
    _install_source(monkeypatch, [_row(table="second")])

    second = _refresh(settings)

    assert second["version"] != first["version"]
    assert _current(tmp_path).name == second["version"]
    assert (tmp_path / "private" / "previous-good").resolve(strict=True) == first_target


def test_corrupt_current_is_not_promoted_to_previous_good(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row(table="first")])
    _refresh(settings)
    first_target = _current(tmp_path)
    with (first_target / CATALOG_NAME).open("a", encoding="utf-8") as handle:
        handle.write("{}\n")
    _install_source(monkeypatch, [_row(table="second")])

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_hash_mismatch"
    assert _current(tmp_path) == first_target
    assert not (tmp_path / "private" / "previous-good").exists()


def test_missing_signing_key_never_rotates_key_under_existing_current(
    tmp_path, monkeypatch
) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row(table="first")])
    _refresh(settings)
    current = _current(tmp_path)
    public_key = (tmp_path / "consumer" / "manifest.public").read_bytes()
    (tmp_path / "private" / "manifest.secret").unlink()
    _install_source(monkeypatch, [_row(table="second")])

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_signing_key_missing"
    assert _current(tmp_path) == current
    assert (tmp_path / "consumer" / "manifest.public").read_bytes() == public_key


def test_catalog_is_parsed_and_validated_after_hash_and_signature(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)
    current = _current(tmp_path)
    catalog = current / CATALOG_NAME
    catalog.write_text("not-json\n", encoding="utf-8")
    manifest_path = current / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["catalog_sha256"] = hashlib.sha256(catalog.read_bytes()).hexdigest()
    key = snapshot_module._load_or_create_signing_key(snapshot_module._paths(settings))
    manifest["signature"] = snapshot_module._sign_manifest(manifest, key)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单")

    assert exc_info.value.code == "metadata_snapshot_catalog_invalid"


def test_tampered_catalog_fails_closed(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)
    with (_current(tmp_path) / CATALOG_NAME).open("a", encoding="utf-8") as handle:
        handle.write("{}\n")

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单")

    assert exc_info.value.code == "metadata_snapshot_hash_mismatch"


def test_tampered_manifest_fails_signature_validation(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)
    manifest_path = _current(tmp_path) / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["row_count"] = 99
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单")

    assert exc_info.value.code == "metadata_snapshot_signature_invalid"


def test_stale_signed_snapshot_fails_closed(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path, DATA_MCP_METADATA_SNAPSHOT_MAX_AGE_SECONDS=60)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)
    manifest_path = _current(tmp_path) / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["generated_at"] = 1
    key = snapshot_module._load_or_create_signing_key(snapshot_module._paths(settings))
    manifest["signature"] = snapshot_module._sign_manifest(manifest, key)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单")

    assert exc_info.value.code == "metadata_snapshot_stale"


def test_consumer_rejects_relaxed_version_directory_permissions(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)
    current = _current(tmp_path)
    os.chmod(current, 0o755)

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单")

    assert exc_info.value.code == "metadata_snapshot_dir_permissions"


def test_consumer_rejects_current_link_outside_versions_root(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    current_link = tmp_path / "consumer" / "current"
    current_link.unlink()
    current_link.symlink_to(outside)

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单")

    assert exc_info.value.code == "metadata_snapshot_unsafe_path"


def test_concurrent_refresh_fails_without_touching_current(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    paths = snapshot_module._paths(settings)
    snapshot_module._ensure_base_dirs(paths)
    lock_fd = os.open(paths.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        with pytest.raises(SnapshotError) as exc_info:
            _refresh(settings)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)

    assert exc_info.value.code == "metadata_snapshot_refresh_in_progress"
    assert not (tmp_path / "consumer" / "current").exists()


def test_refresh_rejects_overlapping_private_and_consumer_roots(tmp_path, monkeypatch) -> None:
    settings = _settings(
        tmp_path,
        DATA_MCP_METADATA_SNAPSHOT_PRIVATE_DIR=tmp_path / "shared",
        DATA_MCP_METADATA_SNAPSHOT_CONSUMER_DIR=tmp_path / "shared" / "consumer",
    )
    _install_source(monkeypatch, [_row()])

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_root_overlap"
    assert not (tmp_path / "shared").exists()


def test_refresh_rejects_missing_source_table_configuration(tmp_path) -> None:
    settings = _settings(tmp_path, DATA_MCP_METADATA_SNAPSHOT_TABLE="")

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_source_table_missing"


@pytest.mark.parametrize("source_table", ["table_only", "db.table; DROP TABLE users", "db.`table`"])
def test_refresh_rejects_unsafe_source_table_configuration(tmp_path, source_table) -> None:
    settings = _settings(tmp_path, DATA_MCP_METADATA_SNAPSHOT_TABLE=source_table)

    with pytest.raises(SnapshotError) as exc_info:
        _refresh(settings)

    assert exc_info.value.code == "metadata_snapshot_source_table_invalid"


@pytest.mark.parametrize("limit", [0, 51, True])
def test_search_rejects_invalid_limit(tmp_path, monkeypatch, limit) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单", limit=limit)

    assert exc_info.value.code == "metadata_snapshot_limit_invalid"


def test_search_rejects_non_string_priority(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)

    with pytest.raises(SnapshotError) as exc_info:
        search_metadata_snapshot(settings, query="账单", priority=1)  # type: ignore[arg-type]

    assert exc_info.value.code == "metadata_snapshot_priority_invalid"


def test_no_match_is_explicit_and_does_not_invite_online_fallback(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)

    result = search_metadata_snapshot(settings, query="完全不存在的指标")

    assert result["status"] == "not_found"
    assert result["error_code"] == "metadata_snapshot_no_match"
    assert result["results"] == []
    assert "猜测" in result["message"]
    assert "在线" not in result["suggested_action"]


def test_refresh_rejects_non_schedule_and_missing_app_binding(tmp_path) -> None:
    service = DataMcpService(build_container(_settings(tmp_path)))

    human = service.refresh_metadata_snapshot_for_owner(
        "on_owner",
        "ou_owner",
        "cli_test",
        audit_context={"sender_type": "user", "caller_source": "gateway_meta"},
    )
    missing_app = service.refresh_metadata_snapshot_for_owner(
        "on_owner",
        "ou_owner",
        None,
        audit_context={"caller_source": "schedule_creator", "task_id": "task_test"},
    )
    missing_open_id = service.refresh_metadata_snapshot_for_owner(
        "on_owner",
        None,
        "cli_test",
        audit_context={"caller_source": "schedule_creator", "task_id": "task_test"},
    )

    for result in (human, missing_app, missing_open_id):
        assert result["status"] == "validation_error"
        assert result["issues"][0]["code"] == "metadata_snapshot_schedule_identity_required"
        assert result["permission_scope"] == "metadata_snapshot_refresh"


def test_service_refresh_uses_schedule_owner_credential_and_fixed_snapshot_api(
    tmp_path, monkeypatch
) -> None:
    service = DataMcpService(build_container(_settings(tmp_path)))
    credential = _credential()
    captured = {}
    monkeypatch.setattr(service.container.credentials, "resolve", lambda user, datasource: credential)

    def fake_refresh(settings, resolved, *, owner_union_id, task_id, lark_app_id):
        captured.update(
            credential=resolved,
            owner_union_id=owner_union_id,
            task_id=task_id,
            lark_app_id=lark_app_id,
        )
        return {
            "status": "success",
            "version": "snapshot-test",
            "source_table": SOURCE_TABLE,
            "partition": datetime.now(UTC).strftime("%Y%m%d"),
            "row_count": 1,
        }

    monkeypatch.setattr(service_module, "refresh_metadata_snapshot", fake_refresh)
    result = service.refresh_metadata_snapshot_for_owner(
        "on_owner",
        "ou_owner",
        "cli_test",
        audit_context={
            "caller_source": "schedule_creator",
            "task_id": "task_test",
            "sender_type": "bot",
        },
    )

    assert result["status"] == "success"
    assert captured == {
        "credential": credential,
        "owner_union_id": "on_owner",
        "task_id": "task_test",
        "lark_app_id": "cli_test",
    }


def test_service_snapshot_error_never_suggests_online_metadata_fallback(
    tmp_path, monkeypatch
) -> None:
    service = DataMcpService(build_container(_settings(tmp_path)))

    def fail(*args, **kwargs):
        raise SnapshotError("metadata_snapshot_signature_invalid", "验签失败")

    monkeypatch.setattr(service_module, "search_metadata_snapshot", fail)
    result = service.search_metadata_snapshot("账单")

    assert result["status"] == "error"
    assert result["error_code"] == "metadata_snapshot_signature_invalid"
    assert "不得改用在线元数据" in result["suggested_action"]


def test_refresh_manifest_hashes_task_and_app_identity(tmp_path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    _install_source(monkeypatch, [_row()])
    _refresh(settings)

    manifest = json.loads((_current(tmp_path) / MANIFEST_NAME).read_text(encoding="utf-8"))
    serialized = json.dumps(manifest)
    assert "task_test" not in serialized
    assert "cli_test" not in serialized
    assert manifest["task_id_hash"] == hashlib.sha256(b"task_test").hexdigest()
    assert manifest["lark_app_id_hash"] == hashlib.sha256(b"cli_test").hexdigest()
