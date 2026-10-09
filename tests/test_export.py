import hashlib
import os
import re
import time
from dataclasses import replace
from pathlib import Path
from zipfile import ZipFile

import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.export import ExportError, LocalExportWriter, build_xlsx_bytes
from ksher_agent_data_mcp.models.contracts import ColumnMeta, QueryResult, Status
from ksher_agent_data_mcp.tools import service as service_module
from ksher_agent_data_mcp.tools.service import DataMcpService

APP_ID = "cli_example"
SESSION_ID = "session_example"
HUMAN_AUDIT_CONTEXT = {"sender_type": "user", "session_id": SESSION_ID}


def test_export_default_row_limit_is_one_hundred_thousand() -> None:
    assert Settings().export_max_rows == 100_000


def test_export_default_file_limit_is_one_gibibyte() -> None:
    assert Settings().export_max_bytes == 1024 * 1024 * 1024


def test_export_sql_account_binding_preserves_unresolved_reason() -> None:
    result = service_module._export_sql_account_binding(
        {
            "datasource": "tchouse-c",
            "tables": [],
            "resolved_by": None,
            "account_bound": False,
            "unresolved_reason": "credential_config_missing",
        }
    )

    assert result == {
        "datasource": "tchouse-c",
        "tables": [],
        "resolved_by": None,
        "account_bound": False,
        "unresolved_reason": "credential_config_missing",
    }


def test_build_xlsx_bytes_creates_workbook(tmp_path: Path) -> None:
    content = build_xlsx_bytes(
        [ColumnMeta(name="merchant_code", type="String"), ColumnMeta(name="amount", type="Float64")],
        [{"merchant_code": "m001", "amount": 12.5}],
    )

    workbook = tmp_path / "export.xlsx"
    workbook.write_bytes(content)

    with ZipFile(workbook) as archive:
        names = set(archive.namelist())
        assert "xl/workbook.xml" in names
        sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
        assert "merchant_code" in sheet
        assert "m001" in sheet
        assert '<pane ySplit="1"' in sheet


def test_local_export_writer_writes_random_0700_artifact_with_digest(tmp_path: Path) -> None:
    writer = LocalExportWriter(
        Settings(METADATA_PROVIDER="memory", DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path)
    )
    content = b"example-xlsx"

    artifact = writer.write_excel("result.xlsx", content)

    path = Path(artifact.path)
    assert path.read_bytes() == content
    assert path.parent.parent == tmp_path
    assert path.parent.name.startswith("export-")
    assert path.parent.name != "export-result"
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert path.stat().st_mode & 0o777 == 0o600
    assert artifact.bytes == len(content)
    assert artifact.sha256 == hashlib.sha256(content).hexdigest()
    assert artifact.mime == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def test_local_export_writer_rejects_path_filename(tmp_path: Path) -> None:
    writer = LocalExportWriter(
        Settings(METADATA_PROVIDER="memory", DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path)
    )

    for filename in ("../result.xlsx", "/tmp/result.xlsx", "nested/result.xlsx"):
        try:
            writer.write_excel(filename, b"example-xlsx")
        except ExportError as exc:
            assert exc.code == "invalid_export_filename"
        else:
            raise AssertionError(f"path filename should fail: {filename}")


def test_local_export_writer_maps_nul_filename_to_export_error(tmp_path: Path) -> None:
    writer = LocalExportWriter(
        Settings(METADATA_PROVIDER="memory", DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path)
    )

    try:
        writer.write_excel("bad\x00name.xlsx", b"example-xlsx")
    except ExportError as exc:
        assert exc.code == "local_export_write_failed"
    else:
        raise AssertionError("NUL filename should fail as export error")

    assert list(tmp_path.iterdir()) == []


def test_local_export_writer_requires_configured_outbox() -> None:
    writer = LocalExportWriter(Settings(METADATA_PROVIDER="memory"))

    try:
        writer.write_excel("result.xlsx", b"example-xlsx")
    except ExportError as exc:
        assert exc.code == "missing_export_outbox_dir"
    else:
        raise AssertionError("missing outbox should fail closed")


def test_local_export_writer_rejects_oversize_without_url(tmp_path: Path) -> None:
    writer = LocalExportWriter(
        Settings(
            METADATA_PROVIDER="memory",
            DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
            DATA_MCP_EXPORT_MAX_BYTES=3,
        )
    )

    try:
        writer.write_excel("result.xlsx", b"too large")
    except ExportError as exc:
        assert exc.code == "export_file_size_limit_exceeded"
        assert not re.search(r"https?://", str(exc))
    else:
        raise AssertionError("oversize export should fail")

    assert list(tmp_path.iterdir()) == []


def test_local_export_writer_allows_file_at_configured_size_limit(tmp_path: Path) -> None:
    writer = LocalExportWriter(
        Settings(
            METADATA_PROVIDER="memory",
            DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
            DATA_MCP_EXPORT_MAX_BYTES=3,
        )
    )

    artifact = writer.write_excel("result.xlsx", b"123")

    assert artifact.bytes == 3
    assert Path(artifact.path).read_bytes() == b"123"


def test_local_export_writer_removes_export_dir_after_write_failure(
    monkeypatch, tmp_path: Path
) -> None:
    writer = LocalExportWriter(
        Settings(METADATA_PROVIDER="memory", DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path)
    )

    def fail_fdopen(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(os, "fdopen", fail_fdopen)

    try:
        writer.write_excel("result.xlsx", b"example-xlsx")
    except ExportError as exc:
        assert exc.code == "local_export_write_failed"
    else:
        raise AssertionError("write failure should fail as export error")

    assert list(tmp_path.iterdir()) == []


def test_local_export_writer_cleanup_expired_keeps_fresh_exports(tmp_path: Path) -> None:
    writer = LocalExportWriter(
        Settings(
            METADATA_PROVIDER="memory",
            DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
            DATA_MCP_EXPORT_FILE_TTL_SECONDS=60,
        )
    )
    expired_dir = tmp_path / "export-expired"
    expired_dir.mkdir()
    expired_file = expired_dir / "old.xlsx"
    expired_file.write_bytes(b"old")
    fresh_dir = tmp_path / "export-fresh"
    fresh_dir.mkdir()
    fresh_file = fresh_dir / "fresh.xlsx"
    fresh_file.write_bytes(b"fresh")
    ignored_dir = tmp_path / "not-an-export"
    ignored_dir.mkdir()
    ignored_file = ignored_dir / "keep.xlsx"
    ignored_file.write_bytes(b"keep")
    old = time.time() - 120
    os.utime(expired_file, (old, old))
    os.utime(expired_dir, (old, old))

    writer.cleanup_expired()

    assert not expired_dir.exists()
    assert fresh_file.exists()
    assert ignored_file.exists()


def test_export_query_to_excel_file_returns_local_file_without_urls(
    monkeypatch, tmp_path: Path
) -> None:
    events = []
    service = DataMcpService(
        build_container(
            Settings(
                METADATA_PROVIDER="memory",
                DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
            )
        )
    )

    def fake_execute(*args, **kwargs):
        return {
            "status": Status.SUCCESS,
            "query_id": "q_example",
            "datasource": "tchouse-c",
            "sql": "SELECT 1 AS cnt",
            "columns": [{"name": "cnt", "type": "UInt64"}],
            "rows": [{"cnt": 1}],
            "row_count": 1,
            "truncated": False,
            "tables": ["analytics.example"],
            "sql_account_binding": {
                "datasource": "tchouse-c",
                "tchouse_account": "demo",
                "tables": ["analytics.example"],
                "resolved_by": "mcp_union_id_mapping",
            },
        }

    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql="SELECT 1 AS cnt",
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            "SELECT 1 AS cnt",
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        filename="注册商户数",
        audit_context={
            "sender_type": "user",
            "session_id": SESSION_ID,
            "turn_id": "turn_123",
            "caller_source": "lark_message",
        },
    )

    assert result["status"] == Status.SUCCESS
    assert result["query_id"] == "q_example"
    assert result["file"]["filename"] == "注册商户数.xlsx"
    assert result["file"]["bytes"] == os.path.getsize(result["file"]["path"])
    assert (
        result["file"]["sha256"]
        == hashlib.sha256(Path(result["file"]["path"]).read_bytes()).hexdigest()
    )
    assert Path(result["file"]["path"]).parent.parent == tmp_path
    assert result["sql_account_binding"] == {
        "datasource": "tchouse-c",
        "tables": ["analytics.example"],
        "resolved_by": "mcp_union_id_mapping",
        "account_bound": True,
    }
    serialized = str(result)
    assert not re.search(r"https?://", serialized)
    for forbidden in (
        "download" + "_url",
        "upload" + "_url",
        "buck" + "et",
        "object" + "_key",
        "q" + "-ak",
    ):
        assert forbidden not in serialized
    assert events[-1].event_type == "excel_export"
    assert events[-1].union_id == "on_example_user"
    assert events[-1].detail["turn_id"] == "turn_123"
    assert events[-1].detail["caller_source"] == "lark_message"
    assert events[-1].detail["file_sha256"] == result["file"]["sha256"]


def test_export_query_to_excel_file_rejects_large_result(monkeypatch) -> None:
    service = DataMcpService(build_container(Settings(METADATA_PROVIDER="memory")))

    def fake_execute(*args, **kwargs):
        return {
            "status": Status.SUCCESS,
            "query_id": "q_example",
            "datasource": "tchouse-c",
            "sql": "SELECT number FROM numbers(2)",
            "columns": [{"name": "number", "type": "UInt64"}],
            "rows": [{"number": 1}, {"number": 2}],
            "row_count": 2,
            "truncated": False,
            "tables": [],
        }

    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql="SELECT number FROM numbers(2)",
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            "SELECT number FROM numbers(2)",
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        max_export_rows=1,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert result["issues"][0]["code"] == "export_row_limit_exceeded"


def test_export_allows_exact_configured_limit_and_probes_one_extra_row(
    monkeypatch, tmp_path: Path
) -> None:
    service = DataMcpService(
        build_container(
            Settings(
                METADATA_PROVIDER="memory",
                DATA_MCP_EXPORT_MAX_ROWS=100_000,
                DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
            )
        )
    )
    seen = {}

    def fake_execute(*args, **kwargs):
        seen.update(kwargs)
        return {
            "status": Status.SUCCESS,
            "query_id": "q_exact_limit",
            "datasource": "tchouse-c",
            "sql": "SELECT number FROM numbers(100000) LIMIT 100000",
            "columns": [{"name": "number", "type": "UInt64"}],
            "rows": [{"number": 1}],
            "row_count": 100_000,
            "truncated": False,
            "tables": [],
        }

    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)
    sql = "SELECT number FROM numbers(100000) LIMIT 100000"

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=sql,
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            sql,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert seen["result_max_rows"] == 100_001


def test_export_without_limit_can_return_more_than_default_query_rows(tmp_path: Path) -> None:
    class RowsExecutor:
        sql = ""
        max_rows = None

        def run(self, credential, sql, timeout_seconds, max_rows=None):
            self.sql = sql
            self.max_rows = max_rows
            rows = [{"number": number} for number in range(1001)]
            return QueryResult(
                status=Status.SUCCESS,
                query_id="q_no_limit_export",
                datasource=credential.datasource,
                sql=sql,
                columns=[ColumnMeta(name="number", type="UInt64")],
                rows=rows,
                row_count=len(rows),
                truncated=False,
            )

    settings = Settings(
        METADATA_PROVIDER="memory",
        CREDENTIAL_MEMORY_FILE=Path("examples/credentials.example.json"),
        REQUIRE_PARTITION_FILTER=False,
        DATA_MCP_EXPORT_MAX_ROWS=100_000,
        DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
    )
    executor = RowsExecutor()
    service = DataMcpService(replace(build_container(settings), executor=executor))
    sql = "SELECT arrayJoin(range(1001)) AS number"

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=sql,
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            sql,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert result["file"]["row_count"] == 1001
    assert executor.sql.endswith("LIMIT 100001")
    assert executor.max_rows == 100_001


def test_export_rejects_one_row_over_configured_limit_before_truncation(monkeypatch) -> None:
    service = DataMcpService(
        build_container(
            Settings(METADATA_PROVIDER="memory", DATA_MCP_EXPORT_MAX_ROWS=100_000)
        )
    )
    seen = {}

    def fake_execute(*args, **kwargs):
        seen.update(kwargs)
        return {
            "status": Status.SUCCESS,
            "query_id": "q_over_limit",
            "datasource": "tchouse-c",
            "sql": "SELECT number FROM numbers(100001) LIMIT 100001",
            "columns": [{"name": "number", "type": "UInt64"}],
            "rows": [{"number": 1}],
            "row_count": 100_001,
            "truncated": True,
            "tables": [],
        }

    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)
    sql = "SELECT number FROM numbers(100001) LIMIT 100001"

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=sql,
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            sql,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        max_export_rows=200_000,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert result["issues"][0]["code"] == "export_row_limit_exceeded"
    assert "100000" in result["message"]
    assert seen["result_max_rows"] == 100_001


def test_export_rejects_incomplete_query_result(monkeypatch, tmp_path: Path) -> None:
    service = DataMcpService(
        build_container(
            Settings(
                METADATA_PROVIDER="memory",
                DATA_MCP_EXPORT_OUTBOX_DIR=tmp_path,
            )
        )
    )

    def fake_execute(*args, **kwargs):
        return {
            "status": Status.SUCCESS,
            "query_id": "q_incomplete",
            "datasource": "tchouse-c",
            "sql": "SELECT number FROM numbers(2)",
            "columns": [{"name": "number", "type": "UInt64"}],
            "rows": [{"number": 1}],
            "row_count": 2,
            "truncated": True,
            "tables": [],
        }

    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)
    sql = "SELECT number FROM numbers(2)"

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=sql,
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            sql,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert result["issues"][0]["code"] == "query_result_truncated"
    assert not list(tmp_path.rglob("*.xlsx"))


@pytest.mark.parametrize("max_export_rows", [0, -1])
def test_export_rejects_nonpositive_caller_limit(max_export_rows: int) -> None:
    service = DataMcpService(build_container(Settings(METADATA_PROVIDER="memory")))
    sql = "SELECT 1"

    result = service.export_query_to_excel_file(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=sql,
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            sql,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        max_export_rows=max_export_rows,
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.VALIDATION_ERROR
    assert result["issues"][0]["code"] == "invalid_export_row_limit"


def test_plain_query_does_not_receive_export_row_override(monkeypatch) -> None:
    service = DataMcpService(build_container(Settings(METADATA_PROVIDER="memory")))
    seen = {}

    def fake_execute(*args, **kwargs):
        seen.update(kwargs)
        return {
            "status": Status.SUCCESS,
            "query_id": "q_plain",
            "datasource": "tchouse-c",
            "sql": "SELECT 1",
            "columns": [{"name": "1", "type": "UInt8"}],
            "rows": [{"1": 1}],
            "row_count": 1,
            "truncated": False,
            "tables": [],
        }

    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)
    sql = "SELECT 1"

    result = service.run_query_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql=sql,
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            sql,
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert "result_max_rows" not in seen


def test_export_query_to_excel_file_does_not_create_file_for_plain_query(monkeypatch) -> None:
    service = DataMcpService(
        build_container(
            Settings(
                METADATA_PROVIDER="memory",
                DATA_MCP_EXPORT_OUTBOX_DIR=Path("/should-not-be-used"),
            )
        )
    )

    def fake_execute(*args, **kwargs):
        return {
            "status": Status.SUCCESS,
            "query_id": "q_example",
            "datasource": "tchouse-c",
            "sql": "SELECT 1 AS cnt",
            "columns": [{"name": "cnt", "type": "UInt64"}],
            "rows": [{"cnt": 1}],
            "row_count": 1,
            "truncated": False,
            "tables": [],
        }

    monkeypatch.setattr(service, "_execute_sql_for_user", fake_execute)

    result = service.run_query_for_user(
        request_user_union_id="on_example_user",
        request_user_open_id="ou_example_user",
        request_lark_app_id=APP_ID,
        sql="SELECT 1 AS cnt",
        query_plan_id=service.query_plans.issue(
            "on_example_user",
            "SELECT 1 AS cnt",
            "tchouse-c",
            session_id=SESSION_ID,
            lark_app_id=APP_ID,
        ),
        audit_context=HUMAN_AUDIT_CONTEXT,
    )

    assert result["status"] == Status.SUCCESS
    assert "file" not in result
    assert not re.search(r"https?://", str(result))
