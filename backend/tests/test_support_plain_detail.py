"""Plain-style view data: status detail, assignees, tier, fields, customer, entry extras (spec 3)."""
import pytest

from support_plain import threads

SCHEMAS = [{"key": "wp_user_id", "label": "WP User ID", "order": 2},
           {"key": "verification_code", "label": "Verification Code", "order": 1},
           {"key": "total_spent", "label": "Total Spent", "order": 3}]


def raw(**kw):
    t = {"id": "th_1", "status": "TODO", "customer": {"id": "c_1", "fullName": "Lilia Billones"}}
    t.update(kw)
    return t


@pytest.mark.parametrize("typename,status,kind,label", [
    ("ThreadStatusDetailCreated", "TODO", "needs_first_response", "Needs first response"),
    ("ThreadStatusDetailNewReply", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailUnsnoozed", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailThreadLinkUpdated", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailLinearUpdated", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailThreadDiscussionResolved", "TODO", "needs_next_response", "Needs next response"),
    ("ThreadStatusDetailReplied", "TODO", "in_progress", "In progress"),
    ("ThreadStatusDetailInProgress", "TODO", "in_progress", "In progress"),
    ("ThreadStatusDetailWaitingForCustomer", "SNOOZED", "waiting_for_customer", "Waiting for customer"),
    ("ThreadStatusDetailWaitingIndefinitely", "SNOOZED", "waiting", "Waiting"),
    ("ThreadStatusDetailDoneManuallySet", "DONE", "done", "Done"),
    ("ThreadStatusDetailIgnored", "DONE", "done", "Done"),
    ("ThreadStatusDetailDoneAutomaticallySet", "DONE", "done_auto", "Done automatically"),
])
def test_status_detail_labels(typename, status, kind, label):
    d = threads.status_detail(raw(status=status, statusDetail={"__typename": typename}))
    assert (d["kind"], d["label"]) == (kind, label)


def test_waiting_until_carries_the_date():
    d = threads.status_detail(raw(status="SNOOZED", statusDetail={
        "__typename": "ThreadStatusDetailWaitingForDuration", "waitingUntil": {"iso8601": "2026-10-20T13:00:00.000Z"}}))
    assert d["kind"] == "waiting_until" and d["until"] == "2026-10-20T13:00:00.000Z"
    assert d["label"].startswith("Waiting until ")


@pytest.mark.parametrize("status,kind", [("TODO", "needs_next_response"), ("SNOOZED", "waiting"), ("DONE", "done")])
def test_null_detail_falls_back_to_status(status, kind):
    assert threads.status_detail(raw(status=status, statusDetail=None))["kind"] == kind


def test_assignees_primary_then_additional_users_and_bots():
    t = raw(assignedTo={"__typename": "User", "id": "u_1", "fullName": "Forrest Parker", "avatarUrl": "https://a/f.png"},
            additionalAssignees=[{"__typename": "User", "id": "u_2", "fullName": "Lauren Hamilton", "avatarUrl": None},
                                 {"__typename": "MachineUser", "id": "mu_1", "fullName": "Sidekick"}])
    assert threads.assignees(t) == [
        {"plain_user_id": "u_1", "name": "Forrest Parker", "avatar_url": "https://a/f.png", "primary": True},
        {"plain_user_id": "u_2", "name": "Lauren Hamilton", "avatar_url": None, "primary": False},
        {"plain_user_id": None, "name": "Sidekick", "avatar_url": None, "primary": False},
    ]


def test_fields_follow_schema_order_and_keep_empty_ones():
    t = raw(threadFields=[{"key": "wp_user_id", "stringValue": None, "numberValue": 3173.0},
                          {"key": "unknown_key", "stringValue": "x"}])
    assert threads.fields(t, SCHEMAS) == [
        {"key": "verification_code", "label": "Verification Code", "value": None},
        {"key": "wp_user_id", "label": "WP User ID", "value": "3173"},
        {"key": "total_spent", "label": "Total Spent", "value": None},
        {"key": "unknown_key", "label": "unknown_key", "value": "x"},
    ]


def test_field_values_by_type():
    t = raw(threadFields=[{"key": "a", "booleanValue": True}, {"key": "b", "numberValue": 160.5},
                          {"key": "c", "dateValue": {"iso8601": "2026-09-01T00:00:00.000Z"}}])
    assert [f["value"] for f in threads.fields(t, [])] == ["Yes", "160.5", "2026-09-01"]


def test_field_schema_failure_falls_back_to_keys():
    assert threads.fields(raw(threadFields=[{"key": "sales_rep", "stringValue": "Scott"}]), []) == [
        {"key": "sales_rep", "label": "sales_rep", "value": "Scott"}]


def test_customer_block_and_wp_link():
    t = raw(customer={"id": "c_1", "fullName": "Lilia Billones", "externalId": "3173", "avatarUrl": None,
                      "email": {"email": "lilia@example.com"}, "company": {"name": "Acme"},
                      "createdAt": {"iso8601": "2026-08-25T00:00:00.000Z"},
                      "updatedAt": {"iso8601": "2026-08-26T00:00:00.000Z"}})
    assert threads.customer_block(t) == {
        "name": "Lilia Billones", "email": "lilia@example.com", "external_id": "3173", "avatar_url": None,
        "company": "Acme", "created_at": "2026-08-25T00:00:00.000Z", "updated_at": "2026-08-26T00:00:00.000Z",
        "wp_profile_url": "https://accumarklabs.com/wp-admin/user-edit.php?user_id=3173"}
    t["customer"]["externalId"] = "abc"
    assert threads.customer_block(t)["wp_profile_url"] is None


def test_detail_extras_tolerate_missing_fields():
    x = threads.detail_extras({"id": "th_1", "status": "TODO", "customer": None}, [])
    assert x == {"status_detail": {"kind": "needs_next_response", "label": "Needs next response", "until": None},
                 "assignees": [], "tier": None, "fields": [], "customer": None}


def _node(entry, actor, nid="e1"):
    return {"id": nid, "timestamp": {"iso8601": "2026-10-09T10:00:00.000Z"}, "actor": actor, "entry": entry}


def test_email_entry_extras():
    e = threads.build_entries([_node(
        {"__typename": "EmailEntry", "subject": "Re: lot", "textContent": "Hi", "hasMoreTextContent": False,
         "markdownContent": "**Hi**", "hasMoreMarkdownContent": False,
         "from": {"name": "Lauren Hamilton", "email": "support@accumarklabs.com"},
         "to": {"name": None, "email": "lilia@example.com"}},
        {"__typename": "UserActor", "userId": "u_2", "user": {"fullName": "Lauren Hamilton", "avatarUrl": "https://a/l.png"}})],
        "Lilia Billones")[0]
    assert e["text"] == "Hi" and e["markdown"] == "**Hi**" and e["automated"] is False
    assert e["email_from"] == "Lauren Hamilton <support@accumarklabs.com>" and e["email_to"] == "lilia@example.com"
    assert e["author_avatar_url"] == "https://a/l.png" and e["event"] is None


def test_system_email_is_automated_but_a_form_is_not():
    auto = threads.build_entries([_node({"__typename": "EmailEntry", "subject": "Re: x", "textContent": "auto",
                                         "hasMoreTextContent": False, "from": {"email": "support@accumarklabs.com"},
                                         "to": {"email": "c@x"}}, {"__typename": "SystemActor", "systemId": "s"})], "C")[0]
    form = threads.build_entries([_node({"__typename": "CustomEntry", "title": "Contact form",
                                         "components": [{"__typename": "ComponentText", "text": "hi"}]},
                                        {"__typename": "MachineUserActor", "machineUser": {"fullName": "Website"}})], "C")[0]
    assert auto["automated"] is True and form["automated"] is False


def test_events_are_structured_and_text_is_unchanged():
    nodes = [_node({"__typename": "ThreadStatusTransitionedEntry", "nextStatus": "DONE"},
                   {"__typename": "UserActor", "userId": "u_2", "user": {"fullName": "Lauren Hamilton"}}, "e1"),
             _node({"__typename": "ThreadLabelsChangedEntry", "nextLabels": [{"labelType": {"name": "Engineering"}}]},
                   {"__typename": "MachineUserActor", "machineUser": {"fullName": "Plain Sidekick"}}, "e2"),
             _node({"__typename": "ThreadAssignmentTransitionedEntry",
                    "nextAssignee": {"__typename": "User", "fullName": "Forrest Parker"}},
                   {"__typename": "SystemActor", "systemId": "s"}, "e3"),
             _node({"__typename": "ThreadPriorityChangedEntry", "nextPriority": 1},
                   {"__typename": "UserActor", "userId": "u_2", "user": {"fullName": "Lauren Hamilton"}}, "e4")]
    ev = [e["event"] for e in threads.build_entries(nodes, "C")]
    assert ev == [{"icon": "status", "actor": "Lauren Hamilton", "text": "changed status to Done"},
                  {"icon": "label", "actor": "Plain Sidekick", "text": "set labels to Engineering"},
                  {"icon": "assign", "actor": "Plain", "text": "assigned Forrest Parker"},
                  {"icon": "priority", "actor": "Lauren Hamilton", "text": "set priority to High"}]
    assert threads.build_entries(nodes, "C")[0]["text"] == "Marked done by Lauren Hamilton"


def test_inline_data_images_are_stripped_from_markdown():
    e = threads.build_entries([_node(
        {"__typename": "EmailEntry", "subject": "s", "textContent": "Hi", "hasMoreTextContent": False,
         "markdownContent": "Hi\n\n![logo](data:image/png;base64,AAAA)\n![](data:image/gif;base64,BB)\n[site](https://x)",
         "hasMoreMarkdownContent": False, "from": {"email": "a@x"}, "to": {"email": "b@x"}},
        {"__typename": "UserActor", "userId": "u", "user": {"fullName": "L"}})], "C")[0]
    assert "data:image" not in e["markdown"] and "[site](https://x)" in e["markdown"]
