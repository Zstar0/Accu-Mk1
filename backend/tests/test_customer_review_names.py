"""customer_review.names: staff names never reach a published review."""
from types import SimpleNamespace

from customer_review import names


def test_scrub_full_names_first_possessives_and_boundaries():
    review = {"headline": "Scott Joseph's reply came late; Scottsdale office fine.",
              "sentiment": {"reason": "Lauren answered fast", "citations": []},
              "open_issues": [{"title": "Scott's Sep 17 reply", "detail": "Ask Scott.", "citations": []}],
              "shortfalls": [], "strengths": [], "next_steps": []}
    out, n = names.scrub(review, {"Scott Joseph", "Scott", "Joseph", "Lauren"})
    assert out["headline"] == "the team's reply came late; Scottsdale office fine."
    assert out["sentiment"]["reason"] == "the team answered fast"
    assert out["open_issues"][0]["title"] == "the team's Sep 17 reply"
    assert out["open_issues"][0]["detail"] == "Ask the team."
    assert n == 4


def test_short_names_are_ignored_and_empty_set_is_a_no_op():
    review = {"headline": "Al and Bo", "sentiment": {"reason": "", "citations": []},
              "open_issues": [], "shortfalls": [], "strengths": [], "next_steps": []}
    assert names.scrub(review, {"Al", "Bo"}) == (review, 0)
    assert names.scrub(review, set()) == (review, 0)


def test_staff_names_from_users_and_run(db_session):
    from models import User

    User.__table__.create(db_session.get_bind(), checkfirst=True)  # fixture ran create_all before this import
    db_session.add(User(email="s@x.example", hashed_password="x", role="admin", first_name="Scott", last_name="Joseph"))
    db_session.commit()
    ctx = SimpleNamespace(memo={"staff": {"Lauren Smith"}})
    got = names.staff_names(db_session, ctx)
    assert {"Scott", "Joseph", "Scott Joseph", "Lauren Smith", "Lauren", "Smith"} <= got


def test_tools_collect_staff_names(monkeypatch):
    from customer_review import tools

    c = tools.Ctx(customer_key="wc:1", db=None)
    monkeypatch.setattr(tools, "_dossier", lambda cx: {"identity": {"name": "Kyle", "rep": "Scott Joseph"}})
    monkeypatch.setattr(tools, "_customer_orders", lambda cx: [])
    tools.call(c, "customer_overview", {})
    thread = {"id": "th_1", "ref": "T-1", "title": "t", "status": "open"}
    monkeypatch.setattr(tools, "_support_list", lambda key: [thread])
    monkeypatch.setattr(tools, "_support_detail", lambda key, tid: {"entries": [
        {"author": "Lauren Smith", "author_kind": "agent", "text": "hi"},
        {"author": "Kyle R", "author_kind": "customer", "text": "yo"}]})
    tools.call(c, "read_ticket", {"ref": "T-1"})
    monkeypatch.setattr(tools, "_crm_list", lambda key, kind: [
        {"id": "a1", "type": "email", "direction": "outbound", "who": "Dana Lee"},
        {"id": "a2", "type": "email", "direction": "inbound", "who": "Kyle R"}])
    tools.call(c, "list_crm", {})
    assert c.memo["staff"] == {"Scott Joseph", "Lauren Smith", "Dana Lee"}


def test_citation_labels_are_scrubbed():
    review = {"headline": "", "sentiment": {"reason": "", "citations": [{"kind": "crm", "id": "a", "label": "Scott note"}]},
              "open_issues": [{"title": "t", "detail": "", "citations": [{"kind": "crm", "id": "b", "label": "Scott said"}]}],
              "shortfalls": [], "strengths": [], "next_steps": []}
    out, n = names.scrub(review, {"Scott"})
    assert out["sentiment"]["citations"][0]["label"] == "the team note"
    assert out["open_issues"][0]["citations"][0]["label"] == "the team said" and n == 2
