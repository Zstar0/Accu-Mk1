"""Native-section spec resolution + verdict (spec-ownership slice 1).

The verdict semantics mirror COABuilder's _verdict — inclusive bounds,
case-insensitive whitespace-trimmed equals — with two DELIBERATE fail-closed
divergences (non-finite false-pass, equals/range abort asymmetry). The
cross-repo parity table in tests/test_spec_rules.py is the contract; its
byte-identical twin lives in coabuilder tests/test_verdict_parity.py.
"""
from __future__ import annotations

import math
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.exc import MultipleResultsFound
from sqlalchemy.orm import Session

# MUST stay identical to coabuilder src/coabuilder_core/logic.py:5
# (_PEPTIDE_MATRICES) — a divergence silently changes which spec resolves.
# Pinned by test_peptide_matrices_parity_with_coabuilder.
_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}


class SpecRuleError(Exception):
    """A spec rule that cannot be applied to a result (fail-closed)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def normalize_matrix(raw: Optional[str]) -> Optional[str]:
    """Sample-type title -> spec-resolution matrix. Mirrors COABuilder's
    Peptide Blend -> Peptide fold. None/blank -> None (resolver then goes
    straight to the NULL-matrix default row)."""
    m = (raw or "").strip()
    if not m:
        return None
    return "Peptide" if m in _PEPTIDE_MATRICES else m


def normalize_unit(unit: Optional[str]) -> str:
    """A unit as specs and results compare it (endo slice 3, spec section 6):
    trimmed, lower case, None as "". "EU/Vial", " eu/vial " and "EU/vial"
    are one unit, and so are NULL and "". The spec uniqueness indexes key on
    the same normalization (lower(btrim(coalesce(unit, ''))))."""
    return (unit or "").strip().lower()


def effective_unit(result_unit: Optional[str], service_unit: Optional[str]) -> str:
    """The normalized unit a result is judged in: its own, else its
    service's catalog unit (a vial row carries none until promote stamps
    one). A blank or whitespace-only result unit counts as none."""
    return normalize_unit(result_unit) or normalize_unit(service_unit)


def _first_in_scope(rows, matrix: Optional[str], peptide_id: Optional[int],
                    sample_form_id: Optional[int] = None):
    """The precedence over already-loaded active rows: (peptide) -> (form)
    -> (matrix) -> (wildcard) -> None. The form scope exists only when the
    sample has a form. Two rows in the winning scope raise
    MultipleResultsFound, as scalar_one_or_none did."""
    scopes = []
    if peptide_id is not None:
        scopes.append(lambda s: s.peptide_id == peptide_id)
    if sample_form_id is not None:
        scopes.append(lambda s: s.sample_form_id == sample_form_id)
    if matrix is not None:
        scopes.append(lambda s: s.matrix == matrix)
    # CRITICAL: the wildcard scope also requires peptide_id IS NULL and
    # sample_form_id IS NULL. Without them, a peptide-bound or form row could
    # masquerade as the default when no true wildcard row exists for this
    # service.
    scopes.append(lambda s: s.matrix is None and s.peptide_id is None
                  and s.sample_form_id is None)
    for in_scope in scopes:
        hits = [s for s in rows if in_scope(s)]
        if len(hits) > 1:
            raise MultipleResultsFound(
                f"{len(hits)} active specs in one scope for analysis service "
                f"{hits[0].analysis_service_id} (spec ids {[s.id for s in hits]})")
        if hits:
            return hits[0]
    return None


def resolve_spec(db: Session, service_id: int, matrix: Optional[str],
                 peptide_id: Optional[int] = None, unit: Optional[str] = None,
                 sample_form_id: Optional[int] = None):
    """Active spec by precedence: (service, peptide) -> (service, form) ->
    (service, matrix) -> (service, wildcard) -> None, over one query for the
    service's active rows.

    sample_form_id (sample forms, spec 2026-10-26) is the sample's dosage
    form. Rows filed under any OTHER form are dropped before the unit filter
    runs, so another form's row in the result's unit can never switch the
    unit filter on for a sample that is not in that form. sample_form_id=None
    drops every form row: a caller that passes no form sees today's tiers.
    The form tier is for peptide-family samples only (final review Ruling
    F-2): callers pass the normalized matrix, and any matrix other than
    "Peptide" ignores the form, so a sample retitled to Bac Water that kept a
    stray form still resolves its BW row.

    Form rows fail closed on unit (final review Ruling F-1). When `unit` is
    given, the sample has a form, and the service has an active row for that
    form, the winner is accepted only if it is peptide-tier, or a row of this
    form in the result's unit (or with no unit, for a result in no unit or in
    the service's catalog unit, the unit-blind fallback below). Anything else,
    a wildcard or matrix row, or a form row in another unit, resolves None, so
    a result the form's rows do not cover stops the certificate instead of
    printing the wildcard's verdict or being censored against an LOQ in the
    wrong unit. A sample with no row for its form, or no form, resolves as
    before.

    unit (endo slice 3, spec section 6) is the result's unit: callers pass
    effective_unit(result_unit, service unit). When any active row of the
    service is filed in that unit, only those rows count and the first scope
    holding one wins: a new EU/vial result for a peptide whose per-peptide
    row is EU/mL falls through to the Peptide EU/vial row, and a bac water
    EU/mL result can never reach 350 EU/vial. When none is, today's lookup
    runs only for a result in the service's own catalog unit (or in none),
    so a spec filed as "µg/g", or with no unit, keeps judging the "ppm" or
    "Pos/Neg" results it judges today. A result in any other unit resolves
    None, and the certificate stops rather than judge it in another unit.
    unit=None is today's lookup.

    Two active rows in the winning scope raise MultipleResultsFound (the
    scalar_one_or_none behaviour this replaced). The partial unique indexes
    allow one active row per scope and unit, so a lookup without a unit
    that meets a scope holding two units fails loud (aborting the
    certificate) rather than silently picking a limit.

    peptide_id=None (the default, preserving every pre-slice-2 caller) skips
    tier 1 entirely. R4/R5: an unresolved peptide anchor, a blend (multiple
    distinct peptide anchors) or a non-peptide sample coarsens straight to
    matrix/wildcard and never aborts here."""
    from models import AnalysisService, AnalysisServiceSpec

    if matrix != "Peptide":
        sample_form_id = None
    rows = db.execute(
        select(AnalysisServiceSpec).where(
            AnalysisServiceSpec.analysis_service_id == service_id,
            AnalysisServiceSpec.active.is_(True),
        ).order_by(AnalysisServiceSpec.id)
    ).scalars().all()
    rows = [s for s in rows if s.sample_form_id is None or s.sample_form_id == sample_form_id]
    if unit is None:
        return _first_in_scope(rows, matrix, peptide_id, sample_form_id)
    want = normalize_unit(unit)
    svc = db.get(AnalysisService, service_id)
    catalog = normalize_unit(svc.unit if svc is not None else None)
    in_unit = [s for s in rows if normalize_unit(s.unit) == want]
    if in_unit:
        winner = _first_in_scope(in_unit, matrix, peptide_id, sample_form_id)
    elif want and want != catalog:
        return None
    else:
        winner = _first_in_scope(rows, matrix, peptide_id, sample_form_id)
    # Final review C1: once the sample's form has a row for this service, only
    # a form row in the result's unit (or the peptide tier) may judge it.
    if (winner is not None and sample_form_id is not None and winner.peptide_id is None
            and any(s.sample_form_id == sample_form_id for s in rows)):
        unit_ok = normalize_unit(winner.unit) == want or (
            not normalize_unit(winner.unit) and (not want or want == catalog))
        if winner.sample_form_id != sample_form_id or not unit_ok:
            return None
    return winner


def sample_peptide_id(db: Session, parent_pk: int) -> Optional[int]:
    """The parent's peptide identity anchor (R6): the DISTINCT peptide_id
    over every family analysis (hosted on the parent OR any of its
    sub-samples) whose service is peptide-linked. The join is always the
    AnalysisService.peptide_id FK — never _fuzzy_match_peptide or a
    peptide_name string. Exactly one distinct id -> that id; zero (no
    peptide-linked service) or many (a blend) -> None, so the caller
    coarsens to the matrix/wildcard tier (R4/R5) instead of aborting.

    review_state != 'retracted' is the ONLY state filter here, on purpose: a
    retracted row is a real incident class (a sample relabeled from one
    peptide to another leaves the old, wrong-identity analysis behind as
    retracted) and must not add a phantom second anchor that demotes a
    single-peptide sample to blend-treatment. Every other state — including
    'ordered' placeholders and 'shadow' SENAITE mirror rows — stays IN the
    anchor query; over-filtering would return None for samples whose anchor
    is in fact knowable, which is exactly the coarsening R4 wants avoided
    when it isn't necessary. The join is always the `AnalysisService.peptide_id`
    FK, COALESCEd behind the row's own `LimsAnalysis.peptide_id` for
    native-born rows (spec 2026-09-10) — never a name string."""
    from models import AnalysisService, LimsAnalysis, LimsSubSample

    anchor = func.coalesce(LimsAnalysis.peptide_id, AnalysisService.peptide_id)
    ids = db.execute(
        select(anchor)
        .select_from(AnalysisService)
        .join(LimsAnalysis, LimsAnalysis.analysis_service_id == AnalysisService.id)
        .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            anchor.is_not(None),
            LimsAnalysis.review_state != "retracted",
            (LimsAnalysis.lims_sample_pk == parent_pk)
            | (LimsSubSample.parent_sample_pk == parent_pk),
        )
        .distinct()
    ).scalars().all()
    return ids[0] if len(ids) == 1 else None


def sample_peptide_ids(db: Session, parent_pks: list[int]) -> dict[int, Optional[int]]:
    """sample_peptide_id for many parents in ONE query (endo slice 5: the
    worksheet item serializer, never one query per row). The same anchor,
    joins and retracted filter; each row counts for every requested parent it
    belongs to, through its own lims_sample_pk or its vial's parent, exactly
    as the single-parent OR does. Every requested pk is a key: its one
    distinct anchor, else None (none, or a blend). No pks, no query."""
    from models import AnalysisService, LimsAnalysis, LimsSubSample

    pks = sorted(set(parent_pks))
    if not pks:
        return {}
    anchors: dict[int, set] = {pk: set() for pk in pks}
    anchor = func.coalesce(LimsAnalysis.peptide_id, AnalysisService.peptide_id)
    rows = db.execute(
        select(LimsAnalysis.lims_sample_pk, LimsSubSample.parent_sample_pk, anchor)
        .select_from(AnalysisService)
        .join(LimsAnalysis, LimsAnalysis.analysis_service_id == AnalysisService.id)
        .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            anchor.is_not(None),
            LimsAnalysis.review_state != "retracted",
            LimsAnalysis.lims_sample_pk.in_(pks) | LimsSubSample.parent_sample_pk.in_(pks),
        )
        .distinct()
    ).all()
    for host_pk, vial_parent_pk, peptide_id in rows:
        for pk in (host_pk, vial_parent_pk):
            if pk in anchors:
                anchors[pk].add(peptide_id)
    return {pk: next(iter(ids)) if len(ids) == 1 else None for pk, ids in anchors.items()}


def evaluate(spec, result: str) -> Optional[bool]:
    """Verdict of a result string against a spec (any object with rule_kind,
    equals_value, min_value, max_value). Pure. Raises SpecRuleError whenever
    the rule cannot actually be applied — a verdict is only ever emitted from
    a rule that ran; anything else fails closed. Bounds are INCLUSIVE.

    rule_kind='informational' returns None — "report as measured", no
    verdict by design (report-only spec, 2026-08-22). This is NOT the
    fail-closed None-shaped anything: the row still required a real,
    deliberately-filed spec row to get here (rule 5 untouched), and no
    numeric parsing applies — the measured value prints verbatim."""
    if spec.rule_kind == "informational":
        return None
    text = str(result or "").strip()
    if spec.rule_kind == "equals":
        expected = str(spec.equals_value or "").strip()
        if not expected:
            raise SpecRuleError(
                "spec has a blank equals_value — file a real expected value on the catalog row"
            )
        return text.lower() == expected.lower()
    if spec.rule_kind != "range":
        raise SpecRuleError(f"unknown rule_kind {spec.rule_kind!r}")
    try:
        value = float(text)
    except ValueError as e:
        raise SpecRuleError(
            f"result {result!r} is not numeric but the spec is a numeric range"
        ) from e
    if not math.isfinite(value):
        # The old engine false-passed NaN and -inf here. Deliberate divergence.
        raise SpecRuleError(f"result {result!r} is non-finite — cannot verdict")
    if spec.min_value is not None and value < float(spec.min_value):
        return False
    if spec.max_value is not None and value > float(spec.max_value):
        return False
    return True


def display_spec_fields(db: Session, *, service_id: Optional[int],
                        matrix: Optional[str], peptide_id: Optional[int],
                        wire_result: Optional[str],
                        cache: Optional[dict] = None,
                        unit: Optional[str] = None,
                        sample_form_id: Optional[int] = None) -> dict:
    """`specification` + `conforms` for a row in the analyses TABLE: the same
    resolve_spec / evaluate / wire dict the certificate is built from, so the
    table can never disagree with the COA. Same inputs as
    coa.legacy_rows._native_spec_fields (the row's OWN peptide_id, the WIRE
    result, i.e. identity as the Conforms token), and the row's effective
    unit (effective_unit), passed to resolve_spec as the certificate passes
    it (endo slice 3).

    The one deliberate difference: a table must render, so this is FAIL-SOFT
    where the COA is fail-closed. A rule that cannot run (non-numeric result
    on a range, blank equals_value) ships the spec with conforms=None; a
    broken catalog (two active rows in one slot) ships nothing. No spec, no
    service id: {}.

    `cache` (optional dict) memoises the resolved spec per
    (service, matrix, peptide, sample form, unit) across the rows of one
    listing."""
    if service_id is None:
        return {}
    key = (service_id, matrix, peptide_id, sample_form_id,
           None if unit is None else normalize_unit(unit))
    if cache is not None and key in cache:
        spec = cache[key]
    else:
        try:
            spec = resolve_spec(db, service_id, matrix, peptide_id=peptide_id, unit=unit,
                                sample_form_id=sample_form_id)
        except Exception:  # noqa: BLE001 -- a catalog fault must not 500 the page
            spec = None
        if cache is not None:
            cache[key] = spec
    if spec is None:
        return {}
    from coa.native_sections import _spec_wire_dict   # local: it imports this module

    conforms = None
    if str(wire_result or "").strip():
        try:
            conforms = evaluate(spec, wire_result)
        except SpecRuleError:
            conforms = None
    return {"specification": _spec_wire_dict(spec), "conforms": conforms}
