"""backfill_attachment_type_stamp: stamp SENAITE's AttachmentType onto
historical (L3-swept, pre-column) lims_parent_attachments rows so the
sample_meta image gate can see them. Covers the title extraction shapes,
cohort selection (only manual / type-NULL / uid-bearing rows), the stamp
write, and the no-type-leaves-NULL rule.

Harness idioms cloned from test_backfill_lims_parent_attachments.py: an
in-memory sqlite sessionmaker with SessionLocal patched into the script's
module-under-test path.
"""
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsParentAttachment, LimsSample
from scripts.backfill_attachment_type_stamp import (
    extract_attachment_type,
    resolve_type_title,
    run,
)


# ── extract_attachment_type ──────────────────────────────────────────────────

def test_extract_plain_string():
    assert extract_attachment_type({"AttachmentType": "Sample Image"}) == "Sample Image"


def test_extract_get_prefixed_fallback():
    assert extract_attachment_type({"getAttachmentType": "HPLC Graph"}) == "HPLC Graph"


def test_extract_dict_title_lower_and_upper():
    assert extract_attachment_type({"AttachmentType": {"title": "Sample Image"}}) == "Sample Image"
    assert extract_attachment_type({"AttachmentType": {"Title": "Sample Image"}}) == "Sample Image"


def test_extract_missing_and_blank_return_none():
    assert extract_attachment_type({}) is None
    assert extract_attachment_type({"AttachmentType": ""}) is None
    assert extract_attachment_type({"AttachmentType": "   "}) is None
    assert extract_attachment_type({"AttachmentType": {}}) is None


def test_extract_clamps_to_column_width():
    assert extract_attachment_type({"AttachmentType": "x" * 150}) == "x" * 100


# ── resolve_type_title: the live ref-dict shape (probed 2026-08-30) ─────────

class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


def test_resolve_ref_dict_fetches_and_caches():
    detail = {"AttachmentType": {"uid": "t1", "url": "u", "api_url": "a"}}
    calls = []

    def _fake_get(url):
        calls.append(url)
        return _FakeResp({"items": [{"title": "Sample Image"}]})

    cache = {}
    with patch("lims_analyses.senaite_writeback._get", side_effect=_fake_get):
        assert resolve_type_title(detail, cache) == "Sample Image"
        assert resolve_type_title(detail, cache) == "Sample Image"  # cached
    assert len(calls) == 1
    assert cache == {"t1": "Sample Image"}


def test_resolve_inline_title_short_circuits_without_fetch():
    with patch("lims_analyses.senaite_writeback._get",
               side_effect=AssertionError("no fetch expected")):
        assert resolve_type_title(
            {"AttachmentType": "HPLC Graph"}, {}) == "HPLC Graph"


def test_resolve_failed_fetch_caches_none():
    detail = {"AttachmentType": {"uid": "t9"}}
    cache = {}
    with patch("lims_analyses.senaite_writeback._get",
               side_effect=RuntimeError("senaite down")):
        assert resolve_type_title(detail, cache) is None
    assert cache == {"t9": None}
    # second call resolves from cache — no retry storm
    with patch("lims_analyses.senaite_writeback._get",
               side_effect=AssertionError("must not refetch")):
        assert resolve_type_title(detail, cache) is None


def test_resolve_no_ref_returns_none():
    assert resolve_type_title({}, {}) is None
    assert resolve_type_title({"AttachmentType": {"url": "u"}}, {}) is None


# ── run(): cohort + stamping ─────────────────────────────────────────────────

@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _seed(session_factory):
    """One sample, four attachment rows: only the first is in-cohort."""
    db = session_factory()
    s = LimsSample(sample_id="P-0001", external_lims_uid="uid-P-0001")
    db.add(s)
    db.flush()
    rows = [
        # in-cohort: manual, type NULL, uid present
        LimsParentAttachment(
            lims_sample_pk=s.id, kind="manual", filename="photo.jpg",
            content_type="image/jpeg", storage="s3", storage_key="k1",
            senaite_attachment_uid="uid-img", render_in_report=True,
        ),
        # out: already typed
        LimsParentAttachment(
            lims_sample_pk=s.id, kind="manual", filename="typed.jpg",
            content_type="image/jpeg", storage="s3", storage_key="k2",
            senaite_attachment_uid="uid-typed", attachment_type="Sample Image",
            render_in_report=True,
        ),
        # out: capture-time kind (never in cohort regardless of type)
        LimsParentAttachment(
            lims_sample_pk=s.id, kind="receive_image", filename="cap.jpg",
            content_type="image/jpeg", storage="s3", storage_key="k3",
            render_in_report=True,
        ),
        # in-cohort but SENAITE has no type for it: stays NULL
        LimsParentAttachment(
            lims_sample_pk=s.id, kind="manual", filename="untyped.png",
            content_type="image/png", storage="s3", storage_key="k4",
            senaite_attachment_uid="uid-no-type", render_in_report=True,
        ),
    ]
    db.add_all(rows)
    db.commit()
    ids = [r.id for r in rows]
    db.close()
    return ids


def _fake_meta(uid, api_url=None):
    if uid == "uid-img":
        return {"AttachmentType": {"title": "Sample Image"}}
    if uid == "uid-no-type":
        return {"AttachmentFile": {"filename": "untyped.png"}}
    raise AssertionError(f"unexpected fetch for uid={uid}")


def test_apply_stamps_cohort_only_and_leaves_no_type_null(
    session_factory, tmp_path,
):
    ids = _seed(session_factory)
    with patch("database.SessionLocal", session_factory), \
         patch("sub_samples.senaite.fetch_attachment_meta", side_effect=_fake_meta):
        rc = run(apply=True, limit=None, probe=8, throttle=0,
                 checkpoint_path=str(tmp_path / "cp.json"),
                 max_consecutive_errors=10)
    assert rc == 0
    db = session_factory()
    rows = {r.id: r for r in db.execute(select(LimsParentAttachment)).scalars()}
    assert rows[ids[0]].attachment_type == "Sample Image"   # stamped
    assert rows[ids[0]].kind == "manual"                     # kind untouched
    assert rows[ids[1]].attachment_type == "Sample Image"   # pre-typed, untouched
    assert rows[ids[2]].attachment_type is None              # out of cohort
    assert rows[ids[3]].attachment_type is None              # no type in SENAITE
    db.close()


def test_dry_run_writes_nothing(session_factory, tmp_path):
    ids = _seed(session_factory)
    with patch("database.SessionLocal", session_factory), \
         patch("sub_samples.senaite.fetch_attachment_meta", side_effect=_fake_meta):
        rc = run(apply=False, limit=None, probe=8, throttle=0,
                 checkpoint_path=str(tmp_path / "cp.json"),
                 max_consecutive_errors=10)
    assert rc == 0
    db = session_factory()
    row = db.get(LimsParentAttachment, ids[0])
    assert row.attachment_type is None
    db.close()
