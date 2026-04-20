"""Repository layer for clickup_user_mapping."""
from dataclasses import dataclass
from typing import Optional

from psycopg2.extras import RealDictCursor

from mk1_db import get_mk1_conn


@dataclass
class ClickUpUserMapping:
    clickup_user_id: str
    accumk1_user_id: Optional[int]
    clickup_username: str
    clickup_email: Optional[str]
    auto_matched: bool


class ClickUpUserMappingRepository:
    def get(self, clickup_user_id: str) -> Optional[ClickUpUserMapping]:
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT clickup_user_id, accumk1_user_id, clickup_username,
                       clickup_email, auto_matched
                FROM clickup_user_mapping WHERE clickup_user_id = %s
            """, (clickup_user_id,))
            row = cur.fetchone()
            return ClickUpUserMapping(**dict(row)) if row else None

    def upsert(
        self, *, clickup_user_id: str, clickup_username: str,
        clickup_email: Optional[str],
    ) -> ClickUpUserMapping:
        """Upsert mapping. On insert, attempt email auto-match to users table.

        Both ``users.id`` and ``clickup_user_mapping.accumk1_user_id`` are now
        INTEGER (with an FK constraint), so a successful email match is
        persisted directly — no more Task-6 workaround where auto_matched was
        flagged but the id was left NULL.
        """
        with get_mk1_conn() as conn:
            # RealDictCursor throughout — simpler than juggling two cursors and
            # lets us index users row as user["id"] instead of positional user[0].
            cur = conn.cursor(cursor_factory=RealDictCursor)

            accumk1_user_id: Optional[int] = None
            auto_matched = False
            if clickup_email:
                cur.execute("SELECT id FROM users WHERE email = %s", (clickup_email,))
                user = cur.fetchone()
                if user:
                    accumk1_user_id = user["id"] if isinstance(user, dict) else user[0]
                    auto_matched = True

            cur.execute("""
                INSERT INTO clickup_user_mapping
                    (clickup_user_id, clickup_username, clickup_email,
                     accumk1_user_id, auto_matched, last_seen_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (clickup_user_id) DO UPDATE SET
                    clickup_username = EXCLUDED.clickup_username,
                    clickup_email = COALESCE(EXCLUDED.clickup_email,
                                              clickup_user_mapping.clickup_email),
                    last_seen_at = NOW(),
                    updated_at = NOW()
                RETURNING clickup_user_id, accumk1_user_id, clickup_username,
                          clickup_email, auto_matched
            """, (
                clickup_user_id, clickup_username, clickup_email,
                accumk1_user_id, auto_matched,
            ))
            row = cur.fetchone()
            conn.commit()
            return ClickUpUserMapping(**dict(row))

    def list_unmapped(self) -> list[ClickUpUserMapping]:
        with get_mk1_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT clickup_user_id, accumk1_user_id, clickup_username,
                       clickup_email, auto_matched
                FROM clickup_user_mapping WHERE accumk1_user_id IS NULL
                ORDER BY last_seen_at DESC
            """)
            return [ClickUpUserMapping(**dict(r)) for r in cur.fetchall()]

    def set_mapping(self, clickup_user_id: str, accumk1_user_id: int) -> None:
        """Admin-driven manual mapping. Clears auto_matched since a human set it."""
        with get_mk1_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE clickup_user_mapping
                SET accumk1_user_id = %s, auto_matched = FALSE, updated_at = NOW()
                WHERE clickup_user_id = %s
            """, (accumk1_user_id, clickup_user_id))
            conn.commit()
