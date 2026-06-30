import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample, LimsSubSample
from boxes import service


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _vial(db, parent, seq, role):
    sub = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid=f"mk1://{parent.sample_id}-{seq}",
        sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq, assignment_role=role,
    )
    db.add(sub)
    db.flush()
    return sub


def test_next_box_numbers_run_per_order(db):
    b1 = service.next_box(db, "WP-20066", "hplc", user_id=1)
    b2 = service.next_box(db, "WP-20066", "ster", user_id=1)
    b3 = service.next_box(db, "WP-20071", "hplc", user_id=1)
    assert (b1.box_number, b2.box_number) == (1, 2)   # running across bins for one order
    assert b3.box_number == 1                          # separate order restarts
    assert service.box_label_code(b2) == "WP-20066-2"


def test_assign_rejects_role_mismatch(db):
    p = LimsSample(sample_id="P-0600", external_lims_uid="u-600")
    db.add(p); db.flush()
    endo_vial = _vial(db, p, 1, "endo")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    with pytest.raises(ValueError):
        service.assign_vials(db, box.id, [endo_vial.sample_id])


def test_assign_then_print_records_membership_and_stamp(db):
    p = LimsSample(sample_id="P-0601", external_lims_uid="u-601")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    assert v.box_id == box.id
    printed = service.mark_printed(db, box.id, user_id=7)
    assert printed.printed_at is not None
    assert printed.printed_by_user_id == 7
    assert len(service.list_for_order(db, "WP-20066")) == 1


def test_delete_empty_box_removes_it(db):
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    assert len(service.list_for_order(db, "WP-20066")) == 1
    service.delete_box(db, box.id)
    assert service.list_for_order(db, "WP-20066") == []


def test_delete_box_with_vials_is_rejected(db):
    p = LimsSample(sample_id="P-0602", external_lims_uid="u-602")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    with pytest.raises(service.BoxNotEmptyError):
        service.delete_box(db, box.id)
    assert len(service.list_for_order(db, "WP-20066")) == 1


def test_delete_missing_box_raises_lookup(db):
    with pytest.raises(LookupError):
        service.delete_box(db, 9999)
