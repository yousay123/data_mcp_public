from abc import ABC, abstractmethod

from ksher_agent_data_mcp.models.contracts import ResolvedPrincipal, UserContext


class CredentialResolutionError(Exception):
    """Base class for credential resolution failures with a known cause."""


class CredentialMappingUnavailable(CredentialResolutionError):
    """The verified user has no credential mapping for the requested datasource."""


class CredentialConfigurationMissing(CredentialResolutionError):
    """The service is missing configuration required to resolve a credential."""


class UnsupportedCredentialDatasource(CredentialResolutionError):
    """The credential resolver does not support the requested datasource."""


class CredentialBackendUnavailable(CredentialResolutionError):
    """The identity or permission backend could not produce a current decision."""

    def __init__(
        self,
        backend_code: str,
        *,
        operation: str | None = None,
        retryable: bool = False,
        elapsed_ms: int | None = None,
    ) -> None:
        super().__init__(backend_code)
        self.backend_code = backend_code
        self.operation = operation
        self.retryable = retryable
        self.elapsed_ms = elapsed_ms


class CredentialResolver(ABC):
    @abstractmethod
    def resolve(
        self, user: UserContext, datasource: str = "tchouse-c"
    ) -> ResolvedPrincipal | None:
        """Resolve a host-verified user to a data-source principal."""
