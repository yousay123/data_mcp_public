from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    server_name: str = Field(default="ksher-agent-data-mcp", alias="MCP_SERVER_NAME")
    env: str = Field(default="dev", alias="MCP_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    max_rows: int = Field(default=1000, alias="MAX_ROWS", ge=1)
    default_limit: int = Field(default=200, alias="DEFAULT_LIMIT", ge=1)
    query_timeout_seconds: int = Field(default=60, alias="QUERY_TIMEOUT_SECONDS", ge=1)
    query_max_rows_to_read: int = Field(default=50_000_000, alias="QUERY_MAX_ROWS_TO_READ", ge=1)
    query_max_bytes_to_read: int = Field(
        default=5 * 1024 * 1024 * 1024, alias="QUERY_MAX_BYTES_TO_READ", ge=1
    )
    query_max_memory_bytes: int = Field(
        default=512 * 1024 * 1024, alias="QUERY_MAX_MEMORY_BYTES", ge=1
    )
    query_max_concurrency: int = Field(default=4, alias="QUERY_MAX_CONCURRENCY", ge=1)
    query_repair_max_failures: int = Field(
        default=3, alias="QUERY_REPAIR_MAX_FAILURES", ge=1, le=10
    )
    query_plan_compare_ttl_seconds: int = Field(
        default=15 * 60,
        alias="DATA_MCP_QUERY_PLAN_COMPARE_TTL_SECONDS",
        ge=1,
        le=15 * 60,
    )
    max_sql_bytes: int = Field(default=20_000, alias="MAX_SQL_BYTES", ge=100)
    require_partition_filter: bool = Field(default=True, alias="REQUIRE_PARTITION_FILTER")

    metadata_provider: str = Field(default="tchouse_c", alias="METADATA_PROVIDER")
    credential_provider: str = Field(default="memory", alias="CREDENTIAL_PROVIDER")
    credential_memory_file: Path | None = Field(default=None, alias="CREDENTIAL_MEMORY_FILE")
    query_executor: str = Field(default="dry_run", alias="QUERY_EXECUTOR")
    export_max_rows: int = Field(default=100_000, alias="DATA_MCP_EXPORT_MAX_ROWS", ge=1)
    export_max_bytes: int = Field(default=20 * 1024 * 1024, alias="DATA_MCP_EXPORT_MAX_BYTES", ge=1)
    export_file_ttl_seconds: int = Field(
        default=3600, alias="DATA_MCP_EXPORT_FILE_TTL_SECONDS", ge=1
    )
    export_outbox_dir: Path | None = Field(default=None, alias="DATA_MCP_EXPORT_OUTBOX_DIR")
    metadata_snapshot_private_dir: Path = Field(
        default=Path.home() / ".config" / "ksher-agent-data-mcp" / "metadata-private",
        alias="DATA_MCP_METADATA_SNAPSHOT_PRIVATE_DIR",
    )
    metadata_snapshot_consumer_dir: Path = Field(
        default=Path.home() / ".cache" / "ksher-agent-data-mcp" / "metadata-current",
        alias="DATA_MCP_METADATA_SNAPSHOT_CONSUMER_DIR",
    )
    metadata_snapshot_max_age_seconds: int = Field(
        default=36 * 3600,
        alias="DATA_MCP_METADATA_SNAPSHOT_MAX_AGE_SECONDS",
        ge=60,
    )
    metadata_snapshot_max_partition_age_days: int = Field(
        default=2,
        alias="DATA_MCP_METADATA_SNAPSHOT_MAX_PARTITION_AGE_DAYS",
        ge=0,
    )
    metadata_snapshot_limit: int = Field(
        default=500_000,
        alias="DATA_MCP_METADATA_SNAPSHOT_LIMIT",
        ge=1,
    )
    metadata_snapshot_source_table: str | None = Field(
        default=None,
        alias="DATA_MCP_METADATA_SNAPSHOT_TABLE",
    )

    tchouse_c_jdbc_base_url: str | None = Field(
        default=None,
        alias="TCHOUSE_C_JDBC_BASE_URL",
    )
    tchouse_d_jdbc_url: str | None = Field(
        default=None,
        alias="TCHOUSE_D_JDBC_URL",
    )
    tchouse_d_username: str | None = Field(default=None, alias="TCHOUSE_D_USERNAME")
    tchouse_d_password: SecretStr | None = Field(default=None, alias="TCHOUSE_D_PASSWORD")
    access_audit_allowed_union_ids: str = Field(
        default="", alias="DATA_MCP_ACCESS_AUDIT_ALLOWED_UNION_IDS"
    )
    access_audit_max_rows: int = Field(
        default=100_000, alias="DATA_MCP_ACCESS_AUDIT_MAX_ROWS", ge=1, le=1_000_000
    )
    access_inspection_max_calls_per_turn: int = Field(
        default=20,
        alias="DATA_MCP_ACCESS_INSPECTION_MAX_CALLS_PER_TURN",
        ge=1,
        le=100,
    )
    amber_enabled: bool = Field(default=False, alias="DATA_MCP_AMBER_ENABLED")
    amber_bind_port: int = Field(default=8766, alias="DATA_MCP_AMBER_PORT", ge=1, le=65535)
    amber_jwks_file: Path | None = Field(default=None, alias="DATA_MCP_AMBER_JWKS_FILE")
    amber_state_db: Path | None = Field(default=None, alias="DATA_MCP_AMBER_STATE_DB")
    amber_audit_key_file: Path | None = Field(
        default=None, alias="DATA_MCP_AMBER_AUDIT_KEY_FILE"
    )
    amber_issuer: str = Field(default="amber", alias="DATA_MCP_AMBER_ISSUER")
    amber_audience: str = Field(default="data-mcp", alias="DATA_MCP_AMBER_AUDIENCE")
    amber_trust_domain: str | None = Field(
        default=None, alias="DATA_MCP_AMBER_TRUST_DOMAIN"
    )
    amber_clock_skew_seconds: int = Field(
        default=30, alias="DATA_MCP_AMBER_CLOCK_SKEW_SECONDS", ge=0, le=120
    )
    amber_max_token_lifetime_seconds: int = Field(
        default=300,
        alias="DATA_MCP_AMBER_MAX_TOKEN_LIFETIME_SECONDS",
        ge=1,
        le=600,
    )
    amber_replay_grace_seconds: int = Field(
        default=120,
        alias="DATA_MCP_AMBER_REPLAY_GRACE_SECONDS",
        ge=60,
        le=3600,
    )
    amber_trial_max_rows: int = Field(
        default=20,
        alias="DATA_MCP_AMBER_TRIAL_MAX_ROWS",
        ge=1,
        le=1000,
    )
    amber_schedule_max_runs_per_minute: int = Field(
        default=10,
        alias="DATA_MCP_AMBER_SCHEDULE_MAX_RUNS_PER_MINUTE",
        ge=1,
        le=1000,
    )
    tchouse_d_credential_sql: str | None = Field(
        default=None,
        alias="TCHOUSE_D_CREDENTIAL_SQL",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
