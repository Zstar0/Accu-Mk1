import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def test_strip_markdown_plain_passthrough():
    from flags.service import strip_markdown
    assert strip_markdown("just plain text") == "just plain text"


def test_strip_markdown_removes_tokens_keeps_mention():
    from flags.service import strip_markdown
    out = strip_markdown("**bold** _em_ `code` see [docs](http://x) hi @Ann Lee")
    assert "**" not in out and "`" not in out and "](" not in out
    assert "bold" in out and "em" in out and "code" in out and "docs" in out
    assert "@Ann Lee" in out


def test_excerpt_image_only_comment():
    from flags.service import _excerpt_for_comment
    assert _excerpt_for_comment("{attachment:12}") == "📎 image"
    assert _excerpt_for_comment("look {attachment:12}").strip() == "look"


def test_comment_event_excerpt_is_stripped():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, service, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    types_service.seed_builtins(db)
    u = SimpleNamespace(id=1, role="standard", email="u@x.t")
    f = service.create_flag(db, user=u, entity_type="sub_sample", entity_id="1",
                            type="blocker", title="t")
    service.add_comment(db, user=u, flag_id=f.id, body="**cloudy** `x`")
    ev = [e for e in seams.EVENT_SINK.events if e["event_type"] == "commented"][-1]
    assert "*" not in ev["details"]["body_excerpt"]
    assert "cloudy" in ev["details"]["body_excerpt"]
