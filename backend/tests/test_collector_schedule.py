"""The daily slot for table checks."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops"))

from collector.schedule import table_checks_due  # noqa: E402

UTC = timezone.utc
T = lambda h, m=0, d=23: datetime(2026, 9, d, h, m, tzinfo=UTC)  # noqa: E731


def test_never_checked_is_due():
    assert table_checks_due(T(3), None)


def test_due_at_the_first_cycle_after_the_slot():
    assert table_checks_due(T(7, 0), T(7, 5, d=22))
    assert table_checks_due(T(7, 5), T(13, 0, d=22))


def test_not_due_again_the_same_day():
    assert not table_checks_due(T(7, 10), T(7, 5))
    assert not table_checks_due(T(23, 55), T(7, 5))


def test_before_the_slot_yesterdays_check_is_enough():
    assert not table_checks_due(T(6, 55), T(7, 5, d=22))


def test_a_missed_day_is_caught_up_by_any_later_cycle():
    assert table_checks_due(T(15, 0), T(7, 5, d=21))
    assert table_checks_due(T(2, 0), T(7, 5, d=21))  # yesterday's slot was missed too


def test_timezones_are_normalised():
    from datetime import timedelta
    brt = timezone(timedelta(hours=-3))
    assert not table_checks_due(datetime(2026, 9, 23, 4, 30, tzinfo=brt), T(7, 5))
