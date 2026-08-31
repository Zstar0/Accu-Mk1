"""Flags 'order' entity: label, context, descendants roll-up.

Mirrors the real seam idiom from test_flags_seams_context.py: `db_session` is
the shared in-memory-SQLite fixture (conftest.py), entities are registered via
`seams.register_mk1_entities()`, and resolution goes through the module's
actual public entrypoints — `resolve_context` / `resolve_descendants` for the
richer resolvers, and `get_entity_spec("order").label(...)` for the label
closure (there is no standalone `resolve_label` — `label` is read straight off
the registered `EntitySpec`, same as `test_flags_seams.py` does for "widget").
"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from flags import seams
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


def test_order_context_deep_link_and_can_flag():
    seams.register_mk1_entities()
    spec = seams.get_entity_spec("order")
    assert spec.deep_link("WP-6344") == "/#senaite/receive-sample"
    assert spec.can_flag(object(), "WP-6344") is True
