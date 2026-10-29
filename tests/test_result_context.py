import hashlib
import json

from ksher_agent_data_mcp.result_context import (
    attach_returned_columns,
    canonical_result_context,
)


def _assert_digest(context: dict[str, object]) -> None:
    unsigned = dict(context)
    integrity = unsigned.pop("integrity")
    payload = json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert integrity == {
        "algorithm": "sha256",
        "digest": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
    }


def test_context_is_derived_from_validated_sql_and_bound_to_result_schema() -> None:
    context = canonical_result_context(
        "SELECT stat_date, sum(amount) AS total FROM analytics.payments "
        "WHERE stat_date >= '2026-03-01' AND status = 'success' "
        "GROUP BY stat_date LIMIT 200",
        datasource="tchouse-c",
        tables=["analytics.payments"],
        referenced_columns=["amount", "stat_date", "status"],
    )
    assert context["provenance"] == "data_mcp_validated_query_plan"
    assert context["metric_columns"] == ["stat_date", "total"]
    assert context["metric_expressions"] == ["stat_date", "sum(amount) AS total"]
    assert context["grouping_columns"] == ["stat_date"]
    assert context["filter_predicates"] == [
        "stat_date >= '2026-03-01'",
        "status = 'success'",
    ]
    assert context["time_range_predicates"] == ["stat_date >= '2026-03-01'"]
    _assert_digest(context)

    finalized = attach_returned_columns(
        context,
        [{"name": "stat_date", "type": "Date"}, {"name": "total", "type": "Decimal"}],
    )
    assert finalized["returned_columns"][1] == {"name": "total", "type": "Decimal"}
    _assert_digest(finalized)
