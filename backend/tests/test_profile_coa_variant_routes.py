"""Route-level tests for the COA text variant routes and the variant audit rows
written by profile delete. Fixtures mirror test_service_spec_routes.py: one
shared in-memory SQLite session backs both the app and the test's assertions.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisProfile, AnalysisProfileCoaVariant, CatalogChangeLog, LimsSampleForm


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


@pytest.fixture
def profile(db_session):
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    db_session.add(p); db_session.commit()
    return p


@pytest.fixture
def nasal(db_session):
    f = LimsSampleForm(name="Nasal Spray", route="nasal_inhaled")
    db_session.add(f); db_session.commit()
    return f


def _post(client, profile, nasal, **fields):
    return client.post(f"/analysis-profiles/{profile.id}/coa-variants",
                       json={"sample_form_id": nasal.id, **fields})


def _log(db, action):
    return db.query(CatalogChangeLog).filter_by(entity_type="profile_coa_variant", action=action).all()


def test_create_returns_the_form_name_and_three_states(client, profile, nasal):
    r = _post(client, profile, nasal, coa_basis_note="", coa_prep_text="Diluted", coa_footnotes=[])
    assert r.status_code == 201
    body = r.json()
    assert body["sample_form_name"] == "Nasal Spray"
    assert body["coa_basis_note"] == "" and body["coa_prep_text"] == "Diluted"
    assert body["coa_method_text"] is None and body["coa_footnotes"] == [] and body["active"] is True


def test_create_404_unknown_profile(client, nasal):
    r = client.post("/analysis-profiles/999/coa-variants", json={"sample_form_id": nasal.id})
    assert r.status_code == 404


@pytest.mark.parametrize("body", [{}, {"sample_form_id": 999}])
def test_create_400_missing_or_unknown_form(client, profile, body):
    assert client.post(f"/analysis-profiles/{profile.id}/coa-variants", json=body).status_code == 400


def test_second_active_variant_409_until_the_first_is_switched_off(client, profile, nasal):
    first = _post(client, profile, nasal).json()
    r = _post(client, profile, nasal)
    assert r.status_code == 409
    assert r.json()["detail"] == "an active version already exists for this form; stop using it first"
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    assert _post(client, profile, nasal).status_code == 201


def test_list_returns_active_only(client, profile, nasal):
    first = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    second = _post(client, profile, nasal).json()
    r = client.get(f"/analysis-profiles/{profile.id}/coa-variants")
    assert [v["id"] for v in r.json()] == [second["id"]]


def test_patch_null_means_default_and_omitted_is_unchanged(client, profile, nasal):
    v = _post(client, profile, nasal, coa_prep_text="Diluted", coa_method_text="ICP").json()
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_prep_text": None})
    assert r.json()["coa_prep_text"] is None and r.json()["coa_method_text"] == "ICP"


def test_patch_cannot_move_the_form(client, profile, nasal, db_session):
    pen = LimsSampleForm(name="Pen", route="injectable")
    db_session.add(pen); db_session.commit()
    v = _post(client, profile, nasal).json()
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"sample_form_id": pen.id})
    assert r.json()["sample_form_id"] == nasal.id


def test_patch_404_unknown_variant(client):
    r = client.patch("/analysis-profile-coa-variants/999", json={"active": False})
    assert r.status_code == 404 and r.json()["detail"] == "version not found"


@pytest.mark.parametrize("fields", [
    {"coa_section_title": ""}, {"coa_section_title": "   "}, {"coa_basis_note": "   "},
    {"coa_prep_text": "Has {lot}"}, {"coa_footnotes": [{"label": "L {lod}", "text": "t"}]},
    {"coa_footnotes": [{"label": "only label", "text": ""}]}, {"coa_footnotes": "nope"},
])
def test_bad_text_400_on_create_and_patch(client, profile, nasal, fields):
    assert _post(client, profile, nasal, **fields).status_code == 400
    v = _post(client, profile, nasal).json()
    assert client.patch(f"/analysis-profile-coa-variants/{v['id']}", json=fields).status_code == 400


@pytest.mark.parametrize("title", ["Metals {lod}", "Metals {lot}"])
def test_macro_in_a_title_is_400_on_create_and_patch(client, profile, nasal, title):
    # The builder prints a title as typed, so {lod} would reach the certificate raw.
    detail = "COA text macros are not filled in section titles"
    r = _post(client, profile, nasal, coa_section_title=title)
    assert r.status_code == 400 and r.json()["detail"] == detail
    v = _post(client, profile, nasal).json()
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_section_title": title})
    assert r.status_code == 400 and r.json()["detail"] == detail


@pytest.mark.parametrize("fields", [
    {"coa_prep_text": "New"},
    # A stale Save with every field on Same as default sends only nulls.
    {"coa_section_title": None, "coa_basis_note": None, "coa_method_text": None,
     "coa_prep_text": None, "coa_footnotes": None},
    {"coa_footnotes": []},
    {"coa_prep_text": "New", "active": False},
])
def test_text_on_a_stopped_version_is_409_and_changes_nothing(client, profile, nasal, db_session, fields):
    v = _post(client, profile, nasal, coa_prep_text="Diluted").json()
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"active": False})
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json=fields)
    assert r.status_code == 409
    assert r.json()["detail"] == "this version is no longer in use; save again to add it back"
    row = db_session.get(AnalysisProfileCoaVariant, v["id"])
    db_session.refresh(row)
    assert row.coa_prep_text == "Diluted" and row.active is False


def test_a_repeat_stop_is_a_no_op_200(client, profile, nasal, db_session):
    v = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"active": False})
    logged = len(_log(db_session, "update"))
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"active": False})
    assert r.status_code == 200 and r.json()["active"] is False
    assert len(_log(db_session, "update")) == logged


def test_active_true_brings_a_stopped_version_back_with_new_text(client, profile, nasal):
    v = _post(client, profile, nasal, coa_prep_text="Diluted").json()
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"active": False})
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}",
                     json={"active": True, "coa_prep_text": "New"})
    assert r.status_code == 200
    assert r.json()["active"] is True and r.json()["coa_prep_text"] == "New"


def test_good_macros_and_empty_footnotes_are_accepted(client, profile, nasal):
    r = _post(client, profile, nasal, coa_prep_text="[LOD {lod}.]", coa_footnotes=[])
    assert r.status_code == 201


def test_text_over_the_column_length_is_422(client, profile, nasal):
    assert _post(client, profile, nasal, coa_basis_note="x" * 201).status_code == 422
    assert _post(client, profile, nasal, coa_section_title="x" * 201).status_code == 422


def test_reactivating_into_an_occupied_slot_is_409(client, profile, nasal):
    first = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    _post(client, profile, nasal)
    r = client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": True})
    assert r.status_code == 409


def test_active_null_is_422(client, profile, nasal):
    v = _post(client, profile, nasal).json()
    assert client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"active": None}).status_code == 422


def test_audit_rows(client, profile, nasal, db_session):
    v = _post(client, profile, nasal, coa_prep_text="Diluted").json()
    [created] = _log(db_session, "create")
    assert created.entity_pk == v["id"]
    assert created.details["changed"]["coa_prep_text"] == {"before": None, "after": "Diluted"}
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_prep_text": "Diluted"})
    assert _log(db_session, "update") == []
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_prep_text": "New", "active": False})
    [updated] = _log(db_session, "update")
    assert set(updated.details["changed"]) == {"coa_prep_text", "active"}


def test_profile_delete_logs_each_variant(client, profile, nasal, db_session):
    first = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    _post(client, profile, nasal)
    assert client.delete(f"/analysis-profiles/{profile.id}").status_code == 204
    assert len(_log(db_session, "delete")) == 2
