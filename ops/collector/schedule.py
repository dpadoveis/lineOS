"""When the table checks run.

Almost every job here runs once a day, so checking fifty tables every five
minutes bought nothing but 1.8 MB of telemetry a day. The checks run once a
day, at the first collector cycle after CHECK_HOUR_UTC -- 07:00 UTC, 04:00 in
Brasilia, after the whole chain (cron mirrors 01:00-02:00 BRT, DAGs 02:00-04:00
UTC). A missed cycle is not a missed day: any later cycle that finds no check
since today's slot runs them. Job runs are still collected every five minutes.
"""
from datetime import datetime, timedelta, timezone

CHECK_HOUR_UTC = 7


def table_checks_due(now: datetime, last_checked_at: datetime | None,
                     hour_utc: int = CHECK_HOUR_UTC) -> bool:
    now = now.astimezone(timezone.utc)
    slot = now.replace(hour=hour_utc, minute=0, second=0, microsecond=0)
    if now < slot:
        slot -= timedelta(days=1)  # before today's slot: yesterday's is the one owed
    if last_checked_at is None:
        return True
    return last_checked_at.astimezone(timezone.utc) < slot
