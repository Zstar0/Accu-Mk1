"""relabel_native_slot + its route (spec 2026-09-10 M6): the only sanctioned
way to change a native-born sample's analyte slot. Pristine-slot gating,
peptide validation, duplicate-slot rejection, the restamp + event, and the
route's error translation. Also covers the legacy Replace/Clear 409 guard
on native-born parents (M6 addendum)."""
import json
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from database import Base
from models import LimsAnalysis, LimsSubSampleEvent, Peptide
from lims_analyses.hplc_native import (KW_IDENTITY, KW_PURITY, relabel_native_slot, NativeSlotLockedError,
                                       identity_title, purity_title)
from lims_analyses.service import apply_transition
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try: yield s
    finally: s.close()


def _rows(db, parent, slot):
    from models import LimsSubSample
    return db.execute(select(LimsAnalysis).outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
                      .where((LimsAnalysis.lims_sample_pk == parent.id) | (LimsSubSample.parent_sample_pk == parent.id),
                             LimsAnalysis.slot == slot)).scalars().all()


def test_relabel_pristine_slot_restamps_everything(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1401", vials=2,
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True); db.add(ghk); db.flush()
    out = relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)
    assert out["old_peptide_id"] == peps[2].id and out["new_peptide_id"] == ghk.id
    slots = json.loads(parent.analytes)
    assert slots[1] == {"name": "GHK-Cu", "declared_quantity": None, "peptide_id": ghk.id}
    rows = _rows(db, parent, 2)
    assert rows and all(r.peptide_id == ghk.id for r in rows)
    assert {r.title for r in rows if r.keyword == KW_IDENTITY} == {identity_title("GHK-Cu")}
    assert {r.title for r in rows if r.keyword == KW_PURITY} == {purity_title("GHK-Cu")}
    assert all(r.reportable_reason is None for r in rows)
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.event == "native_slot_relabeled")).scalar_one()
    assert ev.details["slot"] == 2 and ev.details["new_peptide_id"] == ghk.id
    # slot 1 untouched
    assert all(r.peptide_id == peps[1].id for r in _rows(db, parent, 1))


def test_relabel_resolves_an_unresolved_slot(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="P-1402", slots=[("BPC-157", "BPC157")])
    # simulate an unresolved slot: null the peptide on the stored slot + rows
    slots = json.loads(parent.analytes); slots[0] = {"name": "Mystery", "declared_quantity": None, "peptide_id": None}
    parent.analytes = json.dumps(slots)
    for r in _rows(db, parent, 1):
        r.peptide_id = None; r.reportable_reason = "analyte_unresolved: Mystery"
    db.flush()
    relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=peps[1].id, user_id=1, commit=False)
    assert all(r.peptide_id == peps[1].id and r.reportable_reason is None for r in _rows(db, parent, 1))


def test_relabel_409_once_any_row_has_a_result(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1403",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    pur2 = next(r for r in next(iter(vial_rows.values())) if r.keyword == KW_PURITY and r.slot == 2)
    apply_transition(db, analysis_id=pur2.id, kind="submit", result_value="97", user_id=1, commit=False)
    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True); db.add(ghk); db.flush()
    with pytest.raises(NativeSlotLockedError):
        relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)
    # slot 1 is still relabel-able
    relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=ghk.id, user_id=1, commit=False)


def test_relabel_rejects_duplicate_peptide_across_slots(db):
    from lims_analyses.hplc_native import NativeSlotLockedError
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1404",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    with pytest.raises(NativeSlotLockedError):   # same error class, code duplicate_peptide
        relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=peps[1].id, user_id=1, commit=False)


def test_relabel_rejects_missing_or_inactive_peptide(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1404B", slots=[("BPC-157", "BPC157")])
    with pytest.raises(NativeSlotLockedError) as ei:
        relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=999999, user_id=1, commit=False)
    assert ei.value.code == "peptide_not_found"
    inactive = Peptide(name="Retired", abbreviation="RETD", active=False); db.add(inactive); db.flush()
    with pytest.raises(NativeSlotLockedError) as ei2:
        relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=inactive.id, user_id=1, commit=False)
    assert ei2.value.code == "peptide_not_found"


def test_relabel_404_on_empty_slot(db):
    from lims_analyses.hplc_native import NativeSlotNotFoundError
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1404C", slots=[("BPC-157", "BPC157")])
    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True); db.add(ghk); db.flush()
    with pytest.raises(NativeSlotNotFoundError):
        relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)


# ─── Route + legacy-guard tests (StaticPool TestClient, copied verbatim from
# tests/test_native_promote.py:27-67) ─────────────────────────────────────────


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    from main import app
    from auth import get_current_user
    from database import get_db

    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
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


def test_relabel_route(client, db_session):
    parent, services, peps, vial_rows = native_family(db_session, sample_id="PB-1405",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True); db_session.add(ghk); db_session.flush()
    db_session.commit()

    resp = client.post(f"/api/lims-analyses/parent/PB-1405/native-slots/2/relabel",
                       json={"new_peptide_id": ghk.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["slot"] == 2 and body["new_peptide_id"] == ghk.id

    # a submitted result locks the slot
    mk2 = Peptide(name="Melanotan II", abbreviation="MT2", active=True); db_session.add(mk2); db_session.flush()
    db_session.commit()
    pur1 = next(r for r in next(iter(vial_rows.values())) if r.keyword == KW_PURITY and r.slot == 1)
    apply_transition(db_session, analysis_id=pur1.id, kind="submit", result_value="97", user_id=1, commit=True)
    resp2 = client.post(f"/api/lims-analyses/parent/PB-1405/native-slots/1/relabel",
                        json={"new_peptide_id": mk2.id})
    assert resp2.status_code == 409, resp2.text
    assert resp2.json()["detail"]["code"] == "native_slot_locked"

    # a SENAITE-born parent is never native-born
    from models import LimsSample
    senaite_parent = LimsSample(sample_id="SENAITE-1405", external_lims_system="senaite",
                                external_lims_uid="U-1405", analytes=json.dumps([
                                    {"name": "BPC-157", "declared_quantity": None, "peptide_id": peps[1].id}]))
    db_session.add(senaite_parent); db_session.commit()
    resp3 = client.post(f"/api/lims-analyses/parent/SENAITE-1405/native-slots/1/relabel",
                        json={"new_peptide_id": ghk.id})
    assert resp3.status_code == 409, resp3.text
    assert resp3.json()["detail"]["code"] == "native_slot_locked"


def test_legacy_replace_and_clear_409_on_native_born(client, db_session):
    parent, services, peps, vial_rows = native_family(db_session, sample_id="PB-1406",
                                                      slots=[("BPC-157", "BPC157")])
    db_session.commit()

    with patch("sub_samples.senaite.fetch_parent_analyte_slots", side_effect=AssertionError("must not be called")):
        r1 = client.post("/explorer/samples/PB-1406/analytes/1/replace",
                         json={"new_peptide_id": peps[1].id, "old_peptide_id": peps[1].id,
                               "senaite_uid": "U-PB-1406"})
        assert r1.status_code == 409, r1.text
        assert r1.json()["detail"]["code"] == "native_born_use_relabel"

        r2 = client.post("/explorer/samples/PB-1406/analytes/1/clear",
                         json={"senaite_uid": "U-PB-1406", "old_peptide_id": peps[1].id})
        assert r2.status_code == 409, r2.text
        assert r2.json()["detail"]["code"] == "native_born_use_relabel"
