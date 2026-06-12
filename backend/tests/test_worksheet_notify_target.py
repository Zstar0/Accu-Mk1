"""_worksheet_notify_target: order-status notifications must carry the PARENT
sample id. The IS /explorer/worksheet-assigned endpoint maps sample_id → order
via receive-webhook events / order payload sample_results — both keyed by
parent AR ids. Vial ids (…-SNN) would no-op there (no_order_found)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from main import _worksheet_notify_target
from models import LimsSample, LimsSubSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def vial(db):
    parent = LimsSample(sample_id="BW-0014", external_lims_uid="uid-bw14")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://notify-001",
        sample_id="BW-0014-S03",
        vial_sequence=3,
        assignment_role="hplc",
    )
    db.add(sub)
    db.commit()
    return sub


def test_parent_id_passes_through(db):
    assert _worksheet_notify_target(db, "P-0144") == "P-0144"


def test_vial_id_resolves_to_parent_via_db(db, vial):
    assert _worksheet_notify_target(db, "BW-0014-S03") == "BW-0014"


def test_unknown_vial_shaped_id_falls_back_to_regex_strip(db):
    assert _worksheet_notify_target(db, "P-9999-S01") == "P-9999"


def test_empty_and_non_sample_strings_unchanged(db):
    assert _worksheet_notify_target(db, "") == ""
    assert _worksheet_notify_target(db, "WS-2026-001") == "WS-2026-001"
