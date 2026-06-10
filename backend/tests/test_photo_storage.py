"""Unit tests for backend/sub_samples/photo_storage.py.

Uses a tmp_path fixture so tests are isolated from the live volume.
"""

from __future__ import annotations

import pytest

from sub_samples.photo_storage import (
    FilesystemPhotoStorage,
    PhotoNotFoundError,
    PhotoStorageError,
)


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "89000000004949454e44ae426082"
)


@pytest.fixture
def storage(tmp_path):
    return FilesystemPhotoStorage(root=str(tmp_path))


def test_save_returns_key_with_sample_id_prefix(storage):
    key = storage.save_photo("PB-0075-S01", PNG, "vial.png")
    assert key.startswith("PB-0075-S01/")
    assert key.endswith(".png")


def test_save_and_fetch_round_trip(storage):
    key = storage.save_photo("PB-0075-S01", PNG, "vial.png")
    fetched = storage.fetch_photo(key)
    assert fetched == PNG


def test_save_uses_unique_uuid_per_call(storage):
    k1 = storage.save_photo("S-01", PNG, "a.png")
    k2 = storage.save_photo("S-01", PNG, "b.png")
    assert k1 != k2


def test_save_unknown_extension_falls_back_to_bin(storage):
    key = storage.save_photo("S-01", PNG, "weird")
    assert key.endswith(".bin")


def test_save_jpg_extension_preserved(storage):
    key = storage.save_photo("S-01", PNG, "vial.JPG")
    assert key.endswith(".jpg")


def test_save_empty_bytes_raises(storage):
    with pytest.raises(PhotoStorageError):
        storage.save_photo("S-01", b"", "vial.png")


def test_save_missing_sample_id_raises(storage):
    with pytest.raises(PhotoStorageError):
        storage.save_photo("", PNG, "vial.png")


def test_fetch_missing_key_raises(storage):
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo("S-01/nonexistent.png")


def test_delete_is_idempotent(storage):
    key = storage.save_photo("S-01", PNG, "v.png")
    storage.delete_photo(key)
    storage.delete_photo(key)


def test_delete_then_fetch_raises(storage):
    key = storage.save_photo("S-01", PNG, "v.png")
    storage.delete_photo(key)
    with pytest.raises(PhotoNotFoundError):
        storage.fetch_photo(key)


def test_path_traversal_rejected(storage):
    with pytest.raises(PhotoStorageError):
        storage.fetch_photo("../etc/passwd")
    with pytest.raises(PhotoStorageError):
        storage.fetch_photo("/etc/passwd")
    with pytest.raises(PhotoStorageError):
        storage.fetch_photo("S-01/../../etc/passwd")


def test_multiple_samples_isolated_by_subdir(storage, tmp_path):
    k_a = storage.save_photo("PB-001", PNG, "a.png")
    k_b = storage.save_photo("PB-002", PNG, "b.png")
    assert (tmp_path / "PB-001").is_dir()
    assert (tmp_path / "PB-002").is_dir()
    assert k_a.startswith("PB-001/")
    assert k_b.startswith("PB-002/")
