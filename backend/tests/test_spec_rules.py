"""spec_rules: resolver precedence, matrix normalization parity, and the
new-engine half of the cross-repo parity gate.

PARITY_CASES must stay BYTE-IDENTICAL to the table in
coabuilder tests/test_verdict_parity.py. That file pins the OLD engine
(_verdict); this one pins the NEW (evaluate). The non-finite rows are the
deliberate fail-closed divergence — asserted on both sides so it can never
be mistaken for a regression."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from coa.spec_rules import (SpecRuleError, evaluate, normalize_matrix,
                            resolve_spec, sample_peptide_id, sample_peptide_ids)
from models import AnalysisService, AnalysisServiceSpec  # register tables on Base before conftest's create_all


def _mk_service(db, keyword="HM-XX"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword, keyword=keyword, origin="mk1")
    db.add(svc)
    db.flush()
    return svc


def _mk_spec(db, svc, **over):
    from models import AnalysisServiceSpec
    kw = dict(analysis_service_id=svc.id, matrix=None, rule_kind="range",
              max_value=Decimal("0.5"), unit="ppm")
    kw.update(over)
    spec = AnalysisServiceSpec(**kw)
    db.add(spec)
    db.flush()
    return spec


def _mk_peptide(db, abbreviation, name=None):
    from models import Peptide
    pep = Peptide(name=name or abbreviation, abbreviation=abbreviation)
    db.add(pep)
    db.flush()
    return pep


def _mk_identity_service(db, peptide_id, keyword):
    from models import AnalysisService
    svc = AnalysisService(title=keyword, keyword=keyword, origin="mk1",
                          peptide_id=peptide_id)
    db.add(svc)
    db.flush()
    return svc


def _mk_family(db, sample_id, *, parent_analyses=(), sub_analyses=()):
    """Parent LimsSample with LimsAnalysis rows for parent_analyses (hosted
    directly on the parent) and sub_analyses (hosted on a single sub-sample
    vial under the parent) — the two homes sample_peptide_id's join must
    cover. Each entry is a service, or a (service, review_state) pair when a
    test needs a specific state (e.g. 'retracted')."""
    from models import LimsAnalysis, LimsSample, LimsSubSample

    def _svc_state(entry):
        return entry if isinstance(entry, tuple) else (entry, "unassigned")

    parent = LimsSample(sample_id=sample_id)
    db.add(parent)
    db.flush()
    for entry in parent_analyses:
        svc, state = _svc_state(entry)
        db.add(LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title, review_state=state,
        ))
    if sub_analyses:
        sub = LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"{sample_id}-EXT",
            sample_id=f"{sample_id}-S01", vial_sequence=1,
        )
        db.add(sub)
        db.flush()
        for entry in sub_analyses:
            svc, state = _svc_state(entry)
            db.add(LimsAnalysis(
                lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                keyword=svc.keyword, title=svc.title, review_state=state,
            ))
    db.flush()
    return parent


def _rule_ns(rule):
    if rule[0] == "equals":
        return SimpleNamespace(rule_kind="equals", equals_value=rule[1],
                               min_value=None, max_value=None)
    return SimpleNamespace(rule_kind="range", equals_value=None,
                           min_value=rule[1], max_value=rule[2])


# ── normalize_matrix: parity with coabuilder logic.py:5 ─────────────────────

def test_peptide_matrices_parity_with_coabuilder():
    # MUST mirror coabuilder src/coabuilder_core/logic.py:5
    # (_PEPTIDE_MATRICES = {"Peptide", "Peptide Blend"}). A divergence here
    # silently changes which spec resolves.
    from coa.spec_rules import _PEPTIDE_MATRICES
    assert _PEPTIDE_MATRICES == {"Peptide", "Peptide Blend"}


def test_normalize_blend_to_peptide():
    assert normalize_matrix("Peptide Blend") == "Peptide"
    assert normalize_matrix("Peptide") == "Peptide"


def test_normalize_passthrough_and_null():
    assert normalize_matrix("Bacteriostatic Water") == "Bacteriostatic Water"
    assert normalize_matrix(None) is None
    assert normalize_matrix("") is None
    assert normalize_matrix("  ") is None


# ── resolve_spec precedence ─────────────────────────────────────────────────

def test_exact_matrix_beats_null(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, matrix=None, max_value=Decimal("5.0"))
    bw = _mk_spec(db_session, svc, matrix="Bacteriostatic Water",
                  max_value=Decimal("0.25"))
    got = resolve_spec(db_session, svc.id, "Bacteriostatic Water")
    assert got.id == bw.id


def test_null_matrix_is_the_fallback(db_session):
    svc = _mk_service(db_session)
    base = _mk_spec(db_session, svc, matrix=None)
    got = resolve_spec(db_session, svc.id, "Bacteriostatic Water")
    assert got.id == base.id


def test_null_matrix_input_resolves_null_row(db_session):
    svc = _mk_service(db_session)
    base = _mk_spec(db_session, svc, matrix=None)
    assert resolve_spec(db_session, svc.id, None).id == base.id


def test_inactive_rows_never_resolve(db_session):
    svc = _mk_service(db_session)
    _mk_spec(db_session, svc, active=False)
    assert resolve_spec(db_session, svc.id, None) is None


def test_no_rows_resolves_none(db_session):
    svc = _mk_service(db_session)
    assert resolve_spec(db_session, svc.id, "Peptide") is None


# ── resolve_spec: peptide tier (spec-ownership slice 2) ─────────────────────

def test_resolve_prefers_peptide_over_matrix_over_wildcard(db_session):
    svc = _mk_service(db_session)
    peptide = _mk_peptide(db_session, "BPC157")
    wild = _mk_spec(db_session, svc, matrix=None, max_value=Decimal("1"))
    mat = _mk_spec(db_session, svc, matrix="Peptide", max_value=Decimal("2"))
    pep = _mk_spec(db_session, svc, matrix=None, peptide_id=peptide.id,
                   max_value=Decimal("3"))
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=peptide.id).id == pep.id
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=None).id == mat.id
    assert resolve_spec(db_session, svc.id, None, peptide_id=None).id == wild.id


def test_resolve_peptide_tier_falls_through_when_absent(db_session):
    """R4: a peptide anchor with no filed peptide-tier spec coarsens to the
    matrix tier — it must never abort or silently pick the wildcard."""
    svc = _mk_service(db_session)
    peptide = _mk_peptide(db_session, "BPC157")
    mat = _mk_spec(db_session, svc, matrix="Peptide", max_value=Decimal("2"))
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=peptide.id).id == mat.id


def test_resolve_peptide_id_none_is_backward_compatible_default(db_session):
    """Every pre-slice-2 caller passes no peptide_id kwarg at all — confirm
    the default keeps them on the old two-tier behavior."""
    svc = _mk_service(db_session)
    mat = _mk_spec(db_session, svc, matrix="Peptide", max_value=Decimal("2"))
    assert resolve_spec(db_session, svc.id, "Peptide").id == mat.id


def test_wildcard_arm_excludes_peptide_rows(db_session):
    """CRITICAL regression: the wildcard (both-NULL) arm must also require
    peptide_id IS NULL — otherwise a peptide-bound row could masquerade as
    the default when no true wildcard row exists."""
    svc = _mk_service(db_session)
    peptide = _mk_peptide(db_session, "BPC157")
    _mk_spec(db_session, svc, matrix=None, peptide_id=peptide.id,
            max_value=Decimal("3"))
    assert resolve_spec(db_session, svc.id, None, peptide_id=None) is None


# ── sample-form tier (spec 2026-10-26 sample-forms, task 4) ──────────────────

def _mk_form(db, name):
    from models import LimsSampleForm
    form = LimsSampleForm(name=name, route="injectable")
    db.add(form)
    db.flush()
    return form


def test_form_beats_matrix_and_wildcard_but_not_peptide(db_session):
    db = db_session
    svc = _mk_service(db)
    nasal = _mk_form(db, "Nasal Spray")
    pep = _mk_peptide(db, "BPC157")
    wild = _mk_spec(db, svc)                                        # (1) wildcard
    mat = _mk_spec(db, svc, matrix="Peptide", max_value=Decimal("2"))   # (2) matrix
    pep_row = _mk_spec(db, svc, peptide_id=pep.id, max_value=Decimal("3"))  # (3) peptide
    form_row = _mk_spec(db, svc, sample_form_id=nasal.id, max_value=Decimal("4"))  # (4) form
    assert resolve_spec(db, svc.id, "Peptide", sample_form_id=nasal.id).id == form_row.id
    assert resolve_spec(db, svc.id, "Peptide", peptide_id=pep.id,
                        sample_form_id=nasal.id).id == pep_row.id
    assert resolve_spec(db, svc.id, "Peptide").id == mat.id          # no form -> form rows invisible
    # A form with no row of its own falls through to matrix, then wildcard.
    other = _mk_form(db, "Pen")
    assert resolve_spec(db, svc.id, "Peptide", sample_form_id=other.id).id == mat.id
    assert resolve_spec(db, svc.id, "Bacteriostatic Water",
                        sample_form_id=other.id).id == wild.id


def test_other_forms_rows_never_change_resolution_unit_trap(db_session):
    """Another form's row in the result's unit must not make the unit filter
    drop the wildcard (filed in a different unit) for everyone else: the
    resolver drops other forms' rows BEFORE the unit filter."""
    db = db_session
    svc = _mk_service(db)
    svc.unit = "ppm"                                  # catalog unit: arms the unit-blind fallback
    nasal = _mk_form(db, "Nasal Spray")
    powder = _mk_form(db, "Lyophilized Powder")
    wild = _mk_spec(db, svc, unit="µg/g", max_value=Decimal("1"))
    nasal_row = _mk_spec(db, svc, sample_form_id=nasal.id, unit="ppm", max_value=Decimal("2"))
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=powder.id).id == wild.id
    assert resolve_spec(db, svc.id, "Bacteriostatic Water", unit="ppm").id == wild.id   # Review Focus 5
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=nasal.id).id == nasal_row.id


def test_wildcard_arm_excludes_form_rows(db_session):
    """Clone of the peptide-row regression: a form row must never masquerade
    as the default for a sample that is not in that form."""
    db = db_session
    svc = _mk_service(db)
    nasal = _mk_form(db, "Nasal Spray")
    pen = _mk_form(db, "Pen")
    form_row = _mk_spec(db, svc, sample_form_id=nasal.id, max_value=Decimal("3"))
    assert resolve_spec(db, svc.id, None) is None
    assert resolve_spec(db, svc.id, "Peptide", sample_form_id=pen.id) is None
    assert resolve_spec(db, svc.id, "Peptide", sample_form_id=nasal.id).id == form_row.id


# ── F-1 (final review C1): a result in a unit the form's rows don't cover ────
# Once a sample's form has a row for the service, the form tier is the only
# thing allowed to judge it (peptide tier aside). A result in another unit
# resolves None so the certificate stops, instead of printing the injectable
# wildcard verdict or censoring against an LOQ in the wrong unit.

def _nasal_hm_service(db, *, wildcard_unit):
    """HM-PB (catalog unit ppm), a wildcard filed in `wildcard_unit`, and a
    Nasal Spray report-only row in µg/mL with LOQ 0.1."""
    svc = _mk_service(db, keyword="HM-PB")
    svc.unit = "ppm"
    nasal = _mk_form(db, "Nasal Spray")
    wild = _mk_spec(db, svc, unit=wildcard_unit, max_value=Decimal("10"))
    nasal_row = _mk_spec(db, svc, sample_form_id=nasal.id, rule_kind="informational",
                         max_value=None, unit="µg/mL", loq=Decimal("0.1"))
    return svc, nasal, wild, nasal_row


def test_nasal_result_in_ppm_never_reaches_a_ppm_wildcard(db_session):
    """Probe (a): wildcard filed in ppm, nasal row in µg/mL."""
    db = db_session
    svc, nasal, wild, nasal_row = _nasal_hm_service(db, wildcard_unit="ppm")
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=nasal.id) is None
    assert resolve_spec(db, svc.id, "Peptide", unit="µg/mL",
                        sample_form_id=nasal.id).id == nasal_row.id


def test_nasal_result_in_ppm_is_not_censored_by_a_ug_ml_row(db_session):
    """Probe (b): wildcard in µg/g, catalog unit ppm. The catalog-unit
    fallback used to hand a ppm number the µg/mL form row."""
    db = db_session
    svc, nasal, wild, nasal_row = _nasal_hm_service(db, wildcard_unit="µg/g")
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=nasal.id) is None


def test_form_row_with_a_blank_unit_keeps_the_catalog_unit_fallback(db_session):
    db = db_session
    svc = _mk_service(db)
    svc.unit = "ppm"
    nasal = _mk_form(db, "Nasal Spray")
    row = _mk_spec(db, svc, sample_form_id=nasal.id, unit=None, max_value=Decimal("2"))
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=nasal.id).id == row.id
    assert resolve_spec(db, svc.id, "Peptide", unit="", sample_form_id=nasal.id).id == row.id
    assert resolve_spec(db, svc.id, "Peptide", unit="µg/mL", sample_form_id=nasal.id) is None


def test_other_forms_and_peptide_tier_are_untouched_by_the_form_fail_closed(db_session):
    db = db_session
    svc, nasal, wild, nasal_row = _nasal_hm_service(db, wildcard_unit="ppm")
    powder = _mk_form(db, "Lyophilized Powder")
    pep = _mk_peptide(db, "BPC157")
    pep_row = _mk_spec(db, svc, peptide_id=pep.id, unit="ppm", max_value=Decimal("3"))
    # A powder sample (no row of its own for this service) still gets the wildcard.
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=powder.id).id == wild.id
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm").id == wild.id
    # A nasal sample whose peptide has its own row keeps the peptide tier.
    assert resolve_spec(db, svc.id, "Peptide", peptide_id=pep.id, unit="ppm",
                        sample_form_id=nasal.id).id == pep_row.id


def test_form_without_rows_for_the_service_resolves_as_before(db_session):
    """A nasal sample on a service that has no Nasal Spray row is not
    affected: the post-check only applies when the form has a row here."""
    db = db_session
    svc = _mk_service(db)
    svc.unit = "ppm"
    nasal = _mk_form(db, "Nasal Spray")
    wild = _mk_spec(db, svc, unit="ppm")
    assert resolve_spec(db, svc.id, "Peptide", unit="ppm", sample_form_id=nasal.id).id == wild.id


# ── F-2 (final review I1): the form tier is for peptide-family samples only ───

def test_bac_water_sample_with_a_stray_form_resolves_the_bw_matrix_row(db_session):
    db = db_session
    svc = _mk_service(db)
    nasal = _mk_form(db, "Nasal Spray")
    wild = _mk_spec(db, svc)                                            # wildcard
    bw = _mk_spec(db, svc, matrix="Bacteriostatic Water", max_value=Decimal("0.05"))
    _mk_spec(db, svc, sample_form_id=nasal.id, max_value=Decimal("4"))  # form row
    assert resolve_spec(db, svc.id, "Bacteriostatic Water", unit="ppm",
                        sample_form_id=nasal.id).id == bw.id
    assert resolve_spec(db, svc.id, "Bacteriostatic Water",
                        sample_form_id=nasal.id).id == bw.id
    assert resolve_spec(db, svc.id, None, sample_form_id=nasal.id).id == wild.id


def test_display_spec_fields_cache_is_keyed_by_form(db_session):
    from coa.spec_rules import display_spec_fields
    db = db_session
    svc = _mk_service(db)
    nasal = _mk_form(db, "Nasal Spray")
    _mk_spec(db, svc)                                                  # max 0.5
    _mk_spec(db, svc, sample_form_id=nasal.id, max_value=Decimal("2"))
    cache: dict = {}
    kw = dict(service_id=svc.id, matrix="Peptide", peptide_id=None,
              wire_result="1.5", cache=cache, unit="ppm")
    assert display_spec_fields(db, **kw)["conforms"] is False
    assert display_spec_fields(db, sample_form_id=nasal.id, **kw)["conforms"] is True
    assert len(cache) == 2


# ── sample_peptide_id: identity anchor (R6) ──────────────────────────────────

def test_sample_peptide_id_unique_anchor(db_session):
    peptide = _mk_peptide(db_session, "BPC157")
    identity_svc = _mk_identity_service(db_session, peptide.id, "BPC157-PURITY")
    other_svc = _mk_service(db_session, keyword="HM-PB")   # peptide_id=None
    parent = _mk_family(
        db_session, "P-ANCHOR-1",
        parent_analyses=[identity_svc],
        sub_analyses=[other_svc],
    )
    assert sample_peptide_id(db_session, parent.id) == peptide.id


def test_sample_peptide_id_blend_or_none_returns_none(db_session):
    pep_a = _mk_peptide(db_session, "BPC157")
    pep_b = _mk_peptide(db_session, "TB500")
    svc_a = _mk_identity_service(db_session, pep_a.id, "BPC157-PURITY")
    svc_b = _mk_identity_service(db_session, pep_b.id, "TB500-PURITY")
    two_peptide_parent = _mk_family(db_session, "P-BLEND-1",
                                    parent_analyses=[svc_a, svc_b])

    other_svc = _mk_service(db_session, keyword="HM-PB")
    no_identity_parent = _mk_family(db_session, "P-NOID-1",
                                    parent_analyses=[other_svc])

    assert sample_peptide_id(db_session, two_peptide_parent.id) is None
    assert sample_peptide_id(db_session, no_identity_parent.id) is None


def test_sample_peptide_id_ignores_retracted_wrong_identity_row(db_session):
    """Real incident class: a sample relabeled from one peptide to another
    leaves the OLD, wrong-identity analysis behind as retracted. That
    retracted row must not count as a second anchor and demote the sample
    to blend-treatment — the live row (peptide A) is the only anchor."""
    pep_a = _mk_peptide(db_session, "BPC157")
    pep_b = _mk_peptide(db_session, "TB500")
    svc_a = _mk_identity_service(db_session, pep_a.id, "BPC157-PURITY")
    svc_b = _mk_identity_service(db_session, pep_b.id, "TB500-PURITY")
    parent = _mk_family(
        db_session, "P-RETRACTED-1",
        parent_analyses=[svc_a, (svc_b, "retracted")],
    )
    assert sample_peptide_id(db_session, parent.id) == pep_a.id


# ── Cross-repo parity table — DO NOT EDIT without editing the twin ──────────
# (rule, result, old_verdict, new_verdict); rule = ("range", min, max) or
# ("equals", value); verdict = True | False | "abort".
PARITY_CASES = [
    # HM-shaped: max-only range, inclusive upper bound
    (("range", None, 0.5), "0.12",  True,    True),
    (("range", None, 0.5), "0.5",   True,    True),     # ON the bound: inclusive
    (("range", None, 0.5), "0.50",  True,    True),
    (("range", None, 0.5), "9.99",  False,   False),
    (("range", None, 0.5), "-1",    True,    True),     # no lower bound
    (("range", None, 0.5), "N/A",   "abort", "abort"),
    # pH-shaped: two-sided range, both bounds inclusive
    (("range", 4.5, 7.0),  "4.5",   True,    True),
    (("range", 4.5, 7.0),  "7.0",   True,    True),
    (("range", 4.5, 7.0),  "4.49",  False,   False),
    (("range", 4.5, 7.0),  "7.01",  False,   False),
    # USP<71>-shaped equals: case-insensitive, whitespace-trimmed
    (("equals", "Not Detected"), "Not Detected",     True,  True),
    (("equals", "Not Detected"), "not detected",     True,  True),
    (("equals", "Not Detected"), "  Not Detected  ", True,  True),
    (("equals", "Not Detected"), "Detected",         False, False),
    (("equals", "Not Detected"), "No Growth",        False, False),
    # DELIBERATE DIVERGENCES — non-finite results
    (("range", None, 0.5), "nan",  True,    "abort"),   # old BUG: NaN conforms
    (("range", None, 0.5), "-inf", True,    "abort"),   # old BUG: -inf conforms
    (("range", None, 0.5), "inf",  False,   "abort"),   # old: prints a failure
]


@pytest.mark.parametrize("rule,result,old_verdict,new_verdict", PARITY_CASES)
def test_new_engine_column_is_accurate(rule, result, old_verdict, new_verdict):
    spec = _rule_ns(rule)
    if new_verdict == "abort":
        with pytest.raises(SpecRuleError):
            evaluate(spec, result)
    else:
        assert evaluate(spec, result) is new_verdict


def test_decimal_bounds_from_orm_rows_evaluate(db_session):
    # ORM rows carry Decimal bounds; evaluate must handle them, on-bound
    # inclusively, same as the float table above.
    svc = _mk_service(db_session)
    spec = _mk_spec(db_session, svc)     # range, max 0.5 ppm
    assert evaluate(spec, "0.5") is True
    assert evaluate(spec, "0.51") is False


def test_unknown_rule_kind_aborts():
    with pytest.raises(SpecRuleError):
        evaluate(SimpleNamespace(rule_kind="fancy", equals_value=None,
                                 min_value=None, max_value=None), "1")


def test_blank_equals_value_aborts():
    with pytest.raises(SpecRuleError):
        evaluate(SimpleNamespace(rule_kind="equals", equals_value="   ",
                                 min_value=None, max_value=None), "anything")


# ── floor results (endo ">", 2026-10-26) ─────────────────────────────────────
# A floor is a LOWER bound: "at least this much". NOT added to PARITY_CASES —
# the old engine has no floor concept, so there is no column to assert.

def _range(max_value="350", min_value="0"):
    return SimpleNamespace(rule_kind="range", equals_value=None,
                           min_value=Decimal(min_value) if min_value else None,
                           max_value=Decimal(max_value) if max_value else None)


@pytest.mark.parametrize("result", ["2500", "350", "350.0"])
def test_a_floor_at_or_above_the_limit_does_not_conform(result):
    # 350 against a 0 to 350 spec is the boundary: bounds are inclusive, so an
    # ordinary verdict would read Conforms on a sample holding AT LEAST 350.
    assert evaluate(_range(), result) is (result != "2500")
    assert evaluate(_range(), result, floor=True) is False


@pytest.mark.parametrize("result, max_value", [("250", "350"), ("2500", None)])
def test_a_floor_that_cannot_be_judged_aborts(result, max_value):
    # Below the limit the true value is unknown; with no upper limit there is
    # nothing for a floor to reach. Fail closed either way.
    assert evaluate(_range(max_value), result) is True
    with pytest.raises(SpecRuleError, match="floor"):
        evaluate(_range(max_value), result, floor=True)


@pytest.mark.parametrize("spec", [
    SimpleNamespace(rule_kind="equals", equals_value="Not Detected",
                    min_value=None, max_value=None),
    SimpleNamespace(rule_kind="informational", equals_value=None,
                    min_value=None, max_value=None),
])
def test_a_floor_on_a_non_range_spec_aborts(spec):
    # Only a numeric range can say whether a floor already fails. An
    # informational row returns None for an ordinary result but must not
    # silently swallow a floor it was never asked to judge.
    with pytest.raises(SpecRuleError, match="floor"):
        evaluate(spec, "2500", floor=True)


# ── report-only specs ("as measured", 2026-08-22) ────────────────────────────
# NOT added to PARITY_CASES: informational rows never reach the old engine —
# a wire dict spec bypasses COABuilder's _verdict entirely, so there is no
# old-engine column to assert. New-engine-only by construction.

def test_informational_returns_none_never_aborts():
    spec = SimpleNamespace(rule_kind="informational", equals_value=None,
                           min_value=None, max_value=None)
    assert evaluate(spec, "12.3") is None
    assert evaluate(spec, "trace") is None   # non-numeric: no parse, no abort
    assert evaluate(spec, "") is None


def test_informational_resolves_by_tier_like_any_row(db_session):
    svc = _mk_service(db_session, keyword="MOISTURE-KF")
    pep = _mk_peptide(db_session, "BPC157")
    _mk_spec(db_session, svc, rule_kind="informational", max_value=None)  # wildcard
    _mk_spec(db_session, svc, rule_kind="range", max_value=Decimal("5"),
             peptide_id=pep.id)
    # Peptide anchor present: the peptide-tier RANGE row wins (a verdict can
    # override a wildcard informational per R2)...
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=pep.id).rule_kind == "range"
    # ...and without an anchor the wildcard informational is the answer.
    assert resolve_spec(db_session, svc.id, "Peptide").rule_kind == "informational"


def test_sample_peptide_id_anchors_on_native_row_peptide(db_session):
    """Native trio rows carry peptide_id on the ROW; the generic service has none."""
    from models import LimsAnalysis
    from sqlalchemy import select
    peptide = _mk_peptide(db_session, "BPC157")
    generic = _mk_service(db_session, keyword="HPLC-IDENTITY")        # peptide_id=None
    parent = _mk_family(db_session, "P-ANCHOR-NATIVE", parent_analyses=[generic])
    row = db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
    ).scalar_one()
    row.peptide_id = peptide.id
    row.slot = 1
    db_session.flush()
    assert sample_peptide_id(db_session, parent.id) == peptide.id


def test_sample_peptide_id_native_blend_returns_none(db_session):
    from models import LimsAnalysis
    from sqlalchemy import select
    p1 = _mk_peptide(db_session, "BPC157")
    p2 = _mk_peptide(db_session, "TB500")
    generic1 = _mk_service(db_session, keyword="HPLC-IDENTITY")
    generic2 = _mk_service(db_session, keyword="HPLC-PURITY")
    parent = _mk_family(db_session, "PB-ANCHOR-NATIVE", parent_analyses=[generic1, generic2])
    rows = db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
    ).scalars().all()
    rows[0].peptide_id, rows[0].slot = p1.id, 1
    rows[1].peptide_id, rows[1].slot = p2.id, 2
    db_session.flush()
    assert sample_peptide_id(db_session, parent.id) is None


# ── sample_peptide_ids: the batched twin (endo slice 5) ──────────────────────

def test_sample_peptide_ids_answers_like_sample_peptide_id_in_one_query(db_session):
    """Every case above, batched: the worksheet serializer asks for a whole
    worksheet's parents at once and must get what one call per parent gives."""
    from models import LimsAnalysis
    from sqlalchemy import select
    from tests.test_endo_v2_worksheets import _count_sql
    pep_a = _mk_peptide(db_session, "BPC157")
    pep_b = _mk_peptide(db_session, "TB500")
    svc_a = _mk_identity_service(db_session, pep_a.id, "BPC157-PURITY")
    svc_b = _mk_identity_service(db_session, pep_b.id, "TB500-PURITY")
    other = _mk_service(db_session, keyword="HM-PB")
    generic = _mk_service(db_session, keyword="HPLC-IDENTITY")
    single = _mk_family(db_session, "P-BATCH-1", parent_analyses=[svc_a], sub_analyses=[other])
    on_vial = _mk_family(db_session, "P-BATCH-2", sub_analyses=[svc_b])
    blend = _mk_family(db_session, "P-BATCH-3", parent_analyses=[svc_a, svc_b])
    no_anchor = _mk_family(db_session, "P-BATCH-4", parent_analyses=[other])
    retracted = _mk_family(db_session, "P-BATCH-5", parent_analyses=[svc_a, (svc_b, "retracted")])
    native = _mk_family(db_session, "P-BATCH-6", parent_analyses=[generic])
    split = _mk_family(db_session, "P-BATCH-7", parent_analyses=[svc_a], sub_analyses=[svc_b])
    row = db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == native.id)
    ).scalar_one()
    row.peptide_id, row.slot = pep_b.id, 1
    db_session.flush()
    pks = [p.id for p in (single, on_vial, blend, no_anchor, retracted, native, split)] + [987654]

    with _count_sql(db_session) as seen:
        got = sample_peptide_ids(db_session, pks + [single.id])   # a repeat is harmless

    assert len(seen) == 1
    assert got == {pk: sample_peptide_id(db_session, pk) for pk in pks}
    assert got == {single.id: pep_a.id, on_vial.id: pep_b.id, blend.id: None,
                   no_anchor.id: None, retracted.id: pep_a.id, native.id: pep_b.id,
                   split.id: None, 987654: None}


def test_sample_peptide_ids_of_nothing_runs_no_query(db_session):
    from tests.test_endo_v2_worksheets import _count_sql
    with _count_sql(db_session) as seen:
        assert sample_peptide_ids(db_session, []) == {}
    assert seen == []
