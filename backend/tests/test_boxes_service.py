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


def test_unassign_clears_box_membership(db):
    p = LimsSample(sample_id="P-0610", external_lims_uid="u-610")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    assert v.box_id == box.id
    assert service.vial_count(db, box.id) == 1

    n = service.unassign_vials(db, [v.sample_id])
    assert n == 1
    assert v.box_id is None
    assert service.vial_count(db, box.id) == 0


def test_unassign_already_unassigned_is_noop_success(db):
    p = LimsSample(sample_id="P-0611", external_lims_uid="u-611")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    assert v.box_id is None
    # Unassigning a vial that was never boxed succeeds and leaves it unboxed.
    n = service.unassign_vials(db, [v.sample_id])
    assert n == 1
    assert v.box_id is None
    # Unknown ids are simply not found — no error.
    assert service.unassign_vials(db, ["P-9999-S01"]) == 0


def test_delete_empty_box_removes_it(db):
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    assert len(service.list_for_order(db, "WP-20066")) == 1
    service.delete_box(db, box.id)
    assert service.list_for_order(db, "WP-20066") == []


def test_delete_box_with_vials_unassigns_and_removes(db):
    p = LimsSample(sample_id="P-0602", external_lims_uid="u-602")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20066", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    # Deleting a non-empty box returns its vials to Unboxed, then removes the box.
    service.delete_box(db, box.id)
    assert service.list_for_order(db, "WP-20066") == []
    db.refresh(v)
    assert v.box_id is None


def test_delete_missing_box_raises_lookup(db):
    with pytest.raises(LookupError):
        service.delete_box(db, 9999)


def test_close_box_unassigns_vials_and_stamps_stored(db):
    p = LimsSample(sample_id="P-0603", external_lims_uid="u-603")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20067", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    closed = service.close_box(db, box.id, user_id=7)
    assert closed.stored_at is not None
    assert closed.stored_by_user_id == 7
    db.refresh(v)
    assert v.box_id is None
    # Closed boxes drop off both active surfaces.
    assert service.list_for_order(db, "WP-20067") == []
    assert box.id not in [b.id for b in service.list_active(db)]


def test_close_box_is_idempotent(db):
    box = service.next_box(db, "WP-20068", "hplc", user_id=1)
    first = service.close_box(db, box.id, user_id=1)
    stamp = first.stored_at
    again = service.close_box(db, box.id, user_id=2)
    # Re-close is a no-op: first closer's stamp wins, nothing re-stamps.
    assert again.stored_at == stamp
    assert again.stored_by_user_id == 1


def test_close_missing_box_raises_lookup(db):
    with pytest.raises(LookupError):
        service.close_box(db, 9999, user_id=1)


def test_list_active_excludes_stored(db):
    a = service.next_box(db, "WP-20069", "hplc", user_id=1)
    b = service.next_box(db, "WP-20069", "endo", user_id=1)
    service.close_box(db, a.id, user_id=1)
    ids = [x.id for x in service.list_active(db)]
    assert a.id not in ids
    assert b.id in ids
