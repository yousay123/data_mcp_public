"""Fixed-template ClickHouse access inspection from one configured entry point.

The inspector deliberately does not accept SQL. It uses the trusted caller's
own identity and marks every conclusion as entry-point scoped.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from typing import Any

import sqlglot
from sqlglot import exp

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.db.query_executor import (
    ClickHouseJdbcTarget,
    execute_clickhouse_json,
    parse_clickhouse_jdbc_url,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef

SUPPORTED_CK_VERSION = "23.8.9.1"
SUPPORTED_SCHEMA_COLUMNS = {
    "system.users": (
        "name",
        "id",
        "storage",
        "auth_type",
        "auth_params",
        "host_ip",
        "host_names",
        "host_names_regexp",
        "host_names_like",
        "default_roles_all",
        "default_roles_list",
        "default_roles_except",
        "grantees_any",
        "grantees_list",
        "grantees_except",
        "default_database",
    ),
    "system.grants": (
        "user_name",
        "role_name",
        "access_type",
        "database",
        "table",
        "column",
        "is_partial_revoke",
        "grant_option",
    ),
    "system.role_grants": (
        "user_name",
        "role_name",
        "granted_role_name",
        "granted_role_id",
        "granted_role_is_default",
        "with_admin_option",
    ),
}
_ACCOUNT = re.compile(r"^[A-Za-z0-9_.@-]{1,128}$")
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$")
_SUBJECT_LIMIT = 100
_INSPECTION_TABLE_LIMIT = 50
_ROLE_PATH_LIMIT = 1000
_SYSTEM_TABLES_PROJECTION = ("database", "name", "engine", "engine_full")
_SELECT_ACCESS_TYPES = frozenset({"SELECT", "ALL"})


AuditFetch = Callable[[ClickHouseJdbcTarget, str, str, int, dict[str, str] | None], dict[str, Any]]


class AccessInspectionAuditor:
    def __init__(
        self,
        settings: Settings,
        target: ClickHouseJdbcTarget,
        fetch: AuditFetch = execute_clickhouse_json,
    ) -> None:
        if not target.user or not target.password:
            raise ValueError("access audit caller credentials are incomplete")
        self.settings = settings
        self.target = target
        self.fetch = fetch

    @classmethod
    def from_credential(
        cls,
        settings: Settings,
        credential: CredentialRef,
        fetch: AuditFetch = execute_clickhouse_json,
    ) -> AccessInspectionAuditor:
        return cls(settings, parse_clickhouse_jdbc_url(credential.jdbc_url), fetch)

    def default_role_baseline(self) -> dict[str, Any]:
        snapshots, preflight = self._snapshots()
        if snapshots is None:
            return preflight
        anomalies: list[dict[str, Any]] = []
        for node_id, rows_by_table in snapshots.items():
            for row in rows_by_table["system.users"]:
                if int(row.get("default_roles_all") or 0) == 0:
                    anomalies.append(
                        {
                            "node": node_id,
                            "name": str(row.get("name") or ""),
                            "default_roles_all": 0,
                        }
                    )
        result = dict(preflight)
        result.update(
            {
                "status": "success",
                "result_class": "success",
                "verdict": "partial" if anomalies else "consistent",
                "anomalies": sorted(anomalies, key=lambda item: (item["name"], item["node"])),
            }
        )
        return result

    def subjects_by_table(self, *, target_tables: list[str]) -> dict[str, Any]:
        """Resolve direct and inherited SELECT holders for explicit tables.

        This is intentionally a fixed-template inspection of one configured
        entry point. Every response carries an explicit single-endpoint scope.
        """
        tables = sorted({_validate_table(value) for value in target_tables})
        if not tables or len(tables) > _INSPECTION_TABLE_LIMIT:
            raise ValueError("target_tables must contain 1..50 database.table names")
        snapshots, preflight = self._snapshots()
        if snapshots is None:
            return _inspection_failure(preflight, "subjects_by_table", target_tables=tables)

        node_results: dict[str, list[dict[str, Any]]] = {}
        try:
            for node_id, snapshot in snapshots.items():
                node_results[node_id] = _subjects_for_tables(snapshot, tables)
        except RuntimeError as exc:
            failed = dict(preflight)
            failed.update(
                {
                    "status": "error",
                    "result_class": "inconclusive",
                    "verdict": "inconclusive",
                    "error_code": "access_inspection_incomplete",
                    "node_errors": [{"node": node_id, "reason": _safe_reason(exc)}],
                }
            )
            return _inspection_failure(failed, "subjects_by_table", target_tables=tables)
        return _inspection_result(
            preflight,
            mode="subjects_by_table",
            node_results=node_results,
            max_rows=self.settings.access_audit_max_rows,
            target_tables=tables,
        )

    def resources_by_subject(
        self,
        *,
        target_accounts: list[str],
        target_roles: list[str],
    ) -> dict[str, Any]:
        """Resolve direct/inherited resources for explicit account/role names."""
        accounts = sorted({_validate_account(value) for value in target_accounts})
        roles = sorted({_validate_account(value) for value in target_roles})
        if not accounts and not roles:
            raise ValueError("target_accounts or target_roles must contain at least one subject")
        if len(accounts) + len(roles) > _SUBJECT_LIMIT:
            raise ValueError("target_accounts and target_roles may contain at most 100 subjects")

        snapshots, preflight = self._snapshots()
        if snapshots is None:
            return _inspection_failure(
                preflight,
                "resources_by_subject",
                target_accounts=accounts,
                target_roles=roles,
            )

        try:
            resources = sorted(
                {
                    (
                        str(item["grant"]["database"]).lower(),
                        str(item["grant"]["table"]).lower(),
                    )
                    for snapshot in snapshots.values()
                    for subject_type, names in (("account", accounts), ("role", roles))
                    for subject_name in names
                    for item in _effective_grant_evidence(snapshot, subject_type, subject_name)
                    if item["grant"].get("database") and item["grant"].get("table")
                }
            )
        except RuntimeError as exc:
            failed = dict(preflight)
            failed.update(
                {
                    "status": "error",
                    "result_class": "inconclusive",
                    "verdict": "inconclusive",
                    "error_code": "access_inspection_incomplete",
                    "node_errors": [{"node": "all", "reason": _safe_reason(exc)}],
                }
            )
            return _inspection_failure(
                failed,
                "resources_by_subject",
                target_accounts=accounts,
                target_roles=roles,
            )

        metadata, metadata_preflight = self._table_metadata_snapshots(resources)
        if metadata is None:
            merged = dict(preflight)
            merged.update(metadata_preflight)
            return _inspection_failure(
                merged,
                "resources_by_subject",
                target_accounts=accounts,
                target_roles=roles,
            )

        node_results: dict[str, list[dict[str, Any]]] = {}
        try:
            for node_id, snapshot in snapshots.items():
                node_results[node_id] = _resources_for_subjects(
                    snapshot,
                    metadata[node_id],
                    accounts,
                    roles,
                )
        except RuntimeError as exc:
            failed = dict(preflight)
            failed.update(metadata_preflight)
            failed.update(
                {
                    "status": "error",
                    "result_class": "inconclusive",
                    "verdict": "inconclusive",
                    "error_code": "access_inspection_incomplete",
                    "node_errors": [{"node": node_id, "reason": _safe_reason(exc)}],
                }
            )
            return _inspection_failure(
                failed,
                "resources_by_subject",
                target_accounts=accounts,
                target_roles=roles,
            )
        combined_preflight = dict(preflight)
        combined_preflight.update(metadata_preflight)
        return _inspection_result(
            combined_preflight,
            mode="resources_by_subject",
            node_results=node_results,
            max_rows=self.settings.access_audit_max_rows,
            fail_on_unclassified_resources=True,
            target_accounts=accounts,
            target_roles=roles,
        )

    def _table_metadata_snapshots(
        self,
        resources: list[tuple[str, str]],
    ) -> tuple[dict[str, list[dict[str, Any]]] | None, dict[str, Any]]:
        node_id = "single_endpoint"
        resource_set = set(resources)
        try:
            schema_rows = self._query(
                self.target,
                "SELECT database, table, name, type FROM system.columns "
                "WHERE database = 'system' AND table = 'tables' "
                "AND name IN ('database', 'name', 'engine', 'engine_full') "
                "ORDER BY position",
            )
            names = tuple(str(row.get("name") or "") for row in schema_rows)
            if names != _SYSTEM_TABLES_PROJECTION:
                raise RuntimeError("unsupported_schema:system.tables_projection")
            projection_fingerprint = _schema_fingerprint(schema_rows)
            if resources:
                resource_literals = ", ".join(
                    f"({_quote_literal(database)}, {_quote_literal(table)})"
                    for database, table in resources
                )
                scoped_rows = self._query(
                    self.target,
                    "SELECT database, name, engine, engine_full FROM system.tables "
                    f"WHERE (database, name) IN ({resource_literals}) "
                    "ORDER BY database, name",
                )
            else:
                scoped_rows = []
            distributed_rows = (
                self._query(
                    self.target,
                    "SELECT database, name, engine, engine_full FROM system.tables "
                    "WHERE engine = 'Distributed' ORDER BY database, name",
                )
                if resource_set
                else []
            )
            target_rows = [
                row
                for row in scoped_rows
                if (
                    str(row.get("database") or "").lower(),
                    str(row.get("name") or "").lower(),
                )
                in resource_set
            ]
            relevant_distributed_rows = []
            for row in distributed_rows:
                source = (
                    str(row.get("database") or "").lower(),
                    str(row.get("name") or "").lower(),
                )
                target_table = _parse_distributed_target(str(row.get("engine_full") or ""))
                if source in resource_set or target_table in resource_set:
                    relevant_distributed_rows.append(row)
            rows = list(
                {
                    (
                        str(row.get("database") or "").lower(),
                        str(row.get("name") or "").lower(),
                    ): row
                    for row in [*relevant_distributed_rows, *target_rows]
                }.values()
            )
            return {node_id: rows}, {
                "system_tables_projection": list(_SYSTEM_TABLES_PROJECTION),
                "system_tables_schema_fingerprint": projection_fingerprint,
                "system_tables_metadata_fingerprint": hashlib.sha256(
                    _canonical_json(rows).encode("utf-8")
                ).hexdigest(),
                "system_tables_distributed_fingerprint": hashlib.sha256(
                    _canonical_json(distributed_rows).encode("utf-8")
                ).hexdigest(),
            }
        except Exception as exc:  # noqa: BLE001 - incomplete metadata invalidates proof
            return None, {
                "status": "error",
                "result_class": "inconclusive",
                "verdict": "inconclusive",
                "error_code": "access_inspection_metadata_incomplete",
                "node_errors": [{"node": node_id, "reason": _safe_reason(exc)}],
            }

    def _snapshots(
        self,
    ) -> tuple[dict[str, dict[str, list[dict[str, Any]]]] | None, dict[str, Any]]:
        node_id = "single_endpoint"
        snapshots: dict[str, dict[str, list[dict[str, Any]]]] = {}
        version: str | None = None
        fingerprint: str | None = None
        errors: list[dict[str, str]] = []

        try:
            version_rows = self._query(self.target, "SELECT version() AS version")
            version = str(version_rows[0]["version"])
            if version != SUPPORTED_CK_VERSION:
                raise RuntimeError(f"unsupported_version:{version}")

            schema_rows = self._query(
                self.target,
                "SELECT database, table, name, type FROM system.columns "
                "WHERE database = 'system' AND table IN ('users', 'grants', 'role_grants') "
                "ORDER BY table, position",
            )
            _validate_schema(schema_rows)
            fingerprint = _schema_fingerprint(schema_rows)

            snapshots[node_id] = {
                "system.users": self._query(
                    self.target,
                    "SELECT name, default_roles_all, default_roles_list, "
                    "default_roles_except FROM system.users",
                ),
                "system.grants": self._query(
                    self.target,
                    "SELECT user_name, role_name, access_type, database, table, column, "
                    "is_partial_revoke, grant_option FROM system.grants",
                ),
                "system.role_grants": self._query(
                    self.target,
                    "SELECT user_name, role_name, granted_role_name, granted_role_id, "
                    "granted_role_is_default, with_admin_option FROM system.role_grants",
                ),
            }
        except Exception as exc:  # noqa: BLE001 - incomplete entry-point view invalidates proof
            errors.append({"node": node_id, "reason": _safe_reason(exc)})

        base = {
            "audit_id": f"access_audit_{uuid.uuid4().hex}",
            "scope": "single_endpoint",
            "scope_notice": "入口节点视角，不等于集群全局事实",
            "cross_node_compared": False,
            "expected_nodes": [node_id],
            "observed_nodes": sorted(snapshots),
            "ck_version": version,
            "schema_fingerprint": fingerprint,
            "execution_identity": "caller_bound",
        }
        if errors or node_id not in snapshots:
            base.update(
                {
                    "status": "error",
                    "result_class": "inconclusive",
                    "verdict": "inconclusive",
                    "error_code": "access_audit_incomplete",
                    "node_errors": errors,
                    "differences": [],
                }
            )
            return None, base
        return snapshots, base

    def _query(self, target: ClickHouseJdbcTarget, sql: str) -> list[dict[str, Any]]:
        payload = self.fetch(
            target,
            sql,
            f"access_audit_{uuid.uuid4().hex}",
            self.settings.query_timeout_seconds,
            {
                "max_execution_time": str(self.settings.query_timeout_seconds),
                "max_result_rows": str(self.settings.access_audit_max_rows),
                "result_overflow_mode": "throw",
            },
        )
        data = payload.get("data")
        if not isinstance(data, list):
            raise TypeError("invalid_clickhouse_response")
        if not all(isinstance(row, dict) for row in data):
            raise TypeError("invalid_clickhouse_row")
        return data


def _validate_account(value: str) -> str:
    cleaned = str(value).strip()
    if not _ACCOUNT.fullmatch(cleaned):
        raise ValueError(f"invalid target account: {cleaned!r}")
    return cleaned


def _validate_table(value: str) -> str:
    cleaned = str(value).strip()
    if not _TABLE.fullmatch(cleaned):
        raise ValueError(f"invalid target table: {cleaned!r}")
    return cleaned.lower()


def _validate_schema(rows: list[dict[str, Any]]) -> None:
    actual: dict[str, list[str]] = {name: [] for name in SUPPORTED_SCHEMA_COLUMNS}
    for row in rows:
        full_name = f"{row.get('database')}.{row.get('table')}"
        if full_name in actual:
            actual[full_name].append(str(row.get("name") or ""))
    mismatches = [
        name
        for name, expected in SUPPORTED_SCHEMA_COLUMNS.items()
        if tuple(actual[name]) != expected
    ]
    if mismatches:
        raise RuntimeError("unsupported_schema:" + ",".join(mismatches))


def _schema_fingerprint(rows: list[dict[str, Any]]) -> str:
    material = [
        [row.get("database"), row.get("table"), row.get("name"), row.get("type")] for row in rows
    ]
    encoded = json.dumps(material, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _canonical_value(value: Any) -> Any:
    if isinstance(value, list):
        items = [_canonical_value(item) for item in value]
        return sorted(
            items,
            key=lambda item: json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ),
        )
    if isinstance(value, dict):
        return {key: _canonical_value(value[key]) for key in sorted(value)}
    return value


def _inspection_failure(preflight: dict[str, Any], mode: str, **scope: Any) -> dict[str, Any]:
    result = dict(preflight)
    result.update({"mode": mode, **scope, "results": [], "node_results": {}})
    return result


def _inspection_result(
    preflight: dict[str, Any],
    *,
    mode: str,
    node_results: dict[str, list[dict[str, Any]]],
    max_rows: int,
    fail_on_unclassified_resources: bool = False,
    **scope: Any,
) -> dict[str, Any]:
    normalized = {node: sorted(rows, key=_canonical_json) for node, rows in node_results.items()}
    overflow_nodes = sorted(node for node, rows in normalized.items() if len(rows) > max_rows)
    if overflow_nodes:
        result = dict(preflight)
        result.update(
            {
                "status": "error",
                "result_class": "inconclusive",
                "verdict": "inconclusive",
                "error_code": "access_inspection_result_limit_exceeded",
                "mode": mode,
                **scope,
                "results": [],
                "node_results": {},
                "differences": [],
                "node_errors": [
                    {"node": node, "reason": "result_limit_exceeded"} for node in overflow_nodes
                ],
            }
        )
        return result
    column_review_nodes = sorted(
        node
        for node, rows in normalized.items()
        if any(row.get("column_level_anomaly") is True for row in rows)
    )
    if column_review_nodes:
        result = dict(preflight)
        result.update(
            {
                "status": "error",
                "result_class": "inconclusive",
                "verdict": "inconclusive",
                "error_code": "column_level_requires_review",
                "mode": mode,
                **scope,
                "results": [],
                "node_results": normalized,
                "differences": [],
                "node_errors": [
                    {"node": node, "reason": "column_level_requires_review"}
                    for node in column_review_nodes
                ],
            }
        )
        return result
    unclassified_nodes = sorted(
        node
        for node, rows in normalized.items()
        if any(
            row.get("record_type") == "grant" and row.get("resource_kind") == "unclassified"
            for row in rows
        )
    )
    if fail_on_unclassified_resources and unclassified_nodes:
        inconclusive_subjects = sorted(
            {
                (str(row["subject_type"]), str(row["subject_name"]))
                for rows in normalized.values()
                for row in rows
                if row.get("record_type") == "grant" and row.get("resource_kind") == "unclassified"
            }
        )
        result = dict(preflight)
        result.update(
            {
                "status": "error",
                "result_class": "inconclusive",
                "verdict": "inconclusive",
                "error_code": "resource_metadata_incomplete",
                "mode": mode,
                **scope,
                "results": [],
                "node_results": normalized,
                "differences": [],
                "inconclusive_subjects": [
                    {"subject_type": subject_type, "subject_name": subject_name}
                    for subject_type, subject_name in inconclusive_subjects
                ],
                "node_errors": [
                    {"node": node, "reason": "resource_metadata_incomplete"}
                    for node in unclassified_nodes
                ],
            }
        )
        return result
    encoded_by_node = {node: _canonical_json(rows) for node, rows in normalized.items()}
    consistent = len(set(encoded_by_node.values())) == 1
    differences: list[dict[str, Any]] = []
    if not consistent:
        by_row: dict[str, tuple[dict[str, Any], set[str]]] = {}
        for node, rows in normalized.items():
            for row in rows:
                encoded = _canonical_json(row)
                if encoded not in by_row:
                    by_row[encoded] = (row, set())
                by_row[encoded][1].add(node)
        all_nodes = set(normalized)
        differences = [
            {
                "item": row,
                "present_on": sorted(present_on),
                "missing_on": sorted(all_nodes - present_on),
            }
            for row, present_on in by_row.values()
            if present_on != all_nodes
        ]
        differences.sort(key=_canonical_json)

    result = dict(preflight)
    result.update(
        {
            "status": "success",
            "result_class": "success",
            "verdict": "consistent" if consistent else "partial",
            "mode": mode,
            **scope,
            "results": next(iter(normalized.values())) if consistent and normalized else [],
            "node_results": normalized,
            "differences": differences,
        }
    )
    return result


def _subjects_for_tables(
    snapshot: dict[str, list[dict[str, Any]]], tables: list[str]
) -> list[dict[str, Any]]:
    users = {str(row.get("name")) for row in snapshot["system.users"] if row.get("name")}
    users.update(
        str(row.get("user_name"))
        for row in snapshot["system.grants"] + snapshot["system.role_grants"]
        if row.get("user_name")
    )
    roles = {
        str(value)
        for row in snapshot["system.grants"] + snapshot["system.role_grants"]
        for value in (row.get("role_name"), row.get("granted_role_name"))
        if value
    }
    results: list[dict[str, Any]] = []
    for subject_type, names in (("account", sorted(users)), ("role", sorted(roles))):
        for subject_name in names:
            grants = _effective_grant_evidence(snapshot, subject_type, subject_name)
            for table_name in tables:
                database, table = table_name.split(".", maxsplit=1)
                matched = [
                    item
                    for item in grants
                    if str(item["grant"].get("access_type") or "").upper() in _SELECT_ACCESS_TYPES
                    and _grant_matches_table(item["grant"], database, table)
                ]
                if not matched:
                    continue
                permission_class = _permission_class(matched)
                role_paths = sorted(
                    {" -> ".join(item["role_path"]) for item in matched if item["role_path"]}
                )
                results.append(
                    {
                        "target_table": table_name,
                        "subject_type": subject_type,
                        "subject_name": subject_name,
                        "permission_class": permission_class,
                        "has_access": permission_class == "full_table",
                        "role_held": bool(role_paths),
                        "active_by_default": _active_by_default(matched, subject_type),
                        "source_scopes": sorted({_grant_scope(item["grant"]) for item in matched}),
                        "role_paths": role_paths,
                        "column_level_anomaly": any(
                            item["grant"].get("column") is not None for item in matched
                        ),
                        "grant_option": any(
                            int(item["grant"].get("grant_option") or 0) == 1
                            for item in matched
                            if int(item["grant"].get("is_partial_revoke") or 0) == 0
                        ),
                    }
                )
    return results


def _resources_for_subjects(
    snapshot: dict[str, list[dict[str, Any]]],
    metadata_rows: list[dict[str, Any]],
    accounts: list[str],
    roles: list[str],
) -> list[dict[str, Any]]:
    classifications, unresolved_mappings = _resource_classifications(metadata_rows)
    known_accounts = {str(row.get("name")) for row in snapshot["system.users"] if row.get("name")}
    known_roles = {
        str(value)
        for row in snapshot["system.grants"] + snapshot["system.role_grants"]
        for value in (row.get("role_name"), row.get("granted_role_name"))
        if value
    }
    results: list[dict[str, Any]] = [
        {
            "record_type": "subject_presence",
            "subject_type": "account",
            "subject_name": name,
            "subject_exists": name in known_accounts,
        }
        for name in accounts
    ]
    results.extend(
        {
            "record_type": "subject_presence",
            "subject_type": "role",
            "subject_name": name,
            # Empty roles are not represented by the three fixed access views;
            # do not turn absence of evidence into a false non-existence claim.
            "subject_exists": True if name in known_roles else None,
        }
        for name in roles
    )
    results.extend(_role_membership_records(snapshot, roles))
    for subject_type, names in (("account", accounts), ("role", roles)):
        for subject_name in names:
            evidence = _effective_grant_evidence(snapshot, subject_type, subject_name)
            for item in evidence:
                grant = item["grant"]
                database = grant.get("database")
                table = grant.get("table")
                if database is None:
                    resource_kind = "global"
                elif table is None:
                    resource_kind = "database"
                else:
                    resource_key = (str(database).lower(), str(table).lower())
                    if resource_key in unresolved_mappings:
                        raise RuntimeError("distributed_mapping_unresolved")
                    # ClickHouse may retain grants for objects that no longer exist.
                    # Preserve that evidence instead of conflating a missing metadata
                    # row with an unparseable Distributed engine expression.
                    resource_kind = classifications.get(resource_key, "unclassified")
                results.append(
                    {
                        "record_type": "grant",
                        "subject_type": subject_type,
                        "subject_name": subject_name,
                        "access_type": grant.get("access_type"),
                        "database": database,
                        "table": table,
                        "is_partial_revoke": int(grant.get("is_partial_revoke") or 0),
                        "grant_option": int(grant.get("grant_option") or 0),
                        "resource_kind": resource_kind,
                        "source_subject_type": item["source_subject_type"],
                        "source_subject_name": item["source_subject_name"],
                        "role_path": item["role_path"],
                        "active_by_default": item["active_by_default"],
                        "column_level_anomaly": grant.get("column") is not None,
                    }
                )
    unique = {_canonical_json(row): row for row in results}
    return list(unique.values())


def _role_membership_records(
    snapshot: dict[str, list[dict[str, Any]]], roles: list[str]
) -> list[dict[str, Any]]:
    if not roles:
        return []
    role_set = set(roles)
    accounts = {
        str(value)
        for value in (
            *[row.get("name") for row in snapshot["system.users"]],
            *[row.get("user_name") for row in snapshot["system.role_grants"]],
        )
        if value
    }
    records: list[dict[str, Any]] = []
    for account in sorted(accounts):
        for membership in _reachable_roles(snapshot["system.role_grants"], "account", account):
            role_name = str(membership["subject_name"])
            if role_name not in role_set:
                continue
            path = list(membership["role_path"])
            records.append(
                {
                    "record_type": "role_member",
                    "subject_type": "role",
                    "subject_name": role_name,
                    "member_account": account,
                    "membership_type": "direct" if len(path) == 1 else "inherited",
                    "role_path": path,
                    "active_by_default": membership["active_by_default"],
                }
            )
    return records


def _effective_grant_evidence(
    snapshot: dict[str, list[dict[str, Any]]], subject_type: str, subject_name: str
) -> list[dict[str, Any]]:
    principals: list[dict[str, Any]] = [
        {
            "subject_type": subject_type,
            "subject_name": subject_name,
            "role_path": [],
            "active_by_default": None,
        }
    ]
    principals.extend(_reachable_roles(snapshot["system.role_grants"], subject_type, subject_name))
    evidence: list[dict[str, Any]] = []
    for principal in principals:
        for grant in snapshot["system.grants"]:
            matched = (
                principal["subject_type"] == "account"
                and grant.get("user_name") == principal["subject_name"]
            ) or (
                principal["subject_type"] == "role"
                and grant.get("role_name") == principal["subject_name"]
            )
            if not matched:
                continue
            evidence.append(
                {
                    "grant": grant,
                    "source_subject_type": principal["subject_type"],
                    "source_subject_name": principal["subject_name"],
                    "role_path": principal["role_path"],
                    "active_by_default": principal["active_by_default"],
                }
            )
    return evidence


def _reachable_roles(
    role_grants: list[dict[str, Any]], subject_type: str, subject_name: str
) -> list[dict[str, Any]]:
    queue: deque[tuple[str, list[str], bool | None]] = deque()
    for row in role_grants:
        source_matches = (subject_type == "account" and row.get("user_name") == subject_name) or (
            subject_type == "role" and row.get("role_name") == subject_name
        )
        granted = row.get("granted_role_name")
        if source_matches and granted:
            active = (
                bool(int(row.get("granted_role_is_default") or 0))
                if subject_type == "account"
                else None
            )
            queue.append((str(granted), [str(granted)], active))

    discovered: dict[tuple[str, tuple[str, ...]], dict[str, Any]] = {}
    traversed = 0
    while queue:
        role, path, active = queue.popleft()
        traversed += 1
        if traversed > _ROLE_PATH_LIMIT:
            raise RuntimeError("role_closure_overflow")
        key = (role, tuple(path))
        discovered[key] = {
            "subject_type": "role",
            "subject_name": role,
            "role_path": path,
            "active_by_default": active,
        }
        for row in role_grants:
            granted = row.get("granted_role_name")
            if row.get("role_name") != role or not granted:
                continue
            next_role = str(granted)
            if next_role in path or (subject_type == "role" and next_role == subject_name):
                continue
            queue.append((next_role, [*path, next_role], active))
    return list(discovered.values())


def _grant_matches_table(grant: dict[str, Any], database: str, table: str) -> bool:
    grant_database = grant.get("database")
    grant_table = grant.get("table")
    if grant_database is None:
        return True
    if str(grant_database).lower() != database:
        return False
    return grant_table is None or str(grant_table).lower() == table


def _grant_scope(grant: dict[str, Any]) -> str:
    if grant.get("database") is None:
        return "global"
    if grant.get("table") is None:
        return "database"
    if grant.get("column") is not None:
        return "column"
    return "table"


def _permission_class(evidence: list[dict[str, Any]]) -> str:
    if any(item["grant"].get("column") is not None for item in evidence):
        return "column_level_requires_review"
    by_principal: dict[tuple[str, str, tuple[str, ...]], list[dict[str, Any]]] = defaultdict(list)
    for item in evidence:
        by_principal[
            (
                item["source_subject_type"],
                item["source_subject_name"],
                tuple(item["role_path"]),
            )
        ].append(item)
    if any(
        any(int(item["grant"].get("is_partial_revoke") or 0) == 0 for item in rows)
        and not any(int(item["grant"].get("is_partial_revoke") or 0) == 1 for item in rows)
        for rows in by_principal.values()
    ):
        return "full_table"
    return "revoked"


def _active_by_default(evidence: list[dict[str, Any]], subject_type: str) -> bool | None:
    if subject_type == "role":
        return None
    role_evidence = [item for item in evidence if item["role_path"]]
    if not role_evidence:
        return None
    return any(item["active_by_default"] is True for item in role_evidence)


def _resource_classifications(
    metadata_rows: list[dict[str, Any]],
) -> tuple[dict[tuple[str, str], str], set[tuple[str, str]]]:
    distributed: dict[tuple[str, str], tuple[str, str]] = {}
    all_tables: set[tuple[str, str]] = set()
    unresolved: set[tuple[str, str]] = set()
    for row in metadata_rows:
        key = (str(row.get("database") or "").lower(), str(row.get("name") or "").lower())
        if not all(key):
            continue
        all_tables.add(key)
        if str(row.get("engine") or "").lower() != "distributed":
            continue
        target = _parse_distributed_target(str(row.get("engine_full") or ""))
        if target is None:
            unresolved.add(key)
            continue
        distributed[key] = target
    local_targets = set(distributed.values())
    return (
        {
            key: "base"
            if key in distributed
            else "local"
            if key in local_targets
            else "independent"
            for key in all_tables
        },
        unresolved,
    )


def _parse_distributed_target(engine_full: str) -> tuple[str, str] | None:
    try:
        expression = sqlglot.parse_one(f"SELECT {engine_full}", read="clickhouse").expressions[0]
    except Exception:  # noqa: BLE001 - unsupported macro/expression is intentionally unclassified
        return None
    if not isinstance(expression, exp.Anonymous) or str(expression.this).lower() != "distributed":
        return None
    arguments = expression.expressions
    if len(arguments) < 3 or not all(isinstance(value, exp.Literal) for value in arguments[1:3]):
        return None
    return (str(arguments[1].this).lower(), str(arguments[2].this).lower())


def _quote_literal(value: str) -> str:
    if not _IDENTIFIER.fullmatch(value):
        raise RuntimeError("invalid_metadata_identifier")
    return f"'{value}'"


def _canonical_json(value: Any) -> str:
    return json.dumps(
        _canonical_value(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def _safe_reason(exc: Exception) -> str:
    text = str(exc).splitlines()[0][:300]
    lowered = text.lower()
    if "unsupported_schema" in lowered:
        return text
    if "unsupported_version" in lowered:
        return text
    if "role_closure_overflow" in lowered:
        return "role_closure_overflow"
    if "distributed_mapping_unresolved" in lowered:
        return "distributed_mapping_unresolved"
    if "invalid_metadata_identifier" in lowered:
        return "invalid_metadata_identifier"
    return exc.__class__.__name__
