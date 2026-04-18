import hmac, hashlib, json
from fastapi.testclient import TestClient
from backend.main import app


client = TestClient(app)


def sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_rejects_missing_signature():
    resp = client.post("/webhooks/clickup", json={"event": "taskStatusUpdated"})
    assert resp.status_code == 401


def test_webhook_rejects_bad_signature():
    body = b'{"event":"taskStatusUpdated"}'
    resp = client.post("/webhooks/clickup", content=body,
                       headers={"X-Signature": "nope", "Content-Type": "application/json"})
    assert resp.status_code == 401


def test_webhook_accepts_valid_signature(monkeypatch):
    import os
    secret = os.environ["CLICKUP_WEBHOOK_SECRET"]
    body = b'{"event":"unknown"}'  # unknown event should still 200
    sig = sign(body, secret)
    resp = client.post("/webhooks/clickup", content=body,
                       headers={"X-Signature": sig, "Content-Type": "application/json"})
    assert resp.status_code == 200
