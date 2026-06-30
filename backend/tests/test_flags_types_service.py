"""Unit tests for the flag-type service (validation, entity scope, CRUD guards)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401  (register FlagType)
    import flags.models  # noqa: F401  (register flag_flags)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    # Seed the 5 built-ins the way _run_migrations does on Postgres.
    from models import FlagType
    builtins = [
        ("blocker", "Blocker", "#e5484d", "issue", True, 0),
        ("critical", "Critical", "#e8730a", "issue", True, 1),
        ("question", "Question", "#3b82f6", "issue", False, 2),
        ("waiting_on_customer", "Waiting on Customer", "#8b5cf6", "issue", False, 3),
        ("ready_for_verification", "Ready for Verification", "#22c55e", "signal", False, 4),
    ]
    for slug, label, color, kind, blocking, order in builtins:
        s.add(FlagType(slug=slug, label=label, color=color, kind=kind,
                       is_blocking=blocking, sort_order=order, entity_types=[],
                       is_builtin=True))
    s.commit()
    try:
        yield s
    finally:
        s.close()


def test_list_types_returns_builtins(db):
    from flags import types_service
    rows = types_service.list_types(db)
    slugs = [r.slug for r in rows]
    assert slugs == ["blocker", "critical", "question",
                     "waiting_on_customer", "ready_for_verification"]


def test_is_valid_type(db):
    from flags import types_service
    assert types_service.is_valid_type(db, "blocker") is True
    assert types_service.is_valid_type(db, "nope") is False


def test_kind_for_type(db):
    from flags import types_service
    assert types_service.kind_for_type(db, "ready_for_verification") == "signal"
    assert types_service.kind_for_type(db, "blocker") == "issue"


def test_is_allowed_for_entity_global(db):
    from flags import types_service
    # Built-ins are global (entity_types=[]) → allowed for any entity.
    assert types_service.is_allowed_for_entity(db, "blocker", "sample") is True
    assert types_service.is_allowed_for_entity(db, "blocker", "worksheet") is True


def test_is_allowed_for_entity_restricted(db):
    from flags import types_service
    t = types_service.create_type(db, label="Vial Only", color="#abcdef",
                                  kind="issue", entity_types=["sub_sample"])
    assert types_service.is_allowed_for_entity(db, t.slug, "sub_sample") is True
    assert types_service.is_allowed_for_entity(db, t.slug, "worksheet") is False


def test_list_types_filters_by_entity_and_active(db):
    from flags import types_service
    t = types_service.create_type(db, label="Vial Only", color="#abcdef",
                                  kind="issue", entity_types=["sub_sample"])
    # For a worksheet, the restricted type is excluded; globals remain.
    ws = [r.slug for r in types_service.list_types(db, entity_type="worksheet")]
    assert t.slug not in ws and "blocker" in ws
    # For a vial, the restricted type appears.
    vial = [r.slug for r in types_service.list_types(db, entity_type="sub_sample")]
    assert t.slug in vial
    # active_only hides deactivated types.
    types_service.set_active(db, t.id, False)
    vial_active = [r.slug for r in types_service.list_types(db, entity_type="sub_sample", active_only=True)]
    assert t.slug not in vial_active
    # …but list_types without active_only still includes it (color resolution).
    vial_all = [r.slug for r in types_service.list_types(db, entity_type="sub_sample")]
    assert t.slug in vial_all


def test_create_then_delete_unused_custom(db):
    from flags import types_service
    t = types_service.create_type(db, label="Throwaway", color="#123456", kind="issue")
    assert t.slug == "throwaway" and t.is_builtin is False
    types_service.delete_type(db, t.id)
    assert types_service.get_type(db, t.id) is None


def test_create_generates_unique_slug(db):
    from flags import types_service
    from flags.errors import ConflictError
    types_service.create_type(db, label="My Type", color="#111111", kind="issue")
    # Same label → same generated slug → conflict.
    with pytest.raises(ConflictError):
        types_service.create_type(db, label="My Type", color="#222222", kind="issue")
    # Cannot shadow a built-in slug.
    with pytest.raises(ConflictError):
        types_service.create_type(db, label="X", slug="blocker", color="#333333", kind="issue")


def test_delete_builtin_raises_conflict(db):
    from flags import types_service
    from flags.errors import ConflictError
    blocker = types_service.get_type_by_slug(db, "blocker")
    with pytest.raises(ConflictError):
        types_service.delete_type(db, blocker.id)


def test_delete_in_use_custom_raises_conflict(db):
    from flags import types_service
    from flags.errors import ConflictError
    from flags.models import FlagFlag
    t = types_service.create_type(db, label="In Use", color="#abcabc", kind="issue")
    db.add(FlagFlag(entity_type="sub_sample", entity_id="1", kind="issue",
                    type=t.slug, status="open", title="x", created_by=1))
    db.commit()
    with pytest.raises(ConflictError):
        types_service.delete_type(db, t.id)


def test_set_active_toggles(db):
    from flags import types_service
    t = types_service.create_type(db, label="Toggle", color="#ababab", kind="issue")
    types_service.set_active(db, t.id, False)
    assert types_service.get_type(db, t.id).is_active is False
    types_service.set_active(db, t.id, True)
    assert types_service.get_type(db, t.id).is_active is True


def test_update_type_edits_fields(db):
    from flags import types_service
    t = types_service.create_type(db, label="Edit Me", color="#000000", kind="issue")
    types_service.update_type(db, t.id, label="Edited", color="#ffffff",
                              kind="signal", is_blocking=True,
                              entity_types=["sample"], sort_order=9)
    got = types_service.get_type(db, t.id)
    assert got.label == "Edited" and got.color == "#ffffff"
    assert got.kind == "signal" and got.is_blocking is True
    assert got.entity_types == ["sample"] and got.sort_order == 9


def test_update_type_rejects_slug_change(db):
    from flags import types_service
    from flags.errors import BadRequestError
    t = types_service.create_type(db, label="Immutable", color="#000000", kind="issue")
    with pytest.raises(BadRequestError):
        types_service.update_type(db, t.id, slug="something_else")
    # Supplying the SAME slug is a no-op, not an error.
    types_service.update_type(db, t.id, slug=t.slug, label="Renamed")
    assert types_service.get_type(db, t.id).label == "Renamed"
