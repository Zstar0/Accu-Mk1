"""ChromatographBackgroundUrl joins the coa_meta capture set (spec §6)."""
from sub_samples.service import _COA_META_FIELDS


def test_watermark_in_capture_set():
    assert "ChromatographBackgroundUrl" in _COA_META_FIELDS
