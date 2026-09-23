"""Writing telemetry, idempotently.

The collector re-reads an overlapping window every cycle, so every write here
is an upsert keyed on something stable. A cycle the collector misses recovers
on the next one with no special handling -- which is the whole reason the
unique constraints exist.

An object that disappears from its source is NEVER deleted: last_seen_at
simply stops advancing, and the health rules turn that into "missing from its
source", which is information. Deleting would also be refused by the RESTRICT
on pipeline_bindings, and rightly so.
"""
from datetime import datetime, timedelta, timezone

from psycopg2.extras import Json, execute_values

# 30 days: the History tab shows 30, and nothing reads further back.
RETENTION_DAYS = 30


def upsert_objects(conn, items) -> dict[tuple, int]:
    """Writes the inventory and returns {(kind, source, external_id): id}."""
    if not items:
        return {}
    rows = [
        (i.kind, i.source, i.external_id, i.display_name, Json(i.attrs or {}))
        for i in items
    ]
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO inventory_objects
              (kind, source, external_id, display_name, attrs, first_seen_at, last_seen_at)
            VALUES %s
            ON CONFLICT (kind, source, external_id) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              attrs        = EXCLUDED.attrs,
              last_seen_at = now()
            RETURNING id, kind, source, external_id
            """,
            rows,
            template="(%s, %s, %s, %s, %s, now(), now())",
        )
        found = {(k, s, e): i for i, k, s, e in cur.fetchall()}
    conn.commit()
    return found


def upsert_runs(conn, id_by_key: dict, runs) -> int:
    """Writes runs, skipping any whose object was never discovered.

    A run for an unknown object is dropped rather than raising: the probes run
    independently, and one of them being ahead of the other must not abort a
    cycle.
    """
    by_external = {k[2]: v for k, v in id_by_key.items()}
    rows = []
    for r in runs:
        object_id = by_external.get(r.external_id)
        if object_id is None:
            continue
        rows.append(
            (
                object_id,
                r.run_key,
                r.started_at,
                r.ended_at,
                r.outcome,
                r.exit_code,
                int((r.ended_at - r.started_at).total_seconds() * 1000)
                if r.ended_at
                else None,
                Json(r.facts or {}),
            )
        )
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO object_runs
              (object_id, run_key, started_at, ended_at, outcome, exit_code,
               duration_ms, facts, collected_at)
            VALUES %s
            ON CONFLICT (object_id, run_key) DO UPDATE SET
              ended_at     = EXCLUDED.ended_at,
              outcome      = EXCLUDED.outcome,
              exit_code    = EXCLUDED.exit_code,
              duration_ms  = EXCLUDED.duration_ms,
              facts        = EXCLUDED.facts,
              collected_at = now()
            """,
            rows,
            template="(%s, %s, %s, %s, %s, %s, %s, %s, now())",
        )
    conn.commit()
    return len(rows)


def insert_check(conn, object_id: int, check) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO object_checks (object_id, checked_at, row_count, max_ts, ok, error)
            VALUES (%s, now(), %s, %s, %s, %s)
            """,
            (object_id, check.row_count, check.max_ts, check.ok, check.error),
        )
    conn.commit()


def upsert_edges(conn, id_by_key: dict, edges) -> int:
    """Writes edges, skipping any whose objects were never discovered.

    An edge for an unknown object is dropped rather than raising: the probes run
    independently, and one of them being ahead of the other must not abort a
    cycle.
    """
    by_external = {k[2]: v for k, v in id_by_key.items()}
    # Deduplicated inside the batch, not just by the UNIQUE constraint. The same
    # edge is declared more than once legitimately -- a DAG whose two tasks both
    # read silver.table_a produces it twice -- and Postgres refuses an
    # ON CONFLICT DO UPDATE that would touch the same row twice in one
    # statement ("cannot affect row a second time"), which aborts the whole
    # batch and costs every other edge in it.
    seen = set()
    rows = []
    for e in edges:
        from_id = by_external.get(e.from_external_id)
        to_id = by_external.get(e.to_external_id)
        if from_id is None or to_id is None:
            continue
        key = (from_id, to_id, e.declared_by)
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            (
                from_id,
                to_id,
                e.declared_by,
            )
        )
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO object_edges
              (from_object_id, to_object_id, declared_by, first_seen_at, last_seen_at)
            VALUES %s
            ON CONFLICT (from_object_id, to_object_id, declared_by) DO UPDATE SET
              last_seen_at = now()
            """,
            rows,
            template="(%s, %s, %s, now(), now())",
        )
    conn.commit()
    return len(rows)


def prune(conn, days: int = RETENTION_DAYS) -> int:
    """Telemetry older than `days` goes.

    Telemetry against a 256 MB Postgres fills it in months if nothing prunes it. One line here now; a night of work if it is left until the disk is
    full.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    removed = 0
    with conn.cursor() as cur:
        cur.execute("DELETE FROM object_runs WHERE started_at < %s", (cutoff,))
        removed += cur.rowcount or 0
        cur.execute("DELETE FROM object_checks WHERE checked_at < %s", (cutoff,))
        removed += cur.rowcount or 0
    conn.commit()
    return removed
