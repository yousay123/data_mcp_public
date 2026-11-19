"""Canonical, query-plan-bound context for the isolated result Agent."""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from typing import Any

import sqlglot
from sqlglot import exp

SQL_DIALECT = "clickhouse"
_TIME_COLUMN = re.compile(r"(?:^|_)(?:date|time|datetime|timestamp|day|month|year|ds|dt)(?:\b|_)", re.I)


def canonical_result_context(
    normalized_sql: str,
    *,
    datasource: str,
    tables: list[str],
    referenced_columns: list[str],
) -> dict[str, Any]:
    """Derive context from the already validated normalized SQL, never model text."""

    expression = sqlglot.parse_one(normalized_sql, read=SQL_DIALECT)
    select = expression if isinstance(expression, exp.Select) else expression.find(exp.Select)
    projection_items = [] if select is None else list(select.expressions)
    projections = [_projection_name(item) for item in projection_items]
    projections = [value for value in projections if value]
    metric_expressions = [
        item.sql(dialect=SQL_DIALECT, pretty=False) for item in projection_items
    ]
    where = None if select is None else select.args.get("where")
    filters = [] if where is None else [
        item.sql(dialect=SQL_DIALECT, pretty=False) for item in _flatten_and(where.this)
    ]
    time_filters = [item for item in filters if _TIME_COLUMN.search(item)]
    group = None if select is None else select.args.get("group")
    grouping = [] if group is None else [
        item.sql(dialect=SQL_DIALECT, pretty=False) for item in group.expressions
    ]
    context: dict[str, Any] = {
        "schema_version": 1,
        "provenance": "data_mcp_validated_query_plan",
        "datasource": datasource,
        "tables": sorted(set(tables)),
        "metric_columns": projections or sorted(set(referenced_columns)),
        "metric_expressions": metric_expressions,
        "filter_predicates": filters,
        "time_range_predicates": time_filters,
        "grouping_columns": grouping,
        "unit": {"status": "not_inferred_from_sql"},
        "timezone": {"status": "database_session_default"},
    }
    context["integrity"] = {
        "algorithm": "sha256",
        "digest": _digest(context),
    }
    return context


def attach_returned_columns(
    context: dict[str, Any], columns: list[dict[str, Any]]
) -> dict[str, Any]:
    """Finalize a plan-bound context with the actual result schema."""

    finalized = deepcopy(context)
    finalized["returned_columns"] = [
        {"name": str(column.get("name", "")), "type": str(column.get("type", ""))}
        for column in columns
        if isinstance(column, dict) and str(column.get("name", "")).strip()
    ]
    finalized.pop("integrity", None)
    finalized["integrity"] = {"algorithm": "sha256", "digest": _digest(finalized)}
    return finalized


def _projection_name(expression: exp.Expression) -> str:
    alias = expression.alias_or_name
    if alias:
        return str(alias)
    return expression.sql(dialect=SQL_DIALECT, pretty=False)


def _flatten_and(expression: exp.Expression) -> list[exp.Expression]:
    if isinstance(expression, exp.And):
        return [*_flatten_and(expression.left), *_flatten_and(expression.right)]
    return [expression]


def _digest(value: dict[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
