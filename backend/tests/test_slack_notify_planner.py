"""plan_dms: recipient + category planning for Slack DMs (pure DB logic)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import SlackDmPrefs
from flags.models import FlagFlag, FlagParticipant
from slack_notify.planner import plan_dms, PlannedDM


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _flag(db, *, created_by=1, assignee_id=None, watchers=()):
    f = FlagFlag(entity_type="sample", entity_id="P-1", kind="issue",
                 type="blocker", status="open", title="t", created_by=created_by,
                 assignee_id=assignee_id)
    db.add(f)
    db.flush()
    for uid in watchers:
        db.add(FlagParticipant(flag_id=f.id, user_id=uid))
    db.commit()
    return f


def _event(f, event_type, actor_id, *, to_value=None, details=None):
    return {"event_type": event_type, "flag_id": f.id, "actor_id": actor_id,
            "from_value": None, "to_value": to_value, "details": details or {},
            "event_id": 1,
            "flag": {"id": f.id, "title": f.title, "type": f.type, "kind": f.kind,
                     "status": f.status, "entity_type": f.entity_type,
                     "entity_id": f.entity_id, "assignee_id": f.assignee_id,
                     "created_by": f.created_by}}


def test_assigned_dms_the_assignee_only(db):
    f = _flag(db, created_by=1, assignee_id=2)
    out = plan_dms(db, _event(f, "assigned", actor_id=1, to_value="2"))
    assert out == [PlannedDM(user_id=2, category="assigned")]


def test_actor_is_never_dmed(db):
    f = _flag(db, created_by=1, assignee_id=1)
    assert plan_dms(db, _event(f, "assigned", actor_id=1, to_value="1")) == []


def test_raised_never_dms(db):
    f = _flag(db, created_by=1, assignee_id=2)
    assert plan_dms(db, _event(f, "raised", actor_id=1, to_value="open")) == []


def test_comment_mention_beats_watcher_category(db):
    f = _flag(db, created_by=1, watchers=(3,))
    out = plan_dms(db, _event(f, "commented", actor_id=2,
                              details={"mentions": [3]}))
    assert PlannedDM(user_id=3, category="mentioned") in out
    # creator gets raised_activity
    assert PlannedDM(user_id=1, category="raised_activity") in out
    assert len(out) == 2


def test_comment_watcher_gets_watching_activity(db):
    f = _flag(db, created_by=1, watchers=(4,))
    out = plan_dms(db, _event(f, "commented", actor_id=1))
    assert out == [PlannedDM(user_id=4, category="watching_activity")]


def test_status_change_creator_watcher_assignee(db):
    f = _flag(db, created_by=1, assignee_id=5, watchers=(4,))
    out = plan_dms(db, _event(f, "status_changed", actor_id=9,
                              to_value="resolved"))
    assert PlannedDM(user_id=1, category="raised_activity") in out
    assert PlannedDM(user_id=4, category="watching_activity") in out
    assert PlannedDM(user_id=5, category="status_changes") in out


def test_prefs_filter_disabled_master_and_category(db):
    f = _flag(db, created_by=1, watchers=(4, 6))
    db.add(SlackDmPrefs(user_id=4, enabled=False))
    db.add(SlackDmPrefs(user_id=6, notify_watching_activity=False))
    db.commit()
    assert plan_dms(db, _event(f, "commented", actor_id=1)) == []


def test_absent_prefs_row_means_defaults_on(db):
    f = _flag(db, created_by=1, watchers=(4,))
    out = plan_dms(db, _event(f, "commented", actor_id=1))
    assert out == [PlannedDM(user_id=4, category="watching_activity")]
