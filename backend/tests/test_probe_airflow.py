"""The Airflow probe, against a fixture metadata database.

No Airflow, no container, no docker -- the probe reads a SQLite file, so the
test builds one with the same columns the real one has.
"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops"))

from collector.probe_airflow import discover, runs  # noqa: E402

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def airflow_db(tmp_path):
    path = tmp_path / "airflow.db"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE dag (
          dag_id TEXT PRIMARY KEY, is_paused BOOLEAN,
          schedule_interval TEXT, timetable_description TEXT
        );
        CREATE TABLE dag_run (
          dag_id TEXT, run_id TEXT, state TEXT,
          start_date TEXT, end_date TEXT
        );
        """
    )
    con.execute(
        "INSERT INTO dag VALUES ('dag_silver_a', 0, '\"0 2 * * *\"', 'At 02:00')"
    )
    con.execute("INSERT INTO dag VALUES ('dag_b', 1, 'null', 'Never')")
    con.execute(
        "INSERT INTO dag_run VALUES ('dag_silver_a', 'scheduled__2026-09-22',"
        " 'success', '2026-09-22 02:00:01.000000', '2026-09-22 02:04:12.000000')"
    )
    con.execute(
        "INSERT INTO dag_run VALUES ('dag_silver_a', 'scheduled__2026-09-21',"
        " 'failed', '2026-09-21 02:00:01.000000', '2026-09-21 02:00:09.000000')"
    )
    con.commit()
    con.close()
    return str(path)


def test_discover_lists_every_dag_with_its_schedule(airflow_db):
    found = {d.external_id: d for d in discover(airflow_db, container=None)}
    assert set(found) == {"dag_silver_a", "dag_b"}
    d = found["dag_silver_a"]
    assert d.kind == "airflow_dag"
    # The quotes Airflow stores around the expression must not survive.
    assert d.attrs["schedule"] == "0 2 * * *"
    assert d.attrs["is_paused"] is False


def test_discover_reports_a_paused_dag_as_paused(airflow_db):
    found = {d.external_id: d for d in discover(airflow_db, container=None)}
    assert found["dag_b"].attrs["is_paused"] is True
    # 'null' is Airflow's way of writing "no schedule"; it must not become the
    # string "null", which would look like a cadence to the health rules.
    assert found["dag_b"].attrs["schedule"] is None


def test_runs_translates_state_into_an_outcome(airflow_db):
    got = {r.run_key: r for r in runs(airflow_db, container=None, since=NOW - timedelta(days=7))}
    assert got["scheduled__2026-09-22"].outcome == "success"
    assert got["scheduled__2026-09-21"].outcome == "failed"
    assert got["scheduled__2026-09-22"].started_at.tzinfo is not None


def test_runs_ignores_what_is_older_than_the_window(airflow_db):
    got = runs(airflow_db, container=None, since=NOW - timedelta(hours=12))
    assert [r.run_key for r in got] == ["scheduled__2026-09-22"]


def test_extract_table_from_uri_with_valid_postgres_uri():
    from collector.probe_airflow import _extract_table_from_uri
    uri = "postgres://warehouse-postgres:5432/warehouse/silver/table_b"
    table = _extract_table_from_uri(uri)
    assert table == "silver.table_b"


def test_extract_table_from_uri_ignores_malformed_uris():
    from collector.probe_airflow import _extract_table_from_uri
    assert _extract_table_from_uri("") is None
    assert _extract_table_from_uri("postgres://host") is None
    assert _extract_table_from_uri(None) is None


def test_edges_from_airflow_datasets(airflow_db):
    from collector.probe_airflow import edges as extract_edges
    # Create dataset and references.
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE dataset (id TEXT PRIMARY KEY, uri TEXT)"
    )
    con.execute(
        "CREATE TABLE task_outlet_dataset_reference (dag_id TEXT, dataset_id TEXT)"
    )
    con.execute(
        "CREATE TABLE dag_schedule_dataset_reference (dag_id TEXT, dataset_id TEXT)"
    )
    con.execute(
        "INSERT INTO dataset VALUES ('ds1', 'postgres://host:5432/db/silver/table_b')"
    )
    con.execute(
        "INSERT INTO task_outlet_dataset_reference VALUES ('dag_silver_a', 'ds1')"
    )
    con.execute(
        "INSERT INTO dag_schedule_dataset_reference VALUES ('dag_gold_a', 'ds1')"
    )
    con.commit()
    con.close()

    got_edges = extract_edges(airflow_db, container=None)
    assert len(got_edges) == 2
    outlets = [e for e in got_edges if e.from_external_id == "dag_silver_a"]
    schedules = [e for e in got_edges if e.to_external_id == "dag_gold_a"]
    assert len(outlets) == 1
    assert outlets[0].to_external_id == "silver.table_b"
    assert len(schedules) == 1
    assert schedules[0].from_external_id == "silver.table_b"
    assert all(e.declared_by == "airflow_dataset" for e in got_edges)


def test_edges_ignores_datasets_with_malformed_uris(airflow_db):
    from collector.probe_airflow import edges as extract_edges
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE dataset (id TEXT PRIMARY KEY, uri TEXT)"
    )
    con.execute(
        "CREATE TABLE task_outlet_dataset_reference (dag_id TEXT, dataset_id TEXT)"
    )
    con.execute(
        "CREATE TABLE dag_schedule_dataset_reference (dag_id TEXT, dataset_id TEXT)"
    )
    con.execute(
        "INSERT INTO dataset VALUES ('good', 'postgres://host:5432/db/silver/table_a')"
    )
    con.execute(
        "INSERT INTO dataset VALUES ('bad', 'postgres://host:5432')"
    )
    con.execute(
        "INSERT INTO task_outlet_dataset_reference VALUES ('dag1', 'good')"
    )
    con.execute(
        "INSERT INTO task_outlet_dataset_reference VALUES ('dag2', 'bad')"
    )
    con.commit()
    con.close()

    got_edges = extract_edges(airflow_db, container=None)
    assert len(got_edges) == 1
    assert got_edges[0].from_external_id == "dag1"


def test_edges_from_inlets_outlets_outlet_creates_dag_to_table_edge(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    dag_data = {
        "__version": 1,
        "dag": {
            "_dag_id": "test_dag",
            "tasks": [
                {
                    "__var": {
                        "task_id": "produce_task",
                        "outlets": [
                            {
                                "__type": "dataset",
                                "__var": {
                                    "uri": "postgres://host:5432/db/silver/my_table",
                                    "extra": None,
                                },
                            }
                        ],
                    }
                }
            ],
        },
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('test_dag', ?)",
        (json.dumps(dag_data),),
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 1
    assert got_edges[0].from_external_id == "test_dag"
    assert got_edges[0].to_external_id == "silver.my_table"
    assert got_edges[0].declared_by == "airflow_dataset"


def test_edges_from_inlets_outlets_inlet_creates_table_to_dag_edge(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    dag_data = {
        "__version": 1,
        "dag": {
            "_dag_id": "test_dag",
            "tasks": [
                {
                    "__var": {
                        "task_id": "consume_task",
                        "inlets": [
                            {
                                "__type": "dataset",
                                "__var": {
                                    "uri": "postgres://host:5432/db/silver/input_table",
                                    "extra": None,
                                },
                            }
                        ],
                    }
                }
            ],
        },
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('test_dag', ?)",
        (json.dumps(dag_data),),
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 1
    assert got_edges[0].from_external_id == "silver.input_table"
    assert got_edges[0].to_external_id == "test_dag"
    assert got_edges[0].declared_by == "airflow_dataset"


def test_edges_from_inlets_outlets_unwraps_task_from_var(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    dag_data = {
        "__version": 1,
        "dag": {
            "_dag_id": "test_dag",
            "tasks": [
                {
                    "__var": {
                        "task_id": "wrapped_task",
                        "outlets": [
                            {
                                "__type": "dataset",
                                "__var": {
                                    "uri": "postgres://host:5432/db/bronze/raw_data",
                                    "extra": None,
                                },
                            }
                        ],
                    }
                }
            ],
        },
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('test_dag', ?)",
        (json.dumps(dag_data),),
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 1
    assert got_edges[0].from_external_id == "test_dag"
    assert got_edges[0].to_external_id == "bronze.raw_data"


def test_edges_from_inlets_outlets_ignores_non_dataset_items(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    dag_data = {
        "__version": 1,
        "dag": {
            "_dag_id": "test_dag",
            "tasks": [
                {
                    "__var": {
                        "task_id": "mixed_task",
                        "outlets": [
                            {
                                "__type": "some_other_type",
                                "__var": {"uri": "postgres://host:5432/db/s/t"},
                            }
                        ],
                    }
                }
            ],
        },
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('test_dag', ?)",
        (json.dumps(dag_data),),
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 0


def test_edges_from_inlets_outlets_ignores_malformed_uris(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    dag_data = {
        "__version": 1,
        "dag": {
            "_dag_id": "test_dag",
            "tasks": [
                {
                    "__var": {
                        "task_id": "bad_uri_task",
                        "outlets": [
                            {
                                "__type": "dataset",
                                "__var": {
                                    "uri": "postgres://host:5432",
                                    "extra": None,
                                },
                            }
                        ],
                    }
                }
            ],
        },
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('test_dag', ?)",
        (json.dumps(dag_data),),
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 0


def test_edges_from_inlets_outlets_empty_table_returns_empty_list(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 0


def test_edges_from_inlets_outlets_handles_invalid_json_gracefully(airflow_db):
    from collector.probe_airflow import edges_from_inlets_outlets
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    con.execute(
        "INSERT INTO serialized_dag VALUES ('bad_dag', 'not valid json')"
    )
    con.commit()
    con.close()

    got_edges = edges_from_inlets_outlets(airflow_db, container=None)
    assert len(got_edges) == 0


def test_discover_extracts_dag_details_from_serialized_dag(airflow_db):
    from collector.probe_airflow import discover
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    dag_data = {
        "__version": 1,
        "dag": {
            "_description": "Test DAG description",
            "doc_md": "This is the documentation for the test DAG.",
            "default_args": {
                "__var": {"owner": "data-platform"},
                "__type": "dict"
            },
            "tags": ["etl", "daily"],
            "fileloc": "/opt/airflow/dags/test_dag.py",
            "tasks": [
                {
                    "__var": {
                        "task_id": "read_data",
                        "_task_type": "PythonOperator",
                        "inlets": [
                            {
                                "__type": "dataset",
                                "__var": {
                                    "uri": "postgresql://host:5432/warehouse/bronze/stg_table_a"
                                }
                            }
                        ],
                        "outlets": [],
                        "downstream_task_ids": ["transform_data"]
                    },
                    "__type": "operator"
                },
                {
                    "__var": {
                        "task_id": "transform_data",
                        "_task_type": "PythonOperator",
                        "inlets": [],
                        "outlets": [
                            {
                                "__type": "dataset",
                                "__var": {
                                    "uri": "postgresql://host:5432/warehouse/silver/transformed"
                                }
                            }
                        ],
                        "downstream_task_ids": []
                    },
                    "__type": "operator"
                }
            ]
        }
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('dag_silver_a', ?)",
        (json.dumps(dag_data),)
    )
    con.commit()
    con.close()

    found = {d.external_id: d for d in discover(airflow_db, container=None)}
    d = found["dag_silver_a"]

    assert d.attrs["description"] == "Test DAG description"
    assert d.attrs["doc"] == "This is the documentation for the test DAG."
    assert d.attrs["owner"] == "data-platform"
    assert d.attrs["tags"] == ["etl", "daily"]
    assert d.attrs["file"] == "/opt/airflow/dags/test_dag.py"

    assert len(d.attrs["tasks"]) == 2
    task1 = d.attrs["tasks"][0]
    assert task1["task_id"] == "read_data"
    assert task1["operator"] == "PythonOperator"
    assert task1["inlets"] == ["bronze.stg_table_a"]
    assert task1["outlets"] == []
    assert task1["downstream"] == ["transform_data"]

    task2 = d.attrs["tasks"][1]
    assert task2["task_id"] == "transform_data"
    assert task2["outlets"] == ["silver.transformed"]
    assert task2["inlets"] == []


def test_discover_malformed_serialized_dag_leaves_dag_with_basic_attrs(airflow_db):
    from collector.probe_airflow import discover
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    con.execute(
        "INSERT INTO serialized_dag VALUES ('dag_silver_a', 'not valid json')"
    )
    con.commit()
    con.close()

    found = {d.external_id: d for d in discover(airflow_db, container=None)}
    d = found["dag_silver_a"]

    assert "schedule" in d.attrs
    assert "is_paused" in d.attrs
    assert "tasks" not in d.attrs
    assert "description" not in d.attrs


def test_discover_caps_long_doc_at_4000_chars(airflow_db):
    from collector.probe_airflow import discover
    con = sqlite3.connect(airflow_db)
    con.execute(
        "CREATE TABLE serialized_dag (dag_id TEXT PRIMARY KEY, data TEXT)"
    )
    long_doc = "x" * 10000
    dag_data = {
        "__version": 1,
        "dag": {
            "doc_md": long_doc,
            "default_args": {"__var": {}, "__type": "dict"},
            "tags": [],
            "tasks": []
        }
    }
    con.execute(
        "INSERT INTO serialized_dag VALUES ('dag_b', ?)",
        (json.dumps(dag_data),)
    )
    con.commit()
    con.close()

    found = {d.external_id: d for d in discover(airflow_db, container=None)}
    d = found["dag_b"]

    assert len(d.attrs["doc"]) == 4001  # 4000 + ellipsis
    assert d.attrs["doc"].endswith("…")
