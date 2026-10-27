from collections.abc import Callable
from dataclasses import dataclass

from ksher_agent_data_mcp.access_audit import AccessInspectionAuditor
from ksher_agent_data_mcp.config import Settings, get_settings
from ksher_agent_data_mcp.credentials.base import CredentialResolver
from ksher_agent_data_mcp.credentials.memory import MemoryCredentialResolver
from ksher_agent_data_mcp.credentials.tchouse_d import TChouseDCredentialResolver
from ksher_agent_data_mcp.datasources.dlc import (
    DlcApiClient,
    DlcMetadataCatalog,
    DlcPrincipalResolver,
    DlcQueryExecutor,
)
from ksher_agent_data_mcp.datasources.registry import DataSourceAdapter, DataSourceRegistry
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
    data_sources: DataSourceRegistry | None = None
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

    enabled = _enabled_datasources(settings.enabled_datasources)
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
    sql_guard = SqlGuard(settings=settings, catalog=catalog, datasource="tchouse-c")
    executor = (
        TChouseCQueryExecutor(settings)
        if settings.query_executor == "tchouse_c_http"
        else DryRunQueryExecutor(settings)
    )
    adapters: list[DataSourceAdapter] = []
    if "tchouse-c" in enabled:
        adapters.append(
            DataSourceAdapter(
                datasource="tchouse-c",
                adapter="tchouse_c",
                credentials=credentials,
                sql_guard=sql_guard,
                executor=executor,
            )
        )
    if "dlc" in enabled:
        _validate_dlc_settings(settings)
        dlc_client = DlcApiClient(settings)
        dlc_catalog = DlcMetadataCatalog(settings, dlc_client)
        adapters.append(
            DataSourceAdapter(
                datasource="dlc",
                adapter="tencent_dlc",
                credentials=DlcPrincipalResolver(settings, dlc_client),
                sql_guard=SqlGuard(
                    settings=settings,
                    catalog=dlc_catalog,
                    datasource="dlc",
                    dialect="presto",
                ),
                executor=DlcQueryExecutor(settings, dlc_client),
            )
        )
    registry = DataSourceRegistry(adapters)
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
        data_sources=registry,
        access_auditor_factory=access_auditor_factory,
    )


def _enabled_datasources(raw: str) -> tuple[str, ...]:
    values = tuple(dict.fromkeys(item.strip().lower() for item in raw.split(",") if item.strip()))
    if not values:
        raise ValueError("DATA_MCP_ENABLED_DATASOURCES must not be empty")
    unsupported = sorted(set(values) - {"tchouse-c", "dlc"})
    if unsupported:
        raise ValueError("Unsupported enabled data sources: " + ", ".join(unsupported))
    return values


def _validate_dlc_settings(settings: Settings) -> None:
    missing = [
        name
        for name, value in (
            ("DATA_MCP_DLC_DEFAULT_DATABASE", settings.dlc_default_database),
            ("DATA_MCP_DLC_DATA_ENGINE_NAME", settings.dlc_data_engine_name),
        )
        if not value
    ]
    if not settings.dlc_principal_mapping_file:
        missing.append("DATA_MCP_DLC_PRINCIPAL_MAPPING_FILE")

    auth_mode = settings.dlc_auth_mode.strip().lower()
    if auth_mode == "signer":
        if not settings.dlc_signer_token_file:
            missing.append("DATA_MCP_DLC_SIGNER_TOKEN_FILE")
    elif auth_mode == "skill_tc_call":
        if not settings.dlc_tc_call_path or not settings.dlc_tc_call_path.expanduser().is_file():
            missing.append("DATA_MCP_DLC_TC_CALL_PATH")
        env_mode = settings.dlc_tc_call_env_mode.strip().lower()
        if env_mode not in {"inherit", "zsh_interactive"}:
            raise ValueError(f"Unsupported Skill tc_call environment mode: {env_mode}")
        if env_mode == "zsh_interactive" and not settings.dlc_tc_call_shell.expanduser().is_file():
            missing.append("DATA_MCP_DLC_TC_CALL_SHELL")
    else:
        raise ValueError(f"Unsupported DLC auth mode: {auth_mode}")
    if settings.dlc_region != "ap-hongkong":
        raise ValueError("DLC adapter currently only supports DATA_MCP_DLC_REGION=ap-hongkong")
    if missing:
        raise ValueError(
            "The following settings are required when DLC is enabled: " + ", ".join(missing)
        )
