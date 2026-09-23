"""The cron probe: the crontab as inventory, heartbeats as runs."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops"))

from collector.probe_cron import discover_cron, read_heartbeats  # noqa: E402

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)

CRONTAB = """# a comment that must be ignored

0 * * * * /opt/jobs/staging/sync_job_a.sh >> /tmp/a.log 2>&1
0 1 * * * /opt/lineos/ops/run-job.sh job_c -- /opt/jobs/job_c/run_job_c.sh
*/5 * * * * /opt/lineos/ops/collector/run.py
"""


def test_discover_names_a_wrapped_job_by_its_job_id():
    found = {d.external_id: d for d in discover_cron(CRONTAB)}
    assert "job_c" in found
    assert found["job_c"].attrs["schedule"] == "0 1 * * *"
    assert found["job_c"].kind == "cron_job"


def test_discover_still_lists_an_unwrapped_job():
    """A job nobody instrumented must still appear, so it can be seen as
    unwatched rather than silently missing."""
    found = {d.external_id: d for d in discover_cron(CRONTAB)}
    assert "sync_job_a.sh" in found
    assert found["sync_job_a.sh"].attrs["schedule"] == "0 * * * *"


def test_discover_leaves_out_the_collector_itself():
    """The collector observes the pipeline; as a node on the map it is noise, and
    its health is already on screen as the collection age."""
    wrapped = CRONTAB + (
        "*/5 * * * * /usr/bin/flock -n /tmp/f.lock /opt/lineos/ops/run-job.sh "
        "flow_collector -- /opt/lineos/venv/bin/python /opt/lineos/ops/collector/run.py\n"
    )
    ids = {d.external_id for d in discover_cron(wrapped)}
    assert "flow_collector" not in ids
    assert "job_c" in ids
    assert "flow_collector" in {d.external_id for d in discover_cron(wrapped, ignore=frozenset())}


def test_discover_ignores_comments_and_blank_lines():
    assert all(not d.external_id.startswith("#") for d in discover_cron(CRONTAB))


def test_heartbeats_become_runs(tmp_path):
    line = {
        "job": "job_c",
        "started_at": "2026-09-22T01:00:01Z",
        "ended_at": "2026-09-22T01:00:14Z",
        "exit_code": 0,
        "duration_ms": 13204,
        "facts": {"rows_synced": 2693},
    }
    (tmp_path / "job_c.jsonl").write_text(json.dumps(line) + "\n")
    got = read_heartbeats(str(tmp_path), since=NOW - timedelta(days=1))
    assert len(got) == 1
    r = got[0]
    assert r.external_id == "job_c"
    assert r.outcome == "success"
    assert r.exit_code == 0
    assert r.facts["rows_synced"] == 2693
    # The run_key must be stable, so re-reading the same line does not duplicate.
    assert r.run_key == "2026-09-22T01:00:01Z"


def test_a_nonzero_exit_is_failed_but_keeps_the_raw_code(tmp_path):
    """The multi-source job means 2 = source B failed. The probe must not flatten it."""
    line = {"job": "job_c", "started_at": "2026-09-22T01:00:01Z",
            "ended_at": "2026-09-22T01:00:14Z", "exit_code": 2, "duration_ms": 13204}
    (tmp_path / "job_c.jsonl").write_text(json.dumps(line) + "\n")
    r = read_heartbeats(str(tmp_path), since=NOW - timedelta(days=1))[0]
    assert r.outcome == "failed"
    assert r.exit_code == 2


def test_a_skipped_run_is_reported_as_skipped(tmp_path):
    """flock could not take the lock: neither success nor failure."""
    line = {"job": "job_c", "started_at": "2026-09-22T01:00:01Z",
            "ended_at": "2026-09-22T01:00:01Z", "exit_code": 0, "skipped": True}
    (tmp_path / "job_c.jsonl").write_text(json.dumps(line) + "\n")
    assert read_heartbeats(str(tmp_path), since=NOW - timedelta(days=1))[0].outcome == "skipped"


def test_a_corrupt_line_does_not_lose_the_good_ones(tmp_path):
    """A half-written line from a killed process must not blind the collector."""
    good = json.dumps({"job": "x", "started_at": "2026-09-22T01:00:01Z", "exit_code": 0})
    (tmp_path / "x.jsonl").write_text(good + "\n{ broken\n" + good.replace("01:00", "02:00") + "\n")
    assert len(read_heartbeats(str(tmp_path), since=NOW - timedelta(days=1))) == 2


def test_edges_from_heartbeats_with_writes(tmp_path):
    """Extract edges from facts.writes in heartbeats."""
    from collector.probe_cron import edges_from_heartbeats
    line = {
        "job": "job_c",
        "started_at": "2026-09-22T01:00:01Z",
        "ended_at": "2026-09-22T01:00:14Z",
        "exit_code": 0,
        "facts": {"writes": ["bronze.stg_table_", "bronze.stg_table_"]},
    }
    (tmp_path / "job_c.jsonl").write_text(json.dumps(line) + "\n")
    runs = read_heartbeats(str(tmp_path), since=NOW - timedelta(days=1))
    edges = edges_from_heartbeats(runs)
    assert len(edges) == 2
    assert edges[0].from_external_id == "job_c"
    assert edges[0].to_external_id == "bronze.stg_table_"
    assert edges[1].to_external_id == "bronze.stg_table_"
    assert all(e.declared_by == "heartbeat" for e in edges)


def test_edges_from_heartbeats_without_writes(tmp_path):
    """Heartbeats without writes produce no edges."""
    from collector.probe_cron import edges_from_heartbeats
    line = {
        "job": "some_job",
        "started_at": "2026-09-22T01:00:01Z",
        "ended_at": "2026-09-22T01:00:14Z",
        "exit_code": 0,
    }
    (tmp_path / "some_job.jsonl").write_text(json.dumps(line) + "\n")
    runs = read_heartbeats(str(tmp_path), since=NOW - timedelta(days=1))
    edges = edges_from_heartbeats(runs)
    assert len(edges) == 0


def test_discover_cron_collects_description_from_comment_lines():
    crontab = """# This is the first comment line
# This is the second comment line
0 2 * * * /opt/lineos/ops/run-job.sh test_job -- /path/to/script.sh

# This is a comment not directly above a job
# and this is another isolated comment
0 3 * * * /opt/lineos/ops/run-job.sh another_job -- /path/to/another.sh
"""
    found = {d.external_id: d for d in discover_cron(crontab)}
    test_job = found["test_job"]
    assert test_job.attrs["description"] == "This is the first comment line\nThis is the second comment line"
    assert "This is a comment not directly above a job" not in test_job.attrs.get("description", "")


def test_discover_cron_masks_secrets_in_command():
    crontab = """0 2 * * * /path/to/script.sh DB_PASSWORD=hunter2 API_TOKEN=abc COLLECTOR_DSN_FILE=/x >> /var/log/x.log 2>&1
"""
    found = {d.external_id: d for d in discover_cron(crontab)}
    script = found["script.sh"]
    command = script.attrs["command"]
    assert "DB_PASSWORD=***" in command
    assert "API_TOKEN=***" in command
    assert "COLLECTOR_DSN_FILE=***" in command
    assert "hunter2" not in command
    assert "abc" not in command


def test_discover_cron_extracts_script_and_log():
    crontab = """0 2 * * * /opt/lineos/ops/run-job.sh test_job -- /path/to/job_script.sh >> /var/log/x.log 2>&1
"""
    found = {d.external_id: d for d in discover_cron(crontab)}
    test_job = found["test_job"]
    assert test_job.attrs["script"] == "/path/to/job_script.sh"
    assert test_job.attrs["log"] == "/var/log/x.log"


def test_discover_cron_masks_secrets_in_description():
    crontab = """# This job has password: s3cret in the comment
0 2 * * * /path/to/script.sh
"""
    found = {d.external_id: d for d in discover_cron(crontab)}
    script = found["script.sh"]
    description = script.attrs.get("description", "")
    assert "password=***" in description
    assert "s3cret" not in description


CRON_D = """# Data Lineage jobs (system cron)
MAILTO=""
PATH=/usr/bin:/bin
# Mirror of table a
0 * * * * lineos /opt/lineos/ops/run-job.sh job_a -- /opt/jobs/staging/sync_job_a.sh >> /var/log/lineos/job_a.log 2>&1
*/5 * * * * lineos /usr/bin/flock -n /var/log/lineos/collector.lock /opt/lineos/ops/run-job.sh flow_collector -- /opt/lineos/venv/bin/python /opt/lineos/ops/collector/run.py
"""


def test_cron_d_lines_carry_a_user_field():
    found = {d.external_id: d for d in discover_cron(CRON_D, system=True)}
    assert set(found) == {"job_a"}  # the collector is ignored, env lines skipped
    job = found["job_a"]
    assert job.attrs["schedule"] == "0 * * * *"
    assert job.attrs["user"] == "lineos"
    assert job.attrs["wrapped"] is True
    assert job.attrs["script"] == "/opt/jobs/staging/sync_job_a.sh"
    assert job.attrs["description"] == "Mirror of table a"


def test_the_same_job_keeps_its_identity_when_it_moves_to_cron_d():
    personal = "0 * * * * /x/run-job.sh job_a -- /x/sync_job_a.sh\n"
    a = discover_cron(personal, source="host:local")[0]
    b = [d for d in discover_cron(CRON_D, source="host:local", system=True)][0]
    assert (a.kind, a.source, a.external_id) == (b.kind, b.source, b.external_id)


def test_a_personal_crontab_is_not_read_as_cron_d():
    # In a personal crontab the 6th field is the command, not a user.
    job = discover_cron(CRONTAB)
    assert all("user" not in d.attrs for d in job)


def test_heartbeats_from_several_directories(tmp_path):
    import json as _json
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    line = lambda job, t: _json.dumps({"job": job, "started_at": t, "ended_at": t, "exit_code": 0,
                                       "duration_ms": 1, "facts": {}})
    (a / "job_b.jsonl").write_text(line("job_b", "2026-09-22T11:00:00Z") + "\n")
    (b / "job_a.jsonl").write_text(line("job_a", "2026-09-22T11:30:00Z") + "\n")
    since = NOW - timedelta(days=1)
    runs = read_heartbeats(str(a), since) + read_heartbeats(str(b), since) + read_heartbeats(str(tmp_path / "missing"), since)
    assert sorted(r.external_id for r in runs) == ["job_a", "job_b"]
