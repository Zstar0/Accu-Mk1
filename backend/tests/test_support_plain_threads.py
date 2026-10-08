"""support_plain.threads: pure normalization of Plain threads and timelines (spec 3.3, 3.4)."""
from support_plain import threads

WS = "w_1"


def raw_thread(**kw):
    t = {"id": "th_1", "ref": "T-1", "title": "COA late", "previewText": "  Where   is\nit  ", "status": "TODO",
         "priority": 2, "isTestThread": False, "createdAt": {"iso8601": "2026-09-01T10:00:00.000Z"},
         "updatedAt": {"iso8601": "2026-09-02T10:00:00.000Z"}, "customer": {"id": "c_1", "fullName": "Kyle R"},
         "labels": [{"labelType": {"name": "Lab"}}], "assignedTo": {"__typename": "User", "fullName": "Lauren"},
         "lastInboundMessageInfo": {"timestamp": {"iso8601": "2026-09-02T09:00:00.000Z"}},
         "lastOutboundMessageInfo": {"timestamp": {"iso8601": "2026-09-01T11:00:00.000Z"}}}
    t.update(kw)
    return t


def node(typename, actor=None, at="2026-09-01T10:00:00.000Z", nid="e1", **entry):
    return {"id": nid, "timestamp": {"iso8601": at}, "actor": actor or {"__typename": "SystemActor"},
            "entry": {"__typename": typename, **entry}}


CUST = {"__typename": "CustomerActor", "customer": {"fullName": "Kyle R"}}
AGENT = {"__typename": "UserActor", "user": {"fullName": "Lauren"}}
BOT = {"__typename": "MachineUserActor", "machineUser": {"fullName": "Website"}}


def test_thread_item_maps_fields():
    item = threads.thread_item(raw_thread(), WS)
    assert item == {"id": "th_1", "ref": "T-1", "title": "COA late", "status": "open", "priority": "normal",
                    "labels": ["Lab"], "assignee": "Lauren", "created_at": "2026-09-01T10:00:00.000Z",
                    "updated_at": "2026-09-02T10:00:00.000Z", "preview": "Where is it",
                    "waiting_since": "2026-09-02T09:00:00.000Z",
                    "plain_url": "https://app.plain.com/workspace/w_1/thread/th_1"}


def test_status_and_priority_maps():
    assert threads.thread_item(raw_thread(status="SNOOZED", priority=0), WS)["status"] == "snoozed"
    assert threads.thread_item(raw_thread(priority=0), WS)["priority"] == "urgent"
    assert threads.thread_item(raw_thread(priority=1), WS)["priority"] == "high"
    assert threads.thread_item(raw_thread(priority=3), WS)["priority"] == "low"
    assert threads.thread_item(raw_thread(priority=None, title=None), WS)["priority"] == "normal"


def test_waiting_since_cases():
    replied = {"timestamp": {"iso8601": "2026-09-03T00:00:00.000Z"}}
    assert threads.thread_item(raw_thread(lastOutboundMessageInfo=replied), WS)["waiting_since"] is None
    assert threads.thread_item(raw_thread(status="DONE"), WS)["waiting_since"] is None
    assert threads.thread_item(raw_thread(lastInboundMessageInfo=None), WS)["waiting_since"] is None
    assert threads.thread_item(raw_thread(lastOutboundMessageInfo=None), WS)["waiting_since"] == "2026-09-02T09:00:00.000Z"


def test_unassigned_and_untitled():
    item = threads.thread_item(raw_thread(assignedTo=None, title=None, labels=None), WS)
    assert item["assignee"] is None and item["title"] == "(no subject)" and item["labels"] == []


def test_build_threads_drops_test_threads_and_sorts_newest_first():
    old = raw_thread(id="th_old", updatedAt={"iso8601": "2026-08-01T00:00:00.000Z"})
    test = raw_thread(id="th_test", isTestThread=True)
    out = threads.build_threads([old, raw_thread(), test], WS)
    assert [t["id"] for t in out] == ["th_1", "th_old"]


def test_email_uses_full_text_when_truncated_and_falls_back():
    full = node("EmailEntry", CUST, subject="Hi", textContent="short", hasMoreTextContent=True,
                fullTextContent="short and the rest", **{"from": {"name": "Kyle R", "email": "k@x.example"}})
    missing = node("EmailEntry", CUST, nid="e2", subject="Hi", textContent="short", hasMoreTextContent=True,
                   fullTextContent=None, **{"from": {"name": None, "email": "k@x.example"}})
    out = threads.build_entries([full, missing], "Kyle R")
    assert out[0] == {"id": "e1", "at": "2026-09-01T10:00:00.000Z", "kind": "email", "author": "Kyle R",
                      "author_kind": "customer", "internal": False, "subject": "Hi", "text": "short and the rest"}
    assert out[1]["text"] == "short"


def test_internal_notes_and_discussions_are_flagged():
    out = threads.build_entries([
        node("NoteEntry", AGENT, nid="n", noteText="Retest promised"),
        node("ThreadDiscussionMessageEntry", {"__typename": "SystemActor"}, nid="d", at="2026-09-01T11:00:00.000Z",
             discussionText="Slack: checking with lab"),
        node("ChatEntry", CUST, nid="c", at="2026-09-01T12:00:00.000Z", chatText="hello"),
        node("SlackReplyEntry", AGENT, nid="s", at="2026-09-01T13:00:00.000Z", slackReplyText="on it"),
    ], "Kyle R")
    assert [(e["kind"], e["internal"], e["author_kind"], e["text"]) for e in out] == [
        ("note", True, "agent", "Retest promised"), ("discussion", True, "system", "Slack: checking with lab"),
        ("chat", False, "customer", "hello"), ("slack", False, "agent", "on it")]


def test_contact_form_is_the_customers_message():
    form = node("CustomEntry", BOT, title="Contact form submission",
                components=[{"__typename": "ComponentText", "text": "Need a quote"}, {"__typename": "ComponentDivider"}])
    (e,) = threads.build_entries([form], "Kyle R")
    assert (e["kind"], e["author"], e["author_kind"], e["subject"], e["text"]) == (
        "form", "Kyle R", "customer", "Contact form submission", "Need a quote")


def test_event_one_liners():
    out = threads.build_entries([
        node("ThreadStatusTransitionedEntry", AGENT, nid="1", nextStatus="DONE"),
        node("ThreadLabelsChangedEntry", BOT, nid="2", nextLabels=[{"labelType": {"name": "Lab"}}]),
        node("ThreadAssignmentTransitionedEntry", AGENT, nid="3", nextAssignee={"__typename": "User", "fullName": "Scott"}),
        node("ThreadAssignmentTransitionedEntry", AGENT, nid="4", nextAssignee=None),
        node("ThreadPriorityChangedEntry", {"__typename": "SystemActor"}, nid="5", nextPriority=0),
    ], "Kyle R")
    assert [e["text"] for e in out] == ["Marked done by Lauren", "Labels: Lab by Website", "Assigned to Scott by Lauren",
                                         "Unassigned by Lauren", "Priority set to urgent"]
    assert {e["kind"] for e in out} == {"event"}


def test_unknown_types_are_dropped_and_order_is_oldest_first(caplog):
    caplog.set_level("INFO")
    out = threads.build_entries([
        node("ChatEntry", CUST, nid="late", at="2026-09-02T00:00:00.000Z", chatText="b"),
        node("ServiceLevelAgreementStatusTransitionedEntry", nid="sla"),
        node("ChatEntry", CUST, nid="early", at="2026-09-01T00:00:00.000Z", chatText="a"),
    ], "Kyle R")
    assert [e["id"] for e in out] == ["early", "late"]
    assert "ServiceLevelAgreementStatusTransitionedEntry" in caplog.text
