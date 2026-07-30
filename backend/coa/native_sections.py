"""Native COA sections: catalog-derived certificate sections from Mk1 results.

One builder, two entry points (spec 2): the primary-COA path calls
build_native_sections in-process; GET /samples/{id}/coa-sections exposes the
same document to Integration Service for the additional-COA path. The document
is passed to COABuilder verbatim as `native_sections`.

FAIL-CLOSED: every abort raises NativeSectionsError with a rule-specific
message. A heavy-metals result is a paid, reportable test — if the document
cannot be assembled completely and correctly, the certificate must not be
generated at all. (Contrast with the variance overlay, which is best-effort.)
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from sub_samples.service import fetch_sample_services

log = logging.getLogger(__name__)

# Mirror of the states a native result may be certified from. Deliberately
# narrower than coa/source_resolver._LIVE_RESULT_STATES: native services have
# no SENAITE verify step, so Mk1 review_state is the only gate that exists.
ELIGIBLE_STATES = ("verified", "published")


class NativeSectionsError(Exception):
    """Any condition that must abort COA generation (fail-closed rules 1-4)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def _ordered_native_profiles(db: Session, services: dict, package: Optional[str]) -> list:
    """Profiles that are ordered AND reportable: the order bought the key,
    every member is origin='mk1', and coa_archetype is non-NULL.

    Mixed-origin or NULL-archetype profiles are silently excluded — they are
    legitimately not-native-reportable, not errors (all-native scope rule).
    """
    from models import AnalysisProfile

    ordered_keys = [k for k, v in (services or {}).items() if v]
    if package:
        ordered_keys.append(package)

    out = []
    for key in ordered_keys:
        prof = db.execute(
            select(AnalysisProfile).where(AnalysisProfile.key == key)
        ).scalar_one_or_none()
        if prof is None or prof.coa_archetype is None:
            continue
        members = prof.analysis_services  # ordered by member sort_order (spec 1)
        if not members or any(svc.origin != "mk1" for svc in members):
            continue
        out.append(prof)
    out.sort(key=lambda p: (p.coa_sort_order, p.key))
    return out


def _eligible_parent_row(db: Session, parent_pk: int, service_id: int):
    """The current, certifiable parent-tier row for a member service.

    ID-keyed (native promote stores parent rows by analysis_service_id).
    Retest supersession retracts superseded rows in the same transaction, so
    at most one row is in an eligible state.
    """
    from models import LimsAnalysis

    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.review_state.in_(ELIGIBLE_STATES),
        )
    ).scalars().first()


def _method_label(db: Session, method_id: Optional[int]) -> str:
    if method_id is None:
        return ""
    from models import HplcMethod

    m = db.get(HplcMethod, method_id)
    return (m.name or "") if m is not None else ""


def build_native_sections(db: Session, parent) -> dict:
    """Assemble the native-sections wire document for a parent LimsSample.

    Returns {"sample_id", "ordered_profiles", "sections"}. An order with no
    reportable native profiles yields empty lists — a VALID document (the
    ordered_profiles cross-check is what lets callers distinguish "nothing
    ordered" from "something broke"). All failures raise NativeSectionsError.
    """
    sample_id = parent.sample_id

    # Rule 1: the order lookup itself is fail-closed.
    try:
        raw = fetch_sample_services(sample_id)
    except Exception as e:
        raise NativeSectionsError(
            f"native sections: order lookup failed for {sample_id}: {e}"
        ) from e

    if raw is None:
        # IS 404 — no linked order. Nothing native can have been bought.
        return {"sample_id": sample_id, "ordered_profiles": [], "sections": []}

    profiles = _ordered_native_profiles(db, raw.get("services") or {}, raw.get("package"))

    sections = []
    for prof in profiles:
        rows = []
        for svc in prof.analysis_services:
            row = _eligible_parent_row(db, parent.id, svc.id)
            if row is None:
                # Rule 4: a member without a certifiable result makes the
                # section INCOMPLETE — abort, never skip.
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' member service "
                    f"'{svc.keyword}' (id={svc.id}) has no eligible result "
                    f"(need review_state in {ELIGIBLE_STATES}) on {sample_id}"
                )
            if not (row.result_value or "").strip():
                # Rule 3 (row half): an eligible row with an empty result.
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' row "
                    f"'{svc.keyword}' has an empty result on {sample_id}"
                )
            rows.append({
                "keyword": svc.keyword,
                "name": svc.title,
                "result": row.result_value,
                "unit": row.result_unit or (svc.unit or ""),
                "method": _method_label(db, row.method_id),
                "specification": None,   # COABuilder fills from baked specs
                "conforms": None,        # COABuilder fills from baked specs
            })
        if not rows:
            # Rule 3 (section half): unreachable while members are required
            # non-empty in _ordered_native_profiles, kept as defence.
            raise NativeSectionsError(
                f"native sections: profile '{prof.key}' produced zero rows on {sample_id}"
            )
        sections.append({
            "profile_key": prof.key,
            "title": prof.coa_section_title or prof.name,
            "archetype": prof.coa_archetype,
            "sort_order": prof.coa_sort_order,
            "rows": rows,
        })

    return {
        "sample_id": sample_id,
        "ordered_profiles": [p.key for p in profiles],
        "sections": sections,
    }
