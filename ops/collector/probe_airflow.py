"""Reading Airflow's state without touching Airflow.

This instance is `standalone` with SQLite metadata and a SequentialExecutor --
one task at a time. A DAG that collected state would occupy the queue the real
DAGs need, and a collector living inside Airflow cannot report that Airflow is
down. So the probe reads the metadata database read-only from outside.

Not the REST API: it answers 401 under /airflow/api/v1/ because `auth_backends`
is `airflow.api.auth.backend.session` alone, and adding basic_auth means
changing the configuration of a stack this project does not own.

`mode=ro` and NOT `immutable=1`: the immutable flag tells SQLite the file never
changes, which is false for a live database and can hand back torn pages. The
journal mode there is `delete`, not WAL, so plain read-only is enough.
"""
import json
import shlex
import sqlite3
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .mask import mask_text

# Airflow's dag_run.state, mapped onto the module's vocabulary. `skipped` is
# absent on purpose: a DAG run is never skipped the way a flock'd cron job is.
_STATE = {
    "success": "success",
    "failed": "failed",
    "running": "running",
    "queued": "running",
    "up_for_retry": "running",
}


@dataclass
class Discovered:
    kind: str
    source: str
    external_id: str
    display_name: str
    attrs: dict = field(default_factory=dict)


@dataclass
class DiscoveredRun:
    external_id: str
    run_key: str
    started_at: datetime
    ended_at: datetime | None
    outcome: str
    exit_code: int | None = None
    facts: dict = field(default_factory=dict)


@dataclass
class DiscoveredEdge:
    from_external_id: str
    to_external_id: str
    declared_by: str


def _query(db_path: str, container: str | None, sql: str) -> list[list]:
    """Rows as lists. Inside a container when `container` is set, locally when
    it is not -- which is what makes the probe testable against a fixture."""
    uri = f"file:{db_path}?mode=ro"
    if container is None:
        con = sqlite3.connect(uri, uri=True)
        try:
            return [list(r) for r in con.execute(sql).fetchall()]
        finally:
            con.close()
    # -json keeps values typed and quoted properly; parsing pipe-separated
    # output would break on any text column holding a pipe.
    out = subprocess.run(
        ["docker", "exec", container, "sqlite3", "-json", uri, sql],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout.strip()
    if not out:
        return []
    return [list(row.values()) for row in json.loads(out)]


def _parse_ts(value) -> datetime | None:
    """Airflow writes 'YYYY-MM-DD HH:MM:SS.ffffff' in UTC, with no offset."""
    if not value:
        return None
    text = str(value).replace("T", " ").split("+")[0].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _clean_schedule(raw) -> str | None:
    """Airflow stores the expression JSON-encoded: '"0 2 * * *"', and the
    literal string 'null' for a DAG with no schedule. Neither may reach the
    health rules as written -- 'null' would look like a cadence."""
    if raw is None:
        return None
    text = str(raw).strip()
    if text in ("", "null", "None"):
        return None
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]
    return text or None


_DOC_CAP = 4000
_MAX_TASKS = 100
_MAX_IO = 50


def _unwrap(value):
    """Airflow's serialisation wraps values as {"__var": ..., "__type": ...}."""
    while isinstance(value, dict) and "__var" in value:
        value = value["__var"]
    return value


def _cap(text):
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= _DOC_CAP else text[:_DOC_CAP] + "…"


def _io_names(items):
    out = []
    for item in (items or [])[:_MAX_IO]:
        item = _unwrap(item)
        uri = item.get("uri") if isinstance(item, dict) else None
        name = _extract_table_from_uri(uri) if uri else None
        out.append(name or uri or str(item))
    return out


def dag_details(db_path: str, container: str | None) -> dict:
    """dag_id -> description, doc, owner, tags, file, tasks. Never raises."""
    out = {}
    try:
        rows = _query(db_path, container, "SELECT dag_id, data FROM serialized_dag")
    except Exception:
        return out
    for dag_id, data in rows:
        try:
            dag = json.loads(data).get("dag") or {}
            args = _unwrap(dag.get("default_args")) or {}
            tasks = []
            for raw in (dag.get("tasks") or [])[:_MAX_TASKS]:
                t = _unwrap(raw) or {}
                tasks.append({
                    "task_id": t.get("task_id"),
                    "operator": t.get("_task_type") or t.get("_operator_name"),
                    "inlets": _io_names(t.get("inlets")),
                    "outlets": _io_names(t.get("outlets")),
                    "downstream": list(t.get("downstream_task_ids") or []),
                })
            out[dag_id] = {
                "description": _cap(mask_text(dag.get("_description"))),
                "doc": _cap(mask_text(dag.get("doc_md"))),
                "owner": args.get("owner") if isinstance(args, dict) else None,
                "tags": list(dag.get("tags") or []),
                "file": dag.get("fileloc"),
                "tasks": tasks,
            }
        except Exception:
            continue  # one malformed DAG must not hide the others' details
    return out


def discover(db_path: str, container: str | None, source: str = "airflow-standalone"):
    rows = _query(
        db_path,
        container,
        "SELECT dag_id, is_paused, schedule_interval, timetable_description FROM dag",
    )
    details = dag_details(db_path, container)
    found = []
    for dag_id, is_paused, schedule, description in rows:
        found.append(
            Discovered(
                kind="airflow_dag",
                source=source,
                external_id=dag_id,
                display_name=dag_id,
                attrs={
                    "schedule": _clean_schedule(schedule),
                    "is_paused": bool(is_paused),
                    "timetable": description,
                    **details.get(dag_id, {}),
                },
            )
        )
    return found


def runs(db_path: str, container: str | None, since: datetime):
    """Runs started on or after `since`.

    The window overlaps the previous collection on purpose: a run that was
    still `running` last cycle has to be re-reported so its end time lands.
    The sink is idempotent by (object_id, run_key), so re-reporting is free.
    """
    cutoff = since.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    sql = (
        "SELECT dag_id, run_id, state, start_date, end_date FROM dag_run "
        f"WHERE start_date >= {shlex.quote(cutoff)} ORDER BY start_date"
    )
    out = []
    for dag_id, run_id, state, start, end in _query(db_path, container, sql):
        started = _parse_ts(start)
        if started is None:
            continue
        out.append(
            DiscoveredRun(
                external_id=dag_id,
                run_key=run_id,
                started_at=started,
                ended_at=_parse_ts(end),
                outcome=_STATE.get(state, "unknown"),
            )
        )
    return out


def _extract_table_from_uri(uri: str) -> str | None:
    """Extract schema.table from a Postgres URI.

    Expected form: postgres://host:port/db/schema/table
    Takes the last two path segments and joins with a dot.
    Returns None if URI does not have at least two path segments.
    """
    if not uri:
        return None
    parts = uri.split("/")
    if len(parts) < 2:
        return None
    # Last two parts are schema and table
    table = parts[-1]
    schema = parts[-2]
    if not schema or not table:
        return None
    return f"{schema}.{table}"


def edges(db_path: str, container: str | None) -> list[DiscoveredEdge]:
    """Extract edges from Airflow's dataset references.

    Reads task_outlet_dataset_reference (DAG produces dataset),
    dag_schedule_dataset_reference (DAG triggered by dataset),
    and dataset (URI to schema.table), then creates edges between
    DAGs and tables via the dataset.
    """
    out = []

    # Get all datasets: id -> uri
    dataset_rows = _query(
        db_path,
        container,
        "SELECT id, uri FROM dataset",
    )
    dataset_uris = {row[0]: row[1] for row in dataset_rows}

    # Extract table names from URIs
    dataset_tables = {}
    for dataset_id, uri in dataset_uris.items():
        table_name = _extract_table_from_uri(uri)
        if table_name:
            dataset_tables[dataset_id] = table_name

    # DAG outlets: dag -> dataset -> table
    outlet_rows = _query(
        db_path,
        container,
        "SELECT dag_id, dataset_id FROM task_outlet_dataset_reference",
    )
    for dag_id, dataset_id in outlet_rows:
        table_name = dataset_tables.get(dataset_id)
        if table_name:
            out.append(
                DiscoveredEdge(
                    from_external_id=dag_id,
                    to_external_id=table_name,
                    declared_by="airflow_dataset",
                )
            )

    # DAG triggers: table -> dataset -> dag
    schedule_rows = _query(
        db_path,
        container,
        "SELECT dag_id, dataset_id FROM dag_schedule_dataset_reference",
    )
    for dag_id, dataset_id in schedule_rows:
        table_name = dataset_tables.get(dataset_id)
        if table_name:
            out.append(
                DiscoveredEdge(
                    from_external_id=table_name,
                    to_external_id=dag_id,
                    declared_by="airflow_dataset",
                )
            )

    return out


def edges_from_inlets_outlets(db_path: str, container: str | None) -> list[DiscoveredEdge]:
    """Extract edges from task inlets and outlets declared in serialized_dag.

    Reads the serialized_dag table, parses the JSON data, and extracts inlet/outlet
    declarations from each task. Creates edges between DAGs and tables via the
    dataset URIs found in those declarations.

    Ignores non-dataset items and malformed URIs; returns empty list if table
    is empty or unparseable.
    """
    rows = _query(
        db_path,
        container,
        "SELECT dag_id, data FROM serialized_dag",
    )
    out = []

    for dag_id, data_str in rows:
        if not data_str:
            continue
        try:
            data = json.loads(data_str)
        except (json.JSONDecodeError, ValueError):
            continue

        dag_data = data.get("dag")
        if not dag_data:
            continue

        tasks = dag_data.get("tasks", [])
        for task in tasks:
            # Unwrap task from __var if needed
            if isinstance(task, dict) and "__var" in task:
                task = task.get("__var")

            if not isinstance(task, dict):
                continue

            task_id = task.get("task_id")
            if not task_id:
                continue

            # Process outlets: DAG -> table
            outlets = task.get("outlets", [])
            for outlet in outlets:
                if not isinstance(outlet, dict):
                    continue
                if outlet.get("__type") != "dataset":
                    continue

                outlet_var = outlet.get("__var")
                if not isinstance(outlet_var, dict):
                    continue

                uri = outlet_var.get("uri")
                table_name = _extract_table_from_uri(uri)
                if table_name:
                    out.append(
                        DiscoveredEdge(
                            from_external_id=dag_id,
                            to_external_id=table_name,
                            declared_by="airflow_dataset",
                        )
                    )

            # Process inlets: table -> DAG
            inlets = task.get("inlets", [])
            for inlet in inlets:
                if not isinstance(inlet, dict):
                    continue
                if inlet.get("__type") != "dataset":
                    continue

                inlet_var = inlet.get("__var")
                if not isinstance(inlet_var, dict):
                    continue

                uri = inlet_var.get("uri")
                table_name = _extract_table_from_uri(uri)
                if table_name:
                    out.append(
                        DiscoveredEdge(
                            from_external_id=table_name,
                            to_external_id=dag_id,
                            declared_by="airflow_dataset",
                        )
                    )

    return out
