"""crm_close.timeline: Close activity dicts -> one normalized timeline (pure)."""
from crm_close import timeline

LEADS = {"lead_A": "Valor Peptides"}


def email(**over):
    a = {"_type": "Email", "id": "acti_e1", "lead_id": "lead_A", "date_created": "2026-09-02T15:00:00Z",
         "activity_at": "2026-09-02T15:00:00Z", "direction": "incoming", "subject": "Question about COA",
         "sender": "Kyle <kyle@x.example>", "to": ["forrest@accumarklabs.com"], "cc": [],
         "body_text": "Hi team,\nWhere is my COA?", "body_html": "", "thread_id": "thr_1", "user_name": None}
    a.update(over)
    return a


def test_email_normalized_with_inbound_direction_and_preview():
    item = timeline.normalize(email(), LEADS)
    assert item == {
        "id": "acti_e1", "type": "email", "at": "2026-09-02T15:00:00Z", "direction": "inbound",
        "who": "Kyle <kyle@x.example>", "title": "Question about COA",
        "preview": "Hi team, Where is my COA?", "lead_id": "lead_A", "lead_name": "Valor Peptides",
        "automated": False, "support_thread_url": None,
    }


def test_order_notification_is_automated():
    item = timeline.normalize(email(subject="[Accumark Labs]: You've got a new order: #3636",
                                    direction="outgoing"), LEADS)
    assert item["automated"] is True and item["direction"] == "outbound"


def test_html_only_body_becomes_text():
    item = timeline.normalize(email(body_text="", body_html="<p>Hello <b>there</b></p><script>x()</script>"), LEADS)
    assert item["preview"] == "Hello there"
    assert timeline.html_to_text("<div>a<br>b</div>&amp; c") == "a\nb\n& c"


def test_call_sms_meeting_note_shapes():
    call = {"_type": "Call", "id": "acti_c", "lead_id": "lead_A", "date_created": "2026-09-03T10:00:00Z",
            "direction": "outbound", "duration": 125, "disposition": "answered", "note": "Talked pricing",
            "user_name": "Scott Joseph", "recording_url": None}
    sms = {"_type": "SMS", "id": "acti_s", "lead_id": "lead_A", "date_created": "2026-09-04T10:00:00Z",
           "direction": "inbound", "text": "Thanks!", "remote_phone": "+15550100", "user_name": None}
    meeting = {"_type": "Meeting", "id": "acti_m", "lead_id": "lead_A", "starts_at": "2026-09-05T15:00:00Z",
               "date_created": "2026-09-01T00:00:00Z", "title": "AccuVerify Plugin", "user_name": "Forrest Parker",
               "note": "Demo"}
    note = {"_type": "Note", "id": "acti_n", "lead_id": "lead_A", "date_created": "2026-09-06T10:00:00Z",
            "note": "Referred by RJ from Elevate\nsecond line", "user_name": "Scott Joseph"}
    c, s, m, n = (timeline.normalize(x, LEADS) for x in (call, sms, meeting, note))
    assert (c["type"], c["title"], c["who"], c["preview"]) == ("call", "Call, answered, 2 min", "Scott Joseph", "Talked pricing")
    assert (s["type"], s["direction"], s["who"], s["preview"]) == ("sms", "inbound", "+15550100", "Thanks!")
    assert (m["type"], m["at"], m["title"]) == ("meeting", "2026-09-05T15:00:00Z", "AccuVerify Plugin")
    assert (n["type"], n["title"], n["preview"]) == ("note", "Referred by RJ from Elevate", "Referred by RJ from Elevate second line")


def test_plain_link_note_becomes_support_thread():
    url = "https://app.plain.com/workspace/w_01KN/thread/th_01M4/"
    n = timeline.normalize({"_type": "Note", "id": "acti_p", "lead_id": "lead_A",
                            "date_created": "2026-10-07T17:12:52Z", "note": f"<{url}>"}, LEADS)
    assert n["title"] == "Support thread" and n["support_thread_url"] == url


def test_dropped_types_and_sort_with_missing_dates_last():
    acts = [email(id="a1", activity_at="2026-09-01T00:00:00Z", date_created="2026-09-01T00:00:00Z"),
            {"_type": "EmailThread", "id": "t1", "lead_id": "lead_A", "date_created": "2026-09-09T00:00:00Z"},
            {"_type": "LeadStatusChange", "id": "x1", "lead_id": "lead_A", "date_created": "2026-09-09T00:00:00Z"},
            {"_type": "Note", "id": "n0", "lead_id": "lead_A", "note": "undated"},
            email(id="a2", activity_at="2026-09-03T00:00:00Z", date_created="2026-09-03T00:00:00Z")]
    assert [i["id"] for i in timeline.build(acts, LEADS)] == ["a2", "a1", "n0"]


def test_email_detail_includes_thread_oldest_first():
    first = email(id="a1", activity_at="2026-09-01T00:00:00Z", body_text="first")
    second = email(id="a2", activity_at="2026-09-02T00:00:00Z", body_text="second", direction="outgoing")
    d = timeline.detail(second, [second, first], LEADS)
    assert d["type"] == "email" and d["id"] == "a2"
    assert [m["body"] for m in d["messages"]] == ["first", "second"]
    assert d["messages"][1]["direction"] == "outbound"
