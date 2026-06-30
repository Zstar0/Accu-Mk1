import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace


def _user(id, role="standard"):
    return SimpleNamespace(id=id, role=role, email=f"u{id}@x.t")


def _flag(created_by, assignee_id=None):
    return SimpleNamespace(created_by=created_by, assignee_id=assignee_id)


def test_open_actions_any_user():
    from flags.permissions import can
    u = _user(5)
    for action in ("create", "comment", "watch", "assign"):
        assert can(u, action, _flag(created_by=99)) is True


def test_lifecycle_requires_assignee_raiser_or_admin():
    from flags.permissions import can
    raiser, assignee, other, admin = _user(1), _user(2), _user(3), _user(4, "admin")
    f = _flag(created_by=1, assignee_id=2)
    for action in ("resolve", "close", "reopen", "change_status", "change_type"):
        assert can(raiser, action, f) is True
        assert can(assignee, action, f) is True
        assert can(admin, action, f) is True
        assert can(other, action, f) is False
