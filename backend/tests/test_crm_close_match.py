"""crm_close.match + cache."""
from contextlib import contextmanager

from crm_close import match
from crm_close.cache import TTLCache


class _Cur:
    def __init__(self, rows):
        self.rows, self.sql = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.sql.append((sql, params))

    def fetchall(self):
        return self.rows.pop(0)


def _conn(rows):
    cur = _Cur(rows)

    @contextmanager
    def factory():
        class C:
            def cursor(self):
                return cur
        yield C()
    return factory


def test_wc_key_collects_account_and_billing_emails_lowercased_deduped():
    rows = [[("Kyle@X.example",)], [("kyle@x.example",), ("ops@valor.example ",), (None,)]]
    assert match.customer_emails("wc:1551", conn_factory=_conn(rows)) == ["kyle@x.example", "ops@valor.example"]


def test_unknown_wc_key_is_none_and_email_key_passes_through():
    assert match.customer_emails("wc:99", conn_factory=_conn([[], []])) is None
    assert match.customer_emails("email:", conn_factory=_conn([])) is None
    assert match.customer_emails("bogus", conn_factory=_conn([])) is None


def test_wc_key_with_no_email_anywhere_is_empty_list():
    assert match.customer_emails("wc:5", conn_factory=_conn([[(None,)], []])) == []


class _Close:
    def __init__(self, by_email):
        self.by_email, self.calls = by_email, []

    def get(self, path, params=None):
        self.calls.append(params["query"])
        email = params["query"].split('"')[1]
        return {"data": self.by_email.get(email, [])}


def test_find_leads_dedupes_across_emails():
    a = {"id": "lead_A", "display_name": "Valor"}
    b = {"id": "lead_B", "display_name": "NxGen"}
    close = _Close({"kyle@x.example": [a], "ops@valor.example": [a, b]})
    leads = match.find_leads(["kyle@x.example", "ops@valor.example"], close)
    assert [l["id"] for l in leads] == ["lead_A", "lead_B"]
    assert close.calls[0] == 'email_address:"kyle@x.example"'


def test_shape_lead_handles_missing_lists_and_converts_cents():
    raw = {"id": "lead_A", "display_name": "Valor", "status_label": "Active Customer", "html_url": "https://app.close.com/lead/lead_A/",
           "contacts": None,
           "opportunities": [{"status_label": "Won", "value": 125000, "value_period": "one_time", "confidence": 90,
                              "expected_date": "2026-11-01", "user_name": "Scott Joseph", "date_updated": "2026-09-01"}]}
    s = match.shape_lead(raw)
    assert s["contacts"] == [] and s["owner"] == "Scott Joseph"
    assert s["opportunities"] == [{"status": "Won", "value": 1250.0, "value_period": "one_time",
                                   "confidence": 90, "expected_date": "2026-11-01"}]
    assert match.shape_lead({"id": "lead_B"})["opportunities"] == []


def test_cache_ttl_drop_peek_and_cooldown():
    now = [0.0]
    cache = TTLCache(clock=lambda: now[0])
    loads = []
    v, _ = cache.get_or_load("m:wc:1", 10, lambda: loads.append(1) or "x")
    v2, _ = cache.get_or_load("m:wc:1", 10, lambda: loads.append(1) or "y")
    assert (v, v2, len(loads)) == ("x", "x", 1)
    now[0] = 11
    assert cache.get_or_load("m:wc:1", 10, lambda: "z")[0] == "z"
    cache.drop("m:wc:1")
    assert cache.peek("m:wc:1") is None
    assert cache.allow_refresh("wc:1", 10) is True and cache.allow_refresh("wc:1", 10) is False
    now[0] = 22
    assert cache.allow_refresh("wc:1", 10) is True


def test_nested_load_of_a_different_key_does_not_deadlock():
    """The timeline loader loads the lead match from inside its own load (service._load)."""
    import threading

    cache = TTLCache()
    done = []

    def outer():
        inner, _ = cache.get_or_load("m:wc:1", 10, lambda: "leads")
        return f"timeline({inner})"

    t = threading.Thread(target=lambda: done.append(cache.get_or_load("t:wc:1", 10, outer)[0]), daemon=True)
    t.start()
    t.join(timeout=5)
    assert done == ["timeline(leads)"], "nested get_or_load deadlocked"


def test_guest_key_must_be_a_known_email():
    known = _conn([[(1,)]])
    assert match.customer_emails("email:G@X.com", conn_factory=known) == ["g@x.com"]
    assert match.customer_emails("email:nobody@x.com", conn_factory=_conn([[]])) is None
    assert match.customer_emails('email:a"b@x.com', conn_factory=_conn([[(1,)]])) is None
    assert match.customer_emails("email:not-an-email", conn_factory=_conn([[(1,)]])) is None


def test_find_leads_skips_unsafe_emails():
    close = _Close({})
    match.find_leads(['x"@y.com', "ok@y.com"], close)
    assert close.calls == ['email_address:"ok@y.com"']
