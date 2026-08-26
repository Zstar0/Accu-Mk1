"""Backend reader for the Data Source map's `coa_generation` key.

The `registry_read_source` Settings row is a JSON object owned by the FE
Data Source pane. The page keys (sample_details, ...) are FE-read;
`coa_generation` is the first backend-read key: it decides whether the COA
wire document carries Mk1-sourced legacy rows. Per-session FE page
overrides deliberately do NOT apply here.

Fail-safe: any absence or malformation means "senaite" (the default and
rollback posture).
"""
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

COA_SOURCE_KEY = "coa_generation"
READ_SOURCE_SETTING_KEY = "registry_read_source"


def coa_generation_source(db: Session) -> str:
    from models import Settings

    row = db.execute(
        select(Settings).where(Settings.key == READ_SOURCE_SETTING_KEY)
    ).scalar_one_or_none()
    if row is None or not row.value:
        return "senaite"
    try:
        parsed = json.loads(row.value)
    except (ValueError, TypeError):
        return "senaite"
    val = parsed.get(COA_SOURCE_KEY) if isinstance(parsed, dict) else None
    return val if val in ("senaite", "mk1") else "senaite"
