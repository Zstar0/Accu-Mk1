"""Label catalog (spec §4.3) and the literal-before-parameter route order (spec §6.2)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import client  # noqa: F401,E402


def test_labels_are_served_with_tips(client):
    r = client.get("/api/documents/comment-labels")
    assert r.status_code == 200, r.text  # 422 here means /documents/{doc_id} swallowed the literal path
    ids = [l["id"] for l in r.json()]
    assert ids == ["clarify-this", "verify-this", "out-of-date", "needs-reference", "needs-example",
                   "out-of-scope", "needs-sign-off", "match-format", "nice-work"]
    by_id = {l["id"]: l for l in r.json()}
    assert by_id["verify-this"]["tip"].startswith("This reads as an assumption")
    assert by_id["nice-work"]["tip"] is None
    assert set(by_id["clarify-this"]) == {"id", "emoji", "text", "color", "tip"}


def test_label_lookup_helpers():
    from documents import labels
    assert labels.get_label("needs-tests") is None
    assert "out-of-scope" in labels.label_ids()
    assert labels.get_label("nice-work").emoji == "👍"
