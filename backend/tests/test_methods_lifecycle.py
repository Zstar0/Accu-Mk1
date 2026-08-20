"""Methods controlled documents (slice 3) — Task 1: lifecycle columns +
revision-aware uniqueness. Task 2+3 (combined per ruling R-P3-0): drafts at
create, immutability + audited edits, new-revision + activate verbs. Harness
copied verbatim from tests/test_methods_catalog.py (in-memory SQLite, same
idiom as tests/test_manage_native_routes.py).

Scope note (Task 1 only): the first block of tests below exercises the
schema directly via the ORM — create_method still minted active=True/
status='active' at that point. Task 2 flipped creates to drafts; the
route-level tests further down assume that.
"""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base
from models import AnalysisService, HplcMethod


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _svc(db, kw):
    s = AnalysisService(title=kw.title(), keyword=kw, origin="mk1", active=True,
                        variance_capable=False)
    db.add(s)
    db.flush()
    return s


def _client(db_session, admin=True):
    """Route-level TestClient idiom, copied verbatim from
    tests/test_methods_catalog.py — wires client-issued requests and direct
    db_session queries onto the same connection."""
    from unittest.mock import MagicMock

    from fastapi.testclient import TestClient

    from auth import get_current_user
    from database import get_db
    from main import app

    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, role="admin" if admin else "standard", email="admin@test")

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
def client(db_session):
    yield from _client(db_session, admin=True)


def test_lifecycle_columns_and_same_name_revisions(db_session):
    m1 = HplcMethod(name="ICP-MS", code="AM-E-1", revision=1, status="active",
                    active=True, origin="mk1")
    m2 = HplcMethod(name="ICP-MS", code="AM-E-1", revision=2, status="draft",
                    active=False, origin="mk1", supersedes_id=None)
    db_session.add_all([m1, m2])
    db_session.commit()   # (name,1)+(name,2) legal now; plain name-unique would raise
    assert m2.activated_at is None


def test_lifecycle_columns_default_to_active_revision_1(db_session):
    m = HplcMethod(name="KF Titration", origin="mk1", active=True)
    db_session.add(m)
    db_session.commit()
    row = db_session.execute(select(HplcMethod).where(HplcMethod.name == "KF Titration")).scalar_one()
    assert row.status == "active"
    assert row.revision == 1
    assert row.activated_at is None
    assert row.retired_at is None


def test_duplicate_name_revision_pair_rejected(db_session):
    m1 = HplcMethod(name="PCR Detection", revision=1, origin="mk1", active=True)
    db_session.add(m1)
    db_session.commit()

    m2 = HplcMethod(name="PCR Detection", revision=1, origin="mk1", active=True)
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_code_revision_pair_unique_but_different_revisions_coexist(db_session):
    # Same code across two revisions is legal as long as only one is active
    # (uq_hplc_methods_code_active is a separate, narrower constraint).
    m1 = HplcMethod(name="ICP-MS R1", code="AM-E-2", revision=1, status="active",
                    active=True, origin="mk1")
    m2 = HplcMethod(name="ICP-MS R2", code="AM-E-2", revision=2, status="draft",
                    active=False, origin="mk1")
    db_session.add_all([m1, m2])
    db_session.commit()

    rows = db_session.execute(select(HplcMethod).where(HplcMethod.code == "AM-E-2")).scalars().all()
    assert {r.revision for r in rows} == {1, 2}


def test_duplicate_code_revision_pair_rejected(db_session):
    m1 = HplcMethod(name="ICP-MS Dup A", code="AM-E-3", revision=1, origin="mk1", active=True)
    db_session.add(m1)
    db_session.commit()

    m2 = HplcMethod(name="ICP-MS Dup B", code="AM-E-3", revision=1, origin="mk1", active=False)
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_two_active_rows_same_code_rejected_even_across_revisions(db_session):
    # uq_hplc_methods_code_active: at most one status='active' row per code,
    # regardless of revision.
    m1 = HplcMethod(name="ICP-MS Active A", code="AM-E-4", revision=1, status="active",
                    active=True, origin="mk1")
    db_session.add(m1)
    db_session.commit()

    m2 = HplcMethod(name="ICP-MS Active B", code="AM-E-4", revision=2, status="active",
                    active=True, origin="mk1")
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_null_code_rows_unconstrained_by_code_indexes(db_session):
    m1 = HplcMethod(name="No Code A", code=None, revision=1, origin="mk1", active=True)
    m2 = HplcMethod(name="No Code B", code=None, revision=1, origin="mk1", active=True)
    db_session.add_all([m1, m2])
    db_session.commit()  # both code=None rows coexist: partial indexes are WHERE code IS NOT NULL

    rows = db_session.execute(select(HplcMethod).where(HplcMethod.code.is_(None))).scalars().all()
    assert len(rows) == 2


# ═══════════════════════════════════════════════════════════════════════════════
# Task 2 — PUT rework: immutability + audited edits + no direct `active`
# ═══════════════════════════════════════════════════════════════════════════════


def test_create_mints_draft(client, db_session):
    b = client.post("/hplc/methods", json={"name": "KF", "technique": "KF"}).json()
    assert b["status"] == "draft" and b["active"] is False and b["revision"] == 1


def test_active_not_settable_via_put(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "KF3"}).json()["id"]
    assert client.put(f"/hplc/methods/{mid}", json={"active": False}).status_code == 400


def test_put_writes_change_log(client, db_session):
    from models import CatalogChangeLog
    mid = client.post("/hplc/methods", json={"name": "KF4"}).json()["id"]
    client.put(f"/hplc/methods/{mid}", json={"notes": "x"})
    logs = db_session.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method")).scalars().all()
    assert any(l.action == "update" and "notes" in l.details["changed"] for l in logs)


# ═══════════════════════════════════════════════════════════════════════════════
# Task 3 — new-revision + activate verbs (also covers Task 2's locked-field
# tests, which need `activate` to exist — see task-2-brief's locking-gate note)
# ═══════════════════════════════════════════════════════════════════════════════


def test_locked_field_edit_409_names_fields(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "KF-L", "technique": "KF"}).json()["id"]
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.put(f"/hplc/methods/{mid}", json={"procedure_summary": "changed"})
    assert r.status_code == 409
    assert "procedure_summary" in r.json()["detail"]


def test_notes_and_department_stay_editable_when_locked(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "KF-L2"}).json()["id"]
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.put(f"/hplc/methods/{mid}", json={"notes": "bench tip"})
    assert r.status_code == 200 and r.json()["notes"] == "bench tip"


def _icp_world(client, db):
    lead = _svc(db, "LEAD-PPM"); db.commit()
    mid = client.post("/hplc/methods", json={"name": "ICP-MS G", "code": "AM-G-1"}).json()["id"]
    client.post(f"/hplc/methods/{mid}/activate")
    client.put(f"/hplc/methods/{mid}/services",
               json=[{"analysis_service_id": lead.id, "is_default": True}])
    return mid, lead


def test_new_revision_clones_without_defaults_or_senaite(client, db_session):
    mid, lead = _icp_world(client, db_session)
    r = client.post(f"/hplc/methods/{mid}/new-revision")
    assert r.status_code == 201
    d = r.json()
    assert d["status"] == "draft" and d["revision"] == 2 and d["supersedes_id"] == mid
    assert d["senaite_id"] is None
    links = client.get(f"/hplc/methods/{d['id']}/services").json()
    assert links[0]["analysis_service_id"] == lead.id and links[0]["is_default"] is False


def test_activate_moves_defaults_and_retires_predecessor(client, db_session):
    mid, lead = _icp_world(client, db_session)
    rev2 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]
    r = client.post(f"/hplc/methods/{rev2}/activate")
    assert r.status_code == 200
    old = client.get("/hplc/methods").json()
    old_row = next(m for m in old if m["id"] == mid)
    new_row = next(m for m in old if m["id"] == rev2)
    assert old_row["status"] == "retired" and old_row["active"] is False
    assert new_row["status"] == "active" and new_row["active"] is True
    # default moved (R11)
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] == rev2


def test_activate_after_manual_retire_still_moves_defaults(client, db_session):
    """R11 amendment: defaults come from the SUPERSEDED row regardless of status."""
    mid, lead = _icp_world(client, db_session)
    rev2 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]
    client.post(f"/hplc/methods/{mid}/retire")   # manual retire, ahead of activate
    r = client.post(f"/hplc/methods/{rev2}/activate")
    assert r.status_code == 200
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] == rev2


def test_drafts_invisible_to_default_resolution(client, db_session):
    mid, lead = _icp_world(client, db_session)
    client.post(f"/hplc/methods/{mid}/new-revision")   # draft exists
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] == mid  # rev1 still


# ═══════════════════════════════════════════════════════════════════════════════
# Task 4 — retire verb + R-P3-2 (parallel-drafts generalized retire on activate)
# ═══════════════════════════════════════════════════════════════════════════════


def test_retire_fail_open_defaults(client, db_session):
    mid, lead = _icp_world(client, db_session)
    r = client.post(f"/hplc/methods/{mid}/retire")
    assert r.status_code == 200 and r.json()["status"] == "retired"
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] is None
    # stamped history untouched: FK intact, DELETE still guarded
    assert client.post(f"/hplc/methods/{mid}/retire").status_code == 400  # not active anymore


def test_activate_second_parallel_draft_retires_first(client, db_session):
    """R-P3-2: two drafts new-revision'd off the SAME source, both activated.
    The second activate must retire the first (now-active) revision — not
    just `src`, which is already retired by the time the second one runs —
    or it 500s on uq_hplc_methods_code_active."""
    mid, lead = _icp_world(client, db_session)
    rev2 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]
    rev3 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]

    assert client.post(f"/hplc/methods/{rev2}/activate").status_code == 200
    r = client.post(f"/hplc/methods/{rev3}/activate")
    assert r.status_code == 200

    rows = client.get("/hplc/methods").json()
    mid_row = next(m for m in rows if m["id"] == mid)
    rev2_row = next(m for m in rows if m["id"] == rev2)
    rev3_row = next(m for m in rows if m["id"] == rev3)
    assert mid_row["status"] == "retired"
    assert rev2_row["status"] == "retired" and rev2_row["active"] is False
    assert rev3_row["status"] == "active" and rev3_row["active"] is True

    active_same_code = [m for m in rows if m["code"] == rev3_row["code"] and m["status"] == "active"]
    assert len(active_same_code) == 1


def test_activate_second_parallel_draft_retires_first_codeless(client, db_session):
    """Same shape as test_activate_second_parallel_draft_retires_first but the
    source method has no code — exercises the null-code (name-keyed) branch
    of the generalized retire query directly."""
    mid = client.post("/hplc/methods", json={"name": "KF Codeless"}).json()["id"]
    assert client.post(f"/hplc/methods/{mid}/activate").status_code == 200
    rev2 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]
    rev3 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]

    assert client.post(f"/hplc/methods/{rev2}/activate").status_code == 200
    r = client.post(f"/hplc/methods/{rev3}/activate")
    assert r.status_code == 200

    rows = client.get("/hplc/methods").json()
    mid_row = next(m for m in rows if m["id"] == mid)
    rev2_row = next(m for m in rows if m["id"] == rev2)
    rev3_row = next(m for m in rows if m["id"] == rev3)
    assert mid_row["status"] == "retired"
    assert rev2_row["status"] == "retired" and rev2_row["active"] is False
    assert rev3_row["status"] == "active" and rev3_row["active"] is True
    assert rev3_row["code"] is None

    active_same_name_codeless = [m for m in rows if m["name"] == "KF Codeless"
                                  and m["status"] == "active" and m["code"] is None]
    assert len(active_same_name_codeless) == 1


def test_null_code_fallback_does_not_retire_unrelated_coded_active_method(client, db_session):
    """Fix-round finding: the null-code name-fallback must not cross into rows
    that DO carry a code — those are guarded by uq_hplc_methods_code_active
    (keyed on code), not by name. Reachable bug without `code IS NULL` in the
    fallback filter: update_method's rename guard only checks the (name,
    revision) pair — not status, not code — so a draft sitting at a revision
    number the target hasn't occupied can be renamed onto an existing active
    CODED method's name without tripping it. Activating the renamed,
    still-codeless draft must NOT retire the unrelated coded method."""
    target_r1 = client.post("/hplc/methods",
                             json={"name": "ICP-MS Shared", "code": "AM-SHR-1"}).json()
    assert client.post(f"/hplc/methods/{target_r1['id']}/activate").status_code == 200
    target_r2_id = client.post(f"/hplc/methods/{target_r1['id']}/new-revision").json()["id"]
    assert client.post(f"/hplc/methods/{target_r2_id}/activate").status_code == 200
    # target_r2_id: active, code="AM-SHR-1", occupies revisions 1 (retired) and 2 (active)

    # Walk an unrelated series up to revision 3 — a revision number the
    # "ICP-MS Shared" family hasn't touched — so the rename below lands
    # cross-revision and the (name, revision) guard in update_method has
    # nothing to collide with.
    tmp_r1 = client.post("/hplc/methods", json={"name": "Temp Unrelated"}).json()
    assert client.post(f"/hplc/methods/{tmp_r1['id']}/activate").status_code == 200
    tmp_r2 = client.post(f"/hplc/methods/{tmp_r1['id']}/new-revision").json()
    assert client.post(f"/hplc/methods/{tmp_r2['id']}/activate").status_code == 200
    draft = client.post(f"/hplc/methods/{tmp_r2['id']}/new-revision").json()
    assert draft["revision"] == 3 and draft["code"] is None

    rename = client.put(f"/hplc/methods/{draft['id']}", json={"name": "ICP-MS Shared"})
    assert rename.status_code == 200   # no (name=ICP-MS Shared, revision=3) row exists yet

    assert client.post(f"/hplc/methods/{draft['id']}/activate").status_code == 200

    rows = client.get("/hplc/methods").json()
    target_row = next(m for m in rows if m["id"] == target_r2_id)
    assert target_row["status"] == "active" and target_row["active"] is True
    assert target_row["code"] == "AM-SHR-1"


# ═══════════════════════════════════════════════════════════════════════════════
# Task 5 — method attachments (controlled documents)
# ═══════════════════════════════════════════════════════════════════════════════


def _draft(client, name="ATT-M"):
    return client.post("/hplc/methods", json={"name": name}).json()["id"]


def _use_tmp_photo_storage(tmp_path, monkeypatch):
    """Force filesystem PhotoStorage rooted in tmp_path. MK1_PHOTO_S3_BUCKET
    is already unset in the test env (get_storage() resolves filesystem by
    default — test_photo_storage_selection.py), so no env var needs setting;
    only the singleton's root needs redirecting away from the real default
    dir. monkeypatch.setattr on the module global auto-restores at teardown
    (same net effect as the set_storage_for_tests()/prev-restore idiom in
    test_sub_sample_attachments.py's `storage` fixture)."""
    from sub_samples.photo_storage import FilesystemPhotoStorage
    monkeypatch.setattr("sub_samples.photo_storage._storage",
                        FilesystemPhotoStorage(root=str(tmp_path)))


def test_attachment_upload_list_download(client, db_session, tmp_path, monkeypatch):
    _use_tmp_photo_storage(tmp_path, monkeypatch)

    mid = _draft(client)
    r = client.post(f"/hplc/methods/{mid}/attachments",
                    files={"file": ("sop-am-elem-001.pdf", b"%PDF-fake", "application/pdf")})
    assert r.status_code == 201
    att = r.json()
    assert att["filename"] == "sop-am-elem-001.pdf" and att["size_bytes"] == 9
    listed = client.get(f"/hplc/methods/{mid}/attachments").json()
    assert [a["id"] for a in listed] == [att["id"]]
    dl = client.get(f"/hplc/methods/{mid}/attachments/{att['id']}/download")
    assert dl.status_code == 200 and dl.content == b"%PDF-fake"
    assert dl.headers["content-type"].startswith("application/pdf")


def test_attachment_delete_draft_only(client, db_session, tmp_path, monkeypatch):
    _use_tmp_photo_storage(tmp_path, monkeypatch)

    mid = _draft(client, "ATT-M2")
    att = client.post(f"/hplc/methods/{mid}/attachments",
                      files={"file": ("sop.pdf", b"x", "application/pdf")}).json()
    client.post(f"/hplc/methods/{mid}/activate")
    assert client.delete(f"/hplc/methods/{mid}/attachments/{att['id']}").status_code == 409
    # uploads stay allowed on issued methods
    r = client.post(f"/hplc/methods/{mid}/attachments",
                    files={"file": ("amendment.pdf", b"y", "application/pdf")})
    assert r.status_code == 201


def test_attachment_delete_succeeds_while_draft(client, db_session, tmp_path, monkeypatch):
    _use_tmp_photo_storage(tmp_path, monkeypatch)

    mid = _draft(client, "ATT-M3")
    att = client.post(f"/hplc/methods/{mid}/attachments",
                      files={"file": ("draft-sop.pdf", b"zz", "application/pdf")}).json()
    r = client.delete(f"/hplc/methods/{mid}/attachments/{att['id']}")
    assert r.status_code == 200
    assert client.get(f"/hplc/methods/{mid}/attachments").json() == []
    assert client.get(
        f"/hplc/methods/{mid}/attachments/{att['id']}/download").status_code == 404


def test_attachment_upload_empty_file_rejected(client, db_session, tmp_path, monkeypatch):
    _use_tmp_photo_storage(tmp_path, monkeypatch)

    mid = _draft(client, "ATT-M5")
    r = client.post(f"/hplc/methods/{mid}/attachments",
                    files={"file": ("empty.pdf", b"", "application/pdf")})
    assert r.status_code == 400


def test_attachment_upload_writes_change_log(client, db_session, tmp_path, monkeypatch):
    from models import CatalogChangeLog
    _use_tmp_photo_storage(tmp_path, monkeypatch)

    mid = _draft(client, "ATT-M4")
    att = client.post(f"/hplc/methods/{mid}/attachments",
                      files={"file": ("audited.pdf", b"abc", "application/pdf")}).json()
    logs = db_session.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method_attachment",
        CatalogChangeLog.entity_pk == att["id"])).scalars().all()
    assert any(l.action == "create" and l.details["changed"]["filename"]["after"] == "audited.pdf"
              for l in logs)
