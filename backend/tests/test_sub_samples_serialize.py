"""Phase 5d read-side: the sub-sample list response must expose
external_lims_uid so the frontend can tell native vials (mk1:// uid)
from legacy SENAITE-backed ones and load native vials from Mk1 without
calling SENAITE.
"""
from __future__ import annotations

import datetime

from models import LimsBox, LimsSample, LimsSubSample
from sub_samples.routes import _serialize


def _make(db_session, *, uid, box_id=None):
    parent = LimsSample(sample_id="SER-0001", external_lims_uid="parent-uid",
                        last_synced_at=datetime.datetime.utcnow())
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid=uid,
        sample_id="SER-0001-S01", vial_sequence=1,
        received_at=datetime.datetime.utcnow(),
        box_id=box_id,
    )
    db_session.add(sub)
    db_session.commit()
    return sub


def test_serialize_exposes_native_uid(db_session):
    sub = _make(db_session, uid="mk1://abc123")
    resp = _serialize(sub)
    assert resp.external_lims_uid == "mk1://abc123"


def test_serialize_exposes_legacy_uid(db_session):
    sub = _make(db_session, uid="a8c27e69bfa84ff1bf16a3e370a44456")
    resp = _serialize(sub)
    assert resp.external_lims_uid == "a8c27e69bfa84ff1bf16a3e370a44456"


def test_serialize_box_id_null_when_unboxed(db_session):
    sub = _make(db_session, uid="mk1://unboxed")
    resp = _serialize(sub)
    assert resp.box_id is None


def test_serialize_exposes_box_id(db_session):
    box = LimsBox(order_key="SER-0001", box_number=1, role="hplc")
    db_session.add(box)
    db_session.flush()
    sub = _make(db_session, uid="mk1://boxed", box_id=box.id)
    resp = _serialize(sub)
    assert resp.box_id == box.id


def test_list_response_reflects_box_assignment(db_session):
    """End-to-end: after assigning a vial to a box via the boxing service, the
    sub-sample list response for that parent surfaces the vial's box_id — the
    link the boxing UI reads to render per-box vial chips."""
    from boxes import service as box_service
    from sub_samples.service import list_sub_samples

    parent = LimsSample(sample_id="SER-0002", external_lims_uid="parent-uid-2",
                        last_synced_at=datetime.datetime.utcnow())
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://e2e",
        sample_id="SER-0002-S01", vial_sequence=1,
        received_at=datetime.datetime.utcnow(),
        assignment_role="hplc",
    )
    db_session.add(sub)
    db_session.commit()

    box = box_service.next_box(db_session, order_key="SER-0002", role="hplc", user_id=1)
    box_service.assign_vials(db_session, box.id, [sub.sample_id])

    _parent, subs = list_sub_samples(db_session, "SER-0002")
    serialized = [_serialize(s) for s in subs]
    assert len(serialized) == 1
    assert serialized[0].sample_id == "SER-0002-S01"
    assert serialized[0].box_id == box.id
