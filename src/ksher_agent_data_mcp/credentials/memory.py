import json
from pathlib import Path

from ksher_agent_data_mcp.credentials.base import CredentialResolver
from ksher_agent_data_mcp.models.contracts import CredentialRef, UserContext


class MemoryCredentialResolver(CredentialResolver):
    def __init__(self, file_path: Path | None = None) -> None:
        self._credentials: dict[tuple[str, str], CredentialRef] = {}
        if file_path and file_path.exists():
            payload = json.loads(file_path.read_text(encoding="utf-8"))
            for row in payload.get("credentials", []):
                credential = CredentialRef.model_validate(row)
                key = (credential.user_union_id.lower(), credential.datasource.lower())
                self._credentials[key] = credential

    def resolve(self, user: UserContext, datasource: str = "tchouse-c") -> CredentialRef | None:
        return self._credentials.get((user.union_id.lower(), datasource.lower()))
