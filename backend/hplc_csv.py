"""Chromatogram CSV builder — shared by the live SENAITE push endpoint
(main.py's upload_chromatogram_to_senaite) and the historical backfill
(scripts/backfill_chromatogram_snapshots.py), so a backfilled attachment's
bytes are indistinguishable from what a live push would have produced
(COA read-independence spec §6 — "same CSV builder the push path uses").

Pure extraction of the CSV-construction block that used to live inline in
upload_chromatogram_to_senaite (main.py ~6447-6455) — byte-identical output,
covered by tests/test_hplc_csv.py comparing against the original inline
construction for a fixture analysis.
"""
import csv as csv_mod
import io


def build_chromatogram_csv(analysis) -> bytes:
    """Two-column (time, signal) CSV from an HPLCAnalysis row's
    chromatogram_data ({"times": [...], "signals": [...]}), UTF-8 encoded.

    Duck-typed on `analysis.chromatogram_data` (works for a real HPLCAnalysis
    ORM row or any object/fixture carrying that attribute). Callers are
    responsible for validating chromatogram_data is present with non-empty
    times/signals first — same contract as the original inline block, which
    trusted its caller's precondition check rather than re-validating."""
    chrom = analysis.chromatogram_data
    times = chrom["times"]
    signals = chrom["signals"]
    buf = io.StringIO()
    writer = csv_mod.writer(buf)
    for t, s in zip(times, signals):
        writer.writerow([t, s])
    return buf.getvalue().encode("utf-8")
