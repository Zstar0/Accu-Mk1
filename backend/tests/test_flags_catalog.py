import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_kind_mapping_and_validity():
    from flags.catalog import kind_for_type, is_valid_type
    assert kind_for_type("blocker") == "issue"
    assert kind_for_type("ready_for_verification") == "signal"
    assert is_valid_type("question") is True
    assert is_valid_type("nope") is False


def test_legal_transitions():
    from flags.catalog import is_legal_transition
    assert is_legal_transition("open", "in_progress") is True
    assert is_legal_transition("in_progress", "resolved") is True
    assert is_legal_transition("resolved", "closed") is True
    assert is_legal_transition("closed", "open") is True       # reopen
    assert is_legal_transition("open", "closed") is True       # resolve/close directly
    assert is_legal_transition("resolved", "open") is True     # reopen from resolved
