import pytest
from sub_samples.photo_storage import (
    _extension_for, _build_rel_key, _content_type_for_key, PhotoStorageError,
)

def test_extension_known_and_unknown():
    assert _extension_for("vial.JPG") == ".jpg"
    assert _extension_for("weird.tiff") == ".bin"
    assert _extension_for("") == ".bin"

def test_build_rel_key_shape():
    key = _build_rel_key("P-0960-S01", "vial.png")
    assert key.startswith("P-0960-S01/") and key.endswith(".png")
    assert len(key.split("/")[1].split(".")[0]) == 32  # uuid4 hex

def test_build_rel_key_requires_sample_id():
    with pytest.raises(PhotoStorageError):
        _build_rel_key("", "vial.jpg")

def test_content_type_for_key():
    assert _content_type_for_key("P/abc.jpg") == "image/jpeg"
    assert _content_type_for_key("P/abc.bin") == "application/octet-stream"
