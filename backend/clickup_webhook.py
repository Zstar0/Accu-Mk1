import hmac
import hashlib


def verify_signature(raw_body: bytes, provided_sig: str | None, secret: str) -> bool:
    if not provided_sig:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided_sig)
