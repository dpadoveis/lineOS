"""Turning collected state into one of five words.

Pure functions: no session, no models, no clock of its own. `now` is a
parameter so every case is reproducible, and the module can be tested without
a database.

Five states, because two would be wrong here. `skipped` exists because the
multi-source job's flock can skip a run entirely and a mirror's checksum
guard exits 0 having deliberately loaded nothing -- both are successes, and a
two-colour panel calls one of them red. `no_data` exists because an empty
history and a vanished object must never render as healthy.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta

STATES = ("ok", "skipped", "late", "no_data", "broken")
# Worst first. The list screen sorts by this, and `worst` aggregates by it.
WORST_FIRST = ("broken", "no_data", "late", "skipped", "ok")

# How long an object may go unseen by the collector before its health stops
# meaning anything. Two collection cycles plus slack.
UNSEEN_MINUTES = 60
# Default slack on a derived window, as a fraction of the schedule's interval.
DEFAULT_SLACK = 0.20
DEFAULT_SLACK_FLOOR_MINUTES = 15


@dataclass
class RunFacts:
    outcome: str
    started_at: datetime
    ended_at: datetime | None = None
    exit_code: int | None = None
    facts: dict = field(default_factory=dict)


@dataclass
class CheckFacts:
    checked_at: datetime
    row_count: int | None = None
    max_ts: datetime | None = None
    ok: bool = True
    error: str | None = None


@dataclass
class Health:
    state: str
    reason: str
    since: datetime | None = None


def worst(states) -> str:
    """The aggregate of several nodes: the worst one, never an average.

    An average hides exactly the node worth looking at.
    """
    for s in WORST_FIRST:
        if s in states:
            return s
    return "no_data"


# ── the schedule window ──────────────────────────────────────────────

# Interval in minutes for the schedule shapes this platform actually uses.
# Anything else falls back to None, which means "no window" -- an object with
# no derivable cadence is never reported late, because a made-up window is
# worse than no window.
_PRESETS = {
    "@hourly": 60,
    "@daily": 24 * 60,
    "@midnight": 24 * 60,
    "@weekly": 7 * 24 * 60,
    "@monthly": 30 * 24 * 60,
}


def interval_minutes(schedule: str | None) -> int | None:
    """Minutes between firings, for a preset or a 5-field cron expression.

    Only the shapes in use here are recognised: a preset, `M H * * *` (daily),
    `M * * * *` (hourly), and `*/N * * * *` (every N minutes). Anything more
    exotic returns None rather than a guess.
    """
    if not schedule:
        return None
    s = schedule.strip().strip('"')
    if s in _PRESETS:
        return _PRESETS[s]
    parts = s.split()
    if len(parts) != 5:
        return None
    minute, hour, dom, month, dow = parts
    if minute.startswith("*/") and hour == "*":
        try:
            return max(1, int(minute[2:]))
        except ValueError:
            return None
    if hour == "*" and minute.isdigit():
        return 60
    if minute.isdigit() and hour.isdigit() and dom == "*" and month == "*" and dow == "*":
        return 24 * 60
    return None


def window_minutes(attrs: dict, rules: dict) -> int | None:
    """How long may pass between runs before the object is late.

    `rules.sla_minutes` wins. Otherwise the interval plus 20% slack, floored at
    15 minutes. None means there is no window -- a manually triggered object.
    """
    explicit = rules.get("sla_minutes")
    if isinstance(explicit, (int, float)) and explicit > 0:
        return int(explicit)
    interval = interval_minutes(attrs.get("schedule"))
    if interval is None:
        return None
    return int(interval + max(interval * DEFAULT_SLACK, DEFAULT_SLACK_FLOOR_MINUTES))


# ── the verdict ──────────────────────────────────────────────────────


def evaluate(
    kind: str,
    attrs: dict,
    rules: dict,
    last_run: RunFacts | None,
    last_check: CheckFacts | None,
    seen_at: datetime,
    now: datetime,
) -> Health:
    """The state of one bound node.

    `seen_at` is the object's `last_seen_at` in the inventory: an object the
    collector no longer finds is `no_data`, whatever its last run said, because
    a DAG deleted from Airflow would otherwise report green forever.
    """
    attrs = attrs or {}
    rules = rules or {}

    if (now - seen_at) > timedelta(minutes=UNSEEN_MINUTES):
        days = (now - seen_at).days
        gone = f"{days} days" if days else "over an hour"
        return Health("no_data", f"missing from its source for {gone}", seen_at)

    if kind == "table":
        return _table_health(rules, last_check, now)
    return _job_health(attrs, rules, last_run, now)


def _job_health(attrs: dict, rules: dict, last_run: RunFacts | None, now: datetime) -> Health:
    if last_run is None:
        return Health("no_data", "never collected", None)

    if last_run.outcome == "failed":
        mapped = (rules.get("exit_code_map") or {}).get(str(last_run.exit_code))
        if mapped:
            return Health("broken", mapped, last_run.started_at)
        code = "" if last_run.exit_code is None else f" (exit {last_run.exit_code})"
        return Health("broken", f"last run failed{code}", last_run.started_at)

    if last_run.outcome == "running":
        return Health("ok", "running now", last_run.started_at)

    if attrs.get("is_paused"):
        return Health("ok", "paused, not scheduled", last_run.started_at)

    window = window_minutes(attrs, rules)
    if window is not None:
        age = now - last_run.started_at
        if age > timedelta(minutes=window):
            hours = int(age.total_seconds() // 3600)
            return Health("late", f"no run for {hours}h", last_run.started_at)

    if last_run.outcome == "skipped":
        return Health("skipped", "run skipped, nothing to do", last_run.started_at)
    if last_run.outcome == "unknown":
        return Health("no_data", "outcome not reported", last_run.started_at)
    return Health("ok", "last run succeeded", last_run.started_at)


def expected_window(attrs: dict, rules: dict, started_at):
    """When the next run is due and when it turns late, from the same interval
    and window `late` uses. None without a cadence or without a last run."""
    if started_at is None:
        return None
    interval = interval_minutes((attrs or {}).get("schedule"))
    window = window_minutes(attrs or {}, rules or {})
    if interval is None or window is None:
        return None
    return {"next_at": started_at + timedelta(minutes=interval),
            "late_after": started_at + timedelta(minutes=window)}


def _table_health(rules: dict, last_check: CheckFacts | None, now: datetime) -> Health:
    if last_check is None:
        return Health("no_data", "never checked", None)
    if not last_check.ok:
        return Health("broken", last_check.error or "check failed", last_check.checked_at)

    # A mirror whose source barely changes is not stale for standing still --
    # its health comes from the job that feeds it. Without this the table sits
    # amber forever and teaches its reader to ignore the panel.
    if rules.get("may_be_static"):
        return Health("ok", "checked; this table may legitimately not move",
                      last_check.checked_at)

    max_age = rules.get("max_age_minutes")
    if last_check.max_ts is not None and isinstance(max_age, (int, float)) and max_age > 0:
        age = now - last_check.max_ts
        if age > timedelta(minutes=max_age):
            hours = int(age.total_seconds() // 3600)
            return Health("late", f"newest row is {hours}h old", last_check.checked_at)

    rows = "" if last_check.row_count is None else f"{last_check.row_count:,} rows"
    return Health("ok", rows or "checked", last_check.checked_at)
