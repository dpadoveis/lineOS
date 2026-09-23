"""Test fixtures.

The tests talk to a real Postgres (the schema uses jsonb and a GIN index, which
SQLite does not have). Point DATABASE_URL_TEST at a disposable database; without
the variable the tests skip themselves. See docs/BACKEND.md.
"""
import os

import pytest

URL = os.environ.get("DATABASE_URL_TEST")

if not URL:  # pragma: no cover
    pytest.skip("set DATABASE_URL_TEST to run the tests", allow_module_level=True)

os.environ["DATABASE_URL"] = URL
os.environ.setdefault("DB_SCHEMA", "flow_test")
os.environ.setdefault("STORAGE_DIR", "/tmp/flow-test-files")
os.environ.setdefault("AUTHOR", "pytest")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _schema():
    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA IF EXISTS "{settings.db_schema}" CASCADE'))
        conn.execute(text(f'CREATE SCHEMA "{settings.db_schema}"'))
    Base.metadata.create_all(engine)
    yield
    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA IF EXISTS "{settings.db_schema}" CASCADE'))


@pytest.fixture(autouse=True)
def _truncate():
    """Every test starts with empty tables."""
    yield
    with engine.begin() as conn:
        conn.execute(text(f'TRUNCATE {settings.db_schema}.pipeline_bindings CASCADE'))
        conn.execute(text(f'TRUNCATE {settings.db_schema}.inventory_objects CASCADE'))
        conn.execute(text(f'TRUNCATE {settings.db_schema}.flows CASCADE'))
        conn.execute(text(f'TRUNCATE {settings.db_schema}.custom_tools CASCADE'))
        conn.execute(text(f'TRUNCATE {settings.db_schema}.users CASCADE'))


PASSWORD = "test-password-123"


@pytest.fixture
def anonymous_client():
    """A client with no session -- for the sign-up and sign-in tests."""
    with TestClient(app) as c:
        yield c


def register(c, email="owner@example.test", name="Owner"):
    """Creates an account and leaves the session cookie on the client."""
    r = c.post("/api/auth/register", json={"name": name, "email": email, "password": PASSWORD})
    assert r.status_code == 201, r.text
    return r.json()["user"]


@pytest.fixture
def client():
    """An already signed-in client: since sharing, the whole API needs an
    account."""
    with TestClient(app) as c:
        register(c)
        yield c


def graph(nodes=None, edges=None, groups=None):
    """A minimal valid graph, in the format of src/flow/payload.js."""
    return {
        "kind": "flow-graph",
        "version": 1,
        "nodes": nodes
        if nodes is not None
        else [
            {
                "id": 1,
                "name": "Airflow",
                "label": None,
                "category": "ORCHESTRATION",
                "initials": "AF",
                "color": "#7dd3a0",
                "x": -432,
                "y": 24,
                "width": None,
                "height": None,
                "description": None,
                "metadata": {},
                "tool": None,
                "group": None,
                "uid": None,
            },
            {
                "id": 2,
                "name": "dbt",
                # A renamed and resized node: `name` keeps the stack, `label` the
                # nickname -- both come back from the database untouched.
                "label": "Silver layer",
                "category": "TRANSFORMATION",
                "initials": "DBT",
                "color": "#e8956a",
                "x": -120,
                "y": 192,
                "width": 320,
                "height": 240,
                "description": "staging models",
                "metadata": {"model": "staging.table_a"},
                "tool": None,
                "group": None,
                "uid": None,
            },
        ],
        "edges": edges if edges is not None else [{"id": 1, "from": 1, "to": 2, "label": "trigger"}],
        "groups": groups if groups is not None else [],
    }


def node(id_, **fields):
    base = {
        "id": id_,
        "name": "N",
        # The user's nickname; null keeps the technical stack name.
        "label": None,
        "category": "C",
        "initials": "N",
        "color": "#ffffff",
        "x": 0,
        "y": 0,
        # Explicit size after a resize; null = the default.
        "width": None,
        "height": None,
        "description": None,
        "metadata": {},
        # Slug of the custom tool it came from; null for the built-in catalog.
        "tool": None,
        # Id of the group box holding the node; null when it sits outside every
        # box. The editor derives it from the coordinates.
        "group": None,
        # Stable identity across versions; null for diagrams saved before this field existed.
        "uid": None,
    }
    base.update(fields)
    return base


def group(id_, **fields):
    """A group box, in the format of `groupPayload()` on the frontend."""
    base = {
        "id": id_,
        "name": "Group",
        "x": 0,
        # Inverted like a node's y.
        "y": 0,
        "width": 384,
        "height": 264,
        "color": "#6fb8d3",
    }
    base.update(fields)
    return base
