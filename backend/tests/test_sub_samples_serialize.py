"""Phase 5d read-side: the sub-sample list response must expose
external_lims_uid so the frontend can tell native vials (mk1:// uid)
from legacy SENAITE-backed ones and load native vials from Mk1 without
calling SENAITE.
"""
from __future__ import annotations

import datetime

from models import LimsSample, LimsSubSample
from sub_samples.routes import _serialize


def _make(db_session, *, uid):
    parent = LimsSample(sample_id="SER-0001", external_lims_uid="parent-uid",
                        last_synced_at=datetime.datetime.utcnow())
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid=uid,
        sample_id="SER-0001-S01", vial_sequence=1,
        received_at=datetime.datetime.utcnow(),
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
