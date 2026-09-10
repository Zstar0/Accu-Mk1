"""Who writes lims_samples.status — the sample-tier authority switch.

`registry_read_source` is the Settings row the Data Source pane owns (a JSON
object keyed by surface). This module reads ONE key, `sample_status`:
  "senaite" (default) -> SENAITE-sourced mirrors write the column (today)
  "mk1"               -> the native engine writes it; mirrors stop
Fail-safe: absence, malformed JSON or an unknown value all mean "senaite".
Spec: docs/superpowers/specs/2026-09-09-sample-status-authority-flip-design.md §3.1
"""
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

SAMPLE_STATUS_KEY = "sample_status"
READ_SOURCE_SETTING_KEY = "registry_read_source"
_VALID = ("senaite", "mk1")


def sample_status_authority(db: Session) -> str:
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
    val = parsed.get(SAMPLE_STATUS_KEY) if isinstance(parsed, dict) else None
    return val if val in _VALID else "senaite"
