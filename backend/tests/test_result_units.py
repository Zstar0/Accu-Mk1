"""Result units (sample forms, spec 2026-10-26, task 8).

The allowed units for a test come only from its spec rows (plus the catalog
unit); the default for a sample comes from the unit on its dosage form's spec
row. The bench submit route validates the chosen unit against that list, and
the analyses listing ships the options and the default per row.

Fixtures follow tests/test_retest_routes.py (StaticPool SQLite shared by the
session and the TestClient's threadpool) and tests/test_amendment_audit.py.
"""
from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
import models  # noqa: F401 -- registers models on Base.metadata
from database import Base, get_db
from lims_analyses.result_units import (
    UnitChoices, allowed_units, canonical_unit, unit_choices,
)
from lims_analyses.service import list_analyses_in_senaite_shape
from main import app
from models import (
    AnalysisService, AnalysisServiceSpec, LimsAnalysis, LimsAnalysisTransition,
    LimsSample, LimsSampleForm, LimsSubSample,
)


class _FakeUser:
    id = 9
    email = "tech@accumark.test"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: (yield db)
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(auth.get_current_user, None)


def _service(db, unit="ppm", keyword="ARSENIC-PPM"):
    svc = AnalysisService(title="Arsenic", keyword=keyword, unit=unit, origin="mk1")
    db.add(svc)
    db.flush()
    return svc


def _form(db, name="Nasal Spray", route="nasal_inhaled"):
    form = LimsSampleForm(name=name, route=route)
    db.add(form)
    db.flush()
    return form


def _spec(db, svc, unit, *, form=None, matrix=None, active=True):
    row = AnalysisServiceSpec(
        analysis_service_id=svc.id, sample_form_id=form.id if form else None,
        matrix=matrix, rule_kind="range", max_value=Decimal("10"), unit=unit, active=active)
    db.add(row)
    db.flush()
    return row


def _sample(db, form=None, sample_id="AA-P1"):
    s = LimsSample(sample_id=sample_id, sample_type="x", status="received",
                   sample_form_id=form.id if form else None)
    db.add(s)
    db.flush()
    return s


def _vial_row(db, svc, parent, *, result_unit=None, result_value=None):
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"u-{parent.id}",
                         sample_id=f"{parent.sample_id}-S01", vial_sequence=1)
    db.add(vial)
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title,
                       result_unit=result_unit, result_value=result_value)
    db.add(row)
    db.commit()
    return vial, row


# --- allowed_units / unit_choices ---------------------------------------------

def test_allowed_units_catalog_first_deduped_and_blank_dropped(db):
    svc = _service(db, unit="ppm")
    _spec(db, svc, "µg/g")
    _spec(db, svc, " PPM ", matrix="Peptide")        # same unit as the catalog's
    _spec(db, svc, "µg/mL", form=_form(db))
    _spec(db, svc, None, matrix="Water")             # blank
    _spec(db, svc, "mg/kg", matrix="Old", active=False)   # inactive rows never count
    db.commit()
    assert allowed_units(db, svc) == ["ppm", "µg/g", "µg/mL"]


def test_default_from_single_form_unit_else_catalog(db):
    svc = _service(db, unit="ppm")
    nasal, powder = _form(db), _form(db, "Lyophilized Powder", "injectable")
    _spec(db, svc, "ppm")
    _spec(db, svc, "µg/mL", form=nasal)
    db.commit()

    got = unit_choices(db, svc, nasal.id)
    assert got == UnitChoices(["ppm", "µg/mL"], "µg/mL")
    assert unit_choices(db, svc, powder.id).default == "ppm"
    assert unit_choices(db, svc, None).default == "ppm"


def test_default_is_the_allowed_list_spelling(db):
    svc = _service(db, unit="ppm")
    nasal = _form(db)
    _spec(db, svc, "µg/mL")                           # first spelling wins
    _spec(db, svc, " µg/ML ", form=nasal)
    _spec(db, svc, None, form=nasal)                  # blank form unit does not count
    db.commit()
    got = unit_choices(db, svc, nasal.id)
    assert got.default == "µg/mL" and got.default in got.allowed


def test_default_none_when_form_has_two_units_without_catalog(db):
    svc = _service(db, unit="ppm")
    nasal, oral = _form(db), _form(db, "Oral Solution", "oral")
    _spec(db, svc, "µg/mL", form=nasal)
    _spec(db, svc, "µg/L", form=nasal)
    _spec(db, svc, "µg/mL", form=oral)
    _spec(db, svc, " PPM ", form=oral)
    db.commit()
    assert unit_choices(db, svc, nasal.id).default is None
    # the catalog unit is one of the form's two: it wins, in the list's spelling
    assert unit_choices(db, svc, oral.id).default == "ppm"


def test_service_without_unit_has_no_options(db):
    svc = _service(db, unit=None, keyword="STERILITY")
    _spec(db, svc, None)
    db.commit()
    assert unit_choices(db, svc, None) == UnitChoices([], None)
    assert canonical_unit(db, svc, "ppm") is None


def test_canonical_unit_returns_list_spelling(db):
    svc = _service(db, unit="ppm")
    _spec(db, svc, "µg/mL", form=_form(db))
    db.commit()
    assert canonical_unit(db, svc, " µg/ML ") == "µg/mL"
    assert canonical_unit(db, svc, "PPM") == "ppm"
    assert canonical_unit(db, svc, "mg/kg") is None
    assert canonical_unit(db, svc, "") is None


def test_unit_choices_reads_each_service_once_through_the_cache(db):
    svc = _service(db, unit="ppm")
    nasal = _form(db)
    _spec(db, svc, "µg/mL", form=nasal)
    db.commit()
    cache: dict = {}
    first = unit_choices(db, svc, nasal.id, cache)
    assert svc.id in cache
    db.query(AnalysisServiceSpec).delete()            # a second read must not hit the table
    assert unit_choices(db, svc, nasal.id, cache) == first


# --- the submit route -----------------------------------------------------------

def _routed_row(db):
    svc = _service(db, unit="ppm")
    _spec(db, svc, "µg/mL", form=_form(db))
    parent = _sample(db)
    db.commit()
    _, row = _vial_row(db, svc, parent)
    return row


def test_submit_with_disallowed_unit_422(client, db):
    row = _routed_row(db)
    before = len(db.execute(select(LimsAnalysisTransition)).scalars().all())

    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "submit", "result_value": "1.2", "result_unit": "mg/kg"})

    assert r.status_code == 422
    assert r.json()["detail"] == "unit 'mg/kg' is not one of ['ppm', 'µg/mL']"
    db.refresh(row)
    assert (row.result_value, row.result_unit) == (None, None)
    assert len(db.execute(select(LimsAnalysisTransition)).scalars().all()) == before


def test_submit_normalizes_to_list_spelling_and_stores_it(client, db):
    row = _routed_row(db)

    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "submit", "result_value": "1.2", "result_unit": "µg/ml"})

    assert r.status_code == 200, r.text
    db.refresh(row)
    assert (row.result_value, row.result_unit) == ("1.2", "µg/mL")


def test_submit_without_a_unit_is_unchanged(client, db):
    row = _routed_row(db)

    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "submit", "result_value": "1.2"})

    assert r.status_code == 200, r.text
    db.refresh(row)
    assert (row.result_value, row.result_unit) == ("1.2", None)


def test_unit_check_on_a_missing_analysis_is_404(client):
    r = client.post("/api/lims-analyses/99999/transitions",
                    json={"kind": "submit", "result_value": "1", "result_unit": "ppm"})
    assert r.status_code == 404


# --- the serializer ---------------------------------------------------------------

def _nasal_world(db):
    svc = _service(db, unit="ppm")
    nasal = _form(db)
    _spec(db, svc, "µg/g")
    _spec(db, svc, "µg/mL", form=nasal)
    parent = _sample(db, form=nasal)
    db.commit()
    return svc, parent


def test_serialized_unresulted_row_shows_form_default(db):
    svc, parent = _nasal_world(db)
    vial, _ = _vial_row(db, svc, parent, result_unit="ppm")   # seeded with the catalog unit

    (shaped,) = list_analyses_in_senaite_shape(db, host_kind="sub_sample", host_pk=vial.id)

    assert shaped.unit == "µg/mL"
    assert shaped.default_unit == "µg/mL"
    assert shaped.unit_options == ["ppm", "µg/g", "µg/mL"]


def test_serialized_resulted_row_keeps_its_own_unit(db):
    svc, parent = _nasal_world(db)
    vial, _ = _vial_row(db, svc, parent, result_unit="ppm", result_value="3")

    (shaped,) = list_analyses_in_senaite_shape(db, host_kind="sub_sample", host_pk=vial.id)

    assert shaped.unit == "ppm"
    assert shaped.default_unit == "µg/mL"
    assert shaped.unit_options == ["ppm", "µg/g", "µg/mL"]


def test_serialized_senaite_row_has_no_unit_options(db):
    svc, parent = _nasal_world(db)
    vial, row = _vial_row(db, svc, parent, result_unit="ppm")
    row.provenance, row.mirror_review_state = "shadow", "unassigned"
    row.senaite_analysis_uid = "a" * 32
    db.commit()

    (shaped,) = list_analyses_in_senaite_shape(db, host_kind="sub_sample", host_pk=vial.id)

    assert shaped.uid == "a" * 32
    assert (shaped.unit, shaped.default_unit, shaped.unit_options) == ("ppm", None, [])
