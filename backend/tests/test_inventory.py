"""Tests for the inventory route.

The inventory is written by the collector, not by the API, so these tests
insert rows directly and check only what the API reports.
"""
from datetime import datetime, timedelta, timezone

from app.database import SessionLocal
from app.models_ops import InventoryObject


def add_object(**fields):
    base = {
        "kind": "airflow_dag",
        "source": "airflow-standalone",
        "external_id": "dag_silver_a",
        "display_name": "dag_silver_a",
        "attrs": {"schedule": "0 2 * * *", "is_paused": False},
    }
    base.update(fields)
    with SessionLocal() as db:
        obj = InventoryObject(**base)
        db.add(obj)
        db.commit()
        return obj.id


def test_inventory_lists_what_the_collector_found(client):
    add_object()
    r = client.get("/api/inventory")
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["external_id"] == "dag_silver_a"
    assert items[0]["kind"] == "airflow_dag"
    assert items[0]["attrs"]["schedule"] == "0 2 * * *"


def test_inventory_filters_by_kind(client):
    add_object()
    add_object(kind="cron_job", source="host:local", external_id="job_c",
               display_name="run_job_c.sh")
    assert len(client.get("/api/inventory?kind=cron_job").json()["items"]) == 1
    assert len(client.get("/api/inventory").json()["items"]) == 2


def test_inventory_requires_an_account(anonymous_client):
    r = anonymous_client.get("/api/inventory")
    assert r.status_code == 401
