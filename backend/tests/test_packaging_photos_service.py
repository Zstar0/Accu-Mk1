import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample
from packaging_photos.service import (
    create_packaging_photo,
    list_packaging_photos,
    get_packaging_photo,
    read_packaging_photo_bytes,
    update_packaging_photo,
    delete_packaging_photo,
)
from sub_samples import photo_storage
from sub_samples.photo_storage import (
    FilesystemPhotoStorage,
    PhotoNotFoundError,
    set_storage_for_tests,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def storage(tmp_path):
    """Swap the module singleton for a filesystem store under a tmp dir."""
    prev = photo_storage.get_storage()
    fs = FilesystemPhotoStorage(root=str(tmp_path / "packaging"))
    set_storage_for_tests(fs)
    try:
        yield fs
    finally:
        set_storage_for_tests(prev)


@pytest.fixture
def parent_sample(db):
    p = LimsSample(sample_id="P-0700", external_lims_uid="u-700")
    db.add(p)
    db.flush()
    return p


def test_create_assigns_incrementing_ordering_and_stores_bytes(db, storage, parent_sample):
    p1 = create_packaging_photo(db, parent_sample.sample_id, b"a", "a.jpg", "image/jpeg", None, 1)
    p2 = create_packaging_photo(db, parent_sample.sample_id, b"bb", "b.jpg", "image/jpeg", "note", 1)
    assert p1.ordering == 0 and p2.ordering == 1
    assert p1.storage_key.startswith("mk1://")
    assert p2.remarks == "note"
    raw, ct = read_packaging_photo_bytes(db, p1.id)
    assert raw == b"a" and ct == "image/jpeg"


def test_create_unknown_parent_raises(db, storage):
    with pytest.raises(LookupError):
        create_packaging_photo(db, "NOPE", b"a", "a.jpg", "image/jpeg", None, 1)


def test_list_ordered(db, storage, parent_sample):
    p1 = create_packaging_photo(db, parent_sample.sample_id, b"a", "a.jpg", "image/jpeg", None, 1)
    p2 = create_packaging_photo(db, parent_sample.sample_id, b"b", "b.jpg", "image/jpeg", None, 1)
    p3 = create_packaging_photo(db, parent_sample.sample_id, b"c", "c.jpg", "image/jpeg", None, 1)
    photos = list_packaging_photos(db, parent_sample.sample_id)
    assert [p.id for p in photos] == [p1.id, p2.id, p3.id]
    assert [p.ordering for p in photos] == [0, 1, 2]


def test_list_unknown_parent_returns_empty(db, storage):
    assert list_packaging_photos(db, "NOPE") == []


def test_get_returns_none_for_missing(db, storage):
    assert get_packaging_photo(db, 9999) is None


def test_update_replaces_bytes_and_deletes_old_key(db, storage, parent_sample):
    p = create_packaging_photo(db, parent_sample.sample_id, b"old", "a.jpg", "image/jpeg", None, 1)
    old_key = p.storage_key[len("mk1://"):]
    assert storage.fetch_photo(old_key) == b"old"

    updated = update_packaging_photo(db, p.id, b"new", "updated note")
    assert updated is not None
    assert updated.remarks == "updated note"
    new_key = updated.storage_key[len("mk1://"):]
    assert new_key != old_key

    raw, _ = read_packaging_photo_bytes(db, p.id)
    assert raw == b"new"
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(old_key)


def test_update_remarks_only_keeps_bytes(db, storage, parent_sample):
    p = create_packaging_photo(db, parent_sample.sample_id, b"keep", "a.jpg", "image/jpeg", None, 1)
    key = p.storage_key
    updated = update_packaging_photo(db, p.id, None, "just remarks")
    assert updated.remarks == "just remarks"
    assert updated.storage_key == key
    raw, _ = read_packaging_photo_bytes(db, p.id)
    assert raw == b"keep"


def test_update_missing_returns_none(db, storage):
    assert update_packaging_photo(db, 9999, b"x", "r") is None


def test_delete_removes_row_and_storage(db, storage, parent_sample):
    p = create_packaging_photo(db, parent_sample.sample_id, b"bye", "a.jpg", "image/jpeg", None, 1)
    key = p.storage_key[len("mk1://"):]
    assert storage.fetch_photo(key) == b"bye"

    assert delete_packaging_photo(db, p.id) is True
    assert get_packaging_photo(db, p.id) is None
    assert list_packaging_photos(db, parent_sample.sample_id) == []
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(key)


def test_delete_missing_returns_false(db, storage):
    assert delete_packaging_photo(db, 9999) is False


@pytest.fixture
def parent_sample_2(db):
    p = LimsSample(sample_id="P-0701", external_lims_uid="u-701")
    db.add(p)
    db.flush()
    return p


def test_bulk_creates_one_row_per_parent_with_independent_storage(db, storage, parent_sample, parent_sample_2):
    from packaging_photos.service import create_packaging_photos_bulk
    photos = create_packaging_photos_bulk(
        db, [parent_sample.sample_id, parent_sample_2.sample_id],
        b"box", "packaging.jpg", "image/jpeg", "note", 1,
    )
    assert len(photos) == 2
    assert {p.parent_sample_pk for p in photos} == {parent_sample.id, parent_sample_2.id}
    # independent storage objects, keyed per sample
    keys = [p.storage_key for p in photos]
    assert len(set(keys)) == 2
    assert all(k.startswith("mk1://") for k in keys)
    for p in photos:
        raw, _ = read_packaging_photo_bytes(db, p.id)
        assert raw == b"box"
        assert p.remarks == "note"


def test_bulk_ordering_is_per_parent(db, storage, parent_sample, parent_sample_2):
    from packaging_photos.service import create_packaging_photos_bulk
    create_packaging_photo(db, parent_sample.sample_id, b"a", "a.jpg", "image/jpeg", None, 1)
    photos = create_packaging_photos_bulk(
        db, [parent_sample.sample_id, parent_sample_2.sample_id],
        b"box", "packaging.jpg", "image/jpeg", None, 1,
    )
    by_pk = {p.parent_sample_pk: p for p in photos}
    assert by_pk[parent_sample.id].ordering == 1      # parent 1 already had one
    assert by_pk[parent_sample_2.id].ordering == 0    # parent 2's first


def test_bulk_missing_parent_is_all_or_nothing(db, storage, parent_sample):
    from packaging_photos.service import create_packaging_photos_bulk
    with pytest.raises(LookupError) as ei:
        create_packaging_photos_bulk(
            db, [parent_sample.sample_id, "NOPE-1", "NOPE-2"],
            b"box", "packaging.jpg", "image/jpeg", None, 1,
        )
    assert "NOPE-1" in str(ei.value) and "NOPE-2" in str(ei.value)
    assert list_packaging_photos(db, parent_sample.sample_id) == []


def test_bulk_stamps_capture_token_id(db, storage, parent_sample):
    from packaging_photos.service import create_packaging_photos_bulk
    photos = create_packaging_photos_bulk(
        db, [parent_sample.sample_id], b"box", "p.jpg", "image/jpeg",
        None, 1, capture_token_id=42,
    )
    assert photos[0].capture_token_id == 42
