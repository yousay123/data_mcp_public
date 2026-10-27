from dataclasses import dataclass

from ksher_agent_data_mcp.credentials.base import CredentialResolver
from ksher_agent_data_mcp.db.query_executor import QueryExecutor
from ksher_agent_data_mcp.db.sql_guard import SqlGuard


@dataclass(frozen=True)
class DataSourceAdapter:
    datasource: str
    adapter: str
    credentials: CredentialResolver
    sql_guard: SqlGuard
    executor: QueryExecutor


class DataSourceRegistry:
    def __init__(self, adapters: list[DataSourceAdapter]) -> None:
        by_name: dict[str, DataSourceAdapter] = {}
        for adapter in adapters:
            key = adapter.datasource.strip().lower()
            if not key:
                raise ValueError("Data source id must not be blank")
            if key in by_name:
                raise ValueError(f"Duplicate data source id: {key}")
            by_name[key] = adapter
        if not by_name:
            raise ValueError("At least one data source must be enabled")
        self._adapters = by_name

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(self._adapters)

    def get(self, datasource: str) -> DataSourceAdapter | None:
        return self._adapters.get(datasource.strip().lower())

    def require(self, datasource: str) -> DataSourceAdapter:
        adapter = self.get(datasource)
        if adapter is None:
            raise KeyError(datasource)
        return adapter
