"""Short-lived, caller-bound query plans.

The API currently runs as one uvicorn worker behind a Unix socket.  The
in-process store is intentionally scoped to that deployment shape; switching
to multiple workers requires a shared store before enabling this contract.
"""

import secrets
import threading
import time
from dataclasses import dataclass

QUERY_PLAN_TTL_SECONDS = 300
QUERY_PLAN_COMPARE_TTL_MAX_SECONDS = 15 * 60
EXECUTION_MODE_SINGLE = "single"
EXECUTION_MODE_COMPARE = "compare"
EXECUTION_MODE_MAX_RUNS = {
    EXECUTION_MODE_SINGLE: 1,
    EXECUTION_MODE_COMPARE: 2,
}


@dataclass
class QueryPlan:
    session_id: str
    union_id: str
    sql: str
    datasource: str
    trust_domain: str
    task_id: str | None
    issued_at: float
    ttl_seconds: int
    execution_mode: str
    max_runs: int
    repair_chain_id: str | None = None
    runs_used: int = 0


@dataclass(frozen=True)
class QueryPlanRun:
    repair_chain_id: str | None
    execution_mode: str
    run_index: int
    max_runs: int


class QueryPlanStore:
    def __init__(
        self,
        ttl_seconds: int = QUERY_PLAN_TTL_SECONDS,
        compare_ttl_seconds: int = QUERY_PLAN_COMPARE_TTL_MAX_SECONDS,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("query plan TTL must be positive")
        if compare_ttl_seconds <= 0:
            raise ValueError("compare query plan TTL must be positive")
        if compare_ttl_seconds > QUERY_PLAN_COMPARE_TTL_MAX_SECONDS:
            raise ValueError("compare query plan TTL exceeds the server-side maximum")
        self.ttl_seconds = ttl_seconds
        self.compare_ttl_seconds = compare_ttl_seconds
        self._plans: dict[str, QueryPlan] = {}
        self._lock = threading.Lock()

    def issue(
        self,
        union_id: str,
        sql: str,
        datasource: str,
        repair_chain_id: str | None = None,
        *,
        session_id: str,
        trust_domain: str | None = None,
        lark_app_id: str | None = None,
        task_id: str | None = None,
        execution_mode: str = EXECUTION_MODE_SINGLE,
    ) -> str:
        if not session_id.strip():
            raise ValueError("query plan session_id must not be empty")
        domain = _resolve_trust_domain(trust_domain, lark_app_id)
        if execution_mode not in EXECUTION_MODE_MAX_RUNS:
            raise ValueError(f"unsupported query plan execution mode: {execution_mode}")
        ttl_seconds = (
            self.compare_ttl_seconds
            if execution_mode == EXECUTION_MODE_COMPARE
            else self.ttl_seconds
        )
        plan_id = f"qplan_{secrets.token_urlsafe(24)}"
        with self._lock:
            self._purge_expired(time.time())
            self._plans[plan_id] = QueryPlan(
                session_id=session_id,
                union_id=union_id,
                sql=sql,
                datasource=datasource,
                trust_domain=domain,
                task_id=task_id,
                issued_at=time.time(),
                ttl_seconds=ttl_seconds,
                execution_mode=execution_mode,
                max_runs=EXECUTION_MODE_MAX_RUNS[execution_mode],
                repair_chain_id=repair_chain_id,
            )
        return plan_id

    def consume(
        self,
        plan_id: str,
        *,
        session_id: str,
        union_id: str,
        sql: str,
        datasource: str,
        trust_domain: str | None = None,
        lark_app_id: str | None = None,
        task_id: str | None = None,
    ) -> tuple[bool, str]:
        ok, code, _ = self.consume_for_run(
            plan_id,
            session_id=session_id,
            union_id=union_id,
            sql=sql,
            datasource=datasource,
            trust_domain=trust_domain,
            lark_app_id=lark_app_id,
            task_id=task_id,
        )
        return ok, code

    def consume_for_run(
        self,
        plan_id: str,
        *,
        session_id: str,
        union_id: str,
        sql: str,
        datasource: str,
        trust_domain: str | None = None,
        lark_app_id: str | None = None,
        task_id: str | None = None,
    ) -> tuple[bool, str, QueryPlanRun | None]:
        domain = _resolve_trust_domain(trust_domain, lark_app_id)
        with self._lock:
            now = time.time()
            self._purge_expired(now)
            plan = self._plans.get(plan_id)
            if plan is None:
                return False, "query_plan_not_found_or_expired", None
            if plan.runs_used >= plan.max_runs:
                code = (
                    "query_plan_already_consumed"
                    if plan.max_runs == 1
                    else "query_plan_run_limit_exceeded"
                )
                return False, code, None
            if plan.session_id != session_id:
                return False, "query_plan_session_mismatch", None
            if plan.union_id != union_id:
                return False, "query_plan_identity_mismatch", None
            if plan.sql != sql:
                return False, "query_plan_sql_mismatch", None
            if plan.datasource != datasource:
                return False, "query_plan_datasource_mismatch", None
            if plan.trust_domain != domain:
                code = (
                    "query_plan_app_mismatch"
                    if plan.trust_domain.startswith("lark:") and domain.startswith("lark:")
                    else "query_plan_trust_domain_mismatch"
                )
                return False, code, None
            if plan.task_id != task_id:
                return False, "query_plan_task_mismatch", None
            plan.runs_used += 1
            return (
                True,
                "ok",
                QueryPlanRun(
                    repair_chain_id=plan.repair_chain_id,
                    execution_mode=plan.execution_mode,
                    run_index=plan.runs_used,
                    max_runs=plan.max_runs,
                ),
            )

    def consume_with_chain(
        self,
        plan_id: str,
        *,
        session_id: str,
        union_id: str,
        sql: str,
        datasource: str,
        trust_domain: str | None = None,
        lark_app_id: str | None = None,
        task_id: str | None = None,
    ) -> tuple[bool, str, str | None]:
        ok, code, run = self.consume_for_run(
            plan_id,
            session_id=session_id,
            union_id=union_id,
            sql=sql,
            datasource=datasource,
            trust_domain=trust_domain,
            lark_app_id=lark_app_id,
            task_id=task_id,
        )
        return ok, code, run.repair_chain_id if run else None

    def _purge_expired(self, now: float) -> None:
        for plan_id, plan in list(self._plans.items()):
            if plan.issued_at < now - plan.ttl_seconds:
                del self._plans[plan_id]


def _resolve_trust_domain(trust_domain: str | None, lark_app_id: str | None) -> str:
    """Bind a plan to its host-authenticated identity issuer.

    ``lark_app_id`` remains as a compatibility input for the BotMux path.  New
    trusted callers must provide an explicit, host-owned ``trust_domain`` and
    must never invent a Lark application id.
    """

    if isinstance(trust_domain, str) and trust_domain.strip():
        return trust_domain.strip()
    if isinstance(lark_app_id, str) and lark_app_id.strip():
        return f"lark:{lark_app_id.strip()}"
    raise ValueError("query plan trust_domain must not be empty")


@dataclass
class RepairChain:
    union_id: str
    scope_id: str
    issued_at: float
    failures: int = 0


class RepairChainStore:
    def __init__(self, max_failures: int, ttl_seconds: int = QUERY_PLAN_TTL_SECONDS) -> None:
        self.max_failures = max_failures
        self.ttl_seconds = ttl_seconds
        self._chains: dict[str, RepairChain] = {}
        self._active_by_scope: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()

    def prepare(
        self,
        union_id: str,
        chain_id: str | None,
        scope_id: str | None = None,
    ) -> tuple[bool, str, str]:
        with self._lock:
            self._purge_expired(time.time())
            effective_scope = scope_id or union_id
            scope_key = (union_id, effective_scope)
            if not chain_id:
                active_id = self._active_by_scope.get(scope_key)
                active = self._chains.get(active_id or "")
                if active is not None:
                    if active.failures >= self.max_failures:
                        return False, "repair_chain_failure_limit", active_id or ""
                    return True, "ok", active_id or ""
                issued = f"repair_{secrets.token_urlsafe(24)}"
                self._chains[issued] = RepairChain(
                    union_id=union_id,
                    scope_id=effective_scope,
                    issued_at=time.time(),
                )
                self._active_by_scope[scope_key] = issued
                return True, "ok", issued
            chain = self._chains.get(chain_id)
            if chain is None:
                return False, "repair_chain_not_found_or_expired", chain_id
            if chain.union_id != union_id:
                return False, "repair_chain_identity_mismatch", chain_id
            if chain.scope_id != effective_scope:
                return False, "repair_chain_scope_mismatch", chain_id
            if chain.failures >= self.max_failures:
                return False, "repair_chain_failure_limit", chain_id
            return True, "ok", chain_id

    def record_failure(self, chain_id: str | None) -> int:
        if not chain_id:
            return 0
        with self._lock:
            chain = self._chains.get(chain_id)
            if chain is None:
                return 0
            chain.failures += 1
            return chain.failures

    def remaining(self, chain_id: str | None) -> int:
        if not chain_id:
            return self.max_failures
        with self._lock:
            chain = self._chains.get(chain_id)
            failures = chain.failures if chain else self.max_failures
            return max(0, self.max_failures - failures)

    def _purge_expired(self, now: float) -> None:
        cutoff = now - self.ttl_seconds
        for chain_id, chain in list(self._chains.items()):
            if chain.issued_at < cutoff:
                del self._chains[chain_id]
                scope_key = (chain.union_id, chain.scope_id)
                if self._active_by_scope.get(scope_key) == chain_id:
                    del self._active_by_scope[scope_key]
