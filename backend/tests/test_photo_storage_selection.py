from sub_samples import photo_storage as ps


def test_filesystem_when_bucket_unset(monkeypatch):
    monkeypatch.delenv("MK1_PHOTO_S3_BUCKET", raising=False)
    assert isinstance(ps._make_default_storage(), ps.FilesystemPhotoStorage)


def test_s3_when_bucket_set(monkeypatch):
    monkeypatch.setenv("MK1_PHOTO_S3_BUCKET", "accumark-coa-private-west1")
    monkeypatch.setenv("MK1_PHOTO_S3_PREFIX", "sub-sample-photos/")
    monkeypatch.setenv("S3_REGION", "us-west-1")
    s = ps._make_default_storage()
    assert isinstance(s, ps.S3PhotoStorage)
    assert s.bucket == "accumark-coa-private-west1"
    assert s.prefix == "sub-sample-photos/"
