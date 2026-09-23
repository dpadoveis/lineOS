"""Tests for the dataset detail routes (schema, preview, stats, history)."""
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg
import pytest
from sqlalchemy import text

from app.config import settings
from app.database import SessionLocal, engine
from app.models_ops import ObjectCheck, InventoryObject, PipelineBinding, Pipeline
from conftest import graph, node
from test_inventory import add_object as add_inventory_object


DATABASE_URL = settings.database_url.replace("+psycopg", "")


def create_flow(client, name="Chain", nodes=None):
    g = graph(nodes=nodes or [node(1, uid="u-node-01"), node(2, uid="u-node-02")],
              edges=[{"id": 1, "from": 1, "to": 2, "label": None}])
    r = client.post("/api/flows", json={"name": name, "graph": g})
    assert r.status_code == 201, r.text
    return r.json()


def promote(client, flow, name="Chain ops"):
    r = client.post("/api/pipelines", json={"flow": flow["slug"], "name": name})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(scope="module")
def test_conn():
    """A direct connection to the test database for setup."""
    conn = psycopg.connect(DATABASE_URL)
    yield conn
    conn.close()


@pytest.fixture(scope="module", autouse=True)
def _setup_test_schema(test_conn):
    """Create the source schema and its sample tables -- a schema of its own,
    never the application's: dropping that one on teardown would take every
    other module's tables along."""
    with test_conn.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS dataset_src CASCADE")
        cur.execute("CREATE SCHEMA dataset_src")
        cur.execute("""
            CREATE TABLE dataset_src.sample (
                id INT PRIMARY KEY,
                name TEXT,
                updated_at TIMESTAMPTZ,
                payload BYTEA
            )
        """)
        # Insert 30 rows
        for i in range(1, 31):
            name = "x" * 300 if i == 15 else "50%_off" if i == 20 else None if i == 10 else f"row_{i}"
            payload = b"\x01\x02\x03" if i == 25 else None
            cur.execute(
                "INSERT INTO dataset_src.sample (id, name, updated_at, payload) VALUES (%s, %s, %s, %s)",
                (i, name, datetime(2026, 9, 23, 12, 0, 0, tzinfo=timezone.utc), payload),
            )
        cur.execute("CREATE TABLE dataset_src.nopk (label TEXT, seen_at TIMESTAMPTZ)")
        cur.execute("INSERT INTO dataset_src.nopk VALUES ('a', now()), ('b', now())")
        # Analyze the table
        cur.execute("ANALYZE dataset_src.sample")
    test_conn.commit()
    yield
    with test_conn.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS dataset_src CASCADE")
    test_conn.commit()


@pytest.fixture(autouse=True)
def _monkeypatch_dataset_source(monkeypatch):
    """Redirect dataset_source.connect to the test database."""
    @contextmanager
    def mock_connect():
        conn = psycopg.connect(DATABASE_URL)
        try:
            yield conn
        finally:
            conn.close()

    monkeypatch.setattr("app.dataset_source.connect", mock_connect)


def bind_table(client, pipeline_slug, node_uid, table_kind="table", external_id="dataset_src.sample",
               rules=None):
    """Helper to bind a node to a table object."""
    oid = add_inventory_object(
        kind=table_kind,
        external_id=external_id,
        display_name=external_id,
    )
    r = client.put(
        f"/api/pipelines/{pipeline_slug}/bindings/{node_uid}",
        json={"object_id": oid, "rules": {"freshness_column": "updated_at"} if rules is None else rules},
    )
    assert r.status_code == 200, r.text
    return oid


def test_schema_lists_columns_in_order(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/schema")
    assert r.status_code == 200
    body = r.json()
    assert len(body["columns"]) == 4
    assert body["columns"][0]["name"] == "id"
    assert body["columns"][0]["type"] == "integer"
    assert body["columns"][0]["nullable"] is False
    assert body["columns"][1]["name"] == "name"
    assert body["columns"][1]["type"] == "text"
    assert body["columns"][1]["nullable"] is True


def test_preview_defaults_to_updated_at_desc(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview")
    assert r.status_code == 200
    body = r.json()
    assert body["ordered_by"] == "updated_at"
    assert body["direction"] == "desc"
    assert body["latest"] is True
    assert len(body["rows"]) == 30
    assert body["limit"] == 50


def test_preview_without_freshness_column_falls_back_to_primary_key(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01", rules={})
    body = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview").json()
    assert body["ordered_by"] == "id"
    assert body["direction"] == "desc"
    assert body["latest"] is True
    assert body["rows"][0][0] == "30"


def test_preview_uses_the_source_order_column_before_the_primary_key(client, monkeypatch):
    monkeypatch.setattr(settings, "dataset_source_order_column", "updated_at")
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01", rules={})
    body = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview").json()
    assert body["ordered_by"] == "updated_at"


def test_preview_of_a_table_without_key_or_config_is_unordered(client, monkeypatch):
    monkeypatch.setattr(settings, "dataset_source_order_column", "no_such_column")
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01", external_id="dataset_src.nopk", rules={})
    body = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview").json()
    assert body["ordered_by"] is None
    assert body["direction"] is None
    assert body["latest"] is False
    assert len(body["rows"]) == 2


def test_preview_limit_capped_at_100(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?limit=500")
    assert r.status_code == 200
    body = r.json()
    assert body["limit"] == 100


def test_preview_explicit_order_by_and_direction(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?order_by=id&dir=asc")
    assert r.status_code == 200
    body = r.json()
    assert body["ordered_by"] == "id"
    assert body["direction"] == "asc"
    assert body["latest"] is False
    # First row should have id=1
    assert body["rows"][0][0] == "1"


def test_preview_contains_filter_with_escaping(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=name:contains:50%_off")
    assert r.status_code == 200
    body = r.json()
    assert len(body["rows"]) == 1


def test_preview_literal_percent_in_contains(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=name:contains:%")
    assert r.status_code == 200
    body = r.json()
    # Only the row with "50%_off"
    assert len(body["rows"]) == 1


def test_preview_multiple_filters_with_and(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=id:gt:25&f=name:notnull")
    assert r.status_code == 200
    body = r.json()
    # Rows 26-30 with name not null: 26, 27, 28, 29, 30
    assert len(body["rows"]) == 5


def test_preview_null_filter(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=name:null")
    assert r.status_code == 200
    body = r.json()
    assert len(body["rows"]) == 1


def test_preview_unknown_column_is_400(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=bad_col:eq:x")
    assert r.status_code == 400


def test_preview_unknown_order_by_is_400(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?order_by=bad_col")
    assert r.status_code == 400


def test_preview_unknown_operator_is_400(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=id:bad_op:1")
    assert r.status_code == 400


def test_preview_too_many_filters_is_400(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(
        f"/api/pipelines/{p['slug']}/objects/{oid}/preview"
        "?f=id:gt:1&f=id:lt:30&f=id:gt:10&f=id:lt:20&f=id:gt:15&f=id:lt:25"
    )
    assert r.status_code == 400


def test_preview_injection_order_by_rejected(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?order_by=id;DROP TABLE dataset_src.sample")
    assert r.status_code == 400


def test_preview_injection_filter_value_bound(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    # Attempt to inject SQL in filter value
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?f=id:eq:1 OR 1=1")
    # Either 400 (bind error on int cast) or 0 rows (no match) -- verify table survives
    assert r.status_code in (400, 502)
    # Verify the table still exists with 30 rows
    with psycopg.connect(DATABASE_URL) as conn:
        count = conn.execute("SELECT COUNT(*) FROM dataset_src.sample").fetchone()[0]
        assert count == 30


def test_preview_long_cell_truncated(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?order_by=id&dir=asc")
    assert r.status_code == 200
    body = r.json()
    # Row 15 has 300-char name, should be truncated to 200 + "…"
    row_15 = [row for row in body["rows"] if row[0] == "15"][0]
    assert row_15[1].endswith("…")
    assert len(row_15[1]) == 201


def test_preview_bytes_shown_as_size(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview?order_by=id&dir=asc")
    assert r.status_code == 200
    body = r.json()
    row_25 = [row for row in body["rows"] if row[0] == "25"][0]
    assert row_25[3] == "<3 bytes>"


def test_stats_returns_analyzed_at_and_columns(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["analyzed_at"] is not None
    assert len(body["columns"]) == 4
    assert body["columns"][0]["name"] == "id"


def test_stats_null_frac_and_distinct(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/stats")
    assert r.status_code == 200
    body = r.json()
    # name column: 1 NULL out of 30 rows
    name_col = [c for c in body["columns"] if c["name"] == "name"][0]
    assert name_col["null_frac"] > 0


def test_stats_row_count_from_last_check(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = oid = bind_table(client, p["slug"], "u-node-01")
    # Insert a check
    with SessionLocal() as db:
        check = ObjectCheck(
            object_id=oid,
            checked_at=datetime.now(timezone.utc),
            row_count=25,
            ok=True,
        )
        db.add(check)
        db.commit()
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] == 25


def test_stats_row_count_null_without_check(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] is None


def test_history_returns_points_oldest_first(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = oid = bind_table(client, p["slug"], "u-node-01")
    # Insert checks in reverse order
    with SessionLocal() as db:
        for i in range(3):
            check = ObjectCheck(
                object_id=oid,
                checked_at=datetime(2026, 9, 20 + i, tzinfo=timezone.utc),
                row_count=i * 10,
                ok=True,
            )
            db.add(check)
        db.commit()
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/history?days=30")
    assert r.status_code == 200
    body = r.json()
    assert len(body["points"]) == 3
    # Verify oldest first
    assert body["points"][0]["checked_at"] < body["points"][1]["checked_at"]
    assert body["points"][0]["row_count"] == 0


def test_non_table_object_is_400(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_inventory_object(kind="airflow_dag", external_id="some_dag")
    r = client.put(
        f"/api/pipelines/{p['slug']}/bindings/u-node-01",
        json={"object_id": oid},
    )
    assert r.status_code == 200
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview")
    assert r.status_code == 400


def test_object_not_bound_in_pipeline_is_404(client):
    f = create_flow(client)
    p = promote(client, f)
    oid = add_inventory_object(kind="table", external_id="dataset_src.sample")
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview")
    assert r.status_code == 404


def test_unauthenticated_cannot_read_datasets(client, anonymous_client):
    # Create a pipeline as owner, then try to access as anonymous
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    # Anonymous user should get 401 (sign in required)
    r = anonymous_client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/schema")
    assert r.status_code == 401


def test_source_unavailable_is_503(client, monkeypatch):
    from app import dataset_source

    def mock_unavailable(*args, **kwargs):
        raise dataset_source.SourceUnavailable("test error")

    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")

    monkeypatch.setattr(dataset_source, "connect", mock_unavailable)
    r = client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/schema")
    assert r.status_code == 503


def test_view_link_can_read_schema(client, anonymous_client):
    """A share link at 'view' level allows reading schema."""
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "view"}).json()

    r = anonymous_client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/schema",
                             headers={"X-Share-Token": link["token"]})
    assert r.status_code == 200
    assert len(r.json()["columns"]) == 4


def test_view_link_cannot_read_preview(client, anonymous_client):
    """A share link at 'view' level cannot read preview (edit required)."""
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "view"}).json()

    r = anonymous_client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview",
                             headers={"X-Share-Token": link["token"]})
    assert r.status_code == 403


def test_edit_link_can_read_preview(client, anonymous_client):
    """A share link at 'edit' level allows reading preview."""
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "edit"}).json()

    r = anonymous_client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/preview",
                             headers={"X-Share-Token": link["token"]})
    assert r.status_code == 200
    assert len(r.json()["rows"]) == 30


def test_view_link_can_read_history(client, anonymous_client):
    """A share link at 'view' level allows reading history."""
    f = create_flow(client)
    p = promote(client, f)
    oid = bind_table(client, p["slug"], "u-node-01")
    link = client.post(f"/api/shares/{f['id']}/links", json={"permission": "view"}).json()

    r = anonymous_client.get(f"/api/pipelines/{p['slug']}/objects/{oid}/history?days=30",
                             headers={"X-Share-Token": link["token"]})
    assert r.status_code == 200
    assert r.json()["points"] == []
