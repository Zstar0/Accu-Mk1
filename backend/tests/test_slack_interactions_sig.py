import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import hashlib
import hmac

from slack_notify.interactions import verify_slack_signature

SECRET = "shhh"


def _sign(ts, body):
    base = f"v0:{ts}:{body}".encode()
    return "v0=" + hmac.new(SECRET.encode(), base, hashlib.sha256).hexdigest()


def test_valid_signature_accepted():
    body, ts = "payload=%7B%7D", "1000"
    assert verify_slack_signature(SECRET, ts, _sign(ts, body), body, now=1000) is True


def test_tampered_body_rejected():
    ts = "1000"
    sig = _sign(ts, "payload=%7B%7D")
    assert verify_slack_signature(SECRET, ts, sig, "payload=EVIL", now=1000) is False


def test_replay_outside_window_rejected():
    body, ts = "payload=%7B%7D", "1000"
    assert verify_slack_signature(SECRET, ts, _sign(ts, body), body,
                                  now=1000 + 301) is False


def test_unset_secret_fails_closed():
    assert verify_slack_signature("", "1000", "v0=x", "b", now=1000) is False
    assert verify_slack_signature(None, "1000", "v0=x", "b", now=1000) is False


def test_bad_timestamp_rejected():
    assert verify_slack_signature(SECRET, "notanint", "v0=x", "b", now=1000) is False
