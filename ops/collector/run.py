#!/usr/bin/env python3
"""One collection cycle.

Run from cron every five minutes, under flock so a slow cycle never stacks.

Three properties this file exists to guarantee:

1. **One probe failing never stops the others.** Airflow being down must not
   cost the table readings.
2. **A failed probe never erases the last known state.** Nothing here deletes
   telemetry; `last_seen_at` simply stops advancing, and the panel reports the
   collection age instead of a false green.
3. **The collector cannot write human configuration.** Enforced by the
   flow_collector role's grants, not by this file's good behaviour.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from collector import sink  # noqa: E402
from collector.probe_airflow import discover as discover_dags  # noqa: E402
from collector.probe_airflow import edges as airflow_edges  # noqa: E402
from collector.probe_airflow import edges_from_inlets_outlets  # noqa: E402
from collector.probe_airflow import runs as dag_runs  # noqa: E402
from collector.probe_cron import discover_cron, read_heartbeats, edges_from_heartbeats  # noqa: E402
from collector.probe_table import check_table, discover_tables  # noqa: E402
from collector.schedule import CHECK_HOUR_UTC, table_checks_due  # noqa: E402


def _parse_dsn_config(config):
    """Parse a DSN config which can be a string or a container dict.

    Returns a tuple of (dsn, container_kwargs) where container_kwargs is
    a dict or None.
    """
    if isinstance(config, str):
        return config, None
    if isinstance(config, dict):
        password_file = config.get("password_file")
        if password_file:
            with open(password_file, encoding="utf-8") as f:
                password = f.read().strip()
        else:
            password = config.get("password", "")
        return "", {
            "container": config.get("container", ""),
            "user": config.get("user", ""),
            "db": config.get("db", ""),
            "password": password,
        }
    return "", None

# The window overlaps several cycles deliberately: a run still `running` last
# time has to be re-reported so its end time lands, and the sink is idempotent.
WINDOW = timedelta(hours=36)

AIRFLOW_DB = os.environ.get("COLLECTOR_AIRFLOW_DB", "/opt/airflow/airflow.db")
AIRFLOW_CONTAINER = os.environ.get("COLLECTOR_AIRFLOW_CONTAINER", "airflow-standalone")
HEARTBEAT_DIR = os.environ.get("JOB_HEARTBEAT_DIR", os.path.expanduser("~/.job-heartbeat"))
# Several heartbeat directories, colon-separated, while jobs move from a
# personal crontab to /etc/cron.d (each writes where its run-job.sh points).
HEARTBEAT_DIRS = [d for d in os.environ.get("JOB_HEARTBEAT_DIRS", HEARTBEAT_DIR).split(":") if d]
# Where the cron jobs are declared, colon-separated: "crontab" is the running
# user's own crontab; any path is a file in /etc/cron.d format (with a user
# field). The inventory source name stays the same across both, so a job that
# moves keeps its identity -- and its bindings on the map.
CRON_SOURCES = [c for c in os.environ.get("COLLECTOR_CRON_SOURCES", "crontab").split(":") if c]
CRON_SOURCE_NAME = os.environ.get("COLLECTOR_CRON_SOURCE_NAME", "host:local")
OPS_DSN = os.environ.get("COLLECTOR_DSN") or open(
    os.environ["COLLECTOR_DSN_FILE"], encoding="utf-8"
).read().strip() if "COLLECTOR_DSN_FILE" in os.environ else os.environ["COLLECTOR_DSN"]


_TARGETS_FILE_ERROR = None

def _load_target_dsns() -> dict:
    """Load target DSNs from file or environment, with precedence for file.

    Precedence: COLLECTOR_TARGETS_FILE (if exists) > COLLECTOR_TARGET_DSNS > {}
    Returns empty dict if file is specified but invalid; error is stored in
    _TARGETS_FILE_ERROR for logging in main().
    """
    global _TARGETS_FILE_ERROR
    targets_file = os.environ.get("COLLECTOR_TARGETS_FILE")
    if targets_file:
        try:
            with open(targets_file, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            _TARGETS_FILE_ERROR = f"COLLECTOR_TARGETS_FILE not found: {targets_file}"
            return {}
        except json.JSONDecodeError as exc:
            _TARGETS_FILE_ERROR = f"COLLECTOR_TARGETS_FILE is not valid JSON: {targets_file}: {exc}"
            return {}
    return json.loads(os.environ.get("COLLECTOR_TARGET_DSNS", "{}"))


# {"warehouse": "postgresql://..."} -- which DSN a bound table is read
# through, keyed by the inventory object's `source`.
TARGET_DSNS = _load_target_dsns()


def _log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}] {message}", flush=True)


def _crontab_text() -> str:
    try:
        return subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True, timeout=15
        ).stdout
    except Exception as exc:  # noqa: BLE001
        _log(f"cron probe: crontab unreadable ({exc})")
        return ""


class _NotDue(Exception):
    """Table checks already ran in today's slot."""


def main() -> int:
    since = datetime.now(timezone.utc) - WINDOW
    conn = psycopg2.connect(OPS_DSN)
    failures = 0
    ids: dict = {}

    if _TARGETS_FILE_ERROR:
        _log(_TARGETS_FILE_ERROR)

    # ── inventory ────────────────────────────────────────────────────
    discovered = []
    try:
        discovered += discover_dags(AIRFLOW_DB, AIRFLOW_CONTAINER)
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        failures += 1
        _log(f"airflow probe (discover) failed: {exc}")
    try:
        for cron_source in CRON_SOURCES:
            if cron_source == "crontab":
                discovered += discover_cron(_crontab_text(), source=CRON_SOURCE_NAME)
            else:
                try:
                    with open(cron_source) as fh:
                        discovered += discover_cron(fh.read(), source=CRON_SOURCE_NAME, system=True)
                except OSError as exc:
                    _log(f"cron probe: {cron_source} unreadable ({exc})")
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        failures += 1
        _log(f"cron probe (discover) failed: {exc}")
    # Tables of every configured target. Without this nothing ever creates an
    # object of kind 'table', so no table could be bound and the table half of
    # the health rules would be unreachable.
    for source, config in TARGET_DSNS.items():
        try:
            _dsn, kw = _parse_dsn_config(config)
            if not kw:
                _log(f"table discovery: {source!r} is not a container target, skipped")
                continue
            schemas = config.get("schemas") or ["public"]
            found = discover_tables(
                kw["container"], kw["user"], kw["db"], kw["password"], schemas, source
            )
            discovered += found
            _log(f"table discovery: {len(found)} in {source}")
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            failures += 1
            _log(f"table discovery for {source!r} failed: {exc}")
    if discovered:
        ids = sink.upsert_objects(conn, discovered)
        _log(f"inventory: {len(discovered)} objects")

    # ── runs ─────────────────────────────────────────────────────────
    collected_heartbeats = []
    for name, probe in (
        ("airflow", lambda: dag_runs(AIRFLOW_DB, AIRFLOW_CONTAINER, since)),
        ("cron", lambda: [run for d in HEARTBEAT_DIRS for run in read_heartbeats(d, since)]),
    ):
        try:
            runs = probe()
            if name == "cron":
                collected_heartbeats = runs
            written = sink.upsert_runs(conn, ids, runs)
            _log(f"{name} runs: {written}")
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            failures += 1
            _log(f"{name} probe (runs) failed: {exc}")

    # ── edges ────────────────────────────────────────────────────────
    for name, probe in (
        ("airflow", lambda: airflow_edges(AIRFLOW_DB, AIRFLOW_CONTAINER)),
        ("airflow_inlets_outlets", lambda: edges_from_inlets_outlets(AIRFLOW_DB, AIRFLOW_CONTAINER)),
        ("cron", lambda: edges_from_heartbeats(collected_heartbeats)),
    ):
        try:
            edge_list = probe()
            written = sink.upsert_edges(conn, ids, edge_list)
            _log(f"{name} edges: {written}")
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            failures += 1
            _log(f"{name} probe (edges) failed: {exc}")

    # ── table checks, for bound tables only, once a day ─────────────
    # See collector/schedule.py. FORCE_TABLE_CHECKS=1 runs them now (a manual run).
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT max(checked_at) FROM object_checks")
            last_checked = cur.fetchone()[0]
        due = os.environ.get("FORCE_TABLE_CHECKS") == "1" or table_checks_due(
            datetime.now(timezone.utc), last_checked)
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        due = True  # cannot tell: checking again is the safe side
        _log(f"table check schedule unreadable, checking anyway: {exc}")
    if not due:
        _log(f"table checks: not due (daily at {CHECK_HOUR_UTC:02d}:00 UTC)")
    try:
        if not due:
            raise _NotDue
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT o.id, o.source, o.external_id, b.rules
                FROM inventory_objects o
                JOIN pipeline_bindings b ON b.object_id = o.id
                WHERE o.kind = 'table'
                """
            )
            bound_tables = cur.fetchall()
        for object_id, source, external_id, rules in bound_tables:
            config = TARGET_DSNS.get(source)
            if not config:
                _log(f"table probe: no DSN configured for source {source!r}")
                continue
            dsn, container_kwargs = _parse_dsn_config(config)
            schema, _, table = external_id.partition(".")
            if container_kwargs:
                check = check_table(
                    dsn,
                    schema,
                    table,
                    (rules or {}).get("freshness_column"),
                    container=container_kwargs.get("container"),
                    user=container_kwargs.get("user"),
                    db=container_kwargs.get("db"),
                    password=container_kwargs.get("password"),
                )
            else:
                check = check_table(
                    dsn, schema, table, (rules or {}).get("freshness_column")
                )
            sink.insert_check(conn, object_id, check)
        _log(f"table checks: {len(bound_tables)}")
    except _NotDue:
        pass
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        failures += 1
        _log(f"table probe failed: {exc}")

    try:
        _log(f"pruned {sink.prune(conn)} rows past retention")
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        failures += 1
        _log(f"prune failed: {exc}")

    conn.close()
    # Non-zero when a probe failed, so the collector's OWN heartbeat records it
    # when it is itself wrapped in run-job.sh.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
