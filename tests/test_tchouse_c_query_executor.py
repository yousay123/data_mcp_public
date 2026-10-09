from io import BytesIO
from urllib.error import HTTPError

import pytest

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db import query_executor
from ksher_agent_data_mcp.db.query_executor import (
    TChouseCQueryExecutor,
    parse_clickhouse_jdbc_url,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef, ResultClass, Status


def _credential(datasource: str = "tchouse-c") -> CredentialRef:
    return CredentialRef(
        user_union_id="on_example_user",
        user_email="demo@example.com",
        tchouse_account="demo_user",
        jdbc_url=(
            "jdbc:clickhouse://tchouse-c.example.invalid:8123/example_db;"
            "user=demo_user;password=demo_password"
        ),
        password_secret_ref="secret://demo",
        datasource=datasource,
    )


def test_parse_clickhouse_jdbc_url() -> None:
    target = parse_clickhouse_jdbc_url(_credential().jdbc_url)

    assert target.endpoint == "http://tchouse-c.example.invalid:8123/"
    assert target.database == "example_db"
    assert target.user == "demo_user"
    assert target.password == "demo_password"


def test_tchouse_c_executor_converts_json_response(monkeypatch) -> None:
    seen_settings = {}

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds, query_settings=None):
        seen_settings.update(query_settings or {})
        return {
            "meta": [
                {"name": "user_email", "type": "String"},
                {"name": "cnt", "type": "UInt64"},
            ],
            "data": [{"user_email": "demo@example.com", "cnt": 1}],
            "rows": 1,
            "statistics": {"rows_read": 12, "bytes_read": 345},
        }

    monkeypatch.setattr(query_executor, "execute_clickhouse_json", fake_execute_clickhouse_json)
    executor = TChouseCQueryExecutor(Settings(MAX_ROWS=1000))

    result = executor.run(_credential(), "SELECT 'demo@example.com' AS user_email, 1 AS cnt", 30)

    assert result.status == Status.SUCCESS
    assert result.datasource == "tchouse-c"
    assert [column.name for column in result.columns] == ["user_email", "cnt"]
    assert result.rows == [{"user_email": "demo@example.com", "cnt": 1}]
    assert result.row_count == 1
    assert result.read_rows == 12
    assert result.read_bytes == 345
    assert not result.truncated
    assert seen_settings["max_execution_time"] == "30"
    assert seen_settings["max_rows_to_read"] == "50000000"
    assert seen_settings["max_bytes_to_read"] == str(10 * 1024 * 1024 * 1024)
    assert seen_settings["max_memory_usage"] == str(512 * 1024 * 1024)
    assert seen_settings["max_result_rows"] == "1000"
    assert seen_settings["result_overflow_mode"] == "throw"


def test_tchouse_c_executor_uses_per_call_export_row_limit(monkeypatch) -> None:
    seen_settings = {}

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds, query_settings=None):
        seen_settings.update(query_settings or {})
        return {
            "meta": [{"name": "number", "type": "UInt64"}],
            "data": [{"number": 1}],
            "rows": 1,
        }

    monkeypatch.setattr(query_executor, "execute_clickhouse_json", fake_execute_clickhouse_json)
    executor = TChouseCQueryExecutor(Settings(MAX_ROWS=1000))

    result = executor.run(_credential(), "SELECT 1 AS number", 30, max_rows=100001)

    assert result.status == Status.SUCCESS
    assert not result.truncated
    assert seen_settings["max_result_rows"] == "100001"


@pytest.mark.parametrize(
    ("returned_rows", "expected_truncated"),
    [(1001, False), (100_001, True)],
)
def test_tchouse_c_executor_uses_per_call_limit_for_truncation_detection(
    monkeypatch, returned_rows: int, expected_truncated: bool
) -> None:
    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds, query_settings=None):
        return {
            "meta": [{"name": "number", "type": "UInt64"}],
            "data": [{"number": 1}] * returned_rows,
            "rows": returned_rows,
        }

    monkeypatch.setattr(query_executor, "execute_clickhouse_json", fake_execute_clickhouse_json)

    result = TChouseCQueryExecutor(Settings(MAX_ROWS=1000)).run(
        _credential(), "SELECT number FROM numbers(100001)", 30, max_rows=100_001
    )

    assert result.status == Status.SUCCESS
    assert result.truncated is expected_truncated


def test_tchouse_c_executor_rejects_other_datasource() -> None:
    executor = TChouseCQueryExecutor(Settings())

    result = executor.run(_credential(datasource="other"), "SELECT 1", 30)

    assert result.status == Status.ERROR
    assert "仅支持 TChouse-C SELECT / SHOW" in result.quality_warnings[0]


def test_tchouse_c_executor_returns_structured_error(monkeypatch) -> None:
    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        raise RuntimeError("boom")

    monkeypatch.setattr(query_executor, "execute_clickhouse_json", fake_execute_clickhouse_json)
    executor = TChouseCQueryExecutor(Settings())

    result = executor.run(_credential(), "SELECT 1", 30)

    assert result.status == Status.ERROR
    assert result.result_class == ResultClass.INCONCLUSIVE
    assert result.rows == []
    assert "TChouse-C 查询执行失败" in result.quality_warnings[0]


def test_tchouse_c_sql_error_is_classified_for_repair(monkeypatch) -> None:
    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds, query_settings=None):
        raise HTTPError(
            url="http://clickhouse/",
            code=500,
            msg="failure",
            hdrs=None,
            fp=BytesIO(
                b"Code: 47. DB::Exception: Unknown identifier (UNKNOWN_IDENTIFIER) (version 23.8.9.1)"
            ),
        )

    monkeypatch.setattr(query_executor, "execute_clickhouse_json", fake_execute_clickhouse_json)
    result = TChouseCQueryExecutor(Settings()).run(_credential(), "SELECT missing", 30)

    assert result.result_class == ResultClass.CK_QUERY_ERROR
    assert result.error_code == "ck_47"
    assert result.error_name == "UNKNOWN_IDENTIFIER"
    assert result.retryable is True


def test_tchouse_c_resource_limit_errors_are_inconclusive_and_not_repairable(
    monkeypatch,
) -> None:
    for error_name in (
        "MEMORY_LIMIT_EXCEEDED",
        "QUERY_WAS_CANCELLED",
        "TIMEOUT_EXCEEDED",
        "TOO_MANY_ROWS_OR_BYTES",
    ):
        def fake_execute_clickhouse_json(
            target,
            sql,
            query_id,
            timeout_seconds,
            query_settings=None,
            *,
            _error_name=error_name,
        ):
            detail = (
                f"Code: 396. DB::Exception: Resource limit exceeded "
                f"({_error_name}) (version 23.8.9.1)"
            )
            raise HTTPError(
                url="http://clickhouse/",
                code=500,
                msg="failure",
                hdrs=None,
                fp=BytesIO(detail.encode("utf-8")),
            )

        monkeypatch.setattr(
            query_executor,
            "execute_clickhouse_json",
            fake_execute_clickhouse_json,
        )
        result = TChouseCQueryExecutor(Settings()).run(_credential(), "SELECT 1", 30)

        assert result.result_class == ResultClass.INCONCLUSIVE, error_name
        assert result.error_code == "ck_396", error_name
        assert result.error_name == error_name
        assert result.retryable is False, error_name
