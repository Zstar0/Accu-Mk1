"""Mk1-owned identity verdict for the COA wire (2026-09-10, P-1986 class).

Why this exists: in mk1 mode COABuilder derives the *expected* peptide name
from the registry analyte slot title (`lims_samples.analytes`, the
check-in copy of the SENAITE service title, e.g. "Somatropin - Identity
(HPLC)") and does a `startswith` against the raw `Result` the prep bridge
wrote, which is `peptides.name` (e.g. "HGH (Somatropin)"). Those are two
Mk1 catalog fields that can disagree (service 264 vs peptide 235), and when
they do a conforming identity renders DOES NOT CONFORM on the certificate.

Fix: Mk1 decides. When the stored value conforms under Mk1's own rule
(`sub_samples.variance.identity_conforms` against the peptide name, the
service's legacy `peptide_name`, or the service-title prefix) the wire
carries the literal token ``Conforms`` — the same vocabulary the HPLC
native-born design writes for native identity rows (spec
2026-09-10-hplc-native-born-design.md §19/M5) and one COABuilder's
`_identity_matches` already accepts. On a pass COABuilder prints the slot
display name, never the raw string, so customer-facing text is unchanged.
Anything that does not conform (explicit fail tokens, free text, blank)
rides through RAW so it keeps failing exactly as today.

Dry run against every prod identity row on 2026-09-10 (8,552 rows): the
only rows whose verdict changes are P-1986's three `ID_Somatropin` rows.
"""
from typing import Optional

from sqlalchemy import select

CONFORMS_TOKEN = "Conforms"


def is_identity_keyword(keyword: Optional[str]) -> bool:
    """Mirror of lims_analyses.prep_bridge._category's identity arm — kept
    local so the COA wire never imports the prep bridge."""
    kw = (keyword or "").upper()
    return kw == "HPLC-ID" or kw.startswith("ID_")


def _title_name(title: Optional[str]) -> Optional[str]:
    t = (title or "").strip()
    if " - Identity" not in t:
        return None
    return t.split(" - Identity")[0].strip() or None


def candidate_names(svc) -> list[str]:
    """Every name the stored result may legitimately equal, most
    authoritative first: the linked peptide's catalog name (what the prep
    bridge writes), the service's legacy denormalised peptide_name, then
    the service-title prefix (what COABuilder compares against today)."""
    names: list[str] = []
    pep = getattr(svc, "peptide", None)
    for n in (
        getattr(pep, "name", None) if pep is not None else None,
        getattr(svc, "peptide_name", None),
        _title_name(getattr(svc, "title", None)),
    ):
        n = (n or "").strip()
        if n and n not in names:
            names.append(n)
    return names


def identity_verdict(db, *, result: Optional[str], analysis_service_id: Optional[int]) -> Optional[bool]:
    """True = conforms under Mk1's rule; False = does not; None = blank.

    Fail tokens win over everything (identity_conforms checks them first),
    so a "Does_Not_Conform" can never be rescued by a name match.
    """
    from sub_samples.variance import identity_conforms

    raw = (result or "").strip()
    if not raw:
        return None
    svc = None
    if db is not None and analysis_service_id is not None:
        from models import AnalysisService
        svc = db.execute(
            select(AnalysisService).where(AnalysisService.id == analysis_service_id)
        ).scalar_one_or_none()
    options = getattr(svc, "result_options", None) if svc is not None else None
    names = candidate_names(svc) if svc is not None else []
    # Token-only pass (pass/fail keywords, select-form "1"/"Conforms").
    verdict = identity_conforms(raw, None, options)
    if verdict is True:
        return True
    for name in names:
        if identity_conforms(raw, name, options) is True:
            return True
    return False


def identity_wire_result(db, *, keyword: Optional[str], result: Optional[str],
                         analysis_service_id: Optional[int]) -> Optional[str]:
    """The `Result` to put on the COA wire for one legacy row.

    Non-identity rows and non-conforming identity rows are returned
    untouched; a conforming identity row becomes the ``Conforms`` token.
    """
    if not is_identity_keyword(keyword):
        return result
    if identity_verdict(db, result=result, analysis_service_id=analysis_service_id) is True:
        return CONFORMS_TOKEN
    return result
