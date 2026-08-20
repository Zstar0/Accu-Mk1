from decimal import Decimal
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import VialRole, CatalogChangeLog
from catalog.change_log import apply_and_log, log_create, log_delete, log_members, _json_safe


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _make_role(db, **overrides):
    defaults = dict(
        code="tst", label="Old", boxable=False, variance_eligible=False,
        sort_order=5, frozen=False, is_system=False,
    )
    defaults.update(overrides)
    row = VialRole(**defaults)
    db.add(row)
    db.flush()
    return row


def test_apply_and_log_writes_one_row_for_changed_field(db):
    row = _make_role(db)

    changed = apply_and_log(
        db, row, {"label": "New", "boxable": False},
        entity_type="vial_role", entity_pk=row.id, user_id=7,
    )
    db.flush()

    assert changed == {"label": {"before": "Old", "after": "New"}}
    rows = db.query(CatalogChangeLog).all()
    assert len(rows) == 1
    log_row = rows[0]
    assert log_row.details == {"changed": {"label": {"before": "Old", "after": "New"}}}
    assert log_row.action == "update"
    assert log_row.entity_type == "vial_role"
    assert log_row.entity_pk == row.id
    assert log_row.user_id == 7


def test_apply_and_log_no_row_when_nothing_changes(db):
    row = _make_role(db)

    changed = apply_and_log(
        db, row, {"label": "Old", "boxable": False},
        entity_type="vial_role", entity_pk=row.id, user_id=7,
    )
    db.flush()

    assert changed == {}
    assert db.query(CatalogChangeLog).count() == 0


def test_log_create_snapshots_before_none_per_field(db):
    row = _make_role(db, code="new1", label="Fresh")

    log_create(db, row, ["code", "label"], entity_type="vial_role", entity_pk=row.id, user_id=None)
    db.flush()

    log_row = db.query(CatalogChangeLog).one()
    assert log_row.action == "create"
    assert log_row.entity_type == "vial_role"
    assert log_row.entity_pk == row.id
    assert log_row.user_id is None
    assert log_row.details == {
        "changed": {
            "code": {"before": None, "after": "new1"},
            "label": {"before": None, "after": "Fresh"},
        }
    }


def test_log_delete_snapshots_after_none_per_field(db):
    row = _make_role(db, code="gone", label="Bye")

    log_delete(db, row, ["code", "label"], entity_type="vial_role", entity_pk=row.id, user_id=3)
    db.flush()

    log_row = db.query(CatalogChangeLog).one()
    assert log_row.action == "delete"
    assert log_row.details == {
        "changed": {
            "code": {"before": "gone", "after": None},
            "label": {"before": "Bye", "after": None},
        }
    }


def test_log_members_same_list_writes_no_row(db):
    log_members(
        db, entity_type="department", entity_pk=1, user_id=1,
        field="role_ids", before_ids=[1, 2, 3], after_ids=[1, 2, 3],
    )
    db.flush()

    assert db.query(CatalogChangeLog).count() == 0


def test_log_members_reordered_list_writes_row(db):
    log_members(
        db, entity_type="department", entity_pk=1, user_id=1,
        field="role_ids", before_ids=[1, 2, 3], after_ids=[2, 1, 3],
    )
    db.flush()

    log_row = db.query(CatalogChangeLog).one()
    assert log_row.action == "update"
    assert log_row.entity_type == "department"
    assert log_row.entity_pk == 1
    assert log_row.details == {"changed": {"role_ids": {"before": [1, 2, 3], "after": [2, 1, 3]}}}


def test_json_safe_decimal_becomes_str():
    assert _json_safe(Decimal("1.50")) == "1.50"


def test_json_safe_datetime_becomes_isoformat():
    dt = datetime(2026, 8, 11, 12, 0, 0)
    assert _json_safe(dt) == dt.isoformat()


def test_json_safe_passthrough_for_other_types():
    assert _json_safe("plain") == "plain"
    assert _json_safe(None) is None
    assert _json_safe(42) == 42
