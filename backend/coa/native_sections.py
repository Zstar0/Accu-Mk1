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
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.spec_rules import (SpecRuleError, effective_unit, evaluate, normalize_matrix,
                            resolve_spec, sample_peptide_id)
from coa.text_macros import format_lod, resolve
from sub_samples.service import fetch_sample_services

log = logging.getLogger(__name__)

# Mirror of the states a native result may be certified from. Deliberately
# narrower than coa/source_resolver._LIVE_RESULT_STATES: native services have
# no SENAITE verify step, so Mk1 review_state is the only gate that exists.
ELIGIBLE_STATES = ("verified", "published")

# Liveness predicate for the lab-added union below. MUST stay in lockstep with
# lims_analyses.manage_native.DEAD_STATES — the import runs the other way
# (manage_native imports this module), so the tuple is duplicated here and a
# drift-guard test pins the pair (test_native_sections_lab_added).
_DEAD_STATES = ("rejected", "retracted")


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
            from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
            if prof.coa_archetype is None or prof.coa_archetype == LEGACY_HPLC_ARCHETYPE:
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


def build_native_sections(db: Session, parent, *, vial_parent_ids=None) -> dict:
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
    deferred rather than aborted — the key is OMITTED entirely when nothing
    was deferred (additive-only wire shape; existing consumers see no
    difference). An order with no reportable native profiles yields empty
    lists — a VALID document (the ordered_profiles cross-check is what lets
    callers distinguish "nothing ordered" from "something broke"). All
    non-deferral failures raise NativeSectionsError.
    """
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
    # False key the lab deliberately added anyway flips True — same authority
    # the seeding union already grants (manage_native.placeholder_profile_keys).
    services = dict(((raw or {}).get("services")) or {})
    for key in _lab_added_profile_keys(db, parent.id):
        if not services.get(key):
            services[key] = True
    # Native retest: carried profiles report from the retest's own carried
    # rows, whatever shape the IS payload gives their keys. Keys in `missing`
    # were never on the original, so nothing was carried for them.
    rider = (parent.catalog_snapshot or {}).get("retest") or {}
    for key in set(rider.get("carry") or []) - set(rider.get("missing") or []):
        if not services.get(key):
            services[key] = True

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
            continue

        rows = []
        # (lod, lod_unit) of every printed row, for the profile text's {lod}
        # (endo slice 4).
        limits: list[tuple] = []
        # Whether every printed row is a report-only row filed for the
        # sample's form (the basis-note rule below).
        all_form_report_only = True
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
            if not (row.result_value or "").strip():
                # Rule 3 (row half): an eligible row with an empty result.
                raise NativeSectionsError(
                    f"native sections: profile '{prof.key}' row "
                    f"'{svc.keyword}' has an empty result on {sample_id}"
                )
            unit = row.result_unit or (svc.unit or "")
            if unit == "":
                # A numeric result with a blank unit is the ENDO-LAL failure
                # class (catalog unit missing) — but pH's unit is legitimately
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
            rows.append({
                "keyword": svc.keyword,
                "name": svc.title,
                "result": row.result_value,
                "unit": unit,
                "method": _method_label(db, row.method_id),
                "specification": specification,
                "conforms": conforms,
                "result_display": _result_display(spec, row.result_value, loq,
                                                  floor=floor),
            })
            limits.append((row.lod, row.lod_unit))
            all_form_report_only = (all_form_report_only
                                    and spec.rule_kind == "informational"
                                    and spec.sample_form_id is not None)
        if not rows:
            # Rule 3 (section half): unreachable while members are required
            # non-empty in _ordered_native_profiles, kept as defence.
            raise NativeSectionsError(
                f"native sections: profile '{prof.key}' produced zero rows on {sample_id}"
            )
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
