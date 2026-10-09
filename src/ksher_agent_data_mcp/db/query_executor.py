import json
import re
import threading
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse
from urllib.request import Request, urlopen

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.models.contracts import (
    ColumnMeta,
    CredentialRef,
    QueryResult,
    ResultClass,
    Status,
)

_CK_CODE = re.compile(r"Code:\s*(\d+)")
_CK_NAME = re.compile(r"\(([A-Z][A-Z0-9_]+)\)(?=\s*(?:\(version\b|$))")
_POLICY_ERROR_NAMES = {
    "ACCESS_DENIED",
    "AUTHENTICATION_FAILED",
    "IP_ADDRESS_NOT_ALLOWED",
    "UNKNOWN_USER",
}
_RESOURCE_LIMIT_ERROR_NAMES = {
    "MEMORY_LIMIT_EXCEEDED",
    "QUERY_WAS_CANCELLED",
    "TIMEOUT_EXCEEDED",
    "TOO_MANY_ROWS_OR_BYTES",
}


class QueryExecutor(ABC):
    @abstractmethod
    def run(
        self,
        credential: CredentialRef,
        sql: str,
        timeout_seconds: int,
        max_rows: int | None = None,
    ) -> QueryResult:
        """Run a validated read-only query using the resolved user credential."""


class DryRunQueryExecutor(QueryExecutor):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def run(
        self,
        credential: CredentialRef,
        sql: str,
        timeout_seconds: int,
        max_rows: int | None = None,
    ) -> QueryResult:
        started = time.perf_counter()
        return QueryResult(
            status=Status.SUCCESS,
            query_id=f"q_{uuid.uuid4().hex}",
            datasource=credential.datasource,
            sql=sql,
            columns=[
                ColumnMeta(
                    name="dry_run",
                    type="string",
                    description="查询已通过安全校验；当前执行器未连接真实数据源",
                )
            ],
            rows=[],
            row_count=0,
            truncated=False,
            execution_ms=int((time.perf_counter() - started) * 1000),
            quality_warnings=["当前使用 dry_run 执行器，未连接真实数据源"],
        )


@dataclass(frozen=True)
class ClickHouseJdbcTarget:
    endpoint: str
    database: str
    user: str
    password: str


class TChouseCQueryExecutor(QueryExecutor):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._slots = threading.BoundedSemaphore(settings.query_max_concurrency)

    def run(
        self,
        credential: CredentialRef,
        sql: str,
        timeout_seconds: int,
        max_rows: int | None = None,
    ) -> QueryResult:
        started = time.perf_counter()
        effective_max_rows = max_rows or self.settings.max_rows
        if credential.datasource != "tchouse-c":
            return QueryResult(
                status=Status.ERROR,
                result_class=ResultClass.POLICY_ERROR,
                query_id=f"q_{uuid.uuid4().hex}",
                datasource=credential.datasource,
                sql=sql,
                execution_ms=_elapsed_ms(started),
                quality_warnings=["TChouseCQueryExecutor 仅支持 TChouse-C SELECT / SHOW"],
            )

        query_id = f"q_{uuid.uuid4().hex}"
        if not self._slots.acquire(blocking=False):
            return _error_result(
                started=started,
                credential=credential,
                query_id=query_id,
                sql=sql,
                message="TChouse-C 查询并发达到服务上限，请稍后重试",
                result_class=ResultClass.INCONCLUSIVE,
                error_code="query_concurrency_limit",
                retryable=True,
            )
        try:
            target = parse_clickhouse_jdbc_url(credential.jdbc_url)
            payload = execute_clickhouse_json(
                target=target,
                sql=sql,
                query_id=query_id,
                timeout_seconds=timeout_seconds,
                query_settings={
                    "max_execution_time": str(
                        min(timeout_seconds, self.settings.query_timeout_seconds)
                    ),
                    "max_result_rows": str(effective_max_rows),
                    "result_overflow_mode": "throw",
                },
            )
        except HTTPError as exc:
            message = sanitize_clickhouse_error(exc, target.password)
            error_code, error_name = clickhouse_error_identity(message)
            is_policy_error = error_name in _POLICY_ERROR_NAMES
            is_resource_limit = error_name in _RESOURCE_LIMIT_ERROR_NAMES
            return _error_result(
                started=started,
                credential=credential,
                query_id=query_id,
                sql=sql,
                message=message,
                result_class=(
                    ResultClass.POLICY_ERROR
                    if is_policy_error
                    else (
                        ResultClass.INCONCLUSIVE
                        if is_resource_limit
                        else ResultClass.CK_QUERY_ERROR
                    )
                ),
                error_code=error_code or f"http_{exc.code}",
                error_name=error_name,
                retryable=not is_policy_error and not is_resource_limit,
            )
        except URLError as exc:
            return _error_result(
                started=started,
                credential=credential,
                query_id=query_id,
                sql=sql,
                message=f"TChouse-C 网络连接失败（{exc.reason.__class__.__name__}）",
                result_class=ResultClass.INCONCLUSIVE,
                error_code="datasource_unreachable",
                retryable=True,
            )
        except TimeoutError:
            return _error_result(
                started=started,
                credential=credential,
                query_id=query_id,
                sql=sql,
                message="TChouse-C 查询超时，结果完整性无法确认",
                result_class=ResultClass.INCONCLUSIVE,
                error_code="query_timeout",
                retryable=True,
            )
        except Exception:  # noqa: BLE001 - executor must return a typed fail-closed result
            return _error_result(
                started=started,
                credential=credential,
                query_id=query_id,
                sql=sql,
                message="TChouse-C 查询执行失败，结果完整性无法确认",
                result_class=ResultClass.INCONCLUSIVE,
                error_code="query_execution_failed",
                retryable=True,
            )
        finally:
            self._slots.release()
        rows = payload.get("data", [])
        meta = payload.get("meta", [])
        columns = [
            ColumnMeta(
                name=str(column.get("name")),
                type=str(column.get("type")),
            )
            for column in meta
        ]
        row_count = int(payload.get("rows", len(rows)))
        statistics = payload.get("statistics") or {}
        truncated = len(rows) >= effective_max_rows or len(rows) < row_count
        warnings = []
        if truncated:
            warnings.append("返回结果可能被 LIMIT 或服务最大行数限制截断")

        return QueryResult(
            status=Status.SUCCESS,
            query_id=query_id,
            datasource=credential.datasource,
            sql=sql,
            columns=columns,
            rows=rows,
            row_count=row_count,
            read_rows=_optional_int(statistics.get("rows_read")),
            read_bytes=_optional_int(statistics.get("bytes_read")),
            truncated=truncated,
            execution_ms=_elapsed_ms(started),
            quality_warnings=warnings,
        )


def parse_clickhouse_jdbc_url(jdbc_url: str) -> ClickHouseJdbcTarget:
    raw_url = jdbc_url.removeprefix("jdbc:")
    options: dict[str, str] = {}
    if ";" in raw_url:
        raw_url, options_text = raw_url.split(";", maxsplit=1)
        for item in options_text.split(";"):
            if not item or "=" not in item:
                continue
            key, value = item.split("=", maxsplit=1)
            options[key.lower()] = value

    parsed = urlparse(raw_url)
    if parsed.scheme not in {"clickhouse", "http", "https"} or not parsed.hostname:
        raise ValueError(f"Invalid ClickHouse JDBC URL: {jdbc_url}")

    query_options = {key.lower(): value for key, value in parse_qsl(parsed.query)}
    options.update(query_options)
    user = options.get("user") or options.get("username")
    password = options.get("password") or options.get("pwd")
    if not user or password is None:
        raise ValueError("ClickHouse JDBC URL must include user and password")

    database = parsed.path.lstrip("/") or "default"
    scheme = "https" if parsed.scheme == "https" else "http"
    port = parsed.port or (8443 if scheme == "https" else 8123)
    endpoint = f"{scheme}://{parsed.hostname}:{port}/"
    return ClickHouseJdbcTarget(
        endpoint=endpoint,
        database=database,
        user=user,
        password=password,
    )


def execute_clickhouse_json(
    target: ClickHouseJdbcTarget,
    sql: str,
    query_id: str,
    timeout_seconds: int,
    query_settings: dict[str, str] | None = None,
) -> dict[str, Any]:
    query = sql.strip().rstrip(";")
    if " format " not in f" {query.lower()} ":
        query = f"{query} FORMAT JSON"
    # Server-side read-only enforcement (defense-in-depth on top of the SQL guard and
    # the per-user DB grants). readonly=2 allows SELECT/SHOW and per-request setting
    # overrides but forbids INSERT/DDL, so a sqlglot parse gap can't turn into a write.
    params_dict = {
        "database": target.database,
        "query_id": query_id,
        "readonly": "2",
    }
    for key, value in (query_settings or {}).items():
        if key in {
            "max_execution_time",
            "max_result_rows",
            "result_overflow_mode",
        }:
            params_dict[key] = value
    params = urlencode(params_dict)
    # Credentials go in headers, never the URL query string, so they never land in
    # ClickHouse system.query_log or any intermediate proxy access log.
    request = Request(
        f"{target.endpoint}?{params}",
        data=query.encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "text/plain; charset=utf-8",
            "X-ClickHouse-User": target.user,
            "X-ClickHouse-Key": target.password,
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        body = response.read().decode("utf-8")
    return json.loads(body)


def sanitize_clickhouse_error(exc: HTTPError, password: str) -> str:
    body = exc.read().decode("utf-8", errors="replace")
    if password:
        body = body.replace(password, "***")
    first_line = body.strip().splitlines()[0] if body.strip() else exc.reason
    return f"TChouse-C HTTP {exc.code}: {first_line}"


def _error_result(
    started: float,
    credential: CredentialRef,
    query_id: str,
    sql: str,
    message: str,
    result_class: ResultClass = ResultClass.CK_QUERY_ERROR,
    error_code: str | None = None,
    error_name: str | None = None,
    retryable: bool = False,
) -> QueryResult:
    return QueryResult(
        status=Status.ERROR,
        result_class=result_class,
        query_id=query_id,
        datasource=credential.datasource,
        sql=sql,
        execution_ms=_elapsed_ms(started),
        quality_warnings=[message],
        error_code=error_code,
        error_name=error_name,
        retryable=retryable,
    )


def clickhouse_error_identity(message: str) -> tuple[str | None, str | None]:
    code_match = _CK_CODE.search(message)
    name_match = _CK_NAME.search(message)
    return (
        f"ck_{code_match.group(1)}" if code_match else None,
        name_match.group(1) if name_match else None,
    )


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
