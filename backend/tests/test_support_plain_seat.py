"""support_plain.seat: Mk1 email -> Plain user, cached both ways, fails closed."""
import pytest

from support_plain import client as plain_client
from support_plain import queries, seat, service


class Users:
    def __init__(self, users=None, fail=False):
        self.users, self.fail, self.calls = users or {}, fail, []

    def query(self, q, variables=None):
        assert q == queries.USER_BY_EMAIL
        self.calls.append(variables["email"])
        if self.fail:
            raise plain_client.SupportUnavailable("http_503")
        return {"userByEmail": self.users.get(variables["email"])}


@pytest.fixture
def plain(monkeypatch):
    box = {"p": Users({"sam@accumark.example": {"id": "u_1", "fullName": "Sam Parker", "publicName": "Sam",
                                                "email": "sam@accumark.example", "isDeleted": False},
                       "gone@accumark.example": {"id": "u_2", "fullName": "Gone", "publicName": "Gone",
                                                 "email": "gone@accumark.example", "isDeleted": True}})}
    monkeypatch.setattr(service, "_client_factory", lambda: box["p"])
    service.CACHE.drop("")
    return box


def test_match_is_case_insensitive_and_cached(plain):
    s = seat.resolve("Sam@Accumark.example ")
    assert s == seat.Seat("u_1", "Sam Parker", "Sam", "sam@accumark.example")
    assert seat.resolve("sam@accumark.example") == s and plain["p"].calls == ["sam@accumark.example"]


def test_unknown_deleted_and_non_string_emails_have_no_seat(plain):
    assert seat.resolve("nobody@x.example") is None
    assert seat.resolve("gone@accumark.example") is None
    assert seat.resolve(None) is None and seat.resolve(object()) is None
    seat.resolve("nobody@x.example")
    assert plain["p"].calls.count("nobody@x.example") == 1  # negative result cached


def test_plain_down_raises(plain):
    plain["p"] = Users(fail=True)
    with pytest.raises(plain_client.SupportUnavailable):
        seat.resolve("sam@accumark.example")
