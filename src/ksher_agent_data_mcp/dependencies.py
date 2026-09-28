from collections.abc import Callable
from dataclasses import dataclass

from ksher_agent_data_mcp.access_audit import AccessInspectionAuditor
from ksher_agent_data_mcp.config import Settings, get_settings
from ksher_agent_data_mcp.credentials.base import CredentialResolver
from ksher_agent_data_mcp.credentials.memory import MemoryCredentialResolver
from ksher_agent_data_mcp.credentials.tchouse_d import TChouseDCredentialResolver
from ksher_agent_data_mcp.db.query_executor import (
    DryRunQueryExecutor,
    QueryExecutor,
    TChouseCQueryExecutor,
)
from ksher_agent_data_mcp.db.sql_guard import SqlGuard
from ksher_agent_data_mcp.metadata.catalog import (
    MemoryMetadataCatalog,
    MetadataCatalog,
    TChouseCMetadataCatalog,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef

PRODUCTION_RUNTIME_ALLOWLIST = {
    "CREDENTIAL_PROVIDER": frozenset({"tchouse_d"}),
    "QUERY_EXECUTOR": frozenset({"tchouse_c_http"}),
    "METADATA_PROVIDER": frozenset({"tchouse_c"}),
}


@dataclass(frozen=True)
class Container:
    settings: Settings
    credentials: CredentialResolver
    catalog: MetadataCatalog
    sql_guard: SqlGuard
    executor: QueryExecutor
    access_auditor_factory: Callable[[CredentialRef], AccessInspectionAuditor] | None = None


def _validate_runtime_profile(settings: Settings) -> None:
    configured = {
        "CREDENTIAL_PROVIDER": settings.credential_provider,
        "QUERY_EXECUTOR": settings.query_executor,
        "METADATA_PROVIDER": settings.metadata_provider,
    }
    violations: list[str] = []

    if settings.env == "prod":
        violations.extend(
            f"{name}={configured[name]!r} (allowed: {', '.join(sorted(allowed))})"
            for name, allowed in PRODUCTION_RUNTIME_ALLOWLIST.items()
            if configured[name] not in allowed
        )
    else:
        production_backends = [
            name
            for name in ("CREDENTIAL_PROVIDER", "QUERY_EXECUTOR")
            if configured[name] in PRODUCTION_RUNTIME_ALLOWLIST[name]
        ]
        if production_backends:
            details = ", ".join(f"{name}={configured[name]!r}" for name in production_backends)
            violations.append(f"MCP_ENV={settings.env!r} (required: 'prod' when {details})")

    if violations:
        raise ValueError("Invalid Data MCP runtime profile: " + "; ".join(violations))


def build_container(settings: Settings | None = None) -> Container:
    settings = settings or get_settings()
    _validate_runtime_profile(settings)
    if settings.credential_provider not in {"memory", "tchouse_d"}:
        raise ValueError(f"Unsupported credential provider: {settings.credential_provider}")
    if settings.metadata_provider not in {"memory", "tchouse_c"}:
        raise ValueError(f"Unsupported metadata provider: {settings.metadata_provider}")
    if settings.query_executor not in {"dry_run", "tchouse_c_http"}:
        raise ValueError(f"Unsupported query executor: {settings.query_executor}")
    if settings.credential_provider == "tchouse_d":
        missing = [
            name
            for name, value in (
                ("TCHOUSE_C_JDBC_BASE_URL", settings.tchouse_c_jdbc_base_url),
                ("TCHOUSE_D_JDBC_URL", settings.tchouse_d_jdbc_url),
            )
            if not value
        ]
        if missing:
            raise ValueError(
                "The following settings are required when CREDENTIAL_PROVIDER=tchouse_d: "
                + ", ".join(missing)
            )

    credentials = (
        TChouseDCredentialResolver(settings)
        if settings.credential_provider == "tchouse_d"
        else MemoryCredentialResolver(settings.credential_memory_file)
    )
    catalog = (
        TChouseCMetadataCatalog(settings)
        if settings.metadata_provider == "tchouse_c"
        else MemoryMetadataCatalog()
    )
    sql_guard = SqlGuard(settings=settings, catalog=catalog)
    executor = (
        TChouseCQueryExecutor(settings)
        if settings.query_executor == "tchouse_c_http"
        else DryRunQueryExecutor(settings)
    )
    access_auditor_factory = lambda credential: AccessInspectionAuditor.from_credential(
        settings,
        credential,
    )
    return Container(
        settings=settings,
        credentials=credentials,
        catalog=catalog,
        sql_guard=sql_guard,
        executor=executor,
        access_auditor_factory=access_auditor_factory,
    )
