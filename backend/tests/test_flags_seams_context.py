"""Task 1 — entity-registry `context` + `descendants` seams (Mk1 resolvers).

These guard the host-domain knowledge that lives ONLY in the
`register_mk1_entities()` closures: a vial resolves to its parent Sample ID +
analyte titles + a `sample` deep-link, a sample resolves to itself, and a
sample's descendants are its vials. The flag module core stays entity-agnostic.
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401 — register the LIMS tables on Base.metadata
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seeded(db):
    """One parent sample, two vials, a couple of (de-dupe-worthy) analyses."""
    from models import LimsSample, LimsSubSample, LimsAnalysis
    sample = LimsSample(sample_id="P-0071")
    db.add(sample)
    db.flush()
    v1 = LimsSubSample(parent_sample_pk=sample.id, external_lims_uid="mk1://v1",
                       sample_id="P-0071-S01", vial_sequence=1)
    v2 = LimsSubSample(parent_sample_pk=sample.id, external_lims_uid="mk1://v2",
                       sample_id="P-0071-S02", vial_sequence=2)
    db.add_all([v1, v2])
    db.flush()
    # Two distinct titles on v1 + a duplicate to exercise de-dupe.
    for title, kw in [("PEPT-Total", "pept_total"), ("HPLC-PUR", "hplc_pur"),
                      ("PEPT-Total", "pept_total")]:
        db.add(LimsAnalysis(lims_sub_sample_pk=v1.id, analysis_service_id=1,
                            keyword=kw, title=title))
    db.flush()
    return {"sample": sample, "v1": v1, "v2": v2}


def test_sub_sample_context(db, seeded):
    from flags import seams
    seams.register_mk1_entities()
    ctx = seams.resolve_context(db, "sub_sample", str(seeded["v1"].id))
    assert ctx is not None
    assert ctx["label"] == "P-0071-S01"
    assert ctx["sample_id"] == "P-0071"
    assert ctx["analyses"] == ["PEPT-Total", "HPLC-PUR"]  # de-duped, order-stable
    assert ctx["lot"] is None
    assert ctx["deep_link"] == {"kind": "sample", "id": "P-0071"}


def test_sample_context(db, seeded):
    from flags import seams
    seams.register_mk1_entities()
    ctx = seams.resolve_context(db, "sample", str(seeded["sample"].id))
    assert ctx is not None
    assert ctx["label"] == "P-0071"
    assert ctx["sample_id"] == "P-0071"
    assert ctx["lot"] is None
    assert ctx["deep_link"]["kind"] == "sample"


def test_sample_context_resolves_by_human_id(db, seeded):
    """The frontend has the Sample ID string (P-0071), not the pk — the Mk1
    sample closure accepts either."""
    from flags import seams
    seams.register_mk1_entities()
    ctx = seams.resolve_context(db, "sample", "P-0071")
    assert ctx is not None and ctx["sample_id"] == "P-0071"


def test_sample_descendants(db, seeded):
    from flags import seams
    seams.register_mk1_entities()
    kids = seams.resolve_descendants(db, "sample", str(seeded["sample"].id))
    assert set(kids) == {("sub_sample", str(seeded["v1"].id)),
                         ("sub_sample", str(seeded["v2"].id))}


def test_worksheet_context_and_no_descendants(db, seeded):
    from flags import seams
    seams.register_mk1_entities()
    ctx = seams.resolve_context(db, "worksheet", "9")
    assert ctx == {
        "entity_type": "worksheet", "entity_id": "9", "label": "Worksheet 9",
        "sample_id": None, "analyses": [], "lot": None,
        "deep_link": {"kind": "worksheet", "id": "9"},
    }
    assert seams.resolve_descendants(db, "worksheet", "9") == []


def test_unregistered_and_missing_never_raise(db, seeded):
    from flags import seams
    seams.register_mk1_entities()
    # Unknown entity type → None / [] (never raises into a request).
    assert seams.resolve_context(db, "nope", "1") is None
    assert seams.resolve_descendants(db, "nope", "1") == []
    # Registered type, missing row → None.
    assert seams.resolve_context(db, "sub_sample", "999999") is None
