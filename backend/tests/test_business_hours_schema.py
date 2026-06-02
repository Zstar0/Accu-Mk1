"""Schema + seed tests for the business-hours calendar (sub-project B).

These run against the live accumark_mk1 DB AFTER the backend has started (so
init_db has created + seeded the tables). Restart the backend before running:
    docker restart accu-mk1-backend
    docker exec accu-mk1-backend sh -c 'cd /app && python -m pytest tests/test_business_hours_schema.py -q'
"""
from datetime import date

from sqlalchemy import text

from database import engine, seed_federal_holidays, _seed_federal_holidays_window
from holidays_us import us_federal_holidays


def test_business_hours_config_singleton_seeded():
    with engine.connect() as c:
        rows = c.execute(text("SELECT id, open_time, close_time, timezone, working_days FROM business_hours_config")).fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert row[0] == 1
    assert str(row[1]) == "09:00:00"
    assert str(row[2]) == "17:00:00"
    assert row[3] == "America/Los_Angeles"
    assert list(row[4]) == [0, 1, 2, 3, 4]


def test_federal_holidays_seeded_for_current_year():
    y = date.today().year
    expected = set(us_federal_holidays(y).keys())
    with engine.connect() as c:
        present = {
            r[0]
            for r in c.execute(
                text("SELECT holiday_date FROM lab_holidays WHERE source='federal' AND EXTRACT(year FROM holiday_date)=:y"),
                {"y": y},
            ).fetchall()
        }
    assert expected.issubset(present)


def test_seed_federal_per_year_re_adds_missing_on_explicit_call():
    """The explicit per-year helper (used by POST /lab-holidays/generate-federal)
    re-adds any missing federal row for that year — including one just deleted.
    This is the contract for the user-triggered generate action."""
    year = 2099
    with engine.begin() as c:
        c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})
        assert seed_federal_holidays(c, year) == 11  # 11 federal holidays/year (see holidays_us)
        # re-seeding while all rows are present adds nothing
        assert seed_federal_holidays(c, year) == 0
        # delete one, re-seed -> the missing one is re-added (explicit action)
        victim = sorted(us_federal_holidays(year).keys())[0]
        c.execute(text("DELETE FROM lab_holidays WHERE holiday_date=:d"), {"d": victim})
        assert seed_federal_holidays(c, year) == 1
        # cleanup
        # On assertion failure, engine.begin() rolls back and removes these rows too; this explicit delete handles the success path.
        c.execute(text("DELETE FROM lab_holidays WHERE EXTRACT(year FROM holiday_date)=:y"), {"y": year})


def test_startup_seeder_is_first_boot_only():
    """After the initial boot, _seed_federal_holidays_window() short-circuits on
    the settings flag — so a federal row the lab deleted stays gone across
    restarts (the durable delete-to-disable guarantee). Self-restoring."""
    y = date.today().year
    # The flag is set because init_db ran on the last restart.
    with engine.connect() as c:
        flag = c.execute(text("SELECT value FROM settings WHERE key='business_hours_federal_initial_seeded'")).scalar()
    assert flag == "true"
    # Delete a real current-year federal row; capture it for restore.
    with engine.begin() as c:
        victim = c.execute(text(
            "SELECT holiday_date, name FROM lab_holidays WHERE source='federal' "
            "AND EXTRACT(year FROM holiday_date)=:y ORDER BY holiday_date LIMIT 1"
        ), {"y": y}).fetchone()
        assert victim is not None
        vdate, vname = victim[0], victim[1]
        c.execute(text("DELETE FROM lab_holidays WHERE holiday_date=:d"), {"d": vdate})
    try:
        _seed_federal_holidays_window()  # simulate a reboot
        with engine.connect() as c:
            still_present = c.execute(text("SELECT 1 FROM lab_holidays WHERE holiday_date=:d"), {"d": vdate}).scalar()
        assert still_present is None  # deletion survived the "reboot"
    finally:
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO lab_holidays (holiday_date, name, source, created_at) "
                "VALUES (:d, :n, 'federal', NOW()) ON CONFLICT (holiday_date) DO NOTHING"
            ), {"d": vdate, "n": vname})
