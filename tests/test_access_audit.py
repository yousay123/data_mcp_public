from __future__ import annotations

import re
from dataclasses import replace
from typing import Any

import pytest

from ksher_agent_data_mcp.access_audit import (
    SUPPORTED_SCHEMA_COLUMNS,
    AccessInspectionAuditor,
)
from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db.query_executor import ClickHouseJdbcTarget
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.models.contracts import CredentialRef
from ksher_agent_data_mcp.tools import service as service_module
from ksher_agent_data_mcp.tools.service import DataMcpService

TARGET = ClickHouseJdbcTarget(
    endpoint="http://ck-a:8123/",
    database="default",
    user="audit_reader",
    password="secret",
)


def _schema_rows() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for full_name, fields in sorted(SUPPORTED_SCHEMA_COLUMNS.items()):
        database, table = full_name.split(".")
        rows.extend(
            {"database": database, "table": table, "name": field, "type": "String"}
            for field in fields
        )
    return rows


def _base_rows() -> dict[str, list[dict[str, Any]]]:
    return {
        "users": [
            {
                "name": "reader",
                "default_roles_all": 1,
                "default_roles_list": [],
                "default_roles_except": [],
            }
        ],
        "grants": [
            {
                "user_name": None,
                "role_name": "role_reader",
                "access_type": "SELECT",
                "database": "demo",
                "table": "orders",
                "column": None,
                "is_partial_revoke": 0,
                "grant_option": 0,
            }
        ],
        "role_grants": [
            {
                "user_name": "reader",
                "role_name": None,
                "granted_role_name": "role_reader",
                "granted_role_id": "node-local-uuid",
                "granted_role_is_default": 1,
                "with_admin_option": 0,
            }
        ],
        "tables": [
            {
                "database": "demo",
                "name": "orders",
                "engine": "Distributed",
                "engine_full": "Distributed('default_cluster', 'demo', 'orders_local', rand())",
            },
            {
                "database": "demo",
                "name": "orders_local",
                "engine": "ReplicatedMergeTree",
                "engine_full": "ReplicatedMergeTree('/path', '{replica}') ORDER BY id",
            },
        ],
    }


def _fetch_factory(per_node, *, fail_node=None, seen_query_settings=None):
    def fetch(target, sql, query_id, timeout_seconds, query_settings=None):
        if seen_query_settings is not None:
            seen_query_settings.append(dict(query_settings or {}))
        node = "node-a"
        if node == fail_node:
            raise TimeoutError("injected node timeout")
        if "version()" in sql:
            return {"data": [{"version": "23.8.9.1"}]}
        if "system.columns" in sql and "table = 'tables'" in sql:
            return {
                "data": [
                    {"database": "system", "table": "tables", "name": name, "type": "String"}
                    for name in ("database", "name", "engine", "engine_full")
                ]
            }
        if "system.columns" in sql:
            return {"data": _schema_rows()}
        if "system.clusters" in sql:
            return {"data": [{"host_name": "ck-a"}, {"host_name": "ck-b"}]}
        if "system.role_grants" in sql:
            return {"data": per_node[node]["role_grants"]}
        if "system.grants" in sql:
            return {"data": per_node[node]["grants"]}
        if "system.users" in sql:
            return {"data": per_node[node]["users"]}
        if "system.tables" in sql:
            rows = per_node[node]["tables"]
            if "engine = 'Distributed'" in sql:
                rows = [row for row in rows if row["engine"] == "Distributed"]
            if "(database, name) IN (" in sql:
                pairs = set(re.findall(r"\('([^']+)', '([^']+)'\)", sql))
                rows = [row for row in rows if (row["database"], row["name"]) in pairs]
            return {"data": rows}
        raise AssertionError(sql)

    return fetch


def _auditor(
    per_node, *, fail_node=None, settings=None, seen_query_settings=None
) -> AccessInspectionAuditor:
    return AccessInspectionAuditor(
        settings or Settings(),
        TARGET,
        fetch=_fetch_factory(
            per_node,
            fail_node=fail_node,
            seen_query_settings=seen_query_settings,
        ),
    )


def test_subjects_by_table_scans_all_scopes_and_nested_roles() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["users"].extend(
            [
                {
                    "name": "db_reader",
                    "default_roles_all": 1,
                    "default_roles_list": [],
                    "default_roles_except": [],
                },
                {
                    "name": "global_reader",
                    "default_roles_all": 0,
                    "default_roles_list": [],
                    "default_roles_except": [],
                },
            ]
        )
        snapshot["grants"].extend(
            [
                {
                    "user_name": "db_reader",
                    "role_name": None,
                    "access_type": "SELECT",
                    "database": "demo",
                    "table": None,
                    "column": None,
                    "is_partial_revoke": 0,
                    "grant_option": 0,
                },
                {
                    "user_name": "global_reader",
                    "role_name": None,
                    "access_type": "SELECT",
                    "database": None,
                    "table": None,
                    "column": None,
                    "is_partial_revoke": 0,
                    "grant_option": 0,
                },
                {
                    "user_name": None,
                    "role_name": "role_nested",
                    "access_type": "SELECT",
                    "database": "demo",
                    "table": "orders",
                    "column": None,
                    "is_partial_revoke": 0,
                    "grant_option": 0,
                },
            ]
        )
        snapshot["role_grants"].append(
            {
                "user_name": None,
                "role_name": "role_reader",
                "granted_role_name": "role_nested",
                "granted_role_id": "local",
                "granted_role_is_default": 0,
                "with_admin_option": 0,
            }
        )

    result = _auditor(rows).subjects_by_table(target_tables=["demo.orders"])

    assert result["verdict"] == "consistent"
    account_rows = {
        item["subject_name"]: item
        for item in result["results"]
        if item["subject_type"] == "account"
    }
    assert set(account_rows) == {"reader", "db_reader", "global_reader"}
    assert account_rows["reader"]["role_paths"] == ["role_reader", "role_reader -> role_nested"]
    assert account_rows["reader"]["active_by_default"] is True
    assert account_rows["global_reader"]["source_scopes"] == ["global"]


def test_subjects_by_table_treats_all_privilege_as_including_select() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["users"].append(
            {
                "name": "all_reader",
                "default_roles_all": 1,
                "default_roles_list": [],
                "default_roles_except": [],
            }
        )
        snapshot["grants"].append(
            {
                "user_name": "all_reader",
                "role_name": None,
                "access_type": "ALL",
                "database": None,
                "table": None,
                "column": None,
                "is_partial_revoke": 0,
                "grant_option": 0,
            }
        )

    result = _auditor(rows).subjects_by_table(target_tables=["demo.orders"])

    all_reader = next(
        item
        for item in result["results"]
        if item["subject_type"] == "account" and item["subject_name"] == "all_reader"
    )
    assert all_reader["has_access"] is True
    assert all_reader["source_scopes"] == ["global"]


def test_subjects_by_table_applies_revoke_and_flags_column_level() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"].append(
            {
                "user_name": None,
                "role_name": "role_reader",
                "access_type": "SELECT",
                "database": "demo",
                "table": "orders",
                "column": None,
                "is_partial_revoke": 1,
                "grant_option": 0,
            }
        )
    result = _auditor(rows).subjects_by_table(target_tables=["demo.orders"])
    reader = next(item for item in result["results"] if item["subject_name"] == "reader")
    assert reader["permission_class"] == "revoked"

    for snapshot in rows.values():
        snapshot["grants"][-1]["column"] = "amount"
    result = _auditor(rows).subjects_by_table(target_tables=["demo.orders"])
    reader = next(
        item
        for item in result["node_results"]["single_endpoint"]
        if item["subject_name"] == "reader"
    )
    assert result["verdict"] == "inconclusive"
    assert result["error_code"] == "column_level_requires_review"
    assert reader["permission_class"] == "column_level_requires_review"
    assert reader["column_level_anomaly"] is True


def test_subjects_by_table_distinguishes_default_role_state_and_role_subject() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["role_grants"][0]["granted_role_is_default"] = 0
        snapshot["role_grants"].append(
            {
                "user_name": None,
                "role_name": "role_reader",
                "granted_role_name": "role_nested",
                "granted_role_id": "nested-role-uuid",
                "granted_role_is_default": 0,
                "with_admin_option": 0,
            }
        )
        snapshot["grants"].append(
            {
                "user_name": None,
                "role_name": "role_nested",
                "access_type": "SELECT",
                "database": "demo",
                "table": "orders",
                "column": None,
                "is_partial_revoke": 0,
                "grant_option": 0,
            }
        )

    result = _auditor(rows).subjects_by_table(target_tables=["demo.orders"])

    by_subject = {(item["subject_type"], item["subject_name"]): item for item in result["results"]}
    assert by_subject[("account", "reader")]["role_held"] is True
    assert by_subject[("account", "reader")]["active_by_default"] is False
    assert by_subject[("role", "role_reader")]["active_by_default"] is None


def test_resources_by_subject_includes_inheritance_and_classifies_base_local() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"].append(
            {
                "user_name": None,
                "role_name": "role_reader",
                "access_type": "SELECT",
                "database": "demo",
                "table": "orders_local",
                "column": None,
                "is_partial_revoke": 0,
                "grant_option": 0,
            }
        )

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "consistent"
    by_table = {item["table"]: item for item in result["results"] if item["record_type"] == "grant"}
    assert by_table["orders"]["resource_kind"] == "base"
    assert by_table["orders_local"]["resource_kind"] == "local"
    assert by_table["orders"]["source_subject_name"] == "role_reader"
    assert by_table["orders"]["role_path"] == ["role_reader"]
    assert result["system_tables_projection"] == ["database", "name", "engine", "engine_full"]


def test_resources_by_role_includes_direct_and_inherited_member_accounts() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["users"].append(
            {
                "name": "nested_reader",
                "default_roles_all": 1,
                "default_roles_list": [],
                "default_roles_except": [],
            }
        )
        snapshot["role_grants"].extend(
            [
                {
                    "user_name": "nested_reader",
                    "role_name": None,
                    "granted_role_name": "role_team",
                    "granted_role_id": "team-id",
                    "granted_role_is_default": 1,
                    "with_admin_option": 0,
                },
                {
                    "user_name": None,
                    "role_name": "role_team",
                    "granted_role_name": "role_reader",
                    "granted_role_id": "reader-id",
                    "granted_role_is_default": 0,
                    "with_admin_option": 0,
                },
            ]
        )

    result = _auditor(rows).resources_by_subject(
        target_accounts=[], target_roles=["role_reader"]
    )

    members = {
        item["member_account"]: item
        for item in result["results"]
        if item["record_type"] == "role_member"
    }
    assert members["reader"]["membership_type"] == "direct"
    assert members["reader"]["role_path"] == ["role_reader"]
    assert members["nested_reader"]["membership_type"] == "inherited"
    assert members["nested_reader"]["role_path"] == ["role_team", "role_reader"]


def test_resources_by_subject_classifies_visible_non_distributed_table_as_independent() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["tables"].append(
            {
                "database": "demo",
                "name": "merchant_dimension",
                "engine": "MergeTree",
                "engine_full": "MergeTree ORDER BY merchant_id",
            }
        )
        snapshot["grants"].append(
            {
                "user_name": None,
                "role_name": "role_reader",
                "access_type": "SELECT",
                "database": "demo",
                "table": "merchant_dimension",
                "column": None,
                "is_partial_revoke": 0,
                "grant_option": 0,
            }
        )

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "consistent"
    dimension_grant = next(
        item
        for item in result["results"]
        if item["record_type"] == "grant" and item["table"] == "merchant_dimension"
    )
    assert dimension_grant["resource_kind"] == "independent"


def test_resources_by_subject_classifies_cross_database_distributed_target_as_local() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"][0]["database"] = "db_raw"
        snapshot["grants"][0]["table"] = "fact_t_local"
        snapshot["tables"] = [
            {
                "database": "db_mart",
                "name": "fact_t",
                "engine": "Distributed",
                "engine_full": ("Distributed('default_cluster', 'db_raw', 'fact_t_local', rand())"),
            },
            {
                "database": "db_raw",
                "name": "fact_t_local",
                "engine": "ReplicatedMergeTree",
                "engine_full": "ReplicatedMergeTree('/path', '{replica}') ORDER BY id",
            },
        ]

    base_fetch = _fetch_factory(rows)
    seen_global_mapping_query = False

    def fetch(target, sql, query_id, timeout_seconds, query_settings=None):
        nonlocal seen_global_mapping_query
        if "system.tables" in sql and "engine = 'Distributed'" in sql:
            seen_global_mapping_query = True
        return base_fetch(target, sql, query_id, timeout_seconds, query_settings)

    auditor = AccessInspectionAuditor(Settings(), TARGET, fetch)
    result = auditor.resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert seen_global_mapping_query is True
    assert result["verdict"] == "consistent"
    local_grant = next(
        item
        for item in result["results"]
        if item["record_type"] == "grant" and item["table"] == "fact_t_local"
    )
    assert local_grant["resource_kind"] == "local"


def test_resources_by_subject_distinguishes_missing_account_from_no_grants() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}

    result = _auditor(rows).resources_by_subject(
        target_accounts=["missing_account"], target_roles=[]
    )

    assert result["verdict"] == "consistent"
    assert result["results"] == [
        {
            "record_type": "subject_presence",
            "subject_type": "account",
            "subject_name": "missing_account",
            "subject_exists": False,
        }
    ]


def test_resources_by_subject_does_not_expose_engine_expression_or_column_name() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"][0]["column"] = "secret_column"

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    encoded = str(result)
    assert result["verdict"] == "inconclusive"
    assert result["error_code"] == "column_level_requires_review"
    assert "secret_column" not in encoded
    assert "Distributed(" not in encoded


def test_resources_by_subject_unparseable_distributed_mapping_is_inconclusive() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["tables"][0]["engine_full"] = (
            "Distributed('{cluster}', currentDatabase(), orders_local)"
        )

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "inconclusive"
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "distributed_mapping_unresolved"}
    ]


def test_resources_by_subject_preserves_grant_for_missing_table_as_unclassified() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"][0]["table"] = "dropped_t"

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "inconclusive"
    assert result["error_code"] == "resource_metadata_incomplete"
    stale_grant = next(
        item
        for item in result["node_results"]["single_endpoint"]
        if item["record_type"] == "grant" and item["table"] == "dropped_t"
    )
    assert stale_grant["resource_kind"] == "unclassified"
    assert result["inconclusive_subjects"] == [
        {"subject_type": "account", "subject_name": "reader"}
    ]
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "resource_metadata_incomplete"}
    ]


def test_resources_by_subject_identifies_only_subjects_with_unclassified_grants() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"][0]["table"] = "dropped_t"
        snapshot["users"].append(
            {
                "name": "stable_reader",
                "default_roles_all": 1,
                "default_roles_list": [],
                "default_roles_except": [],
            }
        )
        snapshot["grants"].append(
            {
                "user_name": "stable_reader",
                "role_name": None,
                "access_type": "SELECT",
                "database": "demo",
                "table": "orders",
                "column": None,
                "is_partial_revoke": 0,
                "grant_option": 0,
            }
        )

    result = _auditor(rows).resources_by_subject(
        target_accounts=["reader", "stable_reader"], target_roles=[]
    )

    assert result["verdict"] == "inconclusive"
    assert result["inconclusive_subjects"] == [
        {"subject_type": "account", "subject_name": "reader"}
    ]
    stable_grant = next(
        item
        for item in result["node_results"]["single_endpoint"]
        if item.get("subject_name") == "stable_reader" and item.get("record_type") == "grant"
    )
    assert stable_grant["resource_kind"] == "base"


def test_resources_by_subject_ignores_unparseable_unreferenced_table_mapping() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["tables"].append(
            {
                "database": "demo",
                "name": "unreferenced_view",
                "engine": "Distributed",
                "engine_full": "Distributed('{cluster}', currentDatabase(), unreferenced_local)",
            }
        )

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "consistent"
    order_grant = next(
        item
        for item in result["results"]
        if item["record_type"] == "grant" and item["table"] == "orders"
    )
    assert order_grant["resource_kind"] == "base"


@pytest.mark.parametrize("database", [r"bad\database", "bad'database"])
def test_resources_by_subject_rejects_non_identifier_database_metadata(database: str) -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["grants"][0]["database"] = database

    result = _auditor(rows).resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "inconclusive"
    assert result["error_code"] == "access_inspection_metadata_incomplete"
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "invalid_metadata_identifier"}
    ]


def test_system_tables_projection_shape_drift_is_inconclusive() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    base_fetch = _fetch_factory(rows)

    def fetch(target, sql, query_id, timeout_seconds, query_settings=None):
        payload = base_fetch(target, sql, query_id, timeout_seconds, query_settings)
        if "table = 'tables'" in sql:
            payload["data"] = payload["data"][:-1]
        return payload

    auditor = AccessInspectionAuditor(Settings(), TARGET, fetch)
    result = auditor.resources_by_subject(target_accounts=["reader"], target_roles=[])

    assert result["verdict"] == "inconclusive"
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "unsupported_schema:system.tables_projection"}
    ]


def test_role_cycle_is_bounded_and_does_not_duplicate_root_role() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["role_grants"].extend(
            [
                {
                    "user_name": None,
                    "role_name": "role_reader",
                    "granted_role_name": "role_nested",
                    "granted_role_id": "a",
                    "granted_role_is_default": 0,
                    "with_admin_option": 0,
                },
                {
                    "user_name": None,
                    "role_name": "role_nested",
                    "granted_role_name": "role_reader",
                    "granted_role_id": "b",
                    "granted_role_is_default": 0,
                    "with_admin_option": 0,
                },
            ]
        )

    result = _auditor(rows).resources_by_subject(target_accounts=[], target_roles=["role_reader"])

    assert result["verdict"] == "consistent"
    assert all(
        item["role_path"] != ["role_nested", "role_reader"]
        for item in result["results"]
        if item["record_type"] == "grant"
    )


def test_role_closure_overflow_is_inconclusive(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    for snapshot in rows.values():
        snapshot["role_grants"].append(
            {
                "user_name": None,
                "role_name": "role_reader",
                "granted_role_name": "role_nested",
                "granted_role_id": "nested",
                "granted_role_is_default": 0,
                "with_admin_option": 0,
            }
        )
    monkeypatch.setattr("ksher_agent_data_mcp.access_audit._ROLE_PATH_LIMIT", 1)

    result = _auditor(rows).subjects_by_table(target_tables=["demo.orders"])

    assert result["verdict"] == "inconclusive"
    assert result["error_code"] == "access_inspection_incomplete"
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "role_closure_overflow"}
    ]


def test_inspection_rejects_unbounded_or_ambiguous_scope() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    auditor = _auditor(rows)
    with pytest.raises(ValueError):
        auditor.subjects_by_table(target_tables=[])
    with pytest.raises(ValueError, match="invalid target table"):
        auditor.subjects_by_table(target_tables=["*.*"])
    with pytest.raises(ValueError):
        auditor.resources_by_subject(target_accounts=[], target_roles=[])


def test_inspection_output_limit_is_inconclusive_not_truncated() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    settings = Settings(DATA_MCP_ACCESS_AUDIT_MAX_ROWS=1)

    result = _auditor(rows, settings=settings).subjects_by_table(target_tables=["demo.orders"])

    assert result["verdict"] == "inconclusive"
    assert result["error_code"] == "access_inspection_result_limit_exceeded"
    assert result["results"] == []
    assert result["node_results"] == {}


def test_all_remaining_tools_mark_single_endpoint_scope() -> None:
    rows = {"node-a": _base_rows()}
    auditor = _auditor(rows)

    results = [
        auditor.subjects_by_table(target_tables=["demo.orders"]),
        auditor.resources_by_subject(target_accounts=["reader"], target_roles=[]),
        auditor.default_role_baseline(),
    ]

    assert [result["scope"] for result in results] == ["single_endpoint"] * 3
    assert all(result["cross_node_compared"] is False for result in results)
    assert all("不等于集群全局事实" in result["scope_notice"] for result in results)


def test_access_audit_version_change_fails_closed() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    base_fetch = _fetch_factory(rows)

    def fetch(target, sql, query_id, timeout_seconds, query_settings=None):
        if "version()" in sql:
            return {"data": [{"version": "23.8.10.1"}]}
        return base_fetch(target, sql, query_id, timeout_seconds, query_settings)

    auditor = AccessInspectionAuditor(Settings(), TARGET, fetch)
    result = auditor.subjects_by_table(target_tables=["demo.orders"])
    assert result["verdict"] == "inconclusive"
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "unsupported_version:23.8.10.1"}
    ]


def test_access_audit_schema_change_fails_closed() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    base_fetch = _fetch_factory(rows)

    def fetch(target, sql, query_id, timeout_seconds, query_settings=None):
        if "system.columns" in sql and "table IN" in sql:
            return {
                "data": [
                    row
                    for row in _schema_rows()
                    if not (row["table"] == "grants" and row["name"] == "grant_option")
                ]
            }
        return base_fetch(target, sql, query_id, timeout_seconds, query_settings)

    auditor = AccessInspectionAuditor(Settings(), TARGET, fetch)
    result = auditor.subjects_by_table(target_tables=["demo.orders"])
    assert result["verdict"] == "inconclusive"
    assert result["node_errors"] == [
        {"node": "single_endpoint", "reason": "unsupported_schema:system.grants"}
    ]


def test_default_role_baseline_returns_only_anomalies() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    rows["node-a"]["users"].append(
        {
            "name": "legacy_reader",
            "default_roles_all": 0,
            "default_roles_list": ["role_reader"],
            "default_roles_except": [],
        }
    )
    result = _auditor(rows).default_role_baseline()
    assert result["verdict"] == "partial"
    assert result["anomalies"] == [
        {"node": "single_endpoint", "name": "legacy_reader", "default_roles_all": 0}
    ]
    assert {item["name"] for item in result["anomalies"]} == {"legacy_reader"}


def test_access_audit_uses_dedicated_result_limit_and_throw_mode() -> None:
    rows = {node: _base_rows() for node in ("node-a", "node-b")}
    seen_query_settings: list[dict[str, str]] = []
    settings = Settings(MAX_ROWS=7, DATA_MCP_ACCESS_AUDIT_MAX_ROWS=1234)

    result = _auditor(
        rows,
        settings=settings,
        seen_query_settings=seen_query_settings,
    ).subjects_by_table(target_tables=["demo.orders"])

    assert result["verdict"] == "consistent"
    assert seen_query_settings
    assert {item["max_result_rows"] for item in seen_query_settings} == {"1234"}
    assert {item["result_overflow_mode"] for item in seen_query_settings} == {"throw"}


class _StubAuditor:
    def default_role_baseline(self):
        return {
            "status": "success",
            "scope": "single_endpoint",
            "verdict": "consistent",
            "anomalies": [],
        }

    def subjects_by_table(self, **kwargs):
        return {
            "status": "success",
            "scope": "single_endpoint",
            "verdict": "consistent",
            "results": [],
        }

    def resources_by_subject(self, **kwargs):
        return {
            "status": "success",
            "scope": "single_endpoint",
            "verdict": "consistent",
            "results": [],
        }


class _StubCredentials:
    def resolve(self, user, datasource="tchouse-c"):
        return CredentialRef(
            user_union_id=user.union_id,
            tchouse_account=f"ck_{user.union_id}",
            jdbc_url=(
                "jdbc:clickhouse://example.invalid:8123/default;"
                f"user=ck_{user.union_id};password=secret"
            ),
            password_secret_ref=f"memory://{user.union_id}",
            datasource=datasource,
        )


def _service_with_auditor(*, max_calls_per_turn: int = 20) -> DataMcpService:
    settings = Settings(
        METADATA_PROVIDER="memory",
        DATA_MCP_ACCESS_AUDIT_ALLOWED_UNION_IDS="on_user,on_schedule",
        DATA_MCP_ACCESS_INSPECTION_MAX_CALLS_PER_TURN=max_calls_per_turn,
    )
    container = replace(
        build_container(settings),
        credentials=_StubCredentials(),
        access_auditor_factory=lambda credential: _StubAuditor(),
    )
    return DataMcpService(container)


def test_access_inspection_allows_owner_schedule_and_rejects_union_outside_allowlist() -> None:
    service = _service_with_auditor()
    common = {
        "request_user_union_id": "on_user",
        "request_user_open_id": "ou_user",
        "request_lark_app_id": "cli_app_allowed",
    }
    denied = service.inspect_ck_subjects_by_table(
        **common, target_tables=["demo.orders"], audit_context={"sender_type": "bot"}
    )
    disallowed = service.inspect_ck_resources_by_subject(
        **{**common, "request_user_union_id": "on_other"},
        target_accounts=["reader"],
        target_roles=[],
        audit_context={"sender_type": "user"},
    )
    allowed = service.inspect_ck_resources_by_subject(
        **common,
        target_accounts=["reader"],
        target_roles=[],
        audit_context={"sender_type": "user", "turn_id": "turn-1"},
    )
    schedule = service.inspect_ck_subjects_by_table(
        **{**common, "request_user_union_id": "on_schedule"},
        target_tables=["demo.orders"],
        audit_context={
            "sender_type": "bot",
            "caller_source": "schedule_creator",
            "task_id": "task-1",
            "turn_id": "turn-schedule-1",
        },
    )
    assert denied["error_code"] == "access_audit_human_or_schedule_required"
    assert disallowed["error_code"] == "access_audit_union_id_not_allowed"
    assert allowed["verdict"] == "consistent"
    assert schedule["verdict"] == "consistent"


def test_union_allowlist_gates_all_three_audit_tools() -> None:
    service = _service_with_auditor()
    common = {
        "request_user_union_id": "on_not_allowed",
        "request_user_open_id": "ou_not_allowed",
        "request_lark_app_id": "cli_app",
    }
    human_context = {"sender_type": "user", "turn_id": "turn-human"}
    schedule_context = {
        "sender_type": "bot",
        "caller_source": "schedule_creator",
        "task_id": "task-audit",
        "turn_id": "turn-schedule",
    }

    results = [
        service.inspect_ck_subjects_by_table(
            **common,
            target_tables=["demo.orders"],
            audit_context=human_context,
        ),
        service.inspect_ck_resources_by_subject(
            **common,
            target_accounts=["reader"],
            target_roles=[],
            audit_context=human_context,
        ),
        service.audit_ck_default_role_baseline(
            **common,
            audit_context=schedule_context,
        ),
    ]

    assert [result["error_code"] for result in results] == [
        "access_audit_union_id_not_allowed",
    ] * 3


@pytest.mark.parametrize(
    "audit_context",
    [
        {"sender_type": "user", "session_id": "session-human", "turn_id": "turn-human"},
        {
            "sender_type": "bot",
            "caller_source": "schedule_creator",
            "task_id": "task-query",
            "session_id": "session-schedule",
            "turn_id": "turn-schedule",
        },
    ],
)
def test_union_allowlist_is_scoped_to_audit_tools_only(audit_context) -> None:
    service = _service_with_auditor()
    common = {
        "request_user_union_id": "on_not_allowed",
        "request_user_open_id": "ou_not_allowed",
        "request_lark_app_id": "cli_app",
    }
    sql = "SELECT 1"

    validation = service.validate_sql_for_user(
        **common,
        sql=sql,
        audit_context=audit_context,
    )
    execution = service.run_query_for_user(
        **common,
        sql=sql,
        audit_context=audit_context,
        query_plan_id=validation["query_plan_id"],
    )
    inspection = service.inspect_ck_subjects_by_table(
        **common,
        target_tables=["demo.orders"],
        audit_context=audit_context,
    )

    assert validation["status"] == "success"
    assert execution["status"] == "success"
    assert inspection["error_code"] == "access_audit_union_id_not_allowed"


def test_access_audit_factory_receives_the_callers_resolved_credential() -> None:
    settings = Settings(
        METADATA_PROVIDER="memory",
        DATA_MCP_ACCESS_AUDIT_ALLOWED_UNION_IDS="on_user",
    )
    seen: list[CredentialRef] = []

    def factory(credential):
        seen.append(credential)
        return _StubAuditor()

    service = DataMcpService(
        replace(
            build_container(settings),
            credentials=_StubCredentials(),
            access_auditor_factory=factory,
        )
    )
    result = service.inspect_ck_subjects_by_table(
        request_user_union_id="on_user",
        request_user_open_id="ou_user",
        request_lark_app_id="cli_app",
        target_tables=["demo.orders"],
        audit_context={"sender_type": "user", "turn_id": "turn-1"},
    )

    assert result["verdict"] == "consistent"
    assert len(seen) == 1
    assert seen[0].user_union_id == "on_user"
    assert seen[0].tchouse_account == "ck_on_user"


def test_access_inspection_requires_turn_and_limits_calls_per_turn() -> None:
    service = _service_with_auditor(max_calls_per_turn=1)
    common = {
        "request_user_union_id": "on_user",
        "request_user_open_id": "ou_user",
        "request_lark_app_id": "cli_app_allowed",
        "target_tables": ["demo.orders"],
    }
    missing_turn = service.inspect_ck_subjects_by_table(
        **common, audit_context={"sender_type": "user"}
    )
    first = service.inspect_ck_subjects_by_table(
        **common, audit_context={"sender_type": "user", "turn_id": "turn-1"}
    )
    second = service.inspect_ck_subjects_by_table(
        **common, audit_context={"sender_type": "user", "turn_id": "turn-1"}
    )
    next_turn = service.inspect_ck_subjects_by_table(
        **common, audit_context={"sender_type": "user", "turn_id": "turn-2"}
    )
    assert missing_turn["error_code"] == "access_inspection_turn_required"
    assert first["verdict"] == "consistent"
    assert second["error_code"] == "access_inspection_rate_limit"
    assert next_turn["verdict"] == "consistent"


def test_default_role_baseline_requires_schedule_source(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = _service_with_auditor()
    common = {
        "request_user_union_id": "on_user",
        "request_user_open_id": "ou_user",
        "request_lark_app_id": "cli_app_allowed",
    }

    human = service.audit_ck_default_role_baseline(
        **common,
        audit_context={"sender_type": "user", "turn_id": "turn-human"},
    )
    schedule = service.audit_ck_default_role_baseline(
        **common,
        audit_context={
            "sender_type": "bot",
            "caller_source": "schedule_creator",
            "task_id": "task-1",
        },
    )

    assert human["result_class"] == "policy_error"
    assert human["error_code"] == "access_audit_schedule_required"
    assert schedule["verdict"] == "consistent"
    rejected = [
        event
        for event in events
        if event.event_type == "ck_default_role_baseline"
        and event.detail["error_code"] == "access_audit_schedule_required"
    ]
    assert len(rejected) == 1
    assert rejected[0].status == "error"
    assert rejected[0].union_id == "on_user"
    assert rejected[0].detail["caller_source"] is None
    assert rejected[0].detail["task_id"] is None
    assert rejected[0].detail["turn_id"] == "turn-human"


def test_default_role_baseline_audits_union_allowlist_rejection(monkeypatch) -> None:
    events = []
    monkeypatch.setattr(service_module.audit_logger, "emit", events.append)
    service = _service_with_auditor()

    result = service.audit_ck_default_role_baseline(
        request_user_union_id="on_not_allowed",
        request_user_open_id="ou_not_allowed",
        request_lark_app_id="cli_app",
        audit_context={
            "sender_type": "bot",
            "caller_source": "schedule_creator",
            "task_id": "task-denied",
            "turn_id": "turn-denied",
        },
    )

    assert result["error_code"] == "access_audit_union_id_not_allowed"
    rejected = [
        event
        for event in events
        if event.event_type == "ck_default_role_baseline"
    ]
    assert len(rejected) == 1
    assert rejected[0].status == "error"
    assert rejected[0].union_id == "on_not_allowed"
    assert rejected[0].detail["verdict"] == "inconclusive"
    assert rejected[0].detail["error_code"] == "access_audit_union_id_not_allowed"
    assert rejected[0].detail["caller_source"] == "schedule_creator"
    assert rejected[0].detail["task_id"] == "task-denied"
    assert rejected[0].detail["turn_id"] == "turn-denied"
