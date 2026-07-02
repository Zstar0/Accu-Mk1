from slack_notify.messages import build_message, link_hash_for


def _event(**over):
    e = {"event_type": "assigned", "flag_id": 7, "actor_id": 1,
         "from_value": None, "to_value": "2", "details": {},
         "event_id": 10,
         "flag": {"id": 7, "title": "Vial cloudy", "type": "blocker",
                  "kind": "issue", "status": "open", "entity_type": "sub_sample",
                  "entity_id": "42", "assignee_id": 2, "created_by": 1}}
    e.update(over)
    return e


def test_assigned_message_has_action_title_context_and_link():
    text, blocks = build_message(_event(), "assigned", "Nick",
                                 "https://mk1.example")
    assert "Nick assigned you a flag" in text
    assert "Vial cloudy" in text
    flat = str(blocks)
    assert "Vial 42" in flat and "Blocker" in flat and "Open" in flat
    assert "https://mk1.example/#dashboard/orders?flag=7" in flat


def test_comment_excerpt_truncated():
    e = _event(event_type="commented",
               details={"mentions": [], "body_excerpt": "x" * 300})
    text, blocks = build_message(e, "watching_activity", "Nick",
                                 "https://mk1.example")
    assert "commented on a flag you're watching" in text
    assert ("x" * 140) in str(blocks) and ("x" * 141) not in str(blocks)


def test_link_hash_for_routes_to_the_entity_page():
    # Sample deep link → sample-details page + flag thread, one URL.
    assert link_hash_for({"kind": "sample", "id": "P-0134"}, 7) == (
        "#senaite/sample-details?id=P-0134&flag=7")
    # Worksheet deep link → worksheet drawer + flag thread.
    assert link_hash_for({"kind": "worksheet", "id": "9"}, 7) == (
        "#hplc-analysis/worksheet-detail?id=9&flag=7")
    # No usable deep link → dashboard fallback (thread still opens).
    assert link_hash_for({"kind": "none", "id": "42"}, 7) == (
        "#dashboard/orders?flag=7")
    assert link_hash_for(None, 7) == "#dashboard/orders?flag=7"


def test_build_message_uses_entity_link_hash_when_given():
    text, blocks = build_message(
        _event(), "assigned", "Nick", "https://mk1.example",
        link_hash="#senaite/sample-details?id=P-0134&flag=7")
    flat = str(blocks)
    assert "https://mk1.example/#senaite/sample-details?id=P-0134&flag=7" in flat
    assert "#dashboard/orders" not in flat
