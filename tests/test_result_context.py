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


def test_cte_context_preserves_inner_time_grain_and_distinct_measure() -> None:
    context = canonical_result_context(
        "WITH daily AS (SELECT toDate(reg_time) AS day, uniqExact(merchant_id) AS n "
        "FROM analytics.events WHERE reg_time >= '2026-11-15' AND reg_time < '2026-11-24' "
        "GROUP BY day) SELECT calendar.date AS date, ifNull(daily.n, 0) AS total "
        "FROM calendar LEFT JOIN daily ON calendar.date = daily.day",
        datasource="tchouse-c", tables=["analytics.events"],
        referenced_columns=["reg_time", "merchant_id"],
    )
    semantics = context["query_semantics"]
    block = semantics["source_blocks"][0]
    assert block["tables"] == ["analytics.events"]
    assert block["time_groupings"] == [{"column": "reg_time", "grain": "day"}]
    assert block["aggregations"] == [{"column": "merchant_id", "operation": "count_distinct"}]
    assert block["filters"] == [
        {"column": "reg_time", "operator": "gte", "value": "2026-11-15", "is_time": True},
        {"column": "reg_time", "operator": "lt", "value": "2026-11-24", "is_time": True},
    ]
    assert semantics["unmatched_records_zero_filled"] is True
    assert semantics["filter_coverage_complete"] is True
    _assert_digest(context)


def test_branch_filters_are_not_misrepresented_as_a_global_conjunction() -> None:
    context = canonical_result_context(
        "WITH a AS (SELECT value FROM analytics.a WHERE status = 'ok'), "
        "b AS (SELECT value FROM analytics.b WHERE status = 'pending') "
        "SELECT * FROM a UNION ALL SELECT * FROM b",
        datasource="tchouse-c", tables=["analytics.a", "analytics.b"], referenced_columns=["value", "status"],
    )
    blocks = {block["tables"][0]: block for block in context["query_semantics"]["source_blocks"]}
    assert blocks["analytics.a"]["filters"][0]["value"] == "ok"
    assert blocks["analytics.b"]["filters"][0]["value"] == "pending"


def test_unexpanded_derived_filters_do_not_claim_complete_coverage() -> None:
    context = canonical_result_context(
        "WITH daily AS (SELECT sum(amount) AS total FROM analytics.events) "
        "SELECT total FROM daily WHERE total > 100",
        datasource="tchouse-c", tables=["analytics.events"], referenced_columns=["amount"],
    )
    assert context["query_semantics"]["filter_coverage_complete"] is False
