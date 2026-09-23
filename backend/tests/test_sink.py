"""The sink: idempotent upserts and retention."""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import pytest
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops"))

from collector import sink  # noqa: E402
from collector.probe_airflow import Discovered, DiscoveredRun  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import engine  # noqa: E402

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def conn():
    dsn = os.environ["DATABASE_URL_TEST"].replace("postgresql+psycopg://", "postgresql://")
    c = psycopg2.connect(dsn)
    with c.cursor() as cur:
        cur.execute(f'SET search_path TO "{settings.db_schema}"')
    yield c
    c.close()
    with engine.begin() as e:
        e.execute(text(f'TRUNCATE {settings.db_schema}.inventory_objects CASCADE'))


def a_dag(external_id="dag_gold_a"):
    return Discovered("airflow_dag", "airflow-standalone", external_id, external_id,
                      {"schedule": "0 4 * * *", "is_paused": False})


def a_run(external_id="dag_gold_a", key="r1", outcome="running", ended=None):
    return DiscoveredRun(external_id, key, NOW - timedelta(minutes=10), ended, outcome)


def test_upserting_the_same_object_twice_keeps_one_row(conn):
    sink.upsert_objects(conn, [a_dag()])
    ids = sink.upsert_objects(conn, [a_dag()])
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM inventory_objects")
        assert cur.fetchone()[0] == 1
    assert len(ids) == 1


def test_upserting_advances_last_seen_at(conn):
    sink.upsert_objects(conn, [a_dag()])
    with conn.cursor() as cur:
        cur.execute("SELECT last_seen_at FROM inventory_objects")
        first = cur.fetchone()[0]
    sink.upsert_objects(conn, [a_dag()])
    with conn.cursor() as cur:
        cur.execute("SELECT last_seen_at FROM inventory_objects")
        assert cur.fetchone()[0] >= first


def test_an_object_that_vanished_is_not_deleted(conn):
    sink.upsert_objects(conn, [a_dag()])
    sink.upsert_objects(conn, [a_dag("something_else")])
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM inventory_objects")
        assert cur.fetchone()[0] == 2


def test_re_reporting_a_run_finishes_it_instead_of_duplicating(conn):
    ids = sink.upsert_objects(conn, [a_dag()])
    sink.upsert_runs(conn, ids, [a_run(outcome="running")])
    sink.upsert_runs(conn, ids, [a_run(outcome="success", ended=NOW)])
    with conn.cursor() as cur:
        cur.execute("SELECT count(*), max(outcome) FROM object_runs")
        count, outcome = cur.fetchone()
    assert count == 1
    assert outcome == "success"


def test_a_run_for_an_unknown_object_is_dropped_not_crashed(conn):
    ids = sink.upsert_objects(conn, [a_dag()])
    written = sink.upsert_runs(conn, ids, [a_run(external_id="never_discovered")])
    assert written == 0


def test_prune_removes_old_runs_and_keeps_recent_ones(conn):
    ids = sink.upsert_objects(conn, [a_dag()])
    old = DiscoveredRun("dag_gold_a", "old", NOW - timedelta(days=120),
                        NOW - timedelta(days=120), "success")
    sink.upsert_runs(conn, ids, [old, a_run(key="fresh", outcome="success", ended=NOW)])
    removed = sink.prune(conn, days=90)
    assert removed >= 1
    with conn.cursor() as cur:
        cur.execute("SELECT run_key FROM object_runs")
        assert [r[0] for r in cur.fetchall()] == ["fresh"]


def an_edge(from_id="dag_gold_a", to_id="silver.table_a",
            declared_by="heartbeat"):
    from collector.probe_airflow import DiscoveredEdge
    return DiscoveredEdge(from_id, to_id, declared_by)


def test_upserting_edges_creates_object_edges(conn):
    dag = a_dag()
    table = Discovered("table", "warehouse", "silver.table_a",
                      "silver.table_a")
    ids = sink.upsert_objects(conn, [dag, table])
    edge = an_edge()
    sink.upsert_edges(conn, ids, [edge])
    with conn.cursor() as cur:
        cur.execute("SELECT from_object_id, to_object_id, declared_by FROM object_edges")
        rows = cur.fetchall()
    assert len(rows) == 1
    assert rows[0][2] == "heartbeat"


def test_upserting_the_same_edge_twice_keeps_one_row(conn):
    dag = a_dag()
    table = Discovered("table", "warehouse", "silver.table_a",
                      "silver.table_a")
    ids = sink.upsert_objects(conn, [dag, table])
    edge = an_edge()
    sink.upsert_edges(conn, ids, [edge])
    sink.upsert_edges(conn, ids, [edge])
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM object_edges")
        assert cur.fetchone()[0] == 1


def test_upserting_advances_edge_last_seen_at(conn):
    dag = a_dag()
    table = Discovered("table", "warehouse", "silver.table_a",
                      "silver.table_a")
    ids = sink.upsert_objects(conn, [dag, table])
    edge = an_edge()
    sink.upsert_edges(conn, ids, [edge])
    with conn.cursor() as cur:
        cur.execute("SELECT last_seen_at FROM object_edges")
        first = cur.fetchone()[0]
    sink.upsert_edges(conn, ids, [edge])
    with conn.cursor() as cur:
        cur.execute("SELECT last_seen_at FROM object_edges")
        assert cur.fetchone()[0] >= first


def test_an_edge_for_an_unknown_object_is_dropped_not_crashed(conn):
    dag = a_dag()
    ids = sink.upsert_objects(conn, [dag])
    edge = an_edge()
    written = sink.upsert_edges(conn, ids, [edge])
    assert written == 0
