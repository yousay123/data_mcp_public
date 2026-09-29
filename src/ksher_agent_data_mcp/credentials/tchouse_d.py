from dataclasses import dataclass
from urllib.parse import parse_qsl, quote_plus, urlencode, urlparse

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.credentials.base import (
    CredentialConfigurationMissing,
    CredentialMappingUnavailable,
    CredentialResolver,
    UnsupportedCredentialDatasource,
)
from ksher_agent_data_mcp.models.contracts import CredentialRef, UserContext


@dataclass(frozen=True)
class JdbcMysqlTarget:
    host: str
    port: int
    database: str


class TChouseDCredentialResolver(CredentialResolver):
    """Resolve user-scoped TChouse-C credentials from TChouse-D by Feishu union_id."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def resolve(self, user: UserContext, datasource: str = "tchouse-c") -> CredentialRef | None:
        datasource = datasource.lower()
        if datasource == "tchouse-d":
            return self._configured_tchouse_d_credential(user)
        if datasource != "tchouse-c":
            raise UnsupportedCredentialDatasource(datasource)

        tchouse_c_jdbc_base_url = self.settings.tchouse_c_jdbc_base_url
        if not tchouse_c_jdbc_base_url:
            raise ValueError("TCHOUSE_C_JDBC_BASE_URL is required")
        try:
            account, password, email = self._query_tchouse_c_account(user.union_id)
        except LookupError as exc:
            raise CredentialMappingUnavailable(datasource) from exc
        jdbc_url = build_tchouse_c_jdbc_url(
            tchouse_c_jdbc_base_url,
            account,
            password,
        )
        return CredentialRef(
            user_union_id=user.union_id,
            user_email=email,
            tchouse_account=account,
            jdbc_url=jdbc_url,
            password_secret_ref=f"tchouse-d://union_id/{user.union_id}",
            datasource="tchouse-c",
            engine="tchouse-c",
        )

    def _configured_tchouse_d_credential(self, user: UserContext) -> CredentialRef | None:
        username = self.settings.tchouse_d_username
        password = (
            self.settings.tchouse_d_password.get_secret_value()
            if self.settings.tchouse_d_password
            else None
        )
        if not username or not password:
            raise CredentialConfigurationMissing("TCHOUSE_D_USERNAME/TCHOUSE_D_PASSWORD")
        tchouse_d_jdbc_url = self.settings.tchouse_d_jdbc_url
        if not tchouse_d_jdbc_url:
            raise ValueError("TCHOUSE_D_JDBC_URL is required")
        return CredentialRef(
            user_union_id=user.union_id,
            user_email=user.email,
            tchouse_account=username,
            jdbc_url=build_mysql_jdbc_url(tchouse_d_jdbc_url, username, password),
            password_secret_ref="env://TCHOUSE_D_PASSWORD",
            datasource="tchouse-d",
            engine="mysql",
        )

    def _query_tchouse_c_account(self, union_id: str) -> tuple[str, str, str | None]:
        tchouse_d_jdbc_url = self.settings.tchouse_d_jdbc_url
        if not tchouse_d_jdbc_url:
            raise ValueError("TCHOUSE_D_JDBC_URL is required")
        target = parse_jdbc_mysql_url(tchouse_d_jdbc_url)
        username = self.settings.tchouse_d_username
        password = (
            self.settings.tchouse_d_password.get_secret_value()
            if self.settings.tchouse_d_password
            else None
        )
        if not username or not password:
            raise ValueError("TCHOUSE_D_USERNAME and TCHOUSE_D_PASSWORD are required")
        credential_sql = self.settings.tchouse_d_credential_sql
        if not credential_sql or not credential_sql.strip():
            raise CredentialConfigurationMissing("TCHOUSE_D_CREDENTIAL_SQL")

        try:
            import pymysql
        except ImportError as exc:
            raise RuntimeError("pymysql is required: install with `pip install -e '.[mysql]'`") from exc

        connection = pymysql.connect(
            host=target.host,
            port=target.port,
            user=username,
            password=password,
            database=target.database,
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=5,
            read_timeout=10,
            write_timeout=10,
        )
        try:
            with connection.cursor() as cursor:
                cursor.execute(credential_sql, (union_id,))
                row = cursor.fetchone()
        finally:
            connection.close()

        if not row:
            raise LookupError(f"No TChouse-C credential mapping found for union_id={union_id}")

        account = (
            row.get("tchouse_account")
            or row.get("account")
            or row.get("username")
        )
        credential_password = (
            row.get("tchouse_password")
            or row.get("password")
            or row.get("pwd")
        )
        if not account or not credential_password:
            raise ValueError(
                "TChouse-D credential SQL must return tchouse_account and tchouse_password"
            )
        email = row.get("user_email") or row.get("email") or row.get("enterprise_email")
        return (
            str(account).strip(),
            str(credential_password).strip(),
            str(email).strip() if email else None,
        )


def build_tchouse_c_jdbc_url(base_url: str, account: str, password: str) -> str:
    separator = ";" if ";" not in base_url else ";"
    return f"{base_url}{separator}user={account};password={password}"


def build_mysql_jdbc_url(base_url: str, username: str, password: str) -> str:
    if "?" in base_url:
        prefix, query = base_url.split("?", maxsplit=1)
        params = dict(parse_qsl(query, keep_blank_values=True))
    else:
        prefix, params = base_url, {}
    params["user"] = username
    params["password"] = password
    return f"{prefix}?{urlencode(params, quote_via=quote_plus)}"


def parse_jdbc_mysql_url(jdbc_url: str) -> JdbcMysqlTarget:
    raw_url = jdbc_url.removeprefix("jdbc:")
    parsed = urlparse(raw_url)
    if parsed.scheme != "mysql" or not parsed.hostname:
        raise ValueError(f"Invalid JDBC MySQL URL: {jdbc_url}")
    database = parsed.path.lstrip("/")
    if not database:
        raise ValueError(f"JDBC MySQL URL must include database: {jdbc_url}")
    return JdbcMysqlTarget(
        host=parsed.hostname,
        port=parsed.port or 3306,
        database=database,
    )
