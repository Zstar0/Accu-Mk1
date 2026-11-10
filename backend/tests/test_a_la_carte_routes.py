"""generate-coa attachments gate for a la carte samples. Plan 4 Task 3: the
chromatogram requirement is off for a sample the decision helper judges
eligible, and for nothing else. The sample image stays required."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import event

import main
from models import LimsParentAttachment
from tests.test_a_la_carte_verdict import _add_row, _alc
from tests.test_coa_deferred_sections_warning import _patch_generate_prereqs

FLAGGED = {"source": "mk1", "rows": [], "page1": "none"}
SID = "P-9601"
# The gate's wording, verbatim from main.generate_sample_coa (do not reword).
CHROMATOGRAM_MESSAGE = ("Chromatogram \u2014 attach one from the sample page "
                        "(Select Vial Chromatogram, after processing the HPLC prep).")


def _setup(db, monkeypatch, *, image=True, services=None):
    p = _alc(db, monkeypatch, services=services)
    p.sample_id = SID
    db.flush()
    if image:
        db.add(LimsParentAttachment(
            lims_sample_pk=p.id, kind="receive_image", filename="f",
            content_type="image/png", storage="s3", storage_key="k",
            render_in_report=True, attachment_type="Sample Image",
            created_by_user_id=None))
        db.flush()
    order = {"services": services or {"fentanyl": True}, "package": "alacarte"}
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", lambda sid: order)
    monkeypatch.setattr("sub_samples.service.fetch_sample_services", lambda sid: order)
    monkeypatch.setattr("coa.source_setting.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr("coa.wire_document.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr("coa.wire_document.build_sample_meta",
                        lambda db, p, vial=None: {"source": "mk1"})
    client = _patch_generate_prereqs(
        monkeypatch, {"verification_code": "ALCT-3601", "generation_number": 1,
                      "warnings": []})
    return p, client


def _generate(db):
    return asyncio.run(main.generate_sample_coa(
        sample_id=SID, db=db, current_user=SimpleNamespace(id=1)))


def _blocked_detail(db):
    with pytest.raises(HTTPException) as ei:
        _generate(db)
    assert ei.value.status_code == 422
    return ei.value.detail


def _blocked(db):
    return str(_blocked_detail(db))


def _assert_chromatogram_blocked(db):
    blockers = _blocked_detail(db)["blockers"]
    attach = [b for b in blockers if b["code"] == "missing_attachments"]
    assert len(attach) == 1
    assert attach[0]["missing"] == ["chromatogram"]
    assert f"- {CHROMATOGRAM_MESSAGE}" in attach[0]["message"].splitlines()


def test_generate_fentanyl_only_posts_flagged_block_with_image_and_no_chromatogram(
        db_session, monkeypatch):
    _p, client = _setup(db_session, monkeypatch)
    result = _generate(db_session)
    assert result.success is True
    assert client.calls[0][1]["json"]["native_sections"]["legacy_rows"] == FLAGGED


def test_generate_a_la_carte_without_image_still_blocked(db_session, monkeypatch):
    _p, client = _setup(db_session, monkeypatch, image=False)
    detail = _blocked(db_session)
    assert "sample_image" in detail
    assert "chromatogram" not in detail
    assert client.calls == []


def test_generate_hplc_sample_without_chromatogram_still_blocked(db_session, monkeypatch):
    p, client = _setup(db_session, monkeypatch, services={"hplc-purity-identity": True})
    _add_row(db_session, p, "HPLC-PURITY", "mk1")
    _assert_chromatogram_blocked(db_session)
    assert client.calls == []


def test_generate_keeps_chromatogram_requirement_when_lookup_fails(db_session, monkeypatch):
    _p, client = _setup(db_session, monkeypatch)

    def boom(sid):
        raise RuntimeError("IS down")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", boom)
    monkeypatch.setattr("sub_samples.service.fetch_sample_services", boom)
    _assert_chromatogram_blocked(db_session)
    assert client.calls == []


def test_generate_keeps_422_when_verdict_query_aborts_transaction(db_session, monkeypatch):
    # On Postgres a failed query inside the helper aborts the transaction and
    # every later statement fails until a rollback. SQLite does not do that,
    # so the listener below imitates it. The gate must roll back to its
    # savepoint so the later gates still run and the lab gets the
    # chromatogram blocker, not a 500.
    _p, client = _setup(db_session, monkeypatch)
    aborted = {"on": False}
    engine = db_session.get_bind()

    def _pg_aborted(conn, cursor, statement, *a):
        if aborted["on"] and not statement.startswith("ROLLBACK"):
            raise RuntimeError("current transaction is aborted")

    def _cleared(conn, name, context):
        aborted["on"] = False

    def failing_query(db, pk):
        aborted["on"] = True
        raise RuntimeError("division by zero")
    monkeypatch.setattr("coa.native_sections._lab_added_profile_keys", failing_query)
    event.listen(engine, "before_cursor_execute", _pg_aborted)
    event.listen(engine, "rollback_savepoint", _cleared)
    try:
        _assert_chromatogram_blocked(db_session)
    finally:
        event.remove(engine, "before_cursor_execute", _pg_aborted)
        event.remove(engine, "rollback_savepoint", _cleared)
    assert client.calls == []
