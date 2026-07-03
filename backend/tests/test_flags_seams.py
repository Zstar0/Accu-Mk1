import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import pytest


def test_register_and_resolve_entity():
    from flags import seams
    seams.register_entity("widget",
                           label=lambda db, eid: f"Widget {eid}",
                           deep_link=lambda eid: f"/widgets/{eid}",
                           can_flag=lambda user, eid: True)
    assert seams.is_registered("widget")
    spec = seams.get_entity_spec("widget")
    assert spec.label(None, "9") == "Widget 9"
    assert spec.deep_link("9") == "/widgets/9"
    assert spec.can_flag(object(), "9") is True
    with pytest.raises(KeyError):
        seams.get_entity_spec("nonexistent-type")


def test_in_memory_event_sink_captures():
    from flags import seams
    sink = seams.InMemoryEventSink()
    seams.set_event_sink(sink)
    seams.EVENT_SINK.emit({"event_type": "raised", "flag_id": 1})
    assert sink.events == [{"event_type": "raised", "flag_id": 1}]
