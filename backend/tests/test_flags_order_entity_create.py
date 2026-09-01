"""create_flag on the 'order' entity WITH the builtin 'order' item kind seeded.

Prod-parity regression for the receive-page flag buttons: 'order' is BOTH a
registered entity seam (seams.register_mk1_entities) and a builtin item kind
(kinds_service._BUILTINS, seeded into flag_item_kinds by the Postgres
migration). create_flag consults resolve_virtual_kind before is_registered,
so with the kind row present every entity-anchored order flag was rejected
400 "item kind 'order' takes no entity_id" — which is why prod has zero
entity_type='order' flags. The registered entity seam must win the slug.

Self-contained engine fixture mirroring test_flags_general_tasks.py — the
whole point is controlling the seed: kinds_service.seed_builtins() is what
puts the colliding 'order' kind row in, exactly like prod.
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service, kinds_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    kinds_service.seed_builtins(s)  # seeds 'general_task' AND 'order' — prod parity
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def test_order_flag_creates_with_entity_id_despite_kind_seed(db):
    # The receive-page payload: entity_type='order' + the order number.
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="order",
                            entity_id="WP-6344", type="task",
                            title="short one vial")
    assert f.entity_type == "order" and f.entity_id == "WP-6344"
    assert f.status == "open"


def test_order_kind_anchor_still_creates_without_entity_id(db):
    # The compose-picker category shape (entity_id NULL) must keep working
    # whichever branch it takes.
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="order",
                            entity_id=None, type="task", title="order admin")
    assert f.entity_type == "order" and f.entity_id is None


def test_unregistered_kind_with_entity_id_still_rejected(db):
    # The guard this fix must NOT loosen: a pure item kind (no entity seam)
    # still takes no entity_id.
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(1), entity_type="general_task",
                            entity_id="123", type="task", title="x")


def test_resolve_virtual_kind_yields_to_registered_entity(db):
    # The seam-level contract: a slug that is both a registered entity and an
    # item kind resolves as the entity (docstring: a virtual kind is a category
    # WITHOUT a registered entity seam).
    from flags import seams
    assert seams.resolve_virtual_kind(db, "order") is None
    assert seams.resolve_virtual_kind(db, "general_task") is not None
