from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol


@dataclass(frozen=True)
class SourceVersionObservation:
    """A conservative description of the data version visible to a query.

    ``available`` is reserved for providers that can cover every physical node
    used by the query.  The default provider deliberately reports unavailable;
    callers must never treat its timestamp as a data snapshot.
    """

    version: str | None
    provider: str
    status: str
    nodes: tuple[str, ...]
    captured_at: str


class SourceVersionProvider(Protocol):
    def observe(self, *, sql: str, datasource: str) -> SourceVersionObservation: ...


class UnavailableSourceVersionProvider:
    def observe(self, *, sql: str, datasource: str) -> SourceVersionObservation:
        del sql, datasource
        return SourceVersionObservation(
            version=None,
            provider="unavailable",
            status="unavailable",
            nodes=(),
            captured_at=_utc_now(),
        )


def reconcile_source_version(
    before: SourceVersionObservation,
    after: SourceVersionObservation,
) -> SourceVersionObservation:
    """Return one receipt observation without inventing snapshot semantics."""

    if (
        before.status == "available"
        and after.status == "available"
        and before.version
        and before.version == after.version
        and before.provider == after.provider
        and before.nodes == after.nodes
    ):
        return after
    if before.status == "available" and after.status == "available":
        return SourceVersionObservation(
            version=None,
            provider=after.provider,
            status="changed",
            nodes=after.nodes,
            captured_at=after.captured_at,
        )
    return SourceVersionObservation(
        version=None,
        provider=after.provider,
        status="unavailable",
        nodes=after.nodes,
        captured_at=after.captured_at,
    )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
