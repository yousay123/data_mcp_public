from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.metadata import catalog as catalog_module
from ksher_agent_data_mcp.metadata.catalog import MetadataAccessDenied, TChouseCMetadataCatalog
from ksher_agent_data_mcp.models.contracts import CredentialRef


def _credential() -> CredentialRef:
    return CredentialRef(
        user_union_id="on_example_user",
        user_email="demo@example.com",
        tchouse_account="demo_user",
        jdbc_url=(
            "jdbc:clickhouse://tchouse-c.example.invalid:8123/example_db;"
            "user=demo_user;password=demo_password"
        ),
        password_secret_ref="secret://demo",
        datasource="tchouse-c",
    )


def test_tchouse_c_catalog_describes_existing_table(monkeypatch) -> None:
    seen_sql = []
    seen_query_ids = []

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        seen_sql.append(sql)
        seen_query_ids.append(query_id)
        return {"data": []}

    monkeypatch.setattr(catalog_module, "execute_clickhouse_json", fake_execute_clickhouse_json)

    catalog = TChouseCMetadataCatalog(Settings(QUERY_TIMEOUT_SECONDS=60))
    table = catalog.describe_table("analytics.payment_order_daily", _credential())

    assert table is not None
    assert table.full_name == "analytics.payment_order_daily"
    assert table.columns == []
    assert seen_sql == ["SELECT 1 FROM `analytics`.`payment_order_daily` LIMIT 0"]
    assert len(seen_query_ids) == 1
    assert seen_query_ids[0].startswith("metadata_probe_table_")


def test_tchouse_c_catalog_uses_unique_query_ids(monkeypatch) -> None:
    seen_query_ids = []

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        seen_query_ids.append(query_id)
        return {"data": []}

    monkeypatch.setattr(catalog_module, "execute_clickhouse_json", fake_execute_clickhouse_json)
    catalog = TChouseCMetadataCatalog(Settings())

    catalog.describe_table("analytics.payment_order_daily", _credential())
    catalog.describe_table("analytics.merchant_dimension", _credential())
    catalog.suggest_tables("analytics.payment", credential=_credential())
    catalog.suggest_tables("analytics.merchant", credential=_credential())

    assert len(seen_query_ids) == 4
    assert len(set(seen_query_ids)) == 4
    assert all(
        query_id.startswith("metadata_probe_table_") for query_id in seen_query_ids[:2]
    )
    assert all(
        query_id.startswith("metadata_suggest_tables_") for query_id in seen_query_ids[2:]
    )


def test_tchouse_c_catalog_denies_when_probe_fails(monkeypatch) -> None:
    calls = []

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        calls.append(sql)
        from io import BytesIO
        from urllib.error import HTTPError

        raise HTTPError(
            url="http://clickhouse/",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=BytesIO(b"Code: 60. DB::Exception: Unknown table expression identifier"),
        )

    monkeypatch.setattr(catalog_module, "execute_clickhouse_json", fake_execute_clickhouse_json)

    catalog = TChouseCMetadataCatalog(Settings())

    try:
        catalog.describe_table("analytics.missing_table", _credential())
    except MetadataAccessDenied:
        pass
    else:
        raise AssertionError("expected MetadataAccessDenied")
    assert len(calls) == 1


def test_tchouse_c_catalog_caches_successful_probe(monkeypatch) -> None:
    calls = []

    def fake_execute_clickhouse_json(target, sql, query_id, timeout_seconds):
        calls.append(sql)
        return {"data": []}

    monkeypatch.setattr(catalog_module, "execute_clickhouse_json", fake_execute_clickhouse_json)

    catalog = TChouseCMetadataCatalog(Settings())
    first = catalog.describe_table("analytics.payment_order_daily", _credential())
    second = catalog.describe_table("analytics.payment_order_daily", _credential())

    assert first is not None
    assert second is first
    assert calls == ["SELECT 1 FROM `analytics`.`payment_order_daily` LIMIT 0"]
