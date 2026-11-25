import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from models import AnalysisProfile, AnalysisProfileCoaVariant, LimsSampleForm


def _prof_and_form(db):
    prof = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    form = LimsSampleForm(name="Nasal Spray", route="nasal_inhaled")
    db.add_all([prof, form]); db.flush()
    return prof, form


def test_one_active_variant_per_profile_and_form(db_session):
    prof, form = _prof_and_form(db_session)
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id))
    db_session.flush()
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id))
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_a_switched_off_variant_frees_the_slot(db_session):
    prof, form = _prof_and_form(db_session)
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id,
                                             active=False))
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id))
    db_session.flush()


def test_the_three_states_survive_a_round_trip(db_session):
    prof, form = _prof_and_form(db_session)
    v = AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id,
                                  coa_basis_note="", coa_method_text=None, coa_prep_text="Diluted",
                                  coa_footnotes=[])
    db_session.add(v); db_session.flush(); db_session.expire(v)
    assert v.active is True
    assert v.coa_basis_note == ""
    assert v.coa_method_text is None
    assert v.coa_prep_text == "Diluted"
    assert v.coa_footnotes == []


def test_same_as_default_footnotes_are_sql_null(db_session):
    prof, form = _prof_and_form(db_session)
    pen = LimsSampleForm(name="Pen", route="injectable")
    db_session.add(pen); db_session.flush()
    same_as_default = AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id,
                                                coa_footnotes=None)
    leave_off = AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=pen.id,
                                          coa_footnotes=[])
    db_session.add_all([same_as_default, leave_off]); db_session.flush()

    def is_sql_null(v):
        return bool(db_session.execute(
            text("SELECT coa_footnotes IS NULL FROM analysis_profile_coa_variants WHERE id = :id"),
            {"id": v.id},
        ).scalar())

    assert is_sql_null(same_as_default) is True
    assert is_sql_null(leave_off) is False
