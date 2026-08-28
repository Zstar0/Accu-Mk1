"""build_chromatogram_csv (backend/hplc_csv.py) must be byte-identical to
the inline CSV-construction block it was extracted from in
upload_chromatogram_to_senaite (main.py ~6447-6455, pre-Task-6) — the push
path and the chromatogram-snapshot backfill script both call the extracted
function, so a backfilled row's bytes must be indistinguishable from a live
push's (COA read-independence spec §6)."""
import csv as csv_mod
import io
from types import SimpleNamespace

from hplc_csv import build_chromatogram_csv


def _old_inline_csv_bytes(analysis) -> bytes:
    """The ORIGINAL inline block (main.py ~6447-6455), reproduced verbatim
    as the reference implementation for this test — NOT imported from
    main.py, since that code no longer exists post-extraction."""
    chrom = analysis.chromatogram_data
    times = chrom["times"]
    signals = chrom["signals"]
    buf = io.StringIO()
    writer = csv_mod.writer(buf)
    for t, s in zip(times, signals):
        writer.writerow([t, s])
    return buf.getvalue().encode("utf-8")


def _fixture_analysis(**chrom_overrides):
    chrom = {"times": [0.0, 0.5, 1.0, 1.5], "signals": [10, 250.5, 999, 0]}
    chrom.update(chrom_overrides)
    return SimpleNamespace(id=42, sample_id_label="P-0142", chromatogram_data=chrom)


def test_extracted_builder_byte_identical_to_old_inline():
    analysis = _fixture_analysis()
    assert build_chromatogram_csv(analysis) == _old_inline_csv_bytes(analysis)


def test_extracted_builder_matches_expected_csv_shape():
    """Pin the actual byte shape (two-column, CRLF line terminator — the
    stdlib csv.writer default — UTF-8 encoded) so a future change to the
    builder can't silently drift without failing this test too."""
    analysis = _fixture_analysis(times=[0.0, 0.5], signals=[10, 20])
    assert build_chromatogram_csv(analysis) == b"0.0,10\r\n0.5,20\r\n"


def test_extracted_builder_handles_mismatched_length_via_zip_truncation():
    """zip() truncates to the shorter sequence — same behavior pre- and
    post-extraction (not a new guard, just confirming it's preserved)."""
    analysis = _fixture_analysis(times=[0.0, 0.5, 1.0], signals=[10, 20])
    assert build_chromatogram_csv(analysis) == _old_inline_csv_bytes(analysis)
    assert build_chromatogram_csv(analysis) == b"0.0,10\r\n0.5,20\r\n"


def test_extracted_builder_empty_series_yields_empty_csv():
    analysis = _fixture_analysis(times=[], signals=[])
    assert build_chromatogram_csv(analysis) == b""
