from slack_notify.messages import build_message


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
