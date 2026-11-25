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
        "query_semantics": _query_semantics(expression, tables),
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


def _query_semantics(expression: exp.Expression, tables: list[str]) -> dict[str, Any]:
    """Keep inner query scopes separate; CTE filters are not outer WHERE clauses."""
    physical = set(tables)
    blocks: list[dict[str, Any]] = []
    covered: set[int] = set()
    for select in expression.find_all(exp.Select):
        sources = sorted({
            ".".join(part for part in [table.catalog, table.db, table.name] if part)
            for table in select.find_all(exp.Table)
            if table.find_ancestor(exp.Select) is select
        } & physical)
        if not sources:
            continue
        covered.add(id(select))
        where = select.args.get("where")
        filters = [] if where is None else [_natural_filter(item) for item in _flatten_and(where.this)]
        time_groups: list[dict[str, str]] = []
        aggregates: list[dict[str, str]] = []
        for function in select.find_all(exp.Func):
            if function.find_ancestor(exp.Select) is not select:
                continue
            name = (function.name if isinstance(function, (exp.Anonymous, exp.AnonymousAggFunc))
                    else function.sql_name()).lower()
            columns = list(function.find_all(exp.Column))
            if len(columns) != 1:
                continue
            column = columns[0].name
            if name in {"todate", "date", "ts_or_ds_to_date"}:
                time_groups.append({"column": column, "grain": "day"})
            if name in {"uniqexact", "countdistinct", "sum", "avg", "min", "max", "count"}:
                distinct = name in {"uniqexact", "countdistinct"} or function.find(exp.Distinct) is not None
                aggregates.append({"column": column, "operation": "count_distinct" if distinct else name})
        blocks.append({"tables": sources, "filters": filters,
                       "time_groupings": time_groups, "aggregations": aggregates})
    zero_fill = any(
        isinstance(function, exp.Coalesce)
        and any(isinstance(item, exp.Literal) and not item.is_string and item.this == "0"
                for item in function.iter_expressions())
        for function in expression.find_all(exp.Func)
    )
    left_join = any(str(join.args.get("side", "")).upper() == "LEFT"
                    for join in expression.find_all(exp.Join))
    complete = all(
        (select.args.get("where") is None or id(select) in covered)
        and select.args.get("having") is None and select.args.get("qualify") is None
        for select in expression.find_all(exp.Select)
    )
    return {"source_blocks": blocks, "unmatched_records_zero_filled": zero_fill and left_join,
            "filter_coverage_complete": complete}


def _natural_filter(item: exp.Expression) -> dict[str, Any]:
    operators = {exp.GTE: "gte", exp.GT: "gt", exp.LTE: "lte", exp.LT: "lt",
                 exp.EQ: "eq", exp.NEQ: "neq"}
    operator = operators.get(type(item))
    if operator and isinstance(item.this, exp.Column):
        value = item.expression
        if isinstance(value, exp.Func):
            name = (value.name if isinstance(value, exp.Anonymous) else value.sql_name()).lower()
            if name in {"todate", "todatetime", "todatetime64", "cast", "ts_or_ds_to_date"}:
                value = value.find(exp.Literal)
        if isinstance(value, exp.Literal):
            return {"column": item.this.name, "operator": operator, "value": value.this,
                    "is_time": bool(_TIME_COLUMN.search(item.this.name))}
    return {"status": "not_simplified"}


def _digest(value: dict[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
