"""Flags 'order' entity: label, context, descendants roll-up.

Mirrors the real seam idiom from test_flags_seams_context.py: `db_session` is
the shared in-memory-SQLite fixture (conftest.py), entities are registered via
`seams.register_mk1_entities()`, and resolution goes through the module's
actual public entrypoints — `resolve_context` / `resolve_descendants` for the
richer resolvers, and `get_entity_spec("order").label(...)` for the label
closure (there is no standalone `resolve_label` — `label` is read straight off
the registered `EntitySpec`, same as `test_flags_seams.py` does for "widget").

Fix round 1: the context's `deep_link` must be the `{"kind", "id"}` dict shape
every OTHER registered entity's context uses (routes.py's `EntityContext(**ctx)`
requires a `DeepLink` submodel there, and slack_notify's `link_hash_for` does
`.get("kind")` on it) — the bare `"/#senaite/receive-sample"` string only
belongs on the top-level `spec.deep_link` callable. The tests below now
exercise `resolve_context` directly (the exact hole that let the bare-string
bug ship silently), round-tripping it through the real `EntityContext` pydantic
model the way `routes.py:441` does.
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from flags import seams
from flags.schemas import EntityContext
from models import LimsOrder, LimsSample


def test_order_label_includes_customer(db_session):
    seams.register_mk1_entities()
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-6344",
                             customer_name="Jane Doe"))
    db_session.commit()
    spec = seams.get_entity_spec("order")
    assert spec.label(db_session, "WP-6344") == "WP-6344 · Jane Doe"


def test_order_label_without_row_is_number(db_session):
    seams.register_mk1_entities()
    spec = seams.get_entity_spec("order")
    assert spec.label(db_session, "WP-404") == "WP-404"


def test_order_descendants_are_its_samples(db_session):
    seams.register_mk1_entities()
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-1", client_order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-2", client_order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-9", client_order_number="WP-9"))
    db_session.commit()
    assert set(seams.resolve_descendants(db_session, "order", "WP-6344")) == {
        ("sample", "P-1"), ("sample", "P-2")}


def test_order_spec_deep_link_and_can_flag():
    """Top-level EntitySpec callables (not the context dict) — the static
    hash string used by whatever calls `spec.deep_link(eid)` directly, and
    the can_flag gate. See test_order_context_deep_link_is_kind_id_dict below
    for the DIFFERENT (dict-shaped) deep_link the resolved context carries."""
    seams.register_mk1_entities()
    spec = seams.get_entity_spec("order")
    assert spec.deep_link("WP-6344") == "/#senaite/receive-sample"
    assert spec.can_flag(object(), "WP-6344") is True


def test_order_context_validates_as_entity_context(db_session):
    """Mirrors flags/routes.py:441's real consumption:
    `EntityContext(**ctx) if ctx else None`. A bare-string deep_link would
    raise a pydantic ValidationError here (DeepLink is a required submodel,
    not a string) — this is the exact gap that let the Finding-1 bug ship."""
    seams.register_mk1_entities()
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-6344",
                             customer_name="Jane Doe",
                             customer_email="jane@example.test"))
    db_session.add(LimsSample(sample_id="P-1", client_order_number="WP-6344"))
    db_session.add(LimsSample(sample_id="P-2", client_order_number="WP-6344"))
    db_session.commit()
    ctx = seams.resolve_context(db_session, "order", "WP-6344")
    assert ctx is not None
    model = EntityContext(**ctx)  # raises if the shape doesn't validate
    assert model.entity_type == "order" and model.entity_id == "WP-6344"
    assert model.label == "WP-6344 · Jane Doe"
    assert model.customer_email == "jane@example.test"
    assert model.sample_ids == ["P-1", "P-2"]
    assert model.deep_link.kind == "order" and model.deep_link.id == "WP-6344"


def test_order_context_deep_link_is_kind_id_dict(db_session):
    """The raw dict shape before pydantic coercion — guards against a
    regression back to the bare `"/#senaite/receive-sample"` string."""
    seams.register_mk1_entities()
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-6344"))
    db_session.commit()
    ctx = seams.resolve_context(db_session, "order", "WP-6344")
    assert ctx["deep_link"] == {"kind": "order", "id": "WP-6344"}


def test_order_context_none_when_no_row_and_no_samples(db_session):
    seams.register_mk1_entities()
    assert seams.resolve_context(db_session, "order", "WP-404") is None


def test_order_context_from_samples_when_no_order_row(db_session):
    """A sample can arrive (and get received) before the WP order webhook
    lands — the context still resolves from the samples alone, with
    customer fields absent rather than raising."""
    seams.register_mk1_entities()
    db_session.add(LimsSample(sample_id="P-1", client_order_number="WP-7000"))
    db_session.commit()
    ctx = seams.resolve_context(db_session, "order", "WP-7000")
    assert ctx is not None
    assert ctx["customer_name"] is None and ctx["customer_email"] is None
    assert ctx["sample_ids"] == ["P-1"]
    assert ctx["label"] == "WP-7000"
    model = EntityContext(**ctx)  # still validates with no backing order row
    assert model.sample_ids == ["P-1"]
