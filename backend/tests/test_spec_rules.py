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

from coa.spec_rules import SpecRuleError, evaluate, normalize_matrix, resolve_spec
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
