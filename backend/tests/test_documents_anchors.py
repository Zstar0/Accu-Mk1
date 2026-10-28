"""Anchor caps (spec §5) are the upstream caps in src/vendor/plannotator/html-anchor.ts,
enforced fail-closed; quote verification compares rendered text, not source bytes."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest


def _el(**over):
    d = {"selector": "body > main > p:nth-of-type(2)", "tagName": "p"}
    d.update(over)
    return d


def test_none_is_a_document_level_comment():
    from documents.anchors import validate_anchor
    assert validate_anchor(None) is None


def test_quote_only_anchor_is_valid_and_quote_only():
    from documents.anchors import is_quote_only, validate_anchor
    a = validate_anchor({"originalText": "the lab's calendar day"})
    assert a == {"originalText": "the lab's calendar day"}
    assert is_quote_only(a) is True


def test_dom_anchored_quote_is_not_quote_only_and_unknown_keys_drop():
    from documents.anchors import is_quote_only, validate_anchor
    a = validate_anchor({"originalText": "x", "htmlAnchor": _el(bogus=1), "surprise": True,
                         "elementContext": {"tag": "p", "heading": 'h2 "Rulings"', "evil": "<script>"}})
    assert a == {"originalText": "x", "htmlAnchor": _el(),
                 "elementContext": {"tag": "p", "heading": 'h2 "Rulings"'}}
    assert is_quote_only(a) is False


def test_anchor_with_element_and_empty_quote_is_valid():
    """Review Focus 5: a pinpoint on an image has an element and no text."""
    from documents.anchors import validate_anchor
    a = validate_anchor({"originalText": "", "htmlAnchor": _el(tagName="img", point={"x": 0.4, "y": 0.5})})
    assert a["htmlAnchor"]["point"] == {"x": 0.4, "y": 0.5}


def test_no_quote_and_no_element_is_rejected():
    from documents.anchors import validate_anchor
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError, match="quoted text or an element anchor"):
        validate_anchor({"originalText": "   "})


@pytest.mark.parametrize("raw, needle", [
    ({"originalText": "q" * 401}, "400"),
    ({"originalText": "q", "htmlAnchor": _el(selector="s" * 1025)}, "1024"),
    ({"originalText": "q", "htmlAnchor": _el(tagName="t" * 65)}, "64"),
    ({"originalText": "q", "htmlAdditionalTargets": [{"text": "t"}] * 17}, "16"),
    ({"originalText": "q", "htmlAdditionalTargets": [{"text": "t", "label": "l" * 65}]}, "64"),
    ({"originalText": "q", "elementContext": {"text": "c" * 2100}}, "2048"),
    ({"originalText": "q", "htmlAnchor": _el(point={"x": "1", "y": 2})}, "finite number"),
    ({"originalText": 5}, "must be a string"),
    ("not an object", "object or null"),
])
def test_caps_are_hard_400s(raw, needle):
    from documents.anchors import validate_anchor
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError, match=needle):
        validate_anchor(raw)


def test_whole_anchor_byte_budget():
    from documents.anchors import validate_anchor
    from documents.errors import BadRequestError
    big = {"originalText": "q", "htmlAdditionalTargets": [
        {"text": "t" * 400, "label": "l" * 64, "context": {"text": "c" * 600, "outline": "o" * 600}}
    ] * 16}
    with pytest.raises(BadRequestError, match="16384"):
        validate_anchor(big)


HTML = ("<!doctype html><html><head><style>p{color:red}</style></head><body>"
        "<h2>Limits</h2><p>Cd &amp; Pb limits use&nbsp;50% of   spec,\n per <em>USP</em>.</p>"
        "<script>var q = 'never quoted';</script></body></html>")


def test_quote_occurs_unescapes_entities_and_nbsp():
    """Review Focus 1: an agent quotes rendered text; source carries &amp; and &nbsp;."""
    from documents.anchors import quote_occurs
    assert quote_occurs("Cd & Pb limits use 50% of spec", HTML)
    assert quote_occurs("Cd &amp; Pb limits use 50% of spec", HTML)  # copied from source, still fine


def test_quote_occurs_collapses_whitespace_across_inline_tags():
    from documents.anchors import quote_occurs
    assert quote_occurs("of spec, per USP.", HTML)


def test_quote_in_script_or_style_does_not_count():
    from documents.anchors import quote_occurs
    assert not quote_occurs("never quoted", HTML)
    assert not quote_occurs("color:red", HTML)


def test_missing_quote_is_false_and_empty_quote_is_false():
    from documents.anchors import quote_occurs
    assert not quote_occurs("not in the document", HTML)
    assert not quote_occurs("   ", HTML)
