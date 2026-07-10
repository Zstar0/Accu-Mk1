import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest


@pytest.fixture
def clean_registry():
    """Isolate the seam registry so a fake entity proves the core is
    host-agnostic (mirrors the watch-poller fake-'widget' idiom)."""
    from flags import seams
    saved = dict(seams._REGISTRY)
    seams._REGISTRY.clear()
    try:
        yield seams
    finally:
        seams._REGISTRY.clear()
        seams._REGISTRY.update(saved)


def _register_widget(seams, *, search=None):
    seams.register_entity(
        "widget",
        label=lambda db, e: f"Widget {e}",
        deep_link=lambda e: f"/widgets/{e}",
        can_flag=lambda user, e: True,
        search=search,
    )


def test_unregistered_type_returns_empty(clean_registry):
    seams = clean_registry
    assert seams.resolve_entity_search(None, "nope", "abc") == []


def test_type_without_search_resolver_returns_empty(clean_registry):
    seams = clean_registry
    _register_widget(seams, search=None)
    assert seams.resolve_entity_search(None, "widget", "abc") == []


def test_search_resolver_hits_are_returned(clean_registry):
    seams = clean_registry
    _register_widget(
        seams,
        search=lambda db, q: [{"entity_id": "7", "label": f"Widget {q}"}],
    )
    assert seams.resolve_entity_search(None, "widget", "ab") == [
        {"entity_id": "7", "label": "Widget ab"}
    ]


def test_resolver_error_is_swallowed(clean_registry):
    seams = clean_registry

    def boom(db, q):
        raise RuntimeError("closure blew up")

    _register_widget(seams, search=boom)
    # never raises into the request — a dead resolver just yields no hits
    assert seams.resolve_entity_search(None, "widget", "ab") == []
