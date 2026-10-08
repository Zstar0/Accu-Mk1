"""support_plain.match: customer emails -> Plain customers."""
from support_plain import match, queries


class FakePlain:
    def __init__(self, by_email):
        self.by_email, self.calls = by_email, []

    def query(self, q, variables=None):
        assert q == queries.CUSTOMER_BY_EMAIL
        self.calls.append(variables["email"])
        return {"customerByEmail": self.by_email.get(variables["email"])}


def test_each_email_is_looked_up_and_customers_deduped():
    kyle = {"id": "c_1", "fullName": "Kyle R"}
    plain = FakePlain({"a@x.example": kyle, "b@x.example": kyle, "c@x.example": {"id": "c_2", "fullName": "Bo"}})
    out = match.find_customers(["a@x.example", "b@x.example", "c@x.example", "none@x.example"], plain)
    assert [c["id"] for c in out] == ["c_1", "c_2"]
    assert plain.calls == ["a@x.example", "b@x.example", "c@x.example", "none@x.example"]


def test_unsafe_emails_are_skipped():
    plain = FakePlain({})
    assert match.find_customers(['x"@y.com', "not-an-email", "ok@y.com"], plain) == []
    assert plain.calls == ["ok@y.com"]
