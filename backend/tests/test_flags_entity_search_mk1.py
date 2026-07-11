import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams
    seams._REGISTRY.clear()
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _seed(db):
    from models import LimsSample, LimsSubSample, Worksheet
    s1 = LimsSample(sample_id="PB-0102", status="received")
    s2 = LimsSample(sample_id="PB-0199", status="received")
    s3 = LimsSample(sample_id="XY-0300", status="received")
    db.add_all([s1, s2, s3]); db.commit()
    v1 = LimsSubSample(parent_sample_pk=s1.id, external_lims_uid="u1",
                       sample_id="PB-0102-S01", vial_sequence=1)
    v2 = LimsSubSample(parent_sample_pk=s1.id, external_lims_uid="u2",
                       sample_id="PB-0102-S02", vial_sequence=2)
    db.add_all([v1, v2]); db.commit()
    w1 = Worksheet(title="Batch Alpha")
    w2 = Worksheet(title="Zeta run")
    db.add_all([w1, w2]); db.commit()
    return {"s1": s1, "v1": v1, "v2": v2, "w1": w1, "w2": w2}


def test_sample_search_prefix_returns_human_ids(db):
    from flags import seams
    _seed(db)
    hits = seams.resolve_entity_search(db, "sample", "PB-01")
    # prefix match, ordered by sample_id; XY-0300 excluded.
    assert [h["entity_id"] for h in hits] == ["PB-0102", "PB-0199"]
    # entity_id is the HUMAN sample_id (convention: dedup + deep-link use it).
    assert all(h["entity_id"] == h["label"] for h in hits)


def test_sample_search_is_prefix_not_substring(db):
    from flags import seams
    _seed(db)
    # "0102" is a substring but NOT a prefix of any sample_id → no match.
    assert seams.resolve_entity_search(db, "sample", "0102") == []


def test_sub_sample_search_returns_pk_ids(db):
    from flags import seams
    seed = _seed(db)
    hits = seams.resolve_entity_search(db, "sub_sample", "PB-0102-S")
    # vials only resolve context/label by pk → entity_id is the pk.
    assert {h["entity_id"] for h in hits} == {str(seed["v1"].id), str(seed["v2"].id)}
    assert {h["label"] for h in hits} == {"PB-0102-S01", "PB-0102-S02"}


def test_worksheet_search_title_prefix(db):
    from flags import seams
    seed = _seed(db)
    hits = seams.resolve_entity_search(db, "worksheet", "Batch")
    assert hits == [{"entity_id": str(seed["w1"].id), "label": "Batch Alpha"}]


def test_worksheet_search_numeric_id_match(db):
    from flags import seams
    seed = _seed(db)
    wid = seed["w2"].id
    hits = seams.resolve_entity_search(db, "worksheet", str(wid))
    assert any(h["entity_id"] == str(wid) for h in hits)


def test_search_percent_is_literal_not_wildcard(db):
    from flags import seams
    _seed(db)
    # '%' is escaped → literal, not a wildcard; no id starts with "PB%".
    assert seams.resolve_entity_search(db, "sample", "PB%") == []
