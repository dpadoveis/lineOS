"""The table probe, against the test Postgres."""
import os
import sys
from datetime import timezone
from pathlib import Path

import pytest
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops"))

from collector.probe_table import check_table, discover_tables  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import engine  # noqa: E402


def dsn():
    """The SQLAlchemy URL turned into something psycopg2 accepts."""
    return os.environ["DATABASE_URL_TEST"].replace("postgresql+psycopg://", "postgresql://")


# The docker-exec mode needs a running container that reaches the test
# database: PROBE_TEST_CONTAINER names it, and PROBE_TEST_DB_USER / _DB_NAME /
# _DB_PASSWORD say how to sign in. Without it, the tests that must reach a real
# table skip; the ones that fail before any I/O still run.
CONTAINER = os.environ.get("PROBE_TEST_CONTAINER", "")
DB_USER = os.environ.get("PROBE_TEST_DB_USER", "postgres")
DB_NAME = os.environ.get("PROBE_TEST_DB_NAME", "flows_test")
DB_PASSWORD = os.environ.get("PROBE_TEST_DB_PASSWORD", "")
needs_container = pytest.mark.skipif(not CONTAINER, reason="set PROBE_TEST_CONTAINER to run")


@pytest.fixture
def probe_table():
    with engine.begin() as conn:
        conn.execute(text(f'DROP TABLE IF EXISTS {settings.db_schema}.probe_demo'))
        conn.execute(
            text(
                f'CREATE TABLE {settings.db_schema}.probe_demo '
                "(id int, updated_at timestamptz)"
            )
        )
        conn.execute(
            text(
                f"INSERT INTO {settings.db_schema}.probe_demo VALUES "
                "(1, '2026-09-22 01:00+00'), (2, '2026-09-22 02:00+00')"
            )
        )
    yield "probe_demo"
    with engine.begin() as conn:
        conn.execute(text(f'DROP TABLE IF EXISTS {settings.db_schema}.probe_demo'))


def test_it_counts_rows_and_reads_the_watermark(probe_table):
    got = check_table(dsn(), settings.db_schema, probe_table, freshness_column="updated_at")
    assert got.ok is True
    assert got.row_count == 2
    # The session's time zone is the server's, so compare in UTC.
    assert got.max_ts.astimezone(timezone.utc).hour == 2


def test_without_a_freshness_column_it_only_counts(probe_table):
    got = check_table(dsn(), settings.db_schema, probe_table)
    assert got.ok is True and got.row_count == 2 and got.max_ts is None


def test_a_missing_table_is_an_error_not_a_crash(probe_table):
    got = check_table(dsn(), settings.db_schema, "no_such_table")
    assert got.ok is False
    assert got.error and "no_such_table" in got.error


def test_the_session_is_read_only(probe_table):
    """A write must be refused by the session itself, not by good intentions."""
    got = check_table(dsn(), settings.db_schema, probe_table,
                      freshness_column="updated_at; DROP TABLE probe_demo --")
    # Either the identifier is rejected outright or the read-only session
    # refuses the write; what must never happen is the table disappearing.
    assert got.ok is False
    with engine.begin() as conn:
        assert conn.execute(
            text(f'SELECT count(*) FROM {settings.db_schema}.probe_demo')
        ).scalar() == 2


@needs_container
def test_container_mode_reads_table(probe_table):
    """Via docker exec, read row count and freshness column."""
    got = check_table(
        "",
        settings.db_schema,
        probe_table,
        freshness_column="updated_at",
        container=CONTAINER or "no-such-container",
        user=DB_USER,
        db=DB_NAME,
        password=DB_PASSWORD,
    )
    assert got.ok is True
    assert got.row_count == 2
    assert got.max_ts.astimezone(timezone.utc).hour == 2


def test_container_mode_rejects_invalid_identifier():
    """An invalid identifier is rejected without reaching the database."""
    got = check_table(
        "",
        settings.db_schema,
        'test"; DROP TABLE "anything',
        freshness_column="col",
        container=CONTAINER or "no-such-container",
        user=DB_USER,
        db=DB_NAME,
        password=DB_PASSWORD,
    )
    assert got.ok is False
    assert "invalid identifier" in got.error


def test_container_mode_handles_missing_container():
    """A nonexistent container returns an error, not an exception."""
    got = check_table(
        "",
        settings.db_schema,
        "any_table",
        container="no-such-container",
        user=DB_USER,
        db=DB_NAME,
        password=DB_PASSWORD,
    )
    assert got.ok is False
    assert got.error is not None


@needs_container
def test_discover_tables_finds_tables_in_schema(probe_table):
    """Discover tables returns Discovered objects with correct structure."""
    found = discover_tables(
        CONTAINER or "no-such-container",
        DB_USER,
        DB_NAME,
        DB_PASSWORD,
        [settings.db_schema],
        "test_source",
    )
    assert len(found) > 0
    # The probe_demo table should be discovered
    probe_demo_found = [d for d in found if d.external_id == f"{settings.db_schema}.{probe_table}"]
    assert len(probe_demo_found) == 1
    discovered = probe_demo_found[0]
    assert discovered.kind == "table"
    assert discovered.source == "test_source"
    assert discovered.display_name == f"{settings.db_schema}.{probe_table}"
    assert discovered.attrs["schema"] == settings.db_schema
    assert discovered.attrs["table"] == probe_table
    assert discovered.attrs["layer"] == settings.db_schema


def test_discover_tables_rejects_invalid_schema_without_hitting_db():
    """Invalid schema name returns empty list without reaching database."""
    found = discover_tables(
        CONTAINER or "no-such-container",
        DB_USER,
        DB_NAME,
        DB_PASSWORD,
        ["x; DROP TABLE y"],
        "test_source",
    )
    assert found == []


def test_discover_tables_handles_missing_container():
    """Missing container returns empty list, not an exception."""
    found = discover_tables(
        "no-such-container",
        DB_USER,
        DB_NAME,
        DB_PASSWORD,
        ["public"],
        "test_source",
    )
    assert found == []


