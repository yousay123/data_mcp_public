from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class Status(StrEnum):
    SUCCESS = "success"
    VALIDATION_ERROR = "validation_error"
    NOT_FOUND = "not_found"
    ERROR = "error"


class ResultClass(StrEnum):
    SUCCESS = "success"
    POLICY_ERROR = "policy_error"
    CK_QUERY_ERROR = "ck_query_error"
    INCONCLUSIVE = "inconclusive"


class UserContext(BaseModel):
    union_id: str = Field(min_length=1)
    feishu_user_id: str | None = None
    lark_app_id: str | None = None
    email: str | None = None


class CredentialRef(BaseModel):
    user_union_id: str
    user_email: str | None = None
    tchouse_account: str
    jdbc_url: str
    password_secret_ref: str = Field(exclude=True)
    datasource: str = "tchouse-c"
    engine: str | None = None

    def masked(self) -> dict[str, str]:
        return {
            "user_union_id": self.user_union_id,
            "user_email": self.user_email,
            "tchouse_account": self.tchouse_account,
            "jdbc_url": mask_jdbc_url(self.jdbc_url),
            "datasource": self.datasource,
            "engine": self.engine or self.datasource,
        }


class ColumnMeta(BaseModel):
    name: str
    type: str
    description: str | None = None
    sensitive: bool = False
    masking_policy: str | None = None


class TableMeta(BaseModel):
    datasource: str = "tchouse-c"
    database: str
    table: str
    description: str | None = None
    partition_fields: list[str] = Field(default_factory=list)
    columns: list[ColumnMeta] = Field(default_factory=list)

    @property
    def full_name(self) -> str:
        return f"{self.database}.{self.table}"

    @property
    def qualified_name(self) -> str:
        return f"{self.datasource}.{self.database}.{self.table}"


class ValidationIssue(BaseModel):
    code: str
    severity: str
    message: str
    suggested_action: str | None = None


class SqlValidationResult(BaseModel):
    status: Status
    datasource: str = "tchouse-c"
    normalized_sql: str | None = None
    tables: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    issues: list[ValidationIssue] = Field(default_factory=list)


class QueryResult(BaseModel):
    status: Status
    result_class: ResultClass = ResultClass.SUCCESS
    query_id: str
    datasource: str = "tchouse-c"
    sql: str
    columns: list[ColumnMeta] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    row_count: int = 0
    read_rows: int | None = None
    read_bytes: int | None = None
    truncated: bool = False
    quality_warnings: list[str] = Field(default_factory=list)
    execution_ms: int = 0
    error_code: str | None = None
    error_name: str | None = None
    retryable: bool = False


def mask_jdbc_url(jdbc_url: str) -> str:
    redacted = jdbc_url
    for marker in ("password=", "pwd="):
        lowered = redacted.lower()
        start = lowered.find(marker)
        if start >= 0:
            value_start = start + len(marker)
            delimiters = [
                index
                for index in (
                    redacted.find(";", value_start),
                    redacted.find("&", value_start),
                )
                if index >= 0
            ]
            value_end = min(delimiters) if delimiters else len(redacted)
            redacted = f"{redacted[:value_start]}***{redacted[value_end:]}"
    return redacted
