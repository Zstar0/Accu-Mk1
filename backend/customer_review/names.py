"""Staff names never reach a published review (spec 2026-10-09 section 3.2). Prompting alone did not hold."""
from __future__ import annotations

import copy
import re
from typing import Any

from sqlalchemy import select

REPLACEMENT = "the team"
MIN_LEN = 3
_SECTIONS = ("open_issues", "shortfalls", "strengths", "next_steps")


def staff_names(db, ctx) -> set[str]:
    from models import User
    out: set[str] = set()
    full_names = set(getattr(ctx, "memo", {}).get("staff", set()))
    if db is not None:
        for first, last in db.execute(select(User.first_name, User.last_name)).all():
            full_names.add(" ".join(p for p in (first, last) if p))
    for full in full_names:
        full = (full or "").strip()
        if not full:
            continue
        out.add(full)
        out.update(p for p in full.split() if len(p) >= MIN_LEN)
    return {n for n in out if len(n) >= MIN_LEN}


def _pattern(staff: set[str]) -> re.Pattern | None:
    usable = sorted((n for n in staff if len(n) >= MIN_LEN), key=len, reverse=True)  # full names first
    if not usable:
        return None
    return re.compile(r"\b(?:" + "|".join(re.escape(n) for n in usable) + r")\b")


def scrub(review: dict[str, Any], staff: set[str]) -> tuple[dict[str, Any], int]:
    pat = _pattern(staff)
    if pat is None:
        return review, 0
    out = copy.deepcopy(review)
    count = 0

    def fix(text: str) -> str:
        nonlocal count
        new, n = pat.subn(REPLACEMENT, text or "")
        count += n
        return new

    def fix_cites(cites) -> None:
        for c in cites or []:
            if isinstance(c.get("label"), str):
                c["label"] = fix(c["label"])

    out["headline"] = fix(out.get("headline", ""))
    out["sentiment"]["reason"] = fix(out["sentiment"].get("reason", ""))
    fix_cites(out["sentiment"].get("citations"))
    for name in _SECTIONS:
        for it in out.get(name) or []:
            it["title"] = fix(it.get("title", ""))
            it["detail"] = fix(it.get("detail", ""))
            fix_cites(it.get("citations"))
    return out, count
