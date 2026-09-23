"""Freshness and volume of a bound table.

Read-only by construction: every session opens with
`SET default_transaction_read_only = on`, so a mistake in this file is refused
by Postgres rather than caught by review. No temp tables, ever.

Identifiers are quoted through psycopg2.sql, never interpolated: the schema,
table and column names come from a binding somebody typed, which makes them
untrusted input even though the person is trusted.

Via docker exec, identifiers are quoted by shell escaping and validated before
reaching the command line.
"""
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime

import psycopg2
from psycopg2 import sql


@dataclass
class TableCheck:
    row_count: int | None = None
    max_ts: datetime | None = None
    ok: bool = True
    error: str | None = None


_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


def _validate_identifier(name: str) -> str | None:
    """Return None if valid, else an error message."""
    if not name:
        return "identifier is empty"
    if not _IDENT_RE.match(name):
        return f"invalid identifier: {name!r}"
    return None


def check_table(
    dsn: str,
    schema: str,
    table: str,
    freshness_column: str | None = None,
    timeout_s: int = 15,
    container: str | None = None,
    user: str = "",
    db: str = "",
    password: str = "",
) -> TableCheck:
    # Validate all identifiers before doing any I/O
    for name in [schema, table]:
        err = _validate_identifier(name)
        if err:
            return TableCheck(ok=False, error=err)
    if freshness_column:
        err = _validate_identifier(freshness_column)
        if err:
            return TableCheck(ok=False, error=err)

    if container:
        return _check_table_via_docker(
            container, user, db, password, schema, table, freshness_column, timeout_s
        )
    else:
        return _check_table_via_psycopg2(dsn, schema, table, freshness_column, timeout_s)


def _check_table_via_psycopg2(
    dsn: str,
    schema: str,
    table: str,
    freshness_column: str | None = None,
    timeout_s: int = 15,
) -> TableCheck:
    conn = None
    try:
        conn = psycopg2.connect(dsn, connect_timeout=timeout_s)
        with conn.cursor() as cur:
            cur.execute("SET default_transaction_read_only = on")
            cur.execute("SET statement_timeout = %s", (timeout_s * 1000,))
            target = sql.Identifier(schema, table)
            if freshness_column:
                query = sql.SQL("SELECT count(*), max({col}) FROM {tbl}").format(
                    col=sql.Identifier(freshness_column), tbl=target
                )
            else:
                query = sql.SQL("SELECT count(*), NULL::timestamptz FROM {tbl}").format(
                    tbl=target
                )
            cur.execute(query)
            count, newest = cur.fetchone()
            return TableCheck(row_count=count, max_ts=newest, ok=True)
    except Exception as exc:  # noqa: BLE001 -- a probe reports, it never raises
        # One probe failing must not stop the others, and the message is what
        # the panel shows instead of a false green.
        return TableCheck(ok=False, error=f"{type(exc).__name__}: {exc}".strip()[:500])
    finally:
        if conn is not None:
            conn.close()


def _check_table_via_docker(
    container: str,
    user: str,
    db: str,
    password: str,
    schema: str,
    table: str,
    freshness_column: str | None = None,
    timeout_s: int = 15,
) -> TableCheck:
    # The watermark is rendered as canonical UTC by SQL, never left to psql's
    # own formatting. psql prints a two-digit offset ("-03") that Python 3.10's
    # fromisoformat rejects, and normalising it by hand went wrong the obvious
    # way: a two-character offset was replaced with "+00:00", which silently
    # turns a real offset into UTC. On a host running BRT that shifts every
    # freshness comparison by three hours, and the panel would never say so.
    if freshness_column:
        watermark = (
            f"to_char(max({freshness_column}) AT TIME ZONE 'UTC', "
            "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
        )
    else:
        watermark = "NULL"
    sql_query = (
        "BEGIN; SET default_transaction_read_only = on; "
        f"SET statement_timeout = {timeout_s * 1000}; "
        f"SELECT count(*), {watermark} FROM {schema}.{table}; COMMIT"
    )
    try:
        result = subprocess.run(
            [
                "docker", "exec",
                # The password travels as a process environment variable, so it
                # never appears in `ps` the way a command-line argument would.
                "-e", f"PGPASSWORD={password}",
                container, "psql", "-q", "-U", user, "-d", db, "-tAc", sql_query,
            ],
            capture_output=True, text=True, timeout=timeout_s, check=True,
        )
        output = result.stdout.strip()
        if not output:
            return TableCheck(ok=False, error="no output from query")
        parts = output.split("|")
        if len(parts) != 2:
            return TableCheck(ok=False, error=f"unexpected output format: {output!r}")
        try:
            count = int(parts[0])
        except ValueError:
            return TableCheck(ok=False, error=f"row count is not an integer: {parts[0]!r}")
        newest = None
        if parts[1]:
            try:
                newest = datetime.fromisoformat(parts[1].replace("Z", "+00:00"))
            except ValueError:
                return TableCheck(ok=False, error=f"max_ts is not a timestamp: {parts[1]!r}")
        return TableCheck(row_count=count, max_ts=newest, ok=True)
    except subprocess.TimeoutExpired:
        return TableCheck(ok=False, error=f"docker exec timeout after {timeout_s}s")
    except subprocess.CalledProcessError as exc:
        return TableCheck(
            ok=False,
            error=f"docker exec failed: {exc.stderr.strip() or exc.stdout.strip()}".strip()[:500],
        )
    except Exception as exc:  # noqa: BLE001 -- a probe reports, it never raises
        return TableCheck(ok=False, error=f"{type(exc).__name__}: {exc}".strip()[:500])


def discover_tables(
    container: str,
    user: str,
    db: str,
    password: str,
    schemas: list[str],
    source: str,
    timeout_s: int = 20,
) -> list:
    """Every table in `schemas`, as inventory objects.

    Without this nothing ever creates an object of kind 'table', so no table
    could be bound and the table half of the health rules would be unreachable
    rather than merely unused.

    Discovery is deliberately cheap: names only, no counts. Counting fifty
    tables every five minutes to fill a dropdown would put a real read load on a
    production database for nothing; the count arrives with the freshness check,
    and only for the tables somebody actually bound.
    """
    from .probe_airflow import Discovered

    for name in schemas:
        # _validate_identifier returns None when the name is FINE and a message
        # when it is not. Reading that backwards cost a debugging round.
        if _validate_identifier(name) is not None:
            return []
    wanted = ", ".join("'" + s + "'" for s in schemas)
    sql = (
        "SELECT schemaname || '.' || tablename FROM pg_tables "
        f"WHERE schemaname IN ({wanted}) ORDER BY 1"
    )
    try:
        out = subprocess.run(
            [
                "docker", "exec", "-e", f"PGPASSWORD={password}", container,
                "psql", "-U", user, "-d", db, "-tAq", "-c", sql,
            ],
            capture_output=True, text=True, timeout=timeout_s, check=True,
        ).stdout
    except Exception:  # noqa: BLE001 -- a probe reports, it never raises
        return []
    found = []
    for line in out.splitlines():
        name = line.strip()
        if not name or "." not in name:
            continue
        schema, _, table = name.partition(".")
        found.append(
            Discovered(
                kind="table",
                source=source,
                external_id=name,
                display_name=name,
                attrs={"schema": schema, "table": table, "layer": schema},
            )
        )
    return found
