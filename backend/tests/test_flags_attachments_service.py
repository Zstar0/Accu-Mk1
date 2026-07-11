import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

_PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
_NOT_IMAGE = b"%PDF-1.4 not an image"


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.set_attachment_storage_for_tests(seams.InMemoryAttachmentStorage())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _flag(db, actor=1):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t")


def test_add_attachment_sniffs_and_does_not_bump_updated_at(db):
    from flags import service
    f = _flag(db)
    before = service.get_flag(db, f.id).updated_at
    att = service.add_attachment(db, user=_user(1), flag_id=f.id,
                                 data=_PNG, filename="s.png")
    assert att.content_type == "image/png" and att.comment_id is None
    # A reaction/attachment never marks the thread unread — updated_at untouched.
    assert service.get_flag(db, f.id).updated_at == before


def test_add_attachment_rejects_non_image(db):
    from flags import service
    from flags.errors import BadRequestError
    f = _flag(db)
    with pytest.raises(BadRequestError):
        service.add_attachment(db, user=_user(1), flag_id=f.id,
                               data=_NOT_IMAGE, filename="x.png")


def test_add_attachment_rejects_oversize(db):
    from flags import service
    from flags.errors import BadRequestError
    f = _flag(db)
    big = _PNG + b"0" * (10 * 1024 * 1024 + 1)
    with pytest.raises(BadRequestError):
        service.add_attachment(db, user=_user(1), flag_id=f.id,
                               data=big, filename="s.png")


def test_comment_links_attachment_tokens(db):
    from flags import service
    from flags.models import FlagAttachment
    f = _flag(db)
    att = service.add_attachment(db, user=_user(1), flag_id=f.id,
                                 data=_PNG, filename="s.png")
    assert att.comment_id is None
    c = service.add_comment(db, user=_user(1), flag_id=f.id,
                            body="see {attachment:%d}" % att.id)
    linked = db.get(FlagAttachment, att.id)
    assert linked.comment_id == c.id


def test_link_only_claims_unlinked_on_same_flag(db):
    from flags import service
    from flags.models import FlagAttachment
    f = _flag(db)
    att = service.add_attachment(db, user=_user(1), flag_id=f.id,
                                 data=_PNG, filename="s.png")
    service.add_comment(db, user=_user(1), flag_id=f.id,
                        body="first {attachment:%d}" % att.id)
    first_cid = db.get(FlagAttachment, att.id).comment_id
    # A later comment re-referencing the same (already-linked) attachment must
    # NOT steal it.
    service.add_comment(db, user=_user(1), flag_id=f.id,
                        body="again {attachment:%d}" % att.id)
    assert db.get(FlagAttachment, att.id).comment_id == first_cid
