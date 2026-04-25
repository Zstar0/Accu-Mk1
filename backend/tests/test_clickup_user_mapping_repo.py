import uuid

from mk1_db import ensure_clickup_user_mapping_table, get_mk1_conn
from clickup_user_mapping_repo import ClickUpUserMappingRepository

# Idempotent DDL setup for the test suite. See sibling tests for the same
# pattern — ensure_*_table() is a no-op on subsequent runs. The `users` table
# is created by SQLAlchemy's init_db() during normal app startup; the dev DB
# these tests run against already has it.
ensure_clickup_user_mapping_table()


def test_upsert_and_get():
    # Use an email that isn't in the users table so auto-match stays off.
    uniq = uuid.uuid4().hex[:8]
    email = f"no-match-{uniq}@example.invalid"
    clickup_user_id = f"cu_upsert_{uniq}"
    repo = ClickUpUserMappingRepository()
    repo.upsert(
        clickup_user_id=clickup_user_id, clickup_username="jane",
        clickup_email=email,
    )
    got = repo.get(clickup_user_id)
    assert got.clickup_username == "jane"
    assert got.accumk1_user_id is None  # unmapped by default


def test_auto_match_by_email_when_user_exists():
    """Seed a users row, run upsert, assert auto-match persists the integer id.

    Previously this branch was dead: the column was UUID and the old code
    flagged auto_matched=True but left accumk1_user_id NULL. Now the column
    is INTEGER+FK, so a real match is persisted. Seed + cleanup inline to
    avoid depending on shared dev fixtures.
    """
    uniq = uuid.uuid4().hex[:8]
    email = f"auto-match-{uniq}@example.invalid"
    clickup_user_id = f"cu_match_{uniq}"

    # Seed a user directly — bypass ORM to avoid cross-package imports in tests.
    with get_mk1_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO users (email, hashed_password, role, is_active, created_at) "
            "VALUES (%s, %s, %s, %s, NOW()) RETURNING id",
            (email, "x", "standard", True),
        )
        seeded_id = cur.fetchone()[0]
        conn.commit()

    try:
        repo = ClickUpUserMappingRepository()
        repo.upsert(
            clickup_user_id=clickup_user_id, clickup_username="jane",
            clickup_email=email,
        )
        got = repo.get(clickup_user_id)
        assert got.auto_matched is True
        assert got.accumk1_user_id == seeded_id
    finally:
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM clickup_user_mapping WHERE clickup_user_id = %s",
                (clickup_user_id,),
            )
            cur.execute("DELETE FROM users WHERE id = %s", (seeded_id,))
            conn.commit()
