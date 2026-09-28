import pytest
from pydantic import SecretStr

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.credentials.base import (
    CredentialConfigurationMissing,
    CredentialMappingUnavailable,
    UnsupportedCredentialDatasource,
)
from ksher_agent_data_mcp.credentials.tchouse_d import (
    TChouseDCredentialResolver,
    build_mysql_jdbc_url,
    build_tchouse_c_jdbc_url,
    parse_jdbc_mysql_url,
)
from ksher_agent_data_mcp.models.contracts import UserContext, mask_jdbc_url


TCHOUSE_C_JDBC_BASE_URL = "jdbc:clickhouse://tchouse-c.example.invalid:8123/example_db"
TCHOUSE_D_JDBC_URL = "jdbc:mysql://tchouse-d.example.invalid:9030/example_db"
TCHOUSE_D_CREDENTIAL_SQL = (
    "SELECT account AS tchouse_account, password_ref AS tchouse_password "
    "FROM credential_mapping WHERE union_id = %s LIMIT 1"
)


def _resolver_settings() -> Settings:
    return Settings(
        CREDENTIAL_PROVIDER="tchouse_d",
        TCHOUSE_C_JDBC_BASE_URL=TCHOUSE_C_JDBC_BASE_URL,
        TCHOUSE_D_JDBC_URL=TCHOUSE_D_JDBC_URL,
        TCHOUSE_D_USERNAME="resolver_user",
        TCHOUSE_D_PASSWORD=SecretStr("resolver_password"),
        TCHOUSE_D_CREDENTIAL_SQL=TCHOUSE_D_CREDENTIAL_SQL,
    )


def test_parse_jdbc_mysql_url() -> None:
    target = parse_jdbc_mysql_url(TCHOUSE_D_JDBC_URL)

    assert target.host == "tchouse-d.example.invalid"
    assert target.port == 9030
    assert target.database == "example_db"


def test_build_tchouse_c_jdbc_url_and_mask_password() -> None:
    jdbc_url = build_tchouse_c_jdbc_url(
        TCHOUSE_C_JDBC_BASE_URL,
        "agent_user",
        "secret_password",
    )

    assert jdbc_url == (
        "jdbc:clickhouse://tchouse-c.example.invalid:8123/example_db;"
        "user=agent_user;password=secret_password"
    )
    assert mask_jdbc_url(jdbc_url).endswith("user=agent_user;password=***")


def test_build_mysql_jdbc_url_and_mask_password() -> None:
    jdbc_url = build_mysql_jdbc_url(
        TCHOUSE_D_JDBC_URL,
        "resolver_user",
        "resolver_password",
    )

    assert jdbc_url == (
        "jdbc:mysql://tchouse-d.example.invalid:9030/example_db?"
        "user=resolver_user&password=resolver_password"
    )
    assert mask_jdbc_url(jdbc_url).endswith("user=resolver_user&password=***")


def test_resolves_configured_tchouse_d_credential() -> None:
    settings = _resolver_settings()
    resolver = TChouseDCredentialResolver(settings)

    credential = resolver.resolve(
        UserContext(union_id="on_test", feishu_user_id="ou_test"),
        datasource="tchouse-d",
    )

    assert credential is not None
    assert credential.user_union_id == "on_test"
    assert credential.datasource == "tchouse-d"
    assert credential.tchouse_account == "resolver_user"
    assert credential.password_secret_ref == "env://TCHOUSE_D_PASSWORD"


def test_accepts_configured_credential_sql_aliases(monkeypatch) -> None:
    settings = _resolver_settings()
    resolver = TChouseDCredentialResolver(settings)

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params):
            assert "union_id = %s" in sql
            assert params == ("on_test",)

        def fetchone(self):
            return {"tchouse_account": "agent_user", "tchouse_password": "agent_password"}

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def close(self):
            pass

    import pymysql

    monkeypatch.setattr(pymysql, "connect", lambda **kwargs: FakeConnection())

    credential = resolver.resolve(
        UserContext(union_id="on_test", feishu_user_id="ou_test"),
        datasource="tchouse-c",
    )

    assert credential is not None
    assert credential.user_union_id == "on_test"
    assert credential.user_email is None
    assert credential.tchouse_account == "agent_user"
    assert "user=agent_user;password=agent_password" in credential.jdbc_url


def test_raises_specific_error_when_union_id_mapping_missing(monkeypatch) -> None:
    settings = _resolver_settings()
    resolver = TChouseDCredentialResolver(settings)

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params):
            assert params == ("on_missing",)

        def fetchone(self):
            return None

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def close(self):
            pass

    import pymysql

    monkeypatch.setattr(pymysql, "connect", lambda **kwargs: FakeConnection())

    with pytest.raises(CredentialMappingUnavailable):
        resolver.resolve(
            UserContext(union_id="on_missing", feishu_user_id="ou_missing"),
            datasource="tchouse-c",
        )


def test_raises_specific_error_when_configured_credential_is_missing() -> None:
    settings = Settings(
        CREDENTIAL_PROVIDER="tchouse_d",
        TCHOUSE_C_JDBC_BASE_URL=TCHOUSE_C_JDBC_BASE_URL,
        TCHOUSE_D_JDBC_URL=TCHOUSE_D_JDBC_URL,
        TCHOUSE_D_USERNAME="",
        TCHOUSE_D_PASSWORD=SecretStr(""),
        TCHOUSE_D_CREDENTIAL_SQL=TCHOUSE_D_CREDENTIAL_SQL,
    )
    resolver = TChouseDCredentialResolver(settings)

    with pytest.raises(CredentialConfigurationMissing):
        resolver.resolve(
            UserContext(union_id="on_test", feishu_user_id="ou_test"),
            datasource="tchouse-d",
        )


def test_raises_specific_error_when_credential_sql_is_missing() -> None:
    settings = Settings(
        CREDENTIAL_PROVIDER="tchouse_d",
        TCHOUSE_C_JDBC_BASE_URL=TCHOUSE_C_JDBC_BASE_URL,
        TCHOUSE_D_JDBC_URL=TCHOUSE_D_JDBC_URL,
        TCHOUSE_D_USERNAME="resolver_user",
        TCHOUSE_D_PASSWORD=SecretStr("resolver_password"),
        TCHOUSE_D_CREDENTIAL_SQL="",
    )
    resolver = TChouseDCredentialResolver(settings)

    with pytest.raises(CredentialConfigurationMissing):
        resolver.resolve(
            UserContext(union_id="on_test", feishu_user_id="ou_test"),
            datasource="tchouse-c",
        )


def test_raises_specific_error_for_unsupported_datasource() -> None:
    resolver = TChouseDCredentialResolver(_resolver_settings())

    with pytest.raises(UnsupportedCredentialDatasource):
        resolver.resolve(
            UserContext(union_id="on_test", feishu_user_id="ou_test"),
            datasource="unknown-source",
        )
