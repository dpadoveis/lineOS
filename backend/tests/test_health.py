"""The health rules, as an explicit case table.

Every case here is a real trap from the platform this module watches, written
down so a refactor cannot quietly re-introduce it.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.health import CheckFacts, Health, RunFacts, evaluate, expected_window, worst

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
DAILY = {"schedule": "0 2 * * *"}


def run(outcome, minutes_ago=30, exit_code=None, facts=None):
    started = NOW - timedelta(minutes=minutes_ago)
    return RunFacts(
        outcome=outcome,
        started_at=started,
        ended_at=started + timedelta(seconds=40) if outcome != "running" else None,
        exit_code=exit_code,
        facts=facts or {},
    )


# ── the basics ───────────────────────────────────────────────────────


def test_a_recent_success_is_ok():
    h = evaluate("airflow_dag", DAILY, {}, run("success"), None, NOW, NOW)
    assert h.state == "ok"


def test_a_failure_is_broken():
    h = evaluate("airflow_dag", DAILY, {}, run("failed"), None, NOW, NOW)
    assert h.state == "broken"


def test_never_collected_is_no_data_not_ok():
    """An empty history must never read as healthy."""
    h = evaluate("airflow_dag", DAILY, {}, None, None, NOW, NOW)
    assert h.state == "no_data"


# ── the traps ────────────────────────────────────────────────────────


def test_a_skipped_run_is_not_broken():
    """flock skipping the bronze mirror is neither success nor failure."""
    h = evaluate("cron_job", DAILY, {}, run("skipped"), None, NOW, NOW)
    assert h.state == "skipped"
    assert h.state != "broken"


def test_the_exit_code_map_names_which_source_failed():
    """A multi-source job means 1=source A failed, 2=source B failed, 3=both. Flattening that to
    'failed' erases what its wrapper produced."""
    rules = {"exit_code_map": {"1": "source A failed", "2": "source B failed",
                               "3": "both halves failed"}}
    h = evaluate("cron_job", DAILY, rules, run("failed", exit_code=2), None, NOW, NOW)
    assert h.state == "broken"
    assert h.reason == "source B failed"


def test_an_unmapped_exit_code_still_reports_the_number():
    h = evaluate("cron_job", DAILY, {}, run("failed", exit_code=7), None, NOW, NOW)
    assert h.state == "broken"
    assert "7" in h.reason


def test_a_static_mirror_is_not_late_for_standing_still():
    """bronze.stg_table_d legitimately goes days without moving; its
    checksum guard skips the reload. Without may_be_static it would sit amber
    forever and teach its reader to ignore the panel."""
    stale = CheckFacts(
        checked_at=NOW,
        row_count=2693,
        max_ts=NOW - timedelta(days=9),
        ok=True,
        error=None,
    )
    rules = {"freshness_column": "creation_date", "max_age_minutes": 120,
             "may_be_static": True}
    h = evaluate("table", {}, rules, None, stale, NOW, NOW)
    assert h.state == "ok"


def test_the_same_stale_table_without_the_flag_is_late():
    stale = CheckFacts(checked_at=NOW, row_count=2693,
                       max_ts=NOW - timedelta(days=9), ok=True, error=None)
    rules = {"freshness_column": "creation_date", "max_age_minutes": 120}
    h = evaluate("table", {}, rules, None, stale, NOW, NOW)
    assert h.state == "late"


def test_an_object_missing_from_its_source_is_not_ok():
    """A DAG deleted from Airflow stops being seen. Its last run succeeded, so
    a naive rule would report green forever."""
    seen = NOW - timedelta(days=6)
    h = evaluate("airflow_dag", DAILY, {}, run("success", minutes_ago=6 * 24 * 60),
                 None, seen, NOW)
    assert h.state == "no_data"
    assert "source" in h.reason


# ── the "late" window ────────────────────────────────────────────────


def test_a_daily_job_is_late_after_its_window():
    """0 2 * * * with the default slack: 24h + 20% = 28h48m (1728 min)."""
    h = evaluate("airflow_dag", DAILY, {}, run("success", minutes_ago=28 * 60), None, NOW, NOW)
    assert h.state == "ok"
    h = evaluate("airflow_dag", DAILY, {}, run("success", minutes_ago=29 * 60), None, NOW, NOW)
    assert h.state == "late"


def test_an_hourly_job_is_late_within_hours_not_days():
    """The guard on the slack floor. A floor large enough to satisfy a daily
    job silently swallows an hourly one: with a 6h floor, sync_job_a
    could sit 6 hours dead and still read green. 60 + max(12, 15) = 75 min."""
    hourly = {"schedule": "0 * * * *"}
    assert evaluate("cron_job", hourly, {}, run("success", minutes_ago=70),
                    None, NOW, NOW).state == "ok"
    assert evaluate("cron_job", hourly, {}, run("success", minutes_ago=80),
                    None, NOW, NOW).state == "late"


def test_sla_minutes_overrides_the_derived_window():
    rules = {"sla_minutes": 90}
    h = evaluate("airflow_dag", DAILY, rules, run("success", minutes_ago=100), None, NOW, NOW)
    assert h.state == "late"


def test_a_running_job_is_not_late():
    h = evaluate("airflow_dag", DAILY, {}, run("running", minutes_ago=40 * 60), None, NOW, NOW)
    assert h.state == "ok"


def test_a_paused_dag_is_not_late():
    """Pausing is a decision, not a failure."""
    attrs = {"schedule": "0 2 * * *", "is_paused": True}
    h = evaluate("airflow_dag", attrs, {}, run("success", minutes_ago=90 * 24 * 60),
                 None, NOW, NOW)
    assert h.state == "ok"
    assert "paused" in h.reason


def test_a_manual_dag_is_never_late():
    """schedule=None means external triggers only; there is no window to miss."""
    h = evaluate("airflow_dag", {"schedule": None}, {},
                 run("success", minutes_ago=70 * 24 * 60), None, NOW, NOW)
    assert h.state == "ok"


# ── aggregation ──────────────────────────────────────────────────────


def test_a_pipeline_takes_the_worst_of_its_nodes():
    """Never an average -- an average hides the node worth looking at."""
    assert worst(["ok", "broken", "late"]) == "broken"
    assert worst(["ok", "late", "skipped"]) == "late"
    assert worst(["ok", "skipped"]) == "skipped"
    assert worst(["ok", "ok"]) == "ok"
    assert worst([]) == "no_data"


def test_no_data_outranks_ok_in_the_aggregate():
    assert worst(["ok", "no_data"]) == "no_data"


# ── the expected window ─────────────────────────────────────────────


def test_expected_window_from_a_daily_schedule():
    w = expected_window(DAILY, {}, NOW)
    assert w["next_at"] == NOW + timedelta(hours=24)
    assert w["late_after"] == NOW + timedelta(minutes=1728)


def test_expected_window_is_none_without_a_cadence():
    assert expected_window({"schedule": "Dataset"}, {}, NOW) is None


def test_expected_window_honours_sla_minutes():
    w = expected_window(DAILY, {"sla_minutes": 90}, NOW)
    assert w["late_after"] == NOW + timedelta(minutes=90)


def test_expected_window_is_none_without_a_last_run():
    assert expected_window(DAILY, {}, None) is None
