"""Flagged (a la carte) reporting-row rules, twin of IS generation_service.

Mk1 Re-sync (`POST /reports/resync`) writes `published_coa_results` beside the
Integration Service. A certificate with `coa_data.page1 == "none"` must get the
row IS writes: one row, add-on flags from `coa_data.native_sections` matched by
exact `profile_key`, never by title. Keep these values equal to IS
`app/services/generation_service.py`.
"""

ENDOTOXIN_PROFILE_KEYS: frozenset[str] = frozenset({"endotoxin-usp85-lal"})
STERILITY_PROFILE_KEYS: frozenset[str] = frozenset({"rapid-sterility-pcr", "sterility-usp71"})


def is_flagged(coa_data: dict) -> bool:
    """Exact string, case-sensitive: any other value (or no key) is unflagged."""
    return coa_data.get("page1") == "none"


def native_section_flag(
    native_sections: object, profile_keys: frozenset[str]
) -> tuple[bool, bool | None]:
    """Return (has, conforms) for the native sections whose profile_key matches.

    conforms is all() over every bool row verdict in the matched sections, or
    None when no matched row carries a verdict. Malformed input never raises.
    """
    if not isinstance(native_sections, list):
        return False, None
    matched = [
        s for s in native_sections
        if isinstance(s, dict) and s.get("profile_key") in profile_keys
    ]
    verdicts = [
        row["conforms"]
        for s in matched
        if isinstance(s.get("rows"), list)
        for row in s["rows"]
        if isinstance(row, dict) and isinstance(row.get("conforms"), bool)
    ]
    return bool(matched), (all(verdicts) if verdicts else None)
