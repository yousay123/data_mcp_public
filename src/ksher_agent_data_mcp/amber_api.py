from __future__ import annotations

from functools import lru_cache
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from ksher_agent_data_mcp import __version__
from ksher_agent_data_mcp.amber_auth import (
    AmberAuthError,
    AmberClaims,
    AmberRateLimitError,
    AmberReplayError,
    AmberStateStore,
    AmberTokenVerifier,
)
from ksher_agent_data_mcp.config import Settings, get_settings
from ksher_agent_data_mcp.dependencies import build_container
from ksher_agent_data_mcp.tools.service import DataMcpService


class AmberQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sql: str = Field(min_length=1, max_length=65_536)
    datasource: str = "tchouse-c"


class AmberRuntime:
    def __init__(self, settings: Settings, service: DataMcpService | None = None) -> None:
        if not settings.amber_enabled:
            raise AmberAuthError("amber_endpoint_disabled")
        if not settings.amber_jwks_file:
            raise AmberAuthError("amber_jwks_file_required")
        if not settings.amber_state_db:
            raise AmberAuthError("amber_state_db_required")
        if not settings.amber_audit_key_file:
            raise AmberAuthError("amber_audit_key_file_required")
        if not settings.amber_trust_domain or not settings.amber_trust_domain.strip():
            raise AmberAuthError("amber_trust_domain_required")
        if (
            settings.amber_replay_grace_seconds
            < settings.amber_clock_skew_seconds + 60
        ):
            raise AmberAuthError("amber_replay_grace_too_short")
        self.settings = settings
        self.service = service or DataMcpService(build_container(settings))
        self.verifier = AmberTokenVerifier(
            settings.amber_jwks_file,
            issuer=settings.amber_issuer,
            audience=settings.amber_audience,
            clock_skew_seconds=settings.amber_clock_skew_seconds,
            max_lifetime_seconds=settings.amber_max_token_lifetime_seconds,
        )
        self.state = AmberStateStore(
            settings.amber_state_db,
            settings.amber_audit_key_file,
            replay_grace_seconds=settings.amber_replay_grace_seconds,
        )

    def execute(self, authorization: str | None, request: AmberQueryRequest) -> dict[str, Any]:
        claims = self._authenticate(authorization)
        audit_id = self.state.consume_and_record(claims, request.sql, request.datasource)
        audit_context = self._audit_context(claims)
        try:
            self._enforce_channel_policy(claims)
            validation = self.service.validate_sql_for_user(
                claims.subject,
                None,
                request.sql,
                request.datasource,
                None,
                None,
                audit_context=audit_context,
                execution_mode="single",
            )
            query_plan_id = validation.get("query_plan_id")
            if not isinstance(query_plan_id, str) or not query_plan_id:
                self.state.finish(
                    audit_id,
                    status=_result_status(validation, "validation_error"),
                    error_code=_result_error_code(validation),
                )
                return {**validation, "amber_audit_id": audit_id}
            result = self.service.run_query_for_user(
                claims.subject,
                None,
                request.sql,
                request.datasource,
                None,
                None,
                audit_context=audit_context,
                query_plan_id=query_plan_id,
            )
            self.state.finish(
                audit_id,
                status=_result_status(result, "error"),
                error_code=_result_error_code(result),
                row_count=result.get("row_count") if isinstance(result.get("row_count"), int) else None,
            )
            return {**result, "amber_audit_id": audit_id}
        except AmberRateLimitError as exc:
            self.state.finish(audit_id, status="rejected", error_code=str(exc))
            raise
        except Exception:
            self.state.finish(audit_id, status="error", error_code="unhandled_exception")
            raise

    def _authenticate(self, authorization: str | None) -> AmberClaims:
        if not authorization or not authorization.startswith("Amber "):
            raise AmberAuthError("missing_amber_authorization")
        token = authorization[len("Amber ") :].strip()
        if not token:
            raise AmberAuthError("missing_amber_authorization")
        return self.verifier.verify(token)

    def _audit_context(self, claims: AmberClaims) -> dict[str, str | None]:
        channel = claims.channel.removesuffix(".trial")
        is_schedule = channel == "schedule"
        return {
            "caller_source": "schedule_creator" if is_schedule else "amber",
            "sender_type": "bot" if is_schedule else "user",
            "session_id": f"amber:{claims.run}",
            "task_id": f"amber:{claims.command}" if is_schedule else None,
            "turn_id": claims.run,
            "captured_at": str(claims.issued_at),
            "trust_domain": self.settings.amber_trust_domain,
            "amber_cmd": claims.command,
            "amber_rev": claims.revision,
            "amber_run": claims.run,
            "amber_channel": claims.channel,
            "amber_jti_ref": claims.jti_ref,
            "amber_call": f"{claims.call_index}/{claims.call_count}",
            "query_max_rows": (
                str(self.settings.amber_trial_max_rows)
                if claims.channel.endswith(".trial")
                else None
            ),
        }

    def _enforce_channel_policy(self, claims: AmberClaims) -> None:
        if claims.channel.removesuffix(".trial") == "schedule":
            self.state.consume_rate_limit(
                claims,
                max_runs=self.settings.amber_schedule_max_runs_per_minute,
            )


def _result_error_code(result: dict[str, Any]) -> str | None:
    direct = result.get("error_code")
    if isinstance(direct, str) and direct:
        return direct
    issues = result.get("issues")
    if isinstance(issues, list):
        for issue in issues:
            if isinstance(issue, dict) and isinstance(issue.get("code"), str):
                return issue["code"]
    return None


def _result_status(result: dict[str, Any], default: str) -> str:
    value = result.get("status", default)
    enum_value = getattr(value, "value", None)
    return enum_value if isinstance(enum_value, str) else str(value)


@lru_cache(maxsize=1)
def get_amber_runtime() -> AmberRuntime:
    return AmberRuntime(get_settings())


amber_app = FastAPI(
    title="ksher-agent-data-mcp-amber",
    version=__version__,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@amber_app.get("/health")
def amber_health() -> dict[str, Any]:
    settings = get_settings()
    return {
        "status": "ok" if settings.amber_enabled else "disabled",
        "service": "ksher-agent-data-mcp-amber",
        "version": __version__,
        "trust_boundary": "pinned_amber_jwks",
    }


@amber_app.post("/amber/query")
def amber_query(
    request: AmberQueryRequest,
    authorization: str | None = Header(default=None, alias="Authorization"),
    runtime: AmberRuntime = Depends(get_amber_runtime),
) -> dict[str, Any]:
    try:
        return runtime.execute(authorization, request)
    except AmberReplayError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except AmberRateLimitError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        ) from exc
    except AmberAuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc


def main() -> None:
    settings = get_settings()
    if not settings.amber_enabled:
        raise RuntimeError("Amber API disabled: set DATA_MCP_AMBER_ENABLED=true")
    # Validate pinned keys, audit encryption key and replay store before binding a port.
    get_amber_runtime()
    # This process exposes only amber_app. Agent/internal-token endpoints remain on the private
    # Unix socket owned by the main API process and are not reachable from Amber scripts.
    uvicorn.run(amber_app, host="127.0.0.1", port=settings.amber_bind_port, reload=False)


if __name__ == "__main__":
    main()
