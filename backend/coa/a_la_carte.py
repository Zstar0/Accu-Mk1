"""The one decision: is this sample an a la carte (no-HPLC) sample?

An a la carte sample gets an empty page-1 results table flagged
`page1: "none"` for COABuilder, and no chromatogram requirement. Every
caller asks this helper; none re-derives the rule. The six conditions are
the spec's (2026-11-09-a-la-carte-no-hplc-orders-design.md, "The one
decision"); the reason string names the first one that failed.

FAIL-CLOSED: any failure, including an exception, is "not eligible", so the
existing empty-table guard fires unchanged. The helper never raises and
does no logging; callers log the reason.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from catalog.bw_keys import BW_PRIMARY_KEYS
from catalog.hplc_keys import HPLC_PRIMARY_KEYS
from coa import native_sections
from coa.bw_shim import is_native_bw_row
from coa.hplc_shim import is_native_hplc_row
from coa.spec_rules import normalize_matrix
from lims_analyses.hplc_native import is_native_born


@dataclass(frozen=True)
class ALaCarteVerdict:
    eligible: bool
    reason: str   # "eligible", or the first failed check: "c1: ...", ..., "error: ..."


A_LA_CARTE_PACKAGES: frozenset[str] = frozenset({"alacarte"})
BW_MATRIX: str = "Bacteriostatic Water"


def _is_retest(parent) -> bool:
    snap = parent.catalog_snapshot
    return bool(parent.is_retest or parent.retest_of_sample_id
                or (isinstance(snap, dict) and "retest" in snap))


def a_la_carte_verdict(db, parent, *, sections: list | None,
                       shaped: list | None = None) -> ALaCarteVerdict:
    """sections=None skips c4 (callers that have not built the native
    sections yet). shaped=None reads the parent's shaped rows lazily."""
    try:
        return _verdict(db, parent, sections, shaped)
    except Exception as e:
        # Type name only: exception text can carry SQL and bound parameters,
        # and callers log the reason.
        return ALaCarteVerdict(False, f"error: {type(e).__name__}")


def _verdict(db, parent, sections, shaped) -> ALaCarteVerdict:
    def no(reason: str) -> ALaCarteVerdict:
        return ALaCarteVerdict(False, reason)

    # c1: born native.
    if not is_native_born(parent):
        return no("c1: not native-born")

    # c6: a retest qualifies only on Bacteriostatic Water.
    retest = _is_retest(parent)
    if retest and normalize_matrix(parent.sample_type_title) != BW_MATRIX:
        return no("c6: retest of a non-Bacteriostatic-Water sample")

    # c2: no SENAITE-origin, native HPLC or native BW row. c2 sees a rejected
    # ORDERED placeholder (HPLC was on this sample); canonical retracted rows
    # and retested rows are dropped by the shaped read before c2 runs.
    if shaped is None:
        from lims_analyses.service import list_parent_analyses_senaite_shape
        shaped = list_parent_analyses_senaite_shape(db, parent.sample_id)
    for r in shaped:
        if r.service_origin != "mk1":
            return no(f"c2: row {r.keyword} has origin {r.service_origin}")
        if is_native_hplc_row(r) or is_native_bw_row(r):
            return no(f"c2: native HPLC or BW row {r.keyword}")

    # c3: the order lookup succeeded and orders no HPLC or BW primary.
    try:
        raw = native_sections.fetch_sample_services(parent.sample_id)
    except Exception as e:
        return no(f"c3: order lookup failed: {type(e).__name__}")
    if raw is None:
        return no("c3: no linked order")
    services = {k: v for k, v in (raw.get("services") or {}).items() if v}
    if retest:
        from lims_analyses.order_seed import _retest_demand_only
        services = _retest_demand_only(parent, services) or {}
    if not services:
        return no("c3: no ordered test")
    package = raw.get("package")
    if package and package not in A_LA_CARTE_PACKAGES:
        return no(f"c3: package {package} is not a la carte")
    keys = list(services)
    keys += native_sections._lab_added_profile_keys(db, parent.id)
    rider = (parent.catalog_snapshot or {}).get("retest") or {}
    keys += sorted(set(rider.get("carry") or []) - set(rider.get("missing") or []))
    keys = list(dict.fromkeys(keys))
    hplc_or_bw = set(keys) & (HPLC_PRIMARY_KEYS | BW_PRIMARY_KEYS)
    if hplc_or_bw:
        return no(f"c3: ordered {sorted(hplc_or_bw)}")

    # c5: every key is an active, all-mk1 limit_table profile.
    from models import AnalysisProfile
    for key in keys:
        prof = db.execute(
            select(AnalysisProfile).where(AnalysisProfile.key == key)
        ).scalar_one_or_none()
        if prof is None:
            return no(f"c5: {key} is not a profile")
        if not prof.active:
            return no(f"c5: {key} is inactive")
        if prof.coa_archetype != "limit_table":
            return no(f"c5: {key} archetype is {prof.coa_archetype}")
        members = prof.analysis_services
        if not members or any(m.origin != "mk1" for m in members):
            return no(f"c5: {key} is not an all-mk1 profile")

    # c4: at least one ordered native profile produced a section.
    if sections is not None and not sections:
        return no("c4: no native section")

    return ALaCarteVerdict(True, "eligible")
