import io
import pytest
from botocore.exceptions import ClientError
from sub_samples.photo_storage import (
    S3PhotoStorage, PhotoNotFoundError, PhotoStorageError,
)

class FakeS3:
    def __init__(self):
        self.store = {}
    def put_object(self, Bucket, Key, Body, ContentType=None, **kw):
        self.store[(Bucket, Key)] = {"Body": Body, "ContentType": ContentType}
        return {"ETag": "x"}
    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.store:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.store[(Bucket, Key)]["Body"])}
    def delete_object(self, Bucket, Key):
        self.store.pop((Bucket, Key), None)
        return {}

def _store():
    return S3PhotoStorage(bucket="test-bucket", prefix="sub-sample-photos/",
                          region="us-west-1", client=FakeS3())

def test_save_returns_rel_key_and_puts_prefixed_object():
    s = _store()
    key = s.save_photo("P-0960-S01", b"\xff\xd8jpeg", "vial.jpg")
    assert key.startswith("P-0960-S01/") and key.endswith(".jpg")
    obj = s._client.store[("test-bucket", "sub-sample-photos/" + key)]
    assert obj["ContentType"] == "image/jpeg"
    assert obj["Body"] == b"\xff\xd8jpeg"

def test_fetch_round_trip():
    s = _store()
    key = s.save_photo("P-1/S1", b"data", "x.png")  # noqa
    assert s.fetch_photo(key) == b"data"

def test_fetch_missing_raises_photo_not_found():
    s = _store()
    with pytest.raises(PhotoNotFoundError):
        s.fetch_photo("P-0960-S01/deadbeef.jpg")

def test_delete_idempotent_then_fetch_missing():
    s = _store()
    key = s.save_photo("P-1-S1", b"d", "x.jpg")
    s.delete_photo(key)
    s.delete_photo(key)  # no error
    with pytest.raises(PhotoNotFoundError):
        s.fetch_photo(key)

def test_unsafe_key_rejected():
    s = _store()
    with pytest.raises(PhotoStorageError):
        s.fetch_photo("../secret")

def test_empty_bytes_rejected():
    s = _store()
    with pytest.raises(PhotoStorageError):
        s.save_photo("P-1-S1", b"", "x.jpg")

def test_delete_unsafe_key_rejected():
    s = _store()
    with pytest.raises(PhotoStorageError):
        s.delete_photo("../secret")
