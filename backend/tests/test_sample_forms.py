"""Sample Forms (dosage forms) API, default-on-create, retest copy, sample
PATCH and lookup payload (2026-10-26 sample-forms, Task 3)."""
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
import main
from database import Base, get_db
from models import CatalogChangeLog, LimsSample, LimsSampleForm, LimsSubSampleEvent
from sample_forms import service
from sub_samples.lookup_models import SenaiteLookupResult
from sub_samples.service import upsert_sample_from_signal
from tests.test_registry_signal import _signal_meta


class _FakeUser:
    id = 9
    email = "josh@accumark.test"


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


@pytest.fixture
def client(db):
    main.app.dependency_overrides[get_db] = lambda: (yield db)
    main.app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    yield TestClient(main.app)
    main.app.dependency_overrides.pop(get_db, None)
    main.app.dependency_overrides.pop(auth.get_current_user, None)


@pytest.fixture
def forms(db):
    rows = {
        "lyo": LimsSampleForm(name="Lyophilized Powder", route="injectable",
                              is_default=True, sort_order=10),
        "pen": LimsSampleForm(name="Pen", route="injectable", sort_order=20),
        "nasal": LimsSampleForm(name="Nasal Spray", route="nasal_inhaled", sort_order=30),
        "retired": LimsSampleForm(name="Retired Form", route="oral", active=False, sort_order=40),
    }
    db.add_all(rows.values())
    db.commit()
    return rows


def _events(db, sample):
    return db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == sample.id,
        LimsSubSampleEvent.event == "sample_form_changed",
    )).scalars().all()


def _peptide(db, sample_id="P-2001", uid="AR_UID_1", **over):
    return upsert_sample_from_signal(db, sample_id, uid, _signal_meta(uid=uid, **over))


# ── default on create ──────────────────────────────────────────────────────

def test_new_peptide_row_gets_default_and_bw_gets_none(db, forms):
    pep = _peptide(db)
    assert pep.sample_form_id == forms["lyo"].id
    bw = _peptide(db, "PB-0001", "AR_UID_2", getSampleTypeTitle="Bacteriostatic Water")
    assert bw.sample_form_id is None


def test_peptide_blend_is_eligible_for_default(db, forms):
    row = _peptide(db, getSampleTypeTitle="Peptide Blend")
    assert row.sample_form_id == forms["lyo"].id


def test_unseeded_forms_table_is_a_silent_noop(db):
    assert service.default_form_id(db) is None
    row = _peptide(db)
    assert row.sample_form_id is None


def test_refresh_signal_never_overwrites_a_patched_form(db, forms):
    row = _peptide(db)
    service.set_sample_form(db, sample=row, sample_form_id=forms["nasal"].id, user_id=9)
    db.commit()
    again = _peptide(db, ClientSampleID="CS-9")
    assert again.id == row.id
    assert again.client_sample_id == "CS-9"          # the replay did refresh fields
    assert again.sample_form_id == forms["nasal"].id


# ── retest copy ────────────────────────────────────────────────────────────

def test_retest_signal_copies_original_form(db, forms):
    original = _peptide(db, "P-1", "AR_UID_1")
    service.set_sample_form(db, sample=original, sample_form_id=forms["nasal"].id, user_id=9)
    retest = _peptide(db, "P-2", "AR_UID_2", RetestOfSampleId="P-1")
    assert retest.retest_of_sample_id == "P-1"
    assert retest.sample_form_id == forms["nasal"].id        # not the default


def test_retest_of_missing_original_keeps_default(db, forms):
    retest = _peptide(db, "P-2", "AR_UID_2", RetestOfSampleId="P-404")
    assert retest.sample_form_id == forms["lyo"].id


def test_retest_of_original_without_form_keeps_default(db, forms):
    bw = _peptide(db, "PB-1", "AR_UID_1", getSampleTypeTitle="Bacteriostatic Water")
    assert bw.sample_form_id is None
    retest = _peptide(db, "P-2", "AR_UID_2", RetestOfSampleId="PB-1")
    assert retest.sample_form_id == forms["lyo"].id


def test_retest_copy_is_a_noop_for_an_ineligible_sample_type(db, forms):
    """Final review I1 (Ruling F-2): a retest retitled to Bac Water must not
    inherit its original's form, or the form tier would outrank the BW row."""
    original = _peptide(db, "P-1", "AR_UID_1")
    service.set_sample_form(db, sample=original, sample_form_id=forms["nasal"].id, user_id=9)
    retest = _peptide(db, "PB-2", "AR_UID_2", RetestOfSampleId="P-1",
                      getSampleTypeTitle="Bacteriostatic Water")
    assert retest.sample_form_id is None
    service.copy_form_from_original(db, retest)        # direct call, same answer
    assert retest.sample_form_id is None


# ── service: set_sample_form ───────────────────────────────────────────────

def test_set_sample_form_errors(db, forms):
    pep = _peptide(db)
    with pytest.raises(service.SampleFormError) as e:
        service.set_sample_form(db, sample=pep, sample_form_id=9999, user_id=None)
    assert e.value.status == 404
    with pytest.raises(service.SampleFormError) as e:
        service.set_sample_form(db, sample=pep, sample_form_id=forms["retired"].id, user_id=None)
    assert e.value.status == 422


def test_form_payload_none_row_and_eligible_row(db, forms):
    assert service.form_payload(db, None) == {
        "sample_form_id": None, "sample_form_name": None, "sample_form_eligible": False}
    pep = _peptide(db)
    assert service.form_payload(db, pep) == {
        "sample_form_id": forms["lyo"].id, "sample_form_name": "Lyophilized Powder",
        "sample_form_eligible": True}


# ── PATCH /api/lims-samples/{sample_id}/form ───────────────────────────────

def test_patch_form_writes_event_and_is_noop_when_unchanged(client, db, forms):
    pep = _peptide(db)
    db.commit()
    r = client.patch("/api/lims-samples/P-2001/form", json={"sample_form_id": forms["nasal"].id})
    assert r.status_code == 200, r.text
    assert r.json() == {"sample_form_id": forms["nasal"].id,
                        "sample_form_name": "Nasal Spray", "sample_form_eligible": True}
    evs = _events(db, pep)
    assert len(evs) == 1
    assert evs[0].user_id == 9
    assert evs[0].details == {"from_id": forms["lyo"].id, "from_name": "Lyophilized Powder",
                              "to_id": forms["nasal"].id, "to_name": "Nasal Spray"}
    again = client.patch("/api/lims-samples/P-2001/form", json={"sample_form_id": forms["nasal"].id})
    assert again.status_code == 200
    assert len(_events(db, pep)) == 1


def test_patch_form_404_for_unknown_sample_and_unknown_form(client, db, forms):
    _peptide(db)
    db.commit()
    assert client.patch("/api/lims-samples/P-9999/form",
                        json={"sample_form_id": forms["pen"].id}).status_code == 404
    assert client.patch("/api/lims-samples/P-2001/form",
                        json={"sample_form_id": 9999}).status_code == 404


def test_patch_form_422_for_bac_water_and_for_inactive(client, db, forms):
    bw = _peptide(db, "PB-0001", "AR_UID_2", getSampleTypeTitle="Bacteriostatic Water")
    pep = _peptide(db)
    db.commit()
    r = client.patch("/api/lims-samples/PB-0001/form", json={"sample_form_id": forms["pen"].id})
    assert r.status_code == 422
    r = client.patch("/api/lims-samples/P-2001/form", json={"sample_form_id": forms["retired"].id})
    assert r.status_code == 422
    assert bw.sample_form_id is None
    assert pep.sample_form_id == forms["lyo"].id
    assert _events(db, pep) == []


def test_patch_same_inactive_form_is_accepted(client, db, forms):
    pep = _peptide(db)
    pep.sample_form_id = forms["retired"].id          # retired after assignment
    db.commit()
    r = client.patch("/api/lims-samples/P-2001/form",
                     json={"sample_form_id": forms["retired"].id})
    assert r.status_code == 200
    assert r.json()["sample_form_name"] == "Retired Form"
    assert _events(db, pep) == []


# ── lookup payload ─────────────────────────────────────────────────────────

def test_lookup_cache_hit_shows_new_form_after_patch(client, db, forms, monkeypatch):
    """A cached SENAITE-born lookup must never show a stale form: the form is
    mutable Mk1 state, re-stamped on every cache hit."""
    pep = _peptide(db)
    db.commit()
    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")
    monkeypatch.setattr(main, "_senaite_lookup_cache", {
        "P-2001": (time.time(), SenaiteLookupResult(sample_id="P-2001", analytes=[])),
    })
    first = client.get("/wizard/senaite/lookup", params={"id": "P-2001", "no_cache": "false"})
    assert first.status_code == 200, first.text
    assert first.json()["sample_form_name"] == "Lyophilized Powder"
    assert first.json()["sample_form_eligible"] is True
    r = client.patch("/api/lims-samples/P-2001/form", json={"sample_form_id": forms["nasal"].id})
    assert r.status_code == 200
    second = client.get("/wizard/senaite/lookup", params={"id": "P-2001", "no_cache": "false"})
    assert second.json()["sample_form_id"] == forms["nasal"].id
    assert second.json()["sample_form_name"] == "Nasal Spray"
    assert pep.sample_form_id == forms["nasal"].id


def test_native_details_carries_form(db, forms):
    from sub_samples.registry_details import build_native_details
    _peptide(db)
    db.commit()
    res = build_native_details(db, "P-2001")
    assert (res.sample_form_id, res.sample_form_name, res.sample_form_eligible) == (
        forms["lyo"].id, "Lyophilized Powder", True)
    missing = build_native_details(db, "P-0000")
    assert (missing.sample_form_id, missing.sample_form_name, missing.sample_form_eligible) == (
        None, None, False)


# ── forms list API ─────────────────────────────────────────────────────────

def test_list_forms_counts_samples_and_hides_inactive_by_default(client, db, forms):
    _peptide(db)
    _peptide(db, "P-2002", "AR_UID_2")
    db.commit()
    rows = client.get("/api/sample-forms").json()
    assert [r["name"] for r in rows] == ["Lyophilized Powder", "Pen", "Nasal Spray"]
    assert rows[0] == {"id": forms["lyo"].id, "name": "Lyophilized Powder", "route": "injectable",
                       "is_default": True, "active": True, "sort_order": 10, "sample_count": 2}
    assert rows[1]["sample_count"] == 0
    everything = client.get("/api/sample-forms", params={"include_inactive": "true"}).json()
    assert [r["name"] for r in everything][-1] == "Retired Form"


def test_create_form_logs_and_returns_201(client, db, forms):
    r = client.post("/api/sample-forms", json={"name": "  Capsule ", "route": "oral"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "Capsule"
    assert body["is_default"] is False and body["active"] is True and body["sample_count"] == 0
    assert body["sort_order"] == 50                       # appended after the highest (40)
    log = db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "sample_form")).scalars().all()
    assert [(c.action, c.entity_pk, c.user_id) for c in log] == [("create", body["id"], 9)]


def test_create_form_rejects_bad_route_and_blank_name(client, db, forms):
    assert client.post("/api/sample-forms", json={"name": "X", "route": "rectal"}).status_code == 422
    assert client.post("/api/sample-forms", json={"name": "   ", "route": "oral"}).status_code == 422


def test_duplicate_form_name_409(client, db, forms):
    r = client.post("/api/sample-forms", json={"name": " nasal SPRAY ", "route": "oral"})
    assert r.status_code == 409
    r = client.patch(f"/api/sample-forms/{forms['pen'].id}", json={"name": "lyophilized powder"})
    assert r.status_code == 409
    # the failed write left the session usable
    assert client.get("/api/sample-forms").status_code == 200


def test_cannot_deactivate_default_and_make_default_moves_flag(client, db, forms):
    r = client.patch(f"/api/sample-forms/{forms['lyo'].id}", json={"active": False})
    assert r.status_code == 422
    r = client.patch(f"/api/sample-forms/{forms['pen'].id}", json={"is_default": True})
    assert r.status_code == 200, r.text
    assert r.json()["is_default"] is True
    db.expire_all()
    assert [f.name for f in db.execute(select(LimsSampleForm).where(
        LimsSampleForm.is_default.is_(True))).scalars()] == ["Pen"]
    assert service.default_form_id(db) == forms["pen"].id
    # the old default is now an ordinary form and may be retired
    r = client.patch(f"/api/sample-forms/{forms['lyo'].id}", json={"active": False})
    assert r.status_code == 200 and r.json()["active"] is False
    # a new peptide row now takes the new default
    assert _peptide(db).sample_form_id == forms["pen"].id


def test_default_must_be_active_and_is_default_false_is_refused(client, db, forms):
    r = client.patch(f"/api/sample-forms/{forms['retired'].id}", json={"is_default": True})
    assert r.status_code == 422
    r = client.patch(f"/api/sample-forms/{forms['pen'].id}", json={"is_default": False})
    assert r.status_code == 422


def test_patch_form_edits_fields_and_logs_only_real_changes(client, db, forms):
    pen = forms["pen"]
    r = client.patch(f"/api/sample-forms/{pen.id}",
                     json={"name": "Pen Injector", "sort_order": 25, "active": False})
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["sort_order"], r.json()["active"]) == ("Pen Injector", 25, False)
    log = db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "sample_form")).scalars().all()
    assert len(log) == 1 and set(log[0].details["changed"]) == {"name", "sort_order", "active"}
    client.patch(f"/api/sample-forms/{pen.id}", json={"name": "Pen Injector"})   # no-op
    assert db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "sample_form")).scalars().all().__len__() == 1
    assert client.patch("/api/sample-forms/9999", json={"name": "Z"}).status_code == 404


def test_activity_log_labels_form_change(client, db, forms):
    _peptide(db)
    db.commit()
    client.patch("/api/lims-samples/P-2001/form", json={"sample_form_id": forms["nasal"].id})
    events = client.get("/samples/P-2001/activity").json()
    ev = next(e for e in (events if isinstance(events, list) else events["events"])
              if e["event"] == "sample_form_changed")
    assert ev["label"] == "Form changed: Lyophilized Powder \u2192 Nasal Spray"
    assert ev["details"]["to_name"] == "Nasal Spray"


def test_activity_log_form_change_from_no_form_reads_none(client, db):
    _peptide(db)                      # forms table unseeded: the sample has no form
    nasal = LimsSampleForm(name="Nasal Spray", route="nasal_inhaled")
    db.add(nasal)
    db.commit()
    client.patch("/api/lims-samples/P-2001/form", json={"sample_form_id": nasal.id})
    events = client.get("/samples/P-2001/activity").json()
    ev = next(e for e in (events if isinstance(events, list) else events["events"])
              if e["event"] == "sample_form_changed")
    assert ev["label"] == "Form changed: none → Nasal Spray"
