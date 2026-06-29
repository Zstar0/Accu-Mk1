import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample, LimsSubSample, LimsBox


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_box_holds_vials_across_two_samples_of_same_order(db):
    # Two parents that share one order_key, one HPLC vial each.
    p1 = LimsSample(sample_id="P-0500", external_lims_uid="u-500")
    p2 = LimsSample(sample_id="P-0501", external_lims_uid="u-501")
    db.add_all([p1, p2])
    db.flush()
    box = LimsBox(order_key="WP-20066", box_number=1, role="hplc")
    db.add(box)
    db.flush()
    v1 = LimsSubSample(parent_sample_pk=p1.id, external_lims_uid="mk1://a",
                       sample_id="P-0500-S01", vial_sequence=1,
                       assignment_role="hplc", box_id=box.id)
    v2 = LimsSubSample(parent_sample_pk=p2.id, external_lims_uid="mk1://b",
                       sample_id="P-0501-S01", vial_sequence=1,
                       assignment_role="hplc", box_id=box.id)
    db.add_all([v1, v2])
    db.commit()

    assert {v.sample_id for v in box.vials} == {"P-0500-S01", "P-0501-S01"}
    assert v1.box.order_key == "WP-20066"
    assert v1.box.box_number == 1
