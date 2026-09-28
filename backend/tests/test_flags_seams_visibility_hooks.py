"""New optional registry seams (spec §6.2, §14): can_raise, can_view, visible_entity_ids,
search_scoped, and the two helpers slice 2 wires into the read paths."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import String, create_engine, literal, select, union_all
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ADMIN = SimpleNamespace(id=1, role="admin", is_active=True)
ALLOWED = SimpleNamespace(id=7, role="standard", is_active=True)
BLOCKED = SimpleNamespace(id=8, role="standard", is_active=True)


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    seams.register_mk1_entities()
    saved = dict(seams._REGISTRY)
    try:
        yield s
    finally:
        seams._REGISTRY.clear()
        seams._REGISTRY.update(saved)
        s.close()


def _register_thing(*, raise_in_view=False):
    from flags import seams

    def visible_ids(db, user):
        if getattr(user, "role", None) == "admin":
            return None
        if user.id != ALLOWED.id:
            return select(literal("", String)).where(literal(False))
        return union_all(select(literal("1", String)), select(literal("3", String)))

    def can_view(db, user, eid):
        if raise_in_view:
            raise RuntimeError("boom")
        return getattr(user, "role", None) == "admin" or (user.id == ALLOWED.id and eid in ("1", "3"))

    seams.register_entity(
        "thing",
        label=lambda db, eid: f"Thing {eid}",
        deep_link=lambda eid: "/#dashboard/orders",
        can_flag=lambda user, eid: True,
        can_raise=lambda db, user, eid: user.id == ALLOWED.id,
        can_view=can_view,
        visible_entity_ids=visible_ids,
        context=lambda db, eid: {"label": f"Thing {eid}", "sample_id": None, "analyses": [],
                                 "lot": None, "deep_link": {"kind": "none", "id": eid}},
        search_scoped=lambda db, user, q: [{"entity_id": "1", "label": f"{q} for {user.id}"}],
    )


def test_defaults_keep_legacy_types_visible(db):
    from flags import seams
    assert seams.can_view_entity(db, BLOCKED, "sample", "P-0001") is True
    assert seams.can_view_entity(db, BLOCKED, "not-registered", "x") is True
    spec = seams.get_entity_spec("sample")
    assert spec.can_raise is None and spec.can_view is None
    assert spec.visible_entity_ids is None and spec.search_scoped is None


def test_can_view_entity_uses_the_seam_and_fails_closed(db):
    from flags import seams
    _register_thing()
    assert seams.can_view_entity(db, ALLOWED, "thing", "1") is True
    assert seams.can_view_entity(db, ALLOWED, "thing", "2") is False
    assert seams.can_view_entity(db, BLOCKED, "thing", "1") is False
    assert seams.can_view_entity(db, ADMIN, "thing", "2") is True
    _register_thing(raise_in_view=True)
    assert seams.can_view_entity(db, ADMIN, "thing", "1") is False, "a raising closure hides, never shows"


def test_visibility_clause_filters_only_scoped_types(db):
    from flags import seams
    from flags.models import FlagFlag
    _register_thing()
    # created_by is NOT NULL with no default on FlagFlag (see flags/models.py); the brief's
    # rows omit it, so it is added here (arbitrary actor id, irrelevant to this assertion).
    rows = [FlagFlag(entity_type=None, entity_id=None, kind="issue", type="task", status="open", title="general", created_by=1),
            FlagFlag(entity_type="sample", entity_id="P-1", kind="issue", type="task", status="open", title="legacy", created_by=1),
            FlagFlag(entity_type="thing", entity_id="1", kind="issue", type="task", status="open", title="ok", created_by=1),
            FlagFlag(entity_type="thing", entity_id="2", kind="issue", type="task", status="open", title="hidden", created_by=1)]
    db.add_all(rows)
    db.commit()
    titles = lambda u: sorted(db.execute(  # noqa: E731
        select(FlagFlag.title).where(seams.visibility_clause(db, u))).scalars().all())
    assert titles(ALLOWED) == ["general", "legacy", "ok"]
    assert titles(BLOCKED) == ["general", "legacy"]
    assert titles(ADMIN) == ["general", "hidden", "legacy", "ok"]


def test_visibility_clause_is_true_when_no_type_scopes(db):
    from flags import seams
    from flags.models import FlagFlag
    db.add(FlagFlag(entity_type="sample", entity_id="P-1", kind="issue", type="task", status="open", title="t", created_by=1))
    db.commit()
    assert db.execute(select(FlagFlag.id).where(seams.visibility_clause(db, BLOCKED))).scalars().all()


def test_entity_search_prefers_scoped_and_needs_a_user(db):
    from flags import seams
    _register_thing()
    assert seams.resolve_entity_search(db, "thing", "qq", user=ALLOWED) == [{"entity_id": "1", "label": "qq for 7"}]
    assert seams.resolve_entity_search(db, "thing", "qq") == []
    assert seams.resolve_entity_search(db, "worksheet", "zzz-none", user=ALLOWED) == []  # legacy `search` path still works


def test_create_flag_honors_can_raise(db):
    from flags import service
    from flags.errors import BadRequestError, PermissionDeniedError
    from flags import seams
    _register_thing()
    f = service.create_flag(db, user=ALLOWED, entity_type="thing", entity_id="1", type="task", title="ok")
    assert f.entity_type == "thing"
    with pytest.raises(PermissionDeniedError):
        service.create_flag(db, user=BLOCKED, entity_type="thing", entity_id="1", type="task", title="no")

    def redirect(db_, user, eid):
        raise BadRequestError("flag the underlying worksheet '9' instead")
    spec = seams.get_entity_spec("thing")
    seams.register_entity("thing", label=spec.label, deep_link=spec.deep_link, can_flag=spec.can_flag,
                          can_raise=redirect, context=spec.context)
    with pytest.raises(BadRequestError, match="underlying worksheet"):
        service.create_flag(db, user=ALLOWED, entity_type="thing", entity_id="1", type="task", title="x")
    # legacy path untouched: sample has no can_raise, can_flag says yes
    assert service.create_flag(db, user=BLOCKED, entity_type="sample", entity_id="P-1", type="task", title="s").id


def test_entity_context_carries_board_fields():
    # deep_link is required by EntityContext with no default (every other caller
    # supplies it via **ctx); added here so this construction validates under
    # pydantic v2, without weakening the board_slug/node_kind assertion below.
    from flags.schemas import EntityContext
    c = EntityContext(entity_type="board_node", entity_id="5", label="Org > Marketing",
                      board_slug="org", node_kind="frame",
                      deep_link={"kind": "none", "id": "5"})
    assert (c.board_slug, c.node_kind) == ("org", "frame")
    assert EntityContext(entity_type="sample", entity_id="P-1", label="P-1",
                         deep_link={"kind": "none", "id": "P-1"}).board_slug is None
