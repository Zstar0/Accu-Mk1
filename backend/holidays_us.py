"""US federal holidays — pure, dependency-free (sub-project B).

`us_federal_holidays(year)` returns a dict of OBSERVED federal holiday date ->
display name for a year. Used to seed `lab_holidays` rows. No external deps
(no `holidays`/`pandas`) — the rules are stable and few.
"""
from __future__ import annotations

from datetime import date, timedelta


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The nth (1-based) `weekday` (Mon=0..Sun=6) of month/year."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """The last `weekday` (Mon=0..Sun=6) of month/year."""
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last_day = nxt - timedelta(days=1)
    return last_day - timedelta(days=(last_day.weekday() - weekday) % 7)


def _observed(d: date) -> date:
    """Fixed-date observed shift: Saturday -> Friday, Sunday -> Monday."""
    if d.weekday() == 5:  # Saturday
        return d - timedelta(days=1)
    if d.weekday() == 6:  # Sunday
        return d + timedelta(days=1)
    return d


def us_federal_holidays(year: int) -> dict[date, str]:
    """Observed US federal holiday dates -> display names for `year`.

    Note: an observed shift can move a date into an adjacent year — e.g. Jan 1
    on a Saturday is observed on Dec 31 of the prior year, so a returned key may
    not be in `year`.
    """
    out: dict[date, str] = {}

    def add_fixed(month: int, day: int, name: str) -> None:
        actual = date(year, month, day)
        obs = _observed(actual)
        out[obs] = f"{name} (observed)" if obs != actual else name

    add_fixed(1, 1, "New Year's Day")
    add_fixed(6, 19, "Juneteenth")
    add_fixed(7, 4, "Independence Day")
    add_fixed(11, 11, "Veterans Day")
    add_fixed(12, 25, "Christmas Day")

    out[_nth_weekday(year, 1, 0, 3)] = "Martin Luther King Jr. Day"
    out[_nth_weekday(year, 2, 0, 3)] = "Presidents' Day"
    out[_last_weekday(year, 5, 0)] = "Memorial Day"
    out[_nth_weekday(year, 9, 0, 1)] = "Labor Day"
    out[_nth_weekday(year, 10, 0, 2)] = "Columbus Day"
    out[_nth_weekday(year, 11, 3, 4)] = "Thanksgiving Day"
    return out
