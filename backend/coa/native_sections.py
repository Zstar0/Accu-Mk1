"""Native COA sections: catalog-derived certificate sections from Mk1 results.

One builder, two entry points (spec 2): the primary-COA path calls
build_native_sections in-process; GET /samples/{id}/coa-sections exposes the
same document to Integration Service for the additional-COA path. The document
is passed to COABuilder verbatim as `native_sections`.

FAIL-CLOSED: every abort raises NativeSectionsError with a rule-specific
message. A heavy-metals result is a paid, reportable test — if the document
cannot be assembled completely and correctly, the certificate must not be
generated at all. (Contrast with the variance overlay, which is best-effort.)

Slice 1 of spec ownership (2026-08-03): Mk1 resolves the analysis_service_specs
rule per member row, fills specification (structured dict) + conforms, and
rule 5 — no resolvable active spec — aborts here at the producer.

Partial-COA deferral (2026-08-29, P-2432): a profile with ZERO members
carrying an eligible result (e.g. an armed add-on the bench hasn't run yet)
is not the same failure as Rule 4's half-filled section — nothing has been
tested, so there is nothing incomplete to print. That profile is DEFERRED
(omitted from `sections`, logged loudly, and named in the wire document's
`deferred_sections` list) instead of aborting the whole certificate. Rule 4
still aborts, unchanged, the moment a profile has SOME eligible members and
SOME missing — a half-filled section must never print. See
build_native_sections for the eligible/partial/deferred split.

Withdrawn member (2026-09-14): a member the lab REMOVED from the sample in
Manage Analyses (every parent-tier row dead, one of them 'rejected') is not
missing — it is no longer a paid test on this sample — so it is skipped and
logged rather than aborting the section (a metal that could not be run).
"""
from __future__ import annotations

import logging
import math
from typing import NamedTuple, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.spec_rules import (SpecRuleError, effective_unit, evaluate, normalize_matrix,
                            resolve_spec, sample_peptide_id)
from coa.text_macros import format_lod, resolve
from sub_samples.service import fetch_sample_services, variance_plan_for_parent
from sub_samples.variance_tests import (DEAD_ROW_STATES, VariancePlan,
                                        replicate_anchor_vials, variance_run_problems)

log = logging.getLogger(__name__)

# Mirror of the states a native result may be certified from. Deliberately
# narrower than coa/source_resolver._LIVE_RESULT_STATES: native services have
# no SENAITE verify step, so Mk1 review_state is the only gate that exists.
ELIGIBLE_STATES = ("verified", "published")

# Liveness predicate for the lab-added union below. MUST stay in lockstep with
# lims_analyses.manage_native.DEAD_STATES — the import runs the other way
# (manage_native imports this module), so the tuple is duplicated there and a
# drift-guard test pins the pair (test_native_sections_lab_added). Here it is
# the one dead-state list the Variance rows use (sub_samples.variance_tests).
_DEAD_STATES = DEAD_ROW_STATES


def _lab_added_profile_keys(db: Session, parent_pk: int) -> list[str]:
    """Keys of ACTIVE profiles with >=1 member service carrying a LIVE
    parent-tier row ('ordered' placeholder or non-dead 'canonical' — the same
    "on the sample" notion as manage_native._live_parent_service_ids).

    Gate-rule change (2026-09-01, Handler ruling): the order is no longer the
    SOLE authority for reportable native profiles. A profile the lab put on
    the sample via Manage Analyses (comps, format retrofits) reports exactly
    like an ordered one; removing it there (rows rejected/retracted) withdraws
    it. Archetype/all-mk1/rules 3-5 still apply downstream — this helper only
    widens which keys are CONSIDERED, never what may print."""
    from models import AnalysisProfile, LimsAnalysis

    live_service_ids = set(db.execute(
        select(LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.provenance.in_(("ordered", "canonical")),
            LimsAnalysis.review_state.notin_(_DEAD_STATES),
        )
    ).scalars().all())
    live_service_ids.discard(None)
    if not live_service_ids:
        return []
    keys: list[str] = []
    for prof in db.execute(
        select(AnalysisProfile).where(AnalysisProfile.active.is_(True))
    ).scalars():
        if any(m.id in live_service_ids for m in prof.analysis_services):
            keys.append(prof.key)
    return keys


class NativeSectionsError(Exception):
    """Any condition that must abort COA generation (fail-closed rules 1-5)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def _ordered_native_profiles(db: Session, services: dict, package: Optional[str],
                             *, require_archetype: bool = True) -> list:
    """Profiles that are ordered AND (by default) reportable.

    require_archetype=True  — the COA path: a profile with no coa_archetype
                              cannot be rendered, so it is excluded.
    require_archetype=False — the placeholder path
                              (lims_analyses/parent_placeholders.py): the bench
                              must see a paid test whether or not it can be
                              printed yet. Archetype is a RENDERING concern;
                              it must not decide whether a test is visible.

    The all-mk1 member gate is NOT optional either way — a mixed-origin profile
    is not native, for any caller.
    """
    from models import AnalysisProfile

    ordered_keys = [k for k, v in (services or {}).items() if v]
    if package:
        ordered_keys.append(package)
    ordered_keys = list(dict.fromkeys(ordered_keys))  # order-preserving dedup

    out = []
    for key in ordered_keys:
        prof = db.execute(
            select(AnalysisProfile).where(AnalysisProfile.key == key)
        ).scalar_one_or_none()
        if prof is None:
            continue
        if require_archetype:
            # Slice 8: legacy_hplc rides page 1 via coa/hplc_shim.py and
            # must never surface as a native_sections page-2 section (coab
            # aborts on an unknown archetype) — treated like NULL here.
            # Local import: hplc_shim imports NativeSectionsError from this
            # module at load time, so a module-level import back would cycle.
            # MB5: legacy_bw rides page 1 via coa/bw_shim.py on the same terms.
            from coa.bw_shim import LEGACY_BW_ARCHETYPE
            from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
            if prof.coa_archetype in (None, LEGACY_HPLC_ARCHETYPE, LEGACY_BW_ARCHETYPE):
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
    at most one row is in an eligible state today — but that is an invariant
    of the promote code (lims_analyses/service.py), three files away and with
    no test that pins it for the parent tier specifically. The design spec
    (2026-07-28-native-coa-sections-design.md:73) states the "current" row
    condition explicitly: `retest_of_id IS NULL`. Enforce it here rather than
    depending on an invariant this module doesn't own. `.order_by(id.desc())`
    + `.first()` (not `scalar_one_or_none()`) mirrors
    `parent_mirror._existing_shadow`'s idiom for the same risk class: if an
    anomaly ever produces more than one live row, resolve deterministically to
    the newest rather than raising.
    """
    from models import LimsAnalysis

    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.analysis_service_id == service_id,
            # Only a promoted canonical row can be certified. An 'ordered'
            # placeholder has no result; without this clause the only thing
            # keeping it out of a certificate is its review_state.
            LimsAnalysis.provenance == "canonical",
            LimsAnalysis.review_state.in_(ELIGIBLE_STATES),
            LimsAnalysis.retest_of_id.is_(None),
        ).order_by(LimsAnalysis.id.desc())
    ).scalars().first()


def _replicate_row(db: Session, vial_pk: int, service_id: int):
    """A replicate vial's current row for a member service: not retested,
    not rejected or retracted, newest id (the HPLC series' current-row
    idiom, coa/variance_series.py). Its state is NOT filtered here: the
    caller refuses anything that is not variance_verified with a result."""
    from models import LimsAnalysis

    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == vial_pk,
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state.notin_(DEAD_ROW_STATES),
        ).order_by(LimsAnalysis.id.desc())
    ).scalars().first()


def _withdrawn_by_lab(db: Session, parent_pk: int, service_id: int) -> bool:
    """True iff the lab took this member OFF the sample in Manage Analyses
    (lims_analyses/manage_native.remove_parent_native_analysis): every
    parent-tier row for the service is dead AND at least one is 'rejected'.
    'rejected' is the soft-reject signature — parent-tier reject is reachable
    only through soft_reject_parent_placeholder. A retest cascade only
    RETRACTS, and the 'ordered' placeholder is never retired (it stays live
    through promote and retest), so a member that is pending, under retest,
    or never seeded still reads as missing and Rule 4 aborts."""
    from models import LimsAnalysis

    states = db.execute(
        select(LimsAnalysis.review_state).where(
            LimsAnalysis.lims_sample_pk == parent_pk,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.analysis_service_id == service_id,
        )
    ).scalars().all()
    return (bool(states) and all(s in _DEAD_STATES for s in states)
            and "rejected" in states)


def _method_label(db: Session, method_id: Optional[int]) -> str:
    if method_id is None:
        return ""
    from models import HplcMethod

    m = db.get(HplcMethod, method_id)
    return (m.name or "") if m is not None else ""


# Rule kinds whose printed result is censored against an LOQ. A report-only
# (informational) row censors too: no verdict, but "< <LOQ>" (e.g. "< 0.5")
# when at or below it.
_LOQ_KINDS = ("range", "informational")


def _spec_wire_dict(spec) -> dict:
    """The structured `specification` wire field. Floats (not Decimal) so the
    JSON is stable; display stays None unless the lab filed an override —
    COABuilder owns the formatting."""
    return {
        "rule_kind": spec.rule_kind,
        "equals": spec.equals_value,
        "min": float(spec.min_value) if spec.min_value is not None else None,
        "max": float(spec.max_value) if spec.max_value is not None else None,
        "unit": spec.unit,
        "display": spec.display_override,
        # Range and report-only rows censor; equals rows never do, so
        # publishing a stray loq filed on one (tolerated at write time) would
        # contradict the wire's own convention and light the consumer's LOQ
        # column regardless.
        "loq": (float(spec.loq)
                if spec.rule_kind in _LOQ_KINDS and spec.loq is not None else None),
    }


def effective_loq(row, spec) -> Optional[float]:
    """The LOQ a result is reported against (endo slice 3, spec section 7):
    the result's own (lims_analyses.loq, filled by the worksheet promote)
    when it carries one, else the spec row's. Heavy metals carry none, so
    theirs stays the spec's."""
    loq = row.loq if row.loq is not None else spec.loq
    return float(loq) if loq is not None else None


def _result_display(spec, result, loq: Optional[float], *,
                    floor: bool = False) -> Optional[str]:
    """Mk1's applied lab-reporting convention for the PRINTED result; the
    verdict never reads it. Two conventions: LOQ censoring on range and
    report-only rows, against the effective LOQ (effective_loq), and a floor
    reading (endo ">"), range rows only: evaluate() refuses a floor on any
    other kind before this runs. evaluate() guarantees a finite numeric for
    range rows but NOT for report-only ones (it returns None without reading
    the result), so the float/isfinite guards below are policy for those: a
    text result ("ND", "Not Detected") is never censored.

    Every surface downstream mirrors result_display verbatim (coabuilder's
    validator, its fixed digital key list, the PDF cell, the AccuVerify page
    and badge, the customer portal), so this string is the whole printed
    convention — no new wire key, no coabuilder or WordPress change."""
    if spec.rule_kind not in _LOQ_KINDS or (loq is None and not floor):
        return None
    try:
        value = float(str(result or "").strip())
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    # A floor prints the number it is at least. The qualifier is the whole
    # point of the row, so it is never censored away by the LOQ rule below:
    # a floor is by definition above its own LOQ. evaluate(floor=True) has
    # already refused anything that is not a definitive failure, so the only
    # floor that reaches here is one the certificate marks non-conforming.
    # It returns before the LOQ rule, so a floor with no LOQ never reaches
    # the f-string below.
    if floor:
        return f"> {value:g}"
    # At-or-below the LOQ prints "< <LOQ>", e.g. "< 25" (Handler ruling
    # 2026-09-14: a result reported AT the LOQ is the reporting floor, not a
    # quantified figure, Endotoxin USP85 2.50 vs LOQ 2.5). The number, not the
    # word "LOQ", since 2026-10-17 (Handler: another lab read "< LOQ" as
    # oddly laid out). `:g` is COABuilder's LOQ-column format, so the two
    # cells always agree. The verdict still uses the raw number.
    # A "<25 EU/vial" result is stored as 25 with LOQ 25 (endo slice 3).
    return f"< {loq:g}" if value <= loq else None


def _section_footnotes(raw, values: dict) -> list:
    """The profile's footnotes with macros resolved (endo slice 4). A note
    whose text resolves to nothing is dropped, so its label never prints
    alone. Anything that is not a {label, text} dict passes through as
    before (the builder's fail-open rule for rows written by SQL)."""
    if not isinstance(raw, list):
        return []
    out = []
    for note in raw:
        if isinstance(note, dict) and isinstance(note.get("text"), str):
            text = resolve(note["text"], values)
            if not text:
                continue
            if text != note["text"]:
                note = {**note, "text": text}
        out.append(note)
    return out


def _member_row(db: Session, prof, svc, row, *, sample_id, matrix, peptide_id,
                sample_form_id, form_tier) -> tuple[dict, tuple, bool]:
    """One printed row for member `svc` from result row `row`: (the wire row,
    its (lod, lod_unit), whether it is a report-only row filed for the
    sample's form). Raises NativeSectionsError (Rules 3 and 5, an unappliable
    rule). The base row of a profile and every Variance run row go through
    here, so each run is judged by the same spec engine and carries its own
    specification.loq and conforms."""
    if not (row.result_value or "").strip():
        # Rule 3 (row half): an eligible row with an empty result.
        raise NativeSectionsError(
            f"native sections: profile '{prof.key}' row "
            f"'{svc.keyword}' has an empty result on {sample_id}"
        )
    unit = row.result_unit or (svc.unit or "")
    if unit == "":
        # A numeric result with a blank unit is the ENDO-LAL failure
        # class (catalog unit missing), but pH's unit is legitimately
        # blank, so this is NOT a rule-3 abort. Surface it instead of
        # printing it silently; the section still builds.
        log.warning(
            "native_section_blank_unit sample=%s profile=%s keyword=%s",
            sample_id, prof.key, svc.keyword,
        )
    spec = resolve_spec(db, svc.id, matrix, peptide_id=peptide_id,
                        unit=effective_unit(row.result_unit, svc.unit),
                        sample_form_id=sample_form_id)
    if spec is None:
        # Rule 5 (relocated from COABuilder): a result must not print
        # without a verdict. Names the service, every tier consulted
        # (peptide/matrix/wildcard) and the unit (endo slice 3: a
        # result is judged only by a spec in its own unit), so the lab
        # knows exactly which analysis_service_specs row to file.
        raise NativeSectionsError(
            f"native sections: profile '{prof.key}' member service "
            f"'{svc.keyword}' (id={svc.id}) has no active spec "
            f"(tiers consulted: peptide={peptide_id!r}, "
            f"{form_tier}matrix={matrix!r}, wildcard) on {sample_id}: No active "
            f"{svc.title} spec in {unit or 'no unit'} for "
            f"{matrix or 'any sample type'}. File one in "
            f"analysis_service_specs"
        )
    floor = bool(row.result_floor)
    try:
        conforms = evaluate(spec, row.result_value, floor=floor)
    except SpecRuleError as e:
        raise NativeSectionsError(
            f"native sections: profile '{prof.key}' row "
            f"'{svc.keyword}' on {sample_id}: {e.detail}"
        ) from e
    # The result's own LOQ wins over the spec's (endo slice 3, spec
    # section 7): it decides "< <LOQ>" and rides specification.loq, the
    # field coabuilder's LOQ column and the digital COA already read.
    # Range and report-only rows, as _spec_wire_dict publishes it. A
    # row without its own LOQ (every heavy metal) keeps the spec's,
    # byte for byte.
    loq = effective_loq(row, spec)
    specification = _spec_wire_dict(spec)
    if spec.rule_kind in _LOQ_KINDS:
        specification["loq"] = loq
    out = {
        "keyword": svc.keyword,
        "name": svc.title,
        "result": row.result_value,
        "unit": unit,
        "method": _method_label(db, row.method_id),
        "specification": specification,
        "conforms": conforms,
        "result_display": _result_display(spec, row.result_value, loq,
                                          floor=floor),
    }
    form_report_only = (spec.rule_kind == "informational"
                        and spec.sample_form_id is not None)
    return out, (row.lod, row.lod_unit), form_report_only


def _merged_services(db: Session, parent) -> tuple:
    """(raw IS payload, services) for the parent: the order lookup (Rule 1,
    fail-closed) plus the lab-added and native-retest unions. Shared by the
    builder and the publish guard so both judge the same services."""
    sample_id = parent.sample_id

    # Rule 1: the order lookup itself is fail-closed.
    try:
        raw = fetch_sample_services(sample_id)
    except Exception as e:
        raise NativeSectionsError(
            f"native sections: order lookup failed for {sample_id}: {e}"
        ) from e

    # Lab-added union (2026-09-01 gate-rule change): profiles the lab put on
    # the sample via Manage Analyses report like ordered ones. An ordered
    # False key the lab deliberately added anyway flips True, same authority
    # the seeding union already grants (manage_native.placeholder_profile_keys).
    services = dict(((raw or {}).get("services")) or {})
    for key in _lab_added_profile_keys(db, parent.id):
        if not services.get(key):
            services[key] = True
    # Native retest: carried profiles report from the retest's own carried
    # rows, whatever shape the IS payload gives their keys. Keys in `missing`
    # were never on the original, so nothing was carried for them.
    snapshot = parent.catalog_snapshot or {}
    if not isinstance(snapshot, dict):
        # Fail closed (was an AttributeError, a 500): a retest's carried
        # profiles cannot be read, so nothing may print without them.
        raise NativeSectionsError(
            f"native sections: the registration snapshot is unreadable on {sample_id}")
    rider = snapshot.get("retest") or {}
    for key in set(rider.get("carry") or []) - set(rider.get("missing") or []):
        if not services.get(key):
            services[key] = True

    return raw, services


def build_native_sections(db: Session, parent, *, vial_parent_ids=None,
                          trace: Optional[list] = None) -> dict:
    """Assemble the native-sections wire document for a parent LimsSample.

    `vial_parent_ids` (per-vial certificates, 2026-10-20): the ids of the
    certified parent-tier rows promoted from ONE vial. When given, a profile
    member prints only if its eligible row is one of them; a member that is
    not this vial's is skipped (it belongs to another vial, it is not
    pending), a profile left with no members is dropped, nothing is deferred,
    and ordered_profiles lists only the profiles that printed. The parent
    document (None) is unchanged.

    Returns {"sample_id", "ordered_profiles", "sections"}, plus
    "deferred_sections" (list of profile keys) when one or more profiles were
    deferred rather than aborted; the key is OMITTED entirely when nothing
    was deferred (additive-only wire shape; existing consumers see no
    difference). An order with no reportable native profiles yields empty
    lists, a VALID document (the ordered_profiles cross-check is what lets
    callers distinguish "nothing ordered" from "something broke"). All
    non-deferral failures raise NativeSectionsError.

    `trace` (a list, filled in place, never on the wire): one entry per
    planned four-test Variance profile, in print order, the content
    `variance_fingerprint` hashes. The publish guard compares it with the
    one recorded when the draft was generated.
    """
    raw, services = _merged_services(db, parent)
    return _build_from_services(db, parent, raw, services,
                                vial_parent_ids=vial_parent_ids, trace=trace)


def _build_from_services(db: Session, parent, raw, services, *, vial_parent_ids,
                         trace: Optional[list] = None) -> dict:
    """build_native_sections after the order lookup (see its docstring)."""
    sample_id = parent.sample_id

    if raw is None and not services:
        # IS 404 — no linked order AND nothing lab-added. Nothing native can
        # have been bought or granted; same empty document as before.
        return {"sample_id": sample_id, "ordered_profiles": [], "sections": []}

    profiles = _ordered_native_profiles(db, services, (raw or {}).get("package"))
    matrix = normalize_matrix(parent.sample_type_title)
    # R6: the identity anchor is the peptide_id FK, resolved once per parent
    # (not per row) — a blend or a non-peptide family returns None (R5), and
    # resolve_spec then coarsens straight to the matrix/wildcard tier.
    peptide_id = sample_peptide_id(db, parent.id)
    # The parent's dosage form is a spec tier (sample forms); a vial's rows
    # are judged here too, by its parent's form.
    sample_form_id = getattr(parent, "sample_form_id", None)
    if matrix != "Peptide":
        sample_form_id = None        # the form tier is peptide-family only (resolve_spec)
    # The form tier is only "consulted" when the sample has a form.
    form_tier = f"form={sample_form_id!r}, " if sample_form_id is not None else ""
    # Add-on test Variance: resolved once, from the merged services (they
    # carry `variance`), for the parent document only. None (no four-key
    # entry, every sample today) prints exactly today's rows; the per-vial
    # document never resolves a plan.
    plan = (variance_plan_for_parent(db, parent, services)
            if vial_parent_ids is None else None)
    if plan is not None and plan.errors:
        # An entry Mk1 cannot fulfil aborts the WHOLE document, whichever
        # profile it names: the lock skips its guard when the Integration
        # Service is down, so this is the only place it is caught.
        raise NativeSectionsError(f"native sections: {plan.errors[0]} on {sample_id}")

    sections = []
    deferred_profiles: list[str] = []
    for prof in profiles:
        # Resolve every member's eligible row up front so we can tell
        # "nothing tested yet" (defer) apart from "some results are still
        # missing" (Rule 4 abort) BEFORE committing to either path.
        member_rows = [
            (svc, _eligible_parent_row(db, parent.id, svc.id))
            for svc in prof.analysis_services
        ]
        if vial_parent_ids is not None:
            member_rows = [(svc, row) for svc, row in member_rows
                           if row is not None and row.id in vial_parent_ids]
            if not member_rows:
                continue
        if all(row is None for _, row in member_rows):
            # Partial-COA deferral: zero eligible members means the profile
            # hasn't been started, not that it's half-finished. Omit the
            # section, log loudly (a silently-dropped paid test is exactly
            # what Rule 4 exists to prevent — this must stay visible), and
            # flag it on the wire so the operator can regenerate later.
            log.warning(
                "native_section_deferred sample=%s profile=%s reason=no_eligible_results",
                sample_id, prof.key,
            )
            deferred_profiles.append(prof.key)
            if trace is not None and plan is not None and plan.for_key(prof.key) is not None:
                trace.append({"profile_key": prof.key, "deferred": True, "runs": []})
            continue

        rows = []
        # (lod, lod_unit) of every printed row, for the profile text's {lod}
        # (endo slice 4).
        limits: list[tuple] = []
        # Whether every printed row is a report-only row filed for the
        # sample's form (the basis-note rule below).
        all_form_report_only = True
        # The members that printed (a withdrawn member is skipped), in
        # member order: every Variance run prints the same members.
        printed = []
        printed_rows = []
        for svc, row in member_rows:
            if row is None:
                if _withdrawn_by_lab(db, parent.id, svc.id):
                    # The lab removed this member from the sample in Manage
                    # Analyses (e.g. a metal that could not be run) — it is
                    # no longer a paid, reportable test on THIS sample, so
                    # the section prints without it. Logged, never silent.
                    log.warning(
                        "native_section_member_withdrawn sample=%s profile=%s keyword=%s",
                        sample_id, prof.key, svc.keyword,
                    )
                    continue
                # Rule 4: a partially-pending profile — SOME members have an
                # eligible result and this one doesn't — makes the section
                # INCOMPLETE — abort, never skip. (A fully-pending profile
                # never reaches here; it was deferred above.)
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' member service "
                    f"'{svc.keyword}' (id={svc.id}) has no eligible result "
                    f"(need review_state in {ELIGIBLE_STATES}) on {sample_id} "
                    f"— enter and verify it, or remove it from the sample in "
                    f"Manage Analyses to issue the certificate without it"
                )
            row_out, limit, form_report_only = _member_row(
                db, prof, svc, row, sample_id=sample_id, matrix=matrix,
                peptide_id=peptide_id, sample_form_id=sample_form_id,
                form_tier=form_tier)
            rows.append(row_out)
            limits.append(limit)
            all_form_report_only = all_form_report_only and form_report_only
            printed.append(svc)
            printed_rows.append(row)
        if not rows:
            # Rule 3 (section half): unreachable while members are required
            # non-empty in _ordered_native_profiles, kept as defence.
            raise NativeSectionsError(
                f"native sections: profile '{prof.key}' produced zero rows on {sample_id}"
            )
        rv = plan.for_key(prof.key) if plan is not None else None
        if rv is not None:
            # Add-on test Variance (contract, Mk1 to COABuilder): one ordinary
            # row per run, run by run. Run 1 is today's rows with a suffix;
            # runs 2..n are the in-set replicate anchors in vial order, one
            # row per printed member, judged like the base row. No identity
            # gate, no mean, no summary row.
            # Completeness is the builder's job (the lock and the generate
            # gate fail open when the Integration Service is down), so every
            # check runs before any replicate row is appended. Sign-off
            # first: variance_run_problems counts live rows, and a row that
            # was never entered is live, so its counts are trusted only once
            # every anchor's rows are signed off with a result.
            anchors = replicate_anchor_vials(db, parent.id, rv.role)
            runs = []
            for i, vial in enumerate(anchors, 2):
                run = []
                for svc in printed:
                    rep = _replicate_row(db, vial.id, svc.id)
                    if (rep is None or rep.review_state != "variance_verified"
                            or not (rep.result_value or "").strip()):
                        raise NativeSectionsError(
                            f"native sections: '{prof.key}' run {i} (vial "
                            f"{vial.sample_id}) member '{svc.keyword}' is not signed "
                            f"off (needs variance_verified with a result) on {sample_id}"
                        )
                    run.append((svc, rep))
                runs.append((i, run))
            # The shared run-count check (Task 12, the lock's) decides pass
            # or fail for this role; the customer-facing sentence is ours.
            problems = variance_run_problems(
                db, parent, VariancePlan({rv.role: rv}, (), ()))
            if problems:
                k = len(anchors)
                if k < rv.replicate_runs:
                    tail = "finish them or set the Variance count"
                elif k > rv.replicate_runs:
                    tail = "take the extra vials out of the variance set"
                else:
                    # The count is right, so the helper found no core anchor.
                    raise NativeSectionsError(
                        f"native sections: '{prof.key}' core run has no live result on "
                        f"its core vial (role {rv.role}) on {sample_id}; restore or "
                        f"re-run the core vial")
                raise NativeSectionsError(
                    f"native sections: '{prof.key}' bought {rv.n} runs, {k} replicate "
                    f"runs carry results on {sample_id}; {tail}"
                )
            for row_out, svc in zip(rows, printed):
                row_out["name"] = f"{svc.title}, {rv.run_label} 1"
            traced = [_trace_row(1, row, row_out) for row_out, row in zip(rows, printed_rows)]
            for i, run in runs:
                for svc, rep in run:
                    row_out, limit, form_report_only = _member_row(
                        db, prof, svc, rep, sample_id=sample_id, matrix=matrix,
                        peptide_id=peptide_id, sample_form_id=sample_form_id,
                        form_tier=form_tier)
                    row_out["name"] = f"{svc.title}, {rv.run_label} {i}"
                    traced.append(_trace_row(i, rep, row_out))
                    rows.append(row_out)
                    limits.append(limit)
                    all_form_report_only = all_form_report_only and form_report_only
            if trace is not None:
                trace.append({"profile_key": prof.key, "deferred": False, "runs": traced})
        # Endo slice 4: the profile's COA text may carry {lod} and optional
        # [ ... ] segments, filled from this section's rows (coa.text_macros).
        # Text with no macro comes back exactly as typed.
        values = {"lod": format_lod(limits)}
        # A heavy-metal basis note describes how the limits scale ("Limits
        # scale with dose"); a section whose every row is a report-only row
        # filed for the sample's form (nasal spray) has no limits to describe,
        # so the note would be noise. Form rows only (Handler, 2026-10-28,
        # after the prod pre-check): a section that is report-only for every
        # sample, like the vial vacuum test, uses its note to describe the
        # method and keeps it. The key stays on the wire.
        sections.append({
            "profile_key": prof.key,
            "title": prof.coa_section_title or prof.name,
            "archetype": prof.coa_archetype,
            "sort_order": prof.coa_sort_order,
            "basis_note": (None if all_form_report_only
                           else resolve(prof.coa_basis_note, values)),
            "method_text": resolve(prof.coa_method_text, values),
            "prep_text": resolve(prof.coa_prep_text, values),
            # Fail-open to [] on a malformed container is deliberate: the
            # certificate must not 500 on a bad footnote row (module's
            # NativeSectionsError-only failure surface). The validated
            # routes enforce list shape on every authored write — a non-list
            # here means seed/migration/direct SQL, not user input.
            "footnotes": _section_footnotes(prof.coa_footnotes, values),
            "rows": rows,
        })

    if plan is not None:
        # A planned test whose profile never reached the loop (not
        # reportable, not all-native) would lose its paid runs silently.
        # A deferred profile is accounted for (deferred_sections, trace).
        reached = {s["profile_key"] for s in sections} | set(deferred_profiles)
        for rv in sorted(plan.by_role.values(), key=lambda rv: rv.key):
            if rv.key not in reached:
                raise NativeSectionsError(
                    f"native sections: '{rv.key}' bought {rv.n} Variance runs but its "
                    f"profile does not print on {sample_id} (not reportable or not "
                    f"all-native); fix the profile or set the Variance count")

    if vial_parent_ids is not None:
        return {
            "sample_id": sample_id,
            "ordered_profiles": [s["profile_key"] for s in sections],
            "sections": sections,
        }
    doc = {
        "sample_id": sample_id,
        "ordered_profiles": [p.key for p in profiles],
        "sections": sections,
    }
    if deferred_profiles:
        # ordered_profiles is UNCHANGED — it still lists the deferred
        # profile's key (spec: coab's ordered_profiles ⊆ sections check
        # tolerates a key with no matching section; do not touch coab).
        doc["deferred_sections"] = deferred_profiles
    return doc


# ── Add-on test Variance: generation fingerprint and the publish guard ─────
#
# Publish ships an existing draft and never builds the document. So each
# generation records, on its `coa_generated` sample event, a fingerprint of
# the four-test Variance content the builder returned (`trace`), and publish
# rebuilds and compares. Whatever changed since (a retest, a rejected row, a
# vial out of the set, a kind or role flip, a count change, a deferral, a
# core row) changes the build or the fingerprint.

GENERATED_EVENT = "coa_generated"


def _trace_row(run: int, row, row_out: dict) -> dict:
    return {"run": run, "vial_pk": row.lims_sub_sample_pk, "row_pk": row.id,
            "keyword": row_out["keyword"], "result": row_out["result"],
            "result_display": row_out.get("result_display"),
            "conforms": row_out.get("conforms")}


def _canonical(trace: list) -> list:
    """The trace as it reads back from a JSON column."""
    import json
    return json.loads(json.dumps(trace, default=str))


def variance_fingerprint(trace: list) -> str:
    """sha256 of the canonical JSON (sorted keys) of a builder `trace`. A
    document with no four-test plan has the fingerprint of []."""
    import hashlib
    import json
    return hashlib.sha256(json.dumps(_canonical(trace), sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def _recorded_generations(db: Session, sample_id: str) -> list:
    """details of the sample's parent `coa_generated` events, newest first
    (per-vial events, which carry vial_sequence, left out). ONE indexed read
    (lims_samples.sample_id, ix_lims_sub_sample_events_parent)."""
    from models import LimsSample, LimsSubSampleEvent
    rows = db.execute(
        select(LimsSubSampleEvent.details)
        .join(LimsSample, LimsSample.id == LimsSubSampleEvent.lims_sample_pk)
        .where(LimsSample.sample_id == sample_id,
               LimsSubSampleEvent.event == GENERATED_EVENT)
        .order_by(LimsSubSampleEvent.id.desc())
    ).scalars().all()
    return [d or {} for d in rows if "vial_sequence" not in (d or {})]


def _printed_runs(details: dict) -> bool:
    return bool((details.get("variance") or {}).get("trace"))


def _variance_scope(db: Session, sample_id: str):
    """(in scope, recorded generations, parent or None). In scope when ANY
    recorded parent generation printed Variance runs (a newer event without
    a record, from a sub-sample generation or a failed record write, never
    takes a sample out), or the sample has a variance vial of a four-test
    role (any set state). A sample with no variance vial and no recorded
    runs costs exactly two SELECTs (the events read, the vial read); one
    with variance vials of other roles (HPLC) adds variance_test_roles'
    catalog read."""
    from sub_samples.variance_tests import four_test_replicate_parent
    generations = _recorded_generations(db, sample_id)
    parent = four_test_replicate_parent(db, sample_id)
    in_scope = parent is not None or any(_printed_runs(g) for g in generations)
    return in_scope, generations, parent


def variance_generation_record(db: Session, sample_id: str, trace: list, *,
                               generation_id=None) -> Optional[dict]:
    """`details["variance"]` for the `coa_generated` event of a successful
    generation, or None to leave the event exactly as today (no runs printed
    and the sample out of the guard's scope)."""
    if not trace and not _variance_scope(db, sample_id)[0]:
        return None
    trace = _canonical(trace)
    return {"fingerprint": variance_fingerprint(trace),
            "runs": len({(p["profile_key"], r["run"]) for p in trace for r in p["runs"]}),
            "generation_id": generation_id,
            "trace": trace}


def _first_difference(old: list, new: list, draft: str) -> tuple[str, str]:
    """(the first differing profile and run in plain words, the same with
    no result values: the profile key and run number, for logs)."""
    from itertools import zip_longest
    old_by = {p["profile_key"]: p for p in old}
    new_by = {p["profile_key"]: p for p in new}
    state = {True: "deferred", False: "printed"}
    for key in dict.fromkeys([p["profile_key"] for p in old] + [p["profile_key"] for p in new]):
        o, n = old_by.get(key), new_by.get(key)
        if o is None:
            return f"'{key}' prints Variance runs now but not on {draft}", f"'{key}'"
        if n is None:
            return f"'{key}' printed Variance runs on {draft} but no longer does", f"'{key}'"
        if o["deferred"] != n["deferred"]:
            return (f"'{key}' was {state[o['deferred']]} on {draft} and is "
                    f"{state[n['deferred']]} now", f"'{key}'")
        for a, b in zip_longest(o["runs"], n["runs"]):
            if a == b:
                continue
            ref = a or b
            short = f"'{key}' run {ref['run']}"
            if a is None:
                return f"'{key}' run {b['run']} member '{b['keyword']}' is new since {draft}", short
            if b is None:
                return (f"'{key}' run {a['run']} member '{a['keyword']}' on {draft} no longer "
                        f"prints", short)
            where = f"'{key}' run {a['run']} member '{a['keyword']}'"
            if ((a["result"], a.get("result_display")) == (b["result"], b.get("result_display"))
                    and a.get("conforms") != b.get("conforms")):
                return (f"{where}: the verdict of the same printed result {a['result']} "
                        f"changed since {draft}", short)
            printed = ("result", "result_display", "conforms")
            if any(a.get(k) != b.get(k) for k in printed):
                was = a["result"] if a["result"] != b["result"] else a.get("result_display")
                now = b["result"] if a["result"] != b["result"] else b.get("result_display")
                return f"{where} printed {was} on {draft}, now {now}", short
            return f"{where} now comes from a different vial or result row than on {draft}", short
    return f"the Variance runs differ from {draft}", "the Variance runs"


class Refusal(NamedTuple):
    """Why publish is refused: `detail` for the lab (the 409), `log_detail`
    the same without result values (scheduled publish logs and stores it)."""
    detail: str
    log_detail: str


def _stale(sample_id: str, detail: str, short: str) -> Refusal:
    head = (f"cannot publish {sample_id}: a Variance run changed after this certificate "
            f"was generated; regenerate it first")
    return Refusal(f"{head} ({detail})", f"{head} ({short})")


def variance_publish_refusal(db: Session, sample_id: str, *, draft_badge) -> Optional[Refusal]:
    """Why the draft Publish would ship must not be published, or None.

    Out of scope (see _variance_scope) it returns None after the scope
    reads and calls nothing else. In scope it rebuilds the parent document with
    the builder generation uses (read-only; a failed order lookup refuses,
    Rule 1), then compares the rebuilt fingerprint with the one recorded
    for the draft. `draft_badge` is a zero-argument callable returning the
    draft's badge (integration_db.fetch_publish_draft_badge), called only in
    scope; a failed read refuses, no draft at all passes (nothing to ship)."""
    from models import LimsSample
    in_scope, generations, parent = _variance_scope(db, sample_id)
    if not in_scope:
        return None
    if parent is None:
        parent = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)
                            ).scalar_one_or_none()
        if parent is None:
            return None
    trace: list = []
    try:
        raw, services = _merged_services(db, parent)
        _build_from_services(db, parent, raw, services, vial_parent_ids=None, trace=trace)
    except NativeSectionsError as e:
        # The builder's detail can carry a result value (a SpecRuleError
        # interpolates it): the lab's 409 only, never the log text.
        cause = e.__cause__ or e
        return Refusal(f"cannot publish {sample_id}: {e.detail}",
                       f"cannot publish {sample_id}: the rebuilt document was refused "
                       f"({type(cause).__name__})")
    trace = _canonical(trace)
    try:
        badge = draft_badge()
    except Exception as e:  # noqa: BLE001 (in scope, a failed read refuses)
        msg = (f"cannot publish {sample_id}: the draft certificate could not be read to "
               f"check its Variance runs ({type(e).__name__}); try again")
        return Refusal(msg, msg)
    if badge is None:
        return None
    number = badge.get("generation_number")
    draft = f"draft #{number}" if number is not None else "the draft"
    # Matcher: by identity. The draft's verification code when the badge has
    # one (every coa_generated event stores it), else its generation number;
    # a draft with neither matches nothing (no record). Among the matches,
    # the one that carries a record (a sub-sample generation lands a
    # record-less event on the parent).
    code = badge.get("verification_code")
    if code:
        same = [g for g in generations if g.get("verification_code") == code]
    elif number is not None:
        same = [g for g in generations if g.get("generation_number") == number]
    else:
        same = []
    variance = next((g["variance"] for g in same if g.get("variance") is not None), None)
    if variance is None:
        if not trace and not any(_printed_runs(g) for g in generations):
            return None     # no runs printed then or now (a retest sample, no plan)
        detail = f"{draft} has no record of its Variance runs"
        return _stale(sample_id, detail, detail)
    if variance.get("fingerprint") == variance_fingerprint(trace):
        return None
    return _stale(sample_id, *_first_difference(variance.get("trace") or [], trace, draft))
