"""Build one exact result through the real ClickHouse executor and DataMcpService."""

import json
from pathlib import Path

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.credentials.memory import MemoryCredentialResolver
from ksher_agent_data_mcp.db import query_executor
from ksher_agent_data_mcp.db.query_executor import TChouseCQueryExecutor
from ksher_agent_data_mcp.db.sql_guard import SqlGuard
from ksher_agent_data_mcp.dependencies import Container
from ksher_agent_data_mcp.metadata.catalog import MemoryMetadataCatalog
from ksher_agent_data_mcp.models.contracts import Status
from ksher_agent_data_mcp.tools.service import DataMcpService


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SQL = (
    "SELECT toDecimal128('9007199254740993.00', 2) AS amount, "
    "toUInt64(18446744073709551615) AS event_id "
    "UNION ALL SELECT toDecimal128('0.01', 2), toUInt64(2) "
    "UNION ALL SELECT toDecimal128('-3.50', 2), toUInt64(3)"
)


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return (
            b'{"meta":['
            b'{"name":"amount","type":"Decimal(38,2)"},'
            b'{"name":"event_id","type":"UInt64"}],'
            b'"data":['
            b'{"amount":"9007199254740993.00","event_id":"18446744073709551615"},'
            b'{"amount":"0.01","event_id":"2"},'
            b'{"amount":"-3.50","event_id":"3"}],'
            b'"rows":3,"rows_before_limit_at_least":3}'
        )


def fake_urlopen(request, timeout):
    query = request.full_url
    assert "output_format_json_quote_decimals=1" in query
    assert "output_format_json_quote_64bit_integers=1" in query
    return FakeResponse()


def main() -> None:
    settings = Settings(
        CREDENTIAL_PROVIDER="memory",
        CREDENTIAL_MEMORY_FILE=REPOSITORY_ROOT / "examples/credentials.example.json",
        METADATA_PROVIDER="memory",
        QUERY_EXECUTOR="dry_run",
        REQUIRE_PARTITION_FILTER=False,
    )
    catalog = MemoryMetadataCatalog()
    container = Container(
        settings=settings,
        credentials=MemoryCredentialResolver(settings.credential_memory_file),
        catalog=catalog,
        sql_guard=SqlGuard(settings=settings, catalog=catalog),
        executor=TChouseCQueryExecutor(settings),
    )
    service = DataMcpService(container)
    query_executor.urlopen = fake_urlopen
    audit_context = {"sender_type": "user", "session_id": "session_exact_chain"}
    validation = service.validate_sql_for_user(
        "on_example_user",
        "ou_example_user",
        SQL,
        request_lark_app_id="cli_synthetic",
        audit_context=audit_context,
    )
    assert validation["status"] == Status.SUCCESS
    result = service.run_query_for_user(
        "on_example_user",
        "ou_example_user",
        SQL,
        request_lark_app_id="cli_synthetic",
        audit_context=audit_context,
        query_plan_id=validation["query_plan_id"],
    )
    assert result["status"] == Status.SUCCESS
    assert result["rows"][0]["amount"] == "9007199254740993.00"
    assert result["rows"][0]["event_id"] == "18446744073709551615"
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
