import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.credentials.base import (
    CredentialBackendUnavailable,
    CredentialConfigurationMissing,
    CredentialMappingUnavailable,
    CredentialResolver,
    UnsupportedCredentialDatasource,
)
from ksher_agent_data_mcp.db.query_executor import QueryExecutor
from ksher_agent_data_mcp.metadata.catalog import (
    MetadataAccessDenied,
    MetadataCatalog,
    MetadataLookupError,
)
from ksher_agent_data_mcp.models.contracts import (
    ColumnMeta,
    DlcPolicy,
    DlcPrincipalRef,
    QueryResult,
    ResultClass,
    Status,
    TableMeta,
    UserContext,
)

DLC_API_VERSION = "2021-01-25"
_SUCCESS_STATE = 2
_FAILURE_STATES = {-1, -3}


class DlcApiError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class DlcApiClient:
    """Tencent Cloud transport for the read-only DLC adapter.

    ``signer`` keeps credentials outside this process. ``skill_tc_call`` invokes
    the selected WeData Skill transport with a private payload file, preserving
    its single audited Tencent Cloud call path without exposing credentials or
    SQL in model arguments or the subprocess command line.
    """

    def __init__(self, settings: Settings) -> None:
        self.url = settings.dlc_signer_url.rstrip("/")
        self.region = settings.dlc_region
        self.token_file = settings.dlc_signer_token_file
        self.auth_mode = settings.dlc_auth_mode.strip().lower()
        self.tc_call_path = settings.dlc_tc_call_path
        self.tc_call_env_mode = settings.dlc_tc_call_env_mode.strip().lower()
        self.tc_call_shell = settings.dlc_tc_call_shell

    def call(self, action: str, payload: dict[str, Any], timeout: float = 90) -> dict[str, Any]:
        return self.call_service(
            "dlc", action, DLC_API_VERSION, payload, region=self.region, timeout=timeout
        )

    def call_service(
        self,
        service: str,
        action: str,
        version: str,
        payload: dict[str, Any],
        *,
        region: str,
        timeout: float = 90,
    ) -> dict[str, Any]:
        if self.auth_mode == "skill_tc_call":
            return self._skill_call(service, action, version, payload, region, timeout)
        if self.auth_mode != "signer":
            raise DlcApiError("unsupported_auth_mode", "DLC 鉴权模式不受支持")
        token = self._token()
        body = json.dumps(
            {
                "service": service,
                "action": action,
                "version": version,
                "region": region,
                "payload": payload,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        request = Request(
            f"{self.url}/v1/call",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "X-Signer-Token": token},
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise DlcApiError(f"signer_http_{exc.code}", "DLC 签名代理拒绝请求") from exc
        except (URLError, TimeoutError) as exc:
            raise DlcApiError("signer_unreachable", "DLC 签名代理不可用", retryable=True) from exc
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise DlcApiError("signer_invalid_response", "DLC 签名代理响应无效") from exc

        signer_error = decoded.get("SignerError")
        response = decoded.get("Response") if isinstance(decoded, dict) else None
        api_error = response.get("Error") if isinstance(response, dict) else None
        if signer_error:
            raise DlcApiError("signer_error", "DLC 签名代理调用失败")
        if isinstance(api_error, dict):
            code = str(api_error.get("Code") or "dlc_api_error")
            retryable = code.startswith(("InternalError", "RequestLimitExceeded"))
            raise DlcApiError(code, _safe_dlc_error(code), retryable=retryable)
        if not isinstance(response, dict):
            raise DlcApiError("dlc_invalid_response", "DLC API 响应缺少 Response")
        return response

    def _skill_call(
        self,
        service: str,
        action: str,
        version: str,
        payload: dict[str, Any],
        region: str,
        timeout: float,
    ) -> dict[str, Any]:
        if self.tc_call_path is None:
            raise DlcApiError("tc_call_path_missing", "WeData Skill tc_call.py 未配置")
        script = self.tc_call_path.expanduser()
        if not script.is_file():
            raise DlcApiError("tc_call_path_invalid", "WeData Skill tc_call.py 不可用")
        payload_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", prefix="data-mcp-tc-", suffix=".json", delete=False
            ) as payload_file:
                os.chmod(payload_file.name, 0o600)
                json.dump(payload, payload_file, ensure_ascii=False, separators=(",", ":"))
                payload_path = payload_file.name
            child_env = os.environ.copy()
            tc_args = [
                sys.executable,
                str(script),
                "call",
                "--service",
                service,
                "--action",
                action,
                "--version",
                version,
                "--region",
                region,
                "--payload",
                f"@{payload_path}",
            ]
            if self.tc_call_env_mode == "zsh_interactive":
                command = [
                    str(self.tc_call_shell.expanduser()),
                    "-ic",
                    'exec "$@"',
                    "data-mcp-tc-call",
                    *tc_args,
                ]
            elif self.tc_call_env_mode == "inherit":
                command = tc_args
            else:
                raise DlcApiError("tc_call_env_mode_invalid", "腾讯云 Skill 环境模式不受支持")
            completed = subprocess.run(
                command,
                env=child_env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            decoded = json.loads(completed.stdout)
        except subprocess.TimeoutExpired as exc:
            raise DlcApiError("tc_call_timeout", "腾讯云 Skill 调用超时", retryable=True) from exc
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise DlcApiError("tc_call_invalid_response", "腾讯云 Skill 响应无效") from exc
        finally:
            if payload_path:
                try:
                    os.unlink(payload_path)
                except OSError:
                    pass
        signer_error = decoded.get("SignerError") if isinstance(decoded, dict) else None
        response = decoded.get("Response") if isinstance(decoded, dict) else None
        api_error = response.get("Error") if isinstance(response, dict) else None
        if signer_error:
            raise DlcApiError("tc_call_credentials_error", "腾讯云 Skill 鉴权失败")
        if isinstance(api_error, dict):
            code = str(api_error.get("Code") or "tencent_api_error")
            retryable = code.startswith(("InternalError", "RequestLimitExceeded"))
            raise DlcApiError(code, _safe_dlc_error(code), retryable=retryable)
        if not isinstance(response, dict):
            raise DlcApiError("tencent_invalid_response", "腾讯云 API 响应缺少 Response")
        return response

    def _token(self) -> str:
        if self.token_file is None:
            raise DlcApiError("signer_token_missing", "DLC 签名代理 token 文件未配置")
        try:
            token = self.token_file.expanduser().read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise DlcApiError("signer_token_unreadable", "DLC 签名代理 token 不可读") from exc
        if not token:
            raise DlcApiError("signer_token_missing", "DLC 签名代理 token 为空")
        return token


class DlcPrincipalResolver(CredentialResolver):
    def __init__(self, settings: Settings, client: DlcApiClient) -> None:
        self.settings = settings
        self.client = client
        self._mapping = _load_principal_mapping(settings.dlc_principal_mapping_file)

    def resolve(self, user: UserContext, datasource: str = "dlc") -> DlcPrincipalRef | None:
        if datasource != "dlc":
            raise UnsupportedCredentialDatasource(datasource)
        if not self.settings.dlc_default_database or not self.settings.dlc_data_engine_name:
            raise CredentialConfigurationMissing("DLC database/engine is not configured")
        cam_uin = self._mapping.get(user.union_id.lower())
        if not cam_uin:
            raise CredentialMappingUnavailable(user.union_id)
        try:
            data_info = self._all_user_info(cam_uin, "DataAuth")
            engine_info = self._all_user_info(cam_uin, "EngineAuth")
            row_filter_info = self._all_user_info(cam_uin, "RowFilter")
        except DlcApiError as exc:
            raise CredentialBackendUnavailable(exc.code) from exc

        user_info = data_info.get("UserInfo") or {}
        policies = [_policy(item) for item in _policy_set(user_info, "DataPolicyInfo")]
        engine_policies = [
            _policy(item)
            for item in _policy_set(engine_info.get("UserInfo") or {}, "EnginePolicyInfo")
        ]
        user_type = str(user_info.get("UserType") or "COMMON").upper()
        has_row_filters = bool(_policy_set(row_filter_info.get("UserInfo") or {}, "RowFilterInfo"))
        has_data_masks = any(policy.policy_type.upper() == "DATAMASK" for policy in policies)
        engine_allowed = user_type == "ADMIN" or any(
            policy.data_engine in {"*", self.settings.dlc_data_engine_name}
            and policy.operation.upper() in {"ALL", "USE", "SELECT"}
            for policy in engine_policies
        )
        permission_payload = {
            "cam_uin": cam_uin,
            "user_type": user_type,
            "policies": [item.model_dump() for item in policies],
            "engine_policies": [item.model_dump() for item in engine_policies],
            "has_row_filters": has_row_filters,
            "has_data_masks": has_data_masks,
        }
        permission_version = hashlib.sha256(
            json.dumps(permission_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return DlcPrincipalRef(
            user_union_id=user.union_id,
            cam_uin=cam_uin,
            region=self.settings.dlc_region,
            project_id=self.settings.dlc_project_id,
            catalog=self.settings.dlc_catalog,
            default_database=self.settings.dlc_default_database,
            data_engine_name=self.settings.dlc_data_engine_name,
            user_type=user_type,
            policies=policies,
            engine_allowed=engine_allowed,
            has_row_filters=has_row_filters,
            has_data_masks=has_data_masks,
            permission_version=permission_version,
        )

    def _all_user_info(self, cam_uin: str, info_type: str) -> dict[str, Any]:
        # The API caps each page at 100. Requesting later pages preserves
        # workgroup-derived policy entries instead of silently authorizing from
        # an incomplete first page.
        offset = 0
        merged: list[dict[str, Any]] = []
        first: dict[str, Any] | None = None
        info_key = {
            "DataAuth": "DataPolicyInfo",
            "EngineAuth": "EnginePolicyInfo",
            "RowFilter": "RowFilterInfo",
        }[info_type]
        while True:
            response = self.client.call(
                "DescribeUserInfo",
                {"UserId": cam_uin, "Type": info_type, "Limit": 100, "Offset": offset},
            )
            if first is None:
                first = response
            user_info = response.get("UserInfo") or {}
            page = _policy_set(user_info, info_key)
            merged.extend(page)
            total = int((user_info.get(info_key) or {}).get("TotalCount") or len(merged))
            if not page or len(merged) >= total:
                break
            offset += len(page)
        result = dict(first or {})
        result_user = dict(result.get("UserInfo") or {})
        result_user[info_key] = {"PolicySet": merged, "TotalCount": len(merged)}
        result["UserInfo"] = result_user
        return result


class DlcMetadataCatalog(MetadataCatalog):
    def __init__(self, settings: Settings, client: DlcApiClient) -> None:
        self.settings = settings
        self.client = client

    def describe_table(
        self, full_name: str, credential: DlcPrincipalRef | None = None
    ) -> TableMeta | None:
        principal = _require_dlc_principal(credential)
        database, table = _split_dlc_table(full_name, principal.default_database)
        if principal.has_row_filters or principal.has_data_masks:
            raise MetadataAccessDenied("DLC 行级或脱敏策略尚未接入安全执行，拒绝使用服务身份代查")
        if not _table_allowed(principal, database, table):
            raise MetadataAccessDenied("DLC principal has no SELECT policy for table")
        try:
            response = self.client.call(
                "DescribeTable",
                {
                    "DatabaseName": database,
                    "TableName": table,
                    "DatasourceConnectionName": principal.catalog,
                },
            )
        except DlcApiError as exc:
            if "Permission" in exc.code or "Unauthorized" in exc.code:
                raise MetadataAccessDenied(str(exc)) from exc
            raise MetadataLookupError(str(exc)) from exc
        raw = response.get("Table")
        if not isinstance(raw, dict):
            return None
        columns = [
            ColumnMeta(
                name=str(item.get("Name") or ""),
                type=str(item.get("Type") or "UNKNOWN"),
                description=str(item.get("Comment") or "") or None,
            )
            for item in (raw.get("Columns") or [])
            if item.get("Name")
        ]
        partitions = [
            str(item.get("Name")) for item in (raw.get("Partitions") or []) if item.get("Name")
        ]
        base_info = raw.get("TableBaseInfo") or {}
        return TableMeta(
            datasource="dlc",
            database=database,
            table=table,
            description=str(base_info.get("TableComment") or "") or None,
            partition_fields=partitions,
            columns=columns,
        )

    def suggest_tables(
        self,
        full_name: str,
        limit: int = 5,
        credential: DlcPrincipalRef | None = None,
    ) -> list[TableMeta]:
        principal = _require_dlc_principal(credential)
        needle = full_name.lower().replace("`", "")
        candidates: list[TableMeta] = []
        for policy in principal.policies:
            if policy.policy_type.upper() not in {"TABLE", "VIEW"}:
                continue
            if policy.operation.upper() not in {"ALL", "SELECT"}:
                continue
            full = f"{policy.database}.{policy.table}".lower()
            if (
                policy.table
                and policy.table != "*"
                and any(token in full for token in needle.replace(".", "_").split("_") if token)
            ):
                candidates.append(
                    TableMeta(datasource="dlc", database=policy.database, table=policy.table)
                )
        return candidates[:limit]


class DlcQueryExecutor(QueryExecutor):
    def __init__(self, settings: Settings, client: DlcApiClient) -> None:
        self.settings = settings
        self.client = client
        self._slots = threading.BoundedSemaphore(settings.query_max_concurrency)

    def run(
        self,
        credential: DlcPrincipalRef,
        sql: str,
        timeout_seconds: int,
        max_rows: int | None = None,
    ) -> QueryResult:
        started = time.perf_counter()
        query_ref = f"dlc_{uuid.uuid4().hex}"
        if not isinstance(credential, DlcPrincipalRef) or credential.datasource != "dlc":
            return _dlc_error(
                query_ref, sql, started, "invalid_principal", ResultClass.POLICY_ERROR
            )
        if not credential.engine_allowed:
            return _dlc_error(
                query_ref, sql, started, "engine_permission_denied", ResultClass.POLICY_ERROR
            )
        if credential.has_row_filters or credential.has_data_masks:
            return _dlc_error(
                query_ref,
                sql,
                started,
                "fine_grained_policy_not_supported",
                ResultClass.POLICY_ERROR,
            )
        if not self._slots.acquire(blocking=False):
            return _dlc_error(
                query_ref,
                sql,
                started,
                "query_concurrency_limit",
                ResultClass.INCONCLUSIVE,
                retryable=True,
            )
        task_id: str | None = None
        try:
            created = self.client.call(
                "CreateTask",
                {
                    "Task": {
                        "SQLTask": {"SQL": base64.b64encode(sql.encode("utf-8")).decode("ascii")}
                    },
                    "DatabaseName": credential.default_database,
                    "DatasourceConnectionName": credential.catalog,
                    "DataEngineName": credential.data_engine_name,
                    "SourceInfo": [
                        {"Key": "source", "Value": "data-mcp"},
                        {"Key": "caller", "Value": _short_hash(credential.user_union_id)},
                    ],
                },
                timeout=min(timeout_seconds, 90),
            )
            task_id = str(created.get("TaskId") or "")
            if not task_id:
                raise DlcApiError("task_id_missing", "DLC 未返回任务 ID")
            return self._wait_result(credential, task_id, sql, started, timeout_seconds, max_rows)
        except DlcApiError as exc:
            policy = "Permission" in exc.code or exc.code.startswith("Unauthorized")
            return _dlc_error(
                task_id or query_ref,
                sql,
                started,
                exc.code,
                ResultClass.POLICY_ERROR if policy else ResultClass.INCONCLUSIVE,
                retryable=exc.retryable,
            )
        finally:
            self._slots.release()

    def _wait_result(
        self,
        credential: DlcPrincipalRef,
        task_id: str,
        sql: str,
        started: float,
        timeout_seconds: int,
        max_rows: int | None,
    ) -> QueryResult:
        deadline = time.monotonic() + min(timeout_seconds, self.settings.query_timeout_seconds)
        limit = max_rows or self.settings.max_rows
        next_token = ""
        rows: list[dict[str, Any]] = []
        columns: list[ColumnMeta] = []
        task_info: dict[str, Any] = {}
        while time.monotonic() < deadline:
            page = self.client.call(
                "DescribeTaskResult",
                {"TaskId": task_id, "NextToken": next_token, "MaxResults": min(1000, limit + 1)},
                timeout=min(max(deadline - time.monotonic(), 1), 90),
            )
            task_info = page.get("TaskInfo") or {}
            state = int(task_info.get("State", 0))
            if state in _FAILURE_STATES:
                code = "query_cancelled" if state == -3 else "query_failed"
                result_class = (
                    ResultClass.INCONCLUSIVE if state == -3 else ResultClass.CK_QUERY_ERROR
                )
                return _dlc_error(task_id, sql, started, code, result_class)
            if state != _SUCCESS_STATE:
                time.sleep(
                    min(
                        self.settings.dlc_poll_interval_seconds, max(deadline - time.monotonic(), 0)
                    )
                )
                continue
            if not columns:
                columns = [
                    ColumnMeta(
                        name=str(item.get("Name") or ""), type=str(item.get("Type") or "UNKNOWN")
                    )
                    for item in (task_info.get("ResultSchema") or [])
                    if item.get("Name")
                ]
            result_set = task_info.get("ResultSet") or "[]"
            try:
                decoded_rows = json.loads(result_set) if isinstance(result_set, str) else result_set
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise DlcApiError("invalid_result_set", "DLC 返回了无效结果集") from exc
            for values in decoded_rows or []:
                rows.append(
                    {
                        column.name: values[index] if index < len(values) else None
                        for index, column in enumerate(columns)
                    }
                )
                if len(rows) > limit:
                    break
            next_token = str(task_info.get("NextToken") or "")
            if len(rows) > limit or not next_token:
                break
        else:
            try:
                self.client.call("CancelTask", {"TaskId": task_id}, timeout=15)
            except DlcApiError:
                pass
            return _dlc_error(task_id, sql, started, "query_timeout", ResultClass.INCONCLUSIVE)

        truncated = len(rows) > limit or bool(next_token)
        bounded_rows = rows[:limit]
        return QueryResult(
            status=Status.SUCCESS,
            query_id=task_id,
            datasource="dlc",
            sql=sql,
            columns=columns,
            rows=bounded_rows,
            row_count=len(bounded_rows),
            read_bytes=_optional_int(task_info.get("DataAmount")),
            truncated=truncated,
            quality_warnings=["DLC 查询结果达到服务行数上限，可能已截断"] if truncated else [],
            execution_ms=int((time.perf_counter() - started) * 1000),
        )


def _load_principal_mapping(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    try:
        payload = json.loads(path.expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise CredentialConfigurationMissing("invalid DLC principal mapping file") from exc
    rows = payload.get("principals") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise CredentialConfigurationMissing("DLC principal mapping must contain principals[]")
    result: dict[str, str] = {}
    union_by_uin: dict[str, str] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise CredentialConfigurationMissing(
                f"DLC principal mapping row {index} must be an object"
            )
        if not _mapping_row_enabled(row, index):
            continue
        union_id = str(row.get("user_union_id") or row.get("union_id") or "").strip().lower()
        cam_uin = str(row.get("cam_uin") or "").strip()
        if not union_id.startswith("on_") or not cam_uin.isdigit():
            raise CredentialConfigurationMissing(
                f"DLC principal mapping row {index} has invalid union_id or CAM UIN"
            )
        previous_uin = result.get(union_id)
        if previous_uin and previous_uin != cam_uin:
            raise CredentialConfigurationMissing(
                f"DLC principal mapping has conflicting CAM UINs for {union_id}"
            )
        previous_union = union_by_uin.get(cam_uin)
        if previous_union and previous_union != union_id:
            raise CredentialConfigurationMissing(
                f"DLC principal mapping assigns CAM UIN {cam_uin} to multiple union_ids"
            )
        result[union_id] = cam_uin
        union_by_uin[cam_uin] = union_id
    return result


def _mapping_row_enabled(row: dict[str, Any], index: int) -> bool:
    """Require an explicit active flag so blank Base rows fail closed."""

    if "enabled" in row:
        enabled = row["enabled"]
        if isinstance(enabled, bool):
            return enabled
        raise CredentialConfigurationMissing(
            f"DLC principal mapping row {index} enabled must be boolean"
        )
    status = row.get("status", row.get("enabled_status"))
    if status is None or not str(status).strip():
        return False
    normalized = str(status).strip().lower()
    if normalized in {"enabled", "启用"}:
        return True
    if normalized in {"disabled", "停用"}:
        return False
    raise CredentialConfigurationMissing(
        f"DLC principal mapping row {index} has unsupported status"
    )


def _policy(raw: dict[str, Any]) -> DlcPolicy:
    return DlcPolicy(
        catalog=str(raw.get("Catalog") or "DataLakeCatalog").lower(),
        database=str(raw.get("Database") or "").lower(),
        table=str(raw.get("Table") or raw.get("View") or "").lower(),
        operation=str(raw.get("Operation") or ""),
        policy_type=str(raw.get("PolicyType") or ""),
        source=str(raw.get("Source") or ""),
        data_engine=str(raw.get("DataEngine") or ""),
    )


def _policy_set(user_info: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = user_info.get(key) or {}
    rows = value.get("PolicySet") or [] if isinstance(value, dict) else []
    return [row for row in rows if isinstance(row, dict)]


def _require_dlc_principal(credential: Any) -> DlcPrincipalRef:
    if not isinstance(credential, DlcPrincipalRef):
        raise MetadataAccessDenied("missing DLC principal")
    return credential


def _split_dlc_table(full_name: str, default_database: str) -> tuple[str, str]:
    parts = [part.strip("` ").lower() for part in full_name.split(".") if part.strip("` ")]
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    if not parts:
        raise MetadataLookupError("blank DLC table name")
    return default_database.lower(), parts[0]


def _table_allowed(principal: DlcPrincipalRef, database: str, table: str) -> bool:
    if principal.user_type.upper() == "ADMIN":
        return True
    for policy in principal.policies:
        if policy.operation.upper() not in {"ALL", "SELECT"}:
            continue
        if policy.catalog not in {"*", principal.catalog.lower()}:
            continue
        kind = policy.policy_type.upper()
        database_match = policy.database in {"*", database}
        if kind == "ADMIN":
            return True
        if kind in {"CATALOG", "DATASOURCE"} and policy.operation.upper() == "ALL":
            return True
        if kind == "DATABASE" and database_match and policy.operation.upper() == "ALL":
            return True
        if kind in {"TABLE", "VIEW"} and database_match and policy.table in {"*", table}:
            return True
    return False


def _dlc_error(
    query_id: str,
    sql: str,
    started: float,
    code: str,
    result_class: ResultClass,
    *,
    retryable: bool = False,
) -> QueryResult:
    return QueryResult(
        status=Status.ERROR,
        result_class=result_class,
        query_id=query_id,
        datasource="dlc",
        sql=sql,
        execution_ms=int((time.perf_counter() - started) * 1000),
        error_code=code,
        retryable=retryable,
        quality_warnings=[_safe_dlc_error(code)],
    )


def _safe_dlc_error(code: str) -> str:
    if "Permission" in code or code.startswith("Unauthorized"):
        return "当前 CAM/DLC 身份缺少所需的数据或计算引擎权限"
    return f"DLC 查询失败（{code}）"


def _short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
