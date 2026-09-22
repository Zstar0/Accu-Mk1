"""coa.identity_verdict — Mk1 owns the identity CONFORMS verdict on the COA
wire. Reproduces the P-1986 class (service title "Somatropin - Identity
(HPLC)" vs peptide name "HGH (Somatropin)") and pins that nothing else
changes: fail tokens, free text and blanks ride raw; non-identity rows are
untouched; the native-born "Conforms" literal passes straight through."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from coa.identity_verdict import (
    CONFORMS_TOKEN,
    candidate_names,
    identity_verdict,
    identity_wire_result,
    is_identity_keyword,
)
from database import Base
from models import AnalysisService, Peptide


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _svc(db, *, keyword, title, peptide=None, peptide_name=None, result_options=None):
    svc = AnalysisService(
        title=title, keyword=keyword,
        peptide_id=peptide.id if peptide else None,
        peptide_name=peptide_name, result_options=result_options,
    )
    db.add(svc)
    db.flush()
    return svc


@pytest.fixture
def p1986(db):
    """Prod service 264 / peptide 235 as of 2026-09-10."""
    pep = Peptide(name="HGH (Somatropin)", abbreviation="HGH (SOMATROPIN)", active=True)
    db.add(pep)
    db.flush()
    return _svc(db, keyword="ID_Somatropin", title="Somatropin - Identity (HPLC)", peptide=pep)


def test_identity_keyword_classifier():
    assert is_identity_keyword("ID_Somatropin")
    assert is_identity_keyword("id_bpc157")
    assert is_identity_keyword("HPLC-ID")
    assert not is_identity_keyword("HPLC-PUR")
    assert not is_identity_keyword("PEPT-Total")
    assert not is_identity_keyword(None)
    assert is_identity_keyword("HPLC-IDENTITY")
    assert not is_identity_keyword("HPLC-PURITY")


def test_candidate_names_order_and_dedupe(db, p1986):
    assert candidate_names(p1986) == ["HGH (Somatropin)", "Somatropin"]


def test_p1986_class_conforms_via_peptide_name(db, p1986):
    assert identity_verdict(db, result="HGH (Somatropin)", analysis_service_id=p1986.id) is True
    assert identity_wire_result(
        db, keyword="ID_Somatropin", result="HGH (Somatropin)", analysis_service_id=p1986.id
    ) == CONFORMS_TOKEN


def test_title_prefix_still_conforms(db, p1986):
    """The 58 prod rows that match only the service title keep conforming."""
    assert identity_verdict(db, result="Somatropin", analysis_service_id=p1986.id) is True


def test_service_without_peptide_link_uses_title(db):
    """Prod service 272 `ID_HGHSomatropin` has peptide_id NULL and
    peptide_name NULL — the title arm is the only operand."""
    svc = _svc(db, keyword="ID_HGHSomatropin", title="HGH (Somatropin) - Identity (HPLC)")
    assert identity_verdict(db, result="HGH (Somatropin)", analysis_service_id=svc.id) is True
    assert identity_verdict(db, result="HGH", analysis_service_id=svc.id) is False


def test_legacy_peptide_name_column_is_an_operand(db):
    svc = _svc(db, keyword="ID_AICAR", title="AICAR - Identity (HPLC)", peptide_name="AICAR")
    assert candidate_names(svc) == ["AICAR"]
    assert identity_verdict(db, result="AICAR", analysis_service_id=svc.id) is True


@pytest.mark.parametrize("value", [
    "Does_Not_Conform", "Non-conforming", "does not conform", "0",
    "Unknown", "Not Detected", "no", "Out of Spec",
    "Somatropinase",  # prefix without a word boundary
])
def test_non_conforming_values_ride_raw(db, p1986, value):
    assert identity_verdict(db, result=value, analysis_service_id=p1986.id) is False
    assert identity_wire_result(
        db, keyword="ID_Somatropin", result=value, analysis_service_id=p1986.id
    ) == value


def test_fail_token_beats_name_match(db):
    """A fail token can never be rescued by a name-shaped prefix."""
    pep = Peptide(name="Fail", abbreviation="FAIL", active=True)
    db.add(pep)
    db.flush()
    svc = _svc(db, keyword="ID_FAIL", title="Fail - Identity (HPLC)", peptide=pep)
    assert identity_verdict(db, result="fail", analysis_service_id=svc.id) is False


def test_blank_result_is_none_and_rides_raw(db, p1986):
    assert identity_verdict(db, result=None, analysis_service_id=p1986.id) is None
    assert identity_verdict(db, result="  ", analysis_service_id=p1986.id) is None
    assert identity_wire_result(db, keyword="ID_Somatropin", result=None, analysis_service_id=p1986.id) is None


def test_native_born_conforms_literal_passes_through(db):
    """HPLC native-born identity rows already store the literal token
    (spec 2026-09-10-hplc-native-born-design §19); the wire must not
    alter it regardless of catalog linkage."""
    svc = _svc(db, keyword="HPLC-IDENTITY", title="Retatrutide - Identity (HPLC)")
    assert identity_verdict(db, result="Conforms", analysis_service_id=svc.id) is True
    assert identity_verdict(db, result="Does Not Conform", analysis_service_id=svc.id) is False


def test_select_form_option_value_maps_through_label(db):
    svc = _svc(db, keyword="HPLC-ID", title="Peptide Identity (HPLC)",
               result_options=[{"value": "1", "label": "Conforms"},
                               {"value": "0", "label": "Does Not Conform"}])
    assert identity_wire_result(db, keyword="HPLC-ID", result="1", analysis_service_id=svc.id) == CONFORMS_TOKEN
    assert identity_wire_result(db, keyword="HPLC-ID", result="0", analysis_service_id=svc.id) == "0"


def test_unresolvable_service_falls_back_to_tokens_only(db):
    assert identity_verdict(db, result="BPC-157", analysis_service_id=999_999) is False
    assert identity_verdict(db, result="Conforms", analysis_service_id=None) is True
    assert identity_verdict(None, result="Conforms", analysis_service_id=None) is True


def test_non_identity_rows_untouched(db, p1986):
    assert identity_wire_result(db, keyword="HPLC-PUR", result="Conforms", analysis_service_id=p1986.id) == "Conforms"
    assert identity_wire_result(db, keyword="PEPT-Total", result="29.45", analysis_service_id=None) == "29.45"
