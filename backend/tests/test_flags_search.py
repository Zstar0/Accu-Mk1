import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401  (register FlagType on Base)
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample",
                          label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}",
                          can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id=1, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def _mk(db, *, title, entity_id, comment=None):
    from flags import service
    u = _user(7)
    f = service.create_flag(db, user=u, entity_type="sub_sample",
                            entity_id=entity_id, type="blocker", title=title)
    if comment is not None:
        service.add_comment(db, user=u, flag_id=f.id, body=comment)
    return f


def test_short_query_returns_empty(db):
    from flags import service
    _mk(db, title="ph drift", entity_id="1", comment="the ph is drifting")
    assert service.search_flags(db, q="ph") == []
    assert service.search_flags(db, q="  ") == []


def test_matches_comment_body_with_snippet(db):
    from flags import service
    f = _mk(db, title="Pump seal", entity_id="1",
            comment="the cloudy precipitate settled overnight in the vial")
    hits = service.search_flags(db, q="precipitate")
    assert [h.flag_id for h in hits] == [f.id]
    assert "comment" in hits[0].matched_in
    assert "precipitate" in hits[0].snippet.lower()


def test_matches_title_only_has_empty_snippet(db):
    from flags import service
    f = _mk(db, title="Centrifuge imbalance", entity_id="1")
    hits = service.search_flags(db, q="centrifuge")
    assert [h.flag_id for h in hits] == [f.id]
    assert hits[0].matched_in == ["title"]
    assert hits[0].snippet == ""


def test_match_in_both_title_and_comment(db):
    from flags import service
    f = _mk(db, title="residue on wall", entity_id="1",
            comment="more residue than expected")
    hits = service.search_flags(db, q="residue")
    assert hits[0].flag_id == f.id
    assert set(hits[0].matched_in) == {"title", "comment"}


def test_snippet_strips_attachment_tokens(db):
    from flags import service
    _mk(db, title="x", entity_id="1",
        comment="see {attachment:5} the residue on the wall")
    hits = service.search_flags(db, q="residue")
    assert "{attachment" not in hits[0].snippet
    assert "residue" in hits[0].snippet


def test_escapes_like_metacharacters(db):
    from flags import service
    a = _mk(db, title="100% pure", entity_id="1")
    _mk(db, title="everything else", entity_id="2")
    # '%' is a literal here, NOT a wildcard — only the '100% pure' flag matches.
    hits = service.search_flags(db, q="100%")
    assert [h.flag_id for h in hits] == [a.id]


def test_case_insensitive_and_newest_first(db):
    from flags import service
    a = _mk(db, title="Alpha buffer", entity_id="1", comment="BUFFER low")
    b = _mk(db, title="beta", entity_id="2", comment="buffer high")
    hits = service.search_flags(db, q="buffer")
    # flag_id DESC → newest first.
    assert [h.flag_id for h in hits] == [b.id, a.id]


def test_respects_limit(db):
    from flags import service
    for i in range(1, 6):
        _mk(db, title=f"t{i}", entity_id=str(i), comment="widget failure")
    hits = service.search_flags(db, q="widget", limit=2)
    assert len(hits) == 2
