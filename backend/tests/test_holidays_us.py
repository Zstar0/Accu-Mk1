"""Unit tests for the dependency-free US federal holiday helper (sub-project B).

Run in the backend container:
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_holidays_us.py -q'
"""
from datetime import date

from holidays_us import us_federal_holidays


def test_2026_fixed_and_floating_dates():
    h = us_federal_holidays(2026)
    # Floating
    assert date(2026, 1, 19) in h   # MLK — 3rd Mon Jan
    assert date(2026, 2, 16) in h   # Presidents' — 3rd Mon Feb
    assert date(2026, 5, 25) in h   # Memorial — last Mon May
    assert date(2026, 9, 7) in h    # Labor — 1st Mon Sep
    assert date(2026, 10, 12) in h  # Columbus — 2nd Mon Oct
    assert date(2026, 11, 26) in h  # Thanksgiving — 4th Thu Nov
    # Fixed (no shift in 2026)
    assert date(2026, 1, 1) in h
    assert date(2026, 6, 19) in h
    assert date(2026, 11, 11) in h
    assert date(2026, 12, 25) in h  # Dec 25 2026 is a Friday — no shift


def test_2026_observed_shift_for_july_4_saturday():
    h = us_federal_holidays(2026)
    # Jul 4 2026 is a Saturday -> observed Friday Jul 3
    assert date(2026, 7, 3) in h
    assert date(2026, 7, 4) not in h
    assert h[date(2026, 7, 3)] == "Independence Day (observed)"


def test_sunday_fixed_holiday_shifts_to_monday():
    # New Year's Day 2023-01-01 was a Sunday -> observed Monday Jan 2
    h = us_federal_holidays(2023)
    assert date(2023, 1, 2) in h
    assert date(2023, 1, 1) not in h
    assert h[date(2023, 1, 2)] == "New Year's Day (observed)"


def test_jan1_saturday_observed_in_prior_year():
    # 2028-01-01 is a Saturday -> observed Friday 2027-12-31 (prior year)
    h = us_federal_holidays(2028)
    assert date(2027, 12, 31) in h
    assert h[date(2027, 12, 31)] == "New Year's Day (observed)"


def test_returns_eleven_holidays():
    # 5 fixed + 6 floating, structurally non-overlapping
    assert len(us_federal_holidays(2026)) == 11


def test_names_present_and_nonempty():
    for name in us_federal_holidays(2026).values():
        assert isinstance(name, str) and name
