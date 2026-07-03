"""resolve_parent_analyte_target must tolerate duplicate (non-unique) analysis_service
keywords.

Prod regression (PB-0186-S01, TB-500 purity): a re-run of the analysis-services
sync cloned the per-substance TB-500 services, so two rows share keyword
``PUR_TB500BETA4`` (ids 182/183, both peptide_id 63). The strict
``scalar_one_or_none()`` raised ``MultipleResultsFound`` → the promote endpoint
returned 502 "parent slot resolution failed".

Contract:
  - Duplicates that AGREE on peptide_id resolve normally (pick deterministically).
  - The parent ANALYTE-* lookup tolerates duplicates too.
  - Duplicates that DISAGREE on peptide_id fail loudly (BadRequestError) — never
    silently guess, which would mis-target the parent analyte slot → wrong COA.
"""
import pytest

from models import AnalysisService
from lims_analyses.service import resolve_parent_analyte_target, BadRequestError

_SLOTS = {3: "TB500 (Thymosin Beta 4) - Identity (HPLC)"}


def _svc(keyword, title, peptide_id=None):
    return AnalysisService(keyword=keyword, title=title, peptide_id=peptide_id)


def test_duplicate_vial_keyword_resolves_to_parent_slot(db_session, monkeypatch):
    # Two identical PUR_TB500BETA4 clones (mirrors prod ids 182/183, peptide 63).
    db_session.add_all([
        _svc("PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", 63),
        _svc("PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", 63),
        _svc("ID_TB500BETA4", "TB500 (Thymosin Beta 4) - Identity (HPLC)", 63),
        _svc("ANALYTE-3-PUR", "Analyte 3 (Purity)"),
    ])
    db_session.commit()
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: _SLOTS)

    kw, svc_id, title = resolve_parent_analyte_target(
        db_session, vial_keyword="PUR_TB500BETA4", parent_sample_id="PB-0186")

    assert kw == "ANALYTE-3-PUR"
    assert title == "Analyte 3 (Purity)"
    assert svc_id is not None


def test_single_keyword_unchanged(db_session, monkeypatch):
    # Regression guard: the common no-duplicate path must behave exactly as before.
    db_session.add_all([
        _svc("PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", 63),
        _svc("ID_TB500BETA4", "TB500 (Thymosin Beta 4) - Identity (HPLC)", 63),
        _svc("ANALYTE-3-PUR", "Analyte 3 (Purity)"),
    ])
    db_session.commit()
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: _SLOTS)

    kw, svc_id, title = resolve_parent_analyte_target(
        db_session, vial_keyword="PUR_TB500BETA4", parent_sample_id="PB-0186")

    assert kw == "ANALYTE-3-PUR"
    assert title == "Analyte 3 (Purity)"
    assert svc_id is not None


def test_duplicate_parent_keyword_is_tolerated(db_session, monkeypatch):
    # Defensive: even a duplicated parent ANALYTE-* line resolves deterministically.
    db_session.add_all([
        _svc("PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", 63),
        _svc("ID_TB500BETA4", "TB500 (Thymosin Beta 4) - Identity (HPLC)", 63),
        _svc("ANALYTE-3-PUR", "Analyte 3 (Purity)"),
        _svc("ANALYTE-3-PUR", "Analyte 3 (Purity)"),
    ])
    db_session.commit()
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: _SLOTS)

    kw, svc_id, title = resolve_parent_analyte_target(
        db_session, vial_keyword="PUR_TB500BETA4", parent_sample_id="PB-0186")

    assert kw == "ANALYTE-3-PUR"
    assert svc_id is not None


def test_divergent_duplicate_peptide_fails_loudly(db_session, monkeypatch):
    # Clones disagreeing on peptide_id must NOT be guessed — picking one could
    # write the purity result to the wrong analyte's parent line (wrong COA).
    db_session.add_all([
        _svc("PUR_TB500BETA4", "TB500 (Thymosin Beta 4) - Purity", 63),
        _svc("PUR_TB500BETA4", "TB500 (17-23 Fragment) - Purity", 62),
    ])
    db_session.commit()
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: _SLOTS)

    with pytest.raises(BadRequestError):
        resolve_parent_analyte_target(
            db_session, vial_keyword="PUR_TB500BETA4", parent_sample_id="PB-0186")
