from abc import ABC, abstractmethod

from ksher_agent_data_mcp.models.contracts import CredentialRef, UserContext


class CredentialResolutionError(Exception):
    """Base class for credential resolution failures with a known cause."""


class CredentialMappingUnavailable(CredentialResolutionError):
    """The verified user has no credential mapping for the requested datasource."""


class CredentialConfigurationMissing(CredentialResolutionError):
    """The service is missing configuration required to resolve a credential."""


class UnsupportedCredentialDatasource(CredentialResolutionError):
    """The credential resolver does not support the requested datasource."""


class CredentialResolver(ABC):
    @abstractmethod
    def resolve(self, user: UserContext, datasource: str = "tchouse-c") -> CredentialRef | None:
        """Resolve a verified user to a warehouse credential reference."""
