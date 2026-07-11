import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import pytest


def test_inmemory_roundtrip_and_notfound():
    from flags import seams
    s = seams.InMemoryAttachmentStorage()
    key = s.save("7", b"\x89PNG\r\n\x1a\nrest", "upload.png")
    assert key and s.fetch(key) == b"\x89PNG\r\n\x1a\nrest"
    s.delete(key)
    with pytest.raises(seams.AttachmentNotFound):
        s.fetch(key)


def test_filesystem_roundtrip(tmp_path):
    from flags import seams
    s = seams.FilesystemAttachmentStorage(root=str(tmp_path))
    key = s.save("7", b"abc", "x.jpg")
    assert (tmp_path / key).exists()
    assert s.fetch(key) == b"abc"
    s.delete(key)  # idempotent
    s.delete(key)


def test_filesystem_refuses_traversal(tmp_path):
    from flags import seams
    s = seams.FilesystemAttachmentStorage(root=str(tmp_path))
    with pytest.raises(seams.AttachmentStorageError):
        s.fetch("../escape")


def test_singleton_override_for_tests():
    from flags import seams
    mem = seams.InMemoryAttachmentStorage()
    seams.set_attachment_storage_for_tests(mem)
    assert seams.get_attachment_storage() is mem
