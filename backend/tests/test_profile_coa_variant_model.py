import pytest
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
