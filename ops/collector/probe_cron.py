"""Cron jobs: the crontab is the inventory, the heartbeat directory the runs.

A job nobody wrapped still appears in the inventory, named by its script's
basename, so it shows up as unwatched rather than vanishing. It just has no
runs until somebody points its crontab line at run-job.sh.
"""
import json
import os
from datetime import datetime, timezone

from .probe_airflow import Discovered, DiscoveredRun, DiscoveredEdge
from .mask import mask_text, mask_command

WRAPPER = "run-job.sh"
# Jobs kept out of the inventory. The collector observes the pipeline rather
# than being part of it, and its own health is already on screen as the age of
# the last collection -- as a node it only added an unconnected card.
IGNORED_JOBS = frozenset({"flow_collector"})


def _parse_ts(text) -> datetime | None:
    if not text:
        return None
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _script_name(command: list) -> str:
    """The job's own script, ignoring the wrapper and the shell redirect."""
    tokens = [t for t in command if not t.startswith((">", "<", "2>", "&>"))]
    if "--" in tokens:
        after = tokens[tokens.index("--") + 1 :]
        if after:
            return os.path.basename(after[0])
    return os.path.basename(tokens[0]) if tokens else "job"


def discover_cron(crontab_text: str, source: str = "host:local", ignore=IGNORED_JOBS,
                  system: bool = False):
    """One Discovered per schedule line.

    `system=True` reads the /etc/cron.d format, where a user field sits between
    the five schedule fields and the command.

    A wrapped line is named by the job id it passes to run-job.sh; an unwrapped
    one by the basename of the command, which is the best identity available
    without touching the line.
    """
    found = []
    comments = []  # buffer for description comments
    for raw in (crontab_text or "").splitlines():
        line = raw.strip()

        # Handle comment lines
        if line.startswith("#"):
            # Strip leading # and up to one space, add to buffer
            comment_text = line[1:]
            if comment_text.startswith(" "):
                comment_text = comment_text[1:]
            comments.append(comment_text)
            continue

        # Handle blank lines - clear comment buffer
        if not line:
            comments = []
            continue

        # Handle job lines
        parts = line.split()
        if "=" in parts[0] and len(parts) == 1:
            comments = []  # an environment line (MAILTO=, PATH=) separates blocks
            continue
        if len(parts) < (7 if system else 6) or "=" in parts[0]:
            continue  # too short, or an environment line

        schedule = " ".join(parts[:5])
        run_as = parts[5] if system else None
        command = parts[6:] if system else parts[5:]

        job_id = None
        for i, token in enumerate(command):
            if token.endswith(WRAPPER) and i + 1 < len(command):
                job_id = command[i + 1]
                break
        if job_id is None:
            job_id = os.path.basename(command[0])
        if job_id in ignore:
            comments = []
            continue

        # Build base attrs
        attrs = {"schedule": schedule, "wrapped": job_id != os.path.basename(command[0])}
        if run_as:
            attrs["user"] = run_as

        # Add description, script, log, command with error handling
        try:
            # Description: joined comments, masked, capped
            if comments:
                desc = "\n".join(comments)
                attrs["description"] = _cap_text(mask_text(desc))

            # Script: full path after --, or command[0]
            script_path = None
            if "--" in command:
                idx = command.index("--")
                if idx + 1 < len(command):
                    script_path = command[idx + 1]
            if script_path is None:
                script_path = command[0]
            attrs["script"] = script_path

            # Log: token after last >> or >
            log_file = None
            for i in range(len(command) - 1, -1, -1):
                if command[i] in (">>", ">"):
                    if i + 1 < len(command):
                        log_file = command[i + 1]
                    break
            if log_file is not None:
                attrs["log"] = log_file

            # Command: masked version of the full command line
            attrs["command"] = mask_command(" ".join(command))
        except Exception:
            # One parsing failure must not hide the job entirely
            pass

        found.append(
            Discovered(
                kind="cron_job",
                source=source,
                external_id=job_id,
                display_name=_script_name(command),
                attrs=attrs,
            )
        )
        comments = []  # Clear buffer after processing a job line

    return found


def _cap_text(text):
    """Cap description at 4000 characters, add ellipsis if capped."""
    if text is None:
        return None
    if len(text) <= 4000:
        return text
    return text[:4000] + "…"


def read_heartbeats(directory: str, since: datetime):
    """Every heartbeat line at or after `since`.

    A malformed line is skipped, never fatal: a process killed mid-write leaves
    half a line, and losing the whole file to it would blind the collector
    exactly when something went wrong.
    """
    out = []
    if not os.path.isdir(directory):
        return out
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(directory, name)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            started = _parse_ts(row.get("started_at"))
            if started is None or started < since:
                continue
            code = row.get("exit_code")
            if row.get("skipped"):
                outcome = "skipped"
            elif code is None:
                outcome = "unknown"
            elif int(code) == 0:
                outcome = "success"
            else:
                outcome = "failed"
            out.append(
                DiscoveredRun(
                    external_id=row.get("job") or name[:-6],
                    # The start stamp as written: stable, so re-reading the same
                    # line upserts instead of inserting a second run.
                    run_key=str(row.get("started_at")),
                    started_at=started,
                    ended_at=_parse_ts(row.get("ended_at")),
                    outcome=outcome,
                    exit_code=None if code is None else int(code),
                    facts=row.get("facts") or {},
                )
            )
    return out


def edges_from_heartbeats(runs: list[DiscoveredRun]) -> list[DiscoveredEdge]:
    """Extract edges from heartbeat facts.writes.

    Each `facts.writes` entry is a table name (schema.table), and we create
    an edge from the job to that table.
    """
    out = []
    for run in runs:
        writes = run.facts.get("writes") or []
        for table_name in writes:
            out.append(
                DiscoveredEdge(
                    from_external_id=run.external_id,
                    to_external_id=table_name,
                    declared_by="heartbeat",
                )
            )
    return out
