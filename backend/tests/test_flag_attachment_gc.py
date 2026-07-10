import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


class FakeStorage:
    def __init__(self):
        self.deleted = []
    def delete(self, key):
        self.deleted.append(key)


def test_gc_deletes_only_old_orphans(db):
    from flags.attachments_gc import gc_orphaned_attachments
    from flags.models import FlagAttachment
    now = datetime(2026, 7, 9, 12)
    # orphan (comment_id NULL) older than 24h -> deleted
    db.add(FlagAttachment(flag_id=1, comment_id=None, uploaded_by=1,
                          filename="a.png", content_type="image/png", size_bytes=1,
                          storage_key="k-old", created_at=now - timedelta(hours=25)))
    # orphan but recent -> kept (still mid-compose)
    db.add(FlagAttachment(flag_id=1, comment_id=None, uploaded_by=1,
                          filename="b.png", content_type="image/png", size_bytes=1,
                          storage_key="k-new", created_at=now - timedelta(hours=1)))
    # attached (comment_id set) + old -> kept
    db.add(FlagAttachment(flag_id=1, comment_id=7, uploaded_by=1,
                          filename="c.png", content_type="image/png", size_bytes=1,
                          storage_key="k-keep", created_at=now - timedelta(hours=48)))
    db.commit()
    storage = FakeStorage()
    assert gc_orphaned_attachments(db, now=now, storage=storage) == 1
    assert storage.deleted == ["k-old"]
    from flags.models import FlagAttachment as FA
    assert {a.storage_key for a in db.query(FA).all()} == {"k-new", "k-keep"}
