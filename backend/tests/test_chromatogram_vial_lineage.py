"""Chromatogram ↔ vial lineage (P-2627, 2026-09-14): per-vial COAs read ONLY
the chromatogram row linked to their vial (fail-closed), the parent COA
prefers the core vial's row and falls back to newest, and the one-time
backfill stamps `source_sub_sample_pk` from our own push filenames."""
import logging

import pytest

from coa.native_sections import NativeSectionsError
from coa.sample_meta import select_chromatogram_row
from models import LimsParentAttachment, LimsSample, LimsSubSample
from scripts.backfill_chromatogram_source_vial import backfill


def _parent(db, sample_id="P-2627"):
    row = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}",
                     sample_type="x", status="verified")
    db.add(row); db.flush()
    return row


def _vial(db, parent, seq, kind="core", role="hplc"):
    row = LimsSubSample(
        sample_id=f"{parent.sample_id}-S{seq:02d}", parent_sample_pk=parent.id,
        vial_sequence=seq, external_lims_uid=f"uid-{parent.sample_id}-S{seq:02d}",
        assignment_role=role, assignment_kind=kind,
    )
    db.add(row); db.flush()
    return row


def _chrom(db, parent, *, source=None, kind="chromatogram", filename=None,
           storage="s3"):
    row = LimsParentAttachment(
        lims_sample_pk=parent.id, kind=kind,
        source_sub_sample_pk=source.id if source is not None else None,
        filename=filename or f"chromatogram_{(source.sample_id if source else parent.sample_id)}.csv",
        content_type="text/csv", storage=storage, storage_key="k",
        render_in_report=False, attachment_type="HPLC Graph",
    )
    db.add(row); db.flush()
    return row


# --- vial document -----------------------------------------------------------

def test_vial_picks_linked_row_and_ignores_newer_sibling(db_session):
    p = _parent(db_session)
    v1, v2 = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    mine = _chrom(db_session, p, source=v1)
    _chrom(db_session, p, source=v2)            # newer, sibling's trace
    _chrom(db_session, p)                       # newer still, unlinked
    assert select_chromatogram_row(db_session, p, vial=v1).id == mine.id


def test_vial_with_no_linked_row_fails_closed(db_session):
    p = _parent(db_session)
    v1, v2 = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    _chrom(db_session, p, source=v2)
    _chrom(db_session, p)
    with pytest.raises(NativeSectionsError) as ei:
        select_chromatogram_row(db_session, p, vial=v1)
    assert "P-2627-S01" in ei.value.detail
    assert "push it from the vial's HPLC analysis" in ei.value.detail


# --- parent document ---------------------------------------------------------

def test_parent_prefers_core_vial_row_over_newer_variance_row(db_session, caplog):
    p = _parent(db_session)
    core, var = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    core_row = _chrom(db_session, p, source=core)
    _chrom(db_session, p, source=var)           # newer
    with caplog.at_level(logging.INFO, logger="coa.sample_meta"):
        picked = select_chromatogram_row(db_session, p)
    assert picked.id == core_row.id
    assert any("core-vial" in r.message for r in caplog.records)


def test_parent_falls_back_to_newest_when_nothing_linked(db_session, caplog):
    p = _parent(db_session)
    _vial(db_session, p, 1); _vial(db_session, p, 2, kind="variance")
    _chrom(db_session, p)
    newest = _chrom(db_session, p)
    with caplog.at_level(logging.INFO, logger="coa.sample_meta"):
        picked = select_chromatogram_row(db_session, p)
    assert picked.id == newest.id
    assert any("newest" in r.message for r in caplog.records)


def test_parent_without_hplc_vials_keeps_newest_behaviour(db_session):
    p = _parent(db_session)
    _chrom(db_session, p)
    newest = _chrom(db_session, p)
    assert select_chromatogram_row(db_session, p).id == newest.id
    assert select_chromatogram_row(db_session, _parent(db_session, "P-0001")) is None


# --- backfill ----------------------------------------------------------------

def test_backfill_resolves_from_push_filename(db_session):
    p = _parent(db_session)
    v1 = _vial(db_session, p, 1)
    other = _parent(db_session, "P-0002")
    ov = _vial(db_session, other, 1)
    ok = _chrom(db_session, p, filename="chromatogram_P-2627-S01.csv")
    bare = _chrom(db_session, p, filename="chromatogram_P-2627.csv")
    cross = _chrom(db_session, p, filename=f"chromatogram_{ov.sample_id}.csv")
    manual = _chrom(db_session, p, kind="manual", filename="chromatogram_P-2627-S01.csv")
    already = _chrom(db_session, p, source=v1)

    stats = backfill(db_session, apply=False)
    assert stats == {"resolved": 1, "unresolved": 2, "skipped": 1, "mode": "DRY-RUN"}
    db_session.expire_all()
    assert ok.source_sub_sample_pk is None      # dry-run wrote nothing

    stats = backfill(db_session, apply=True)
    assert stats["resolved"] == 1 and stats["mode"] == "APPLY"
    db_session.expire_all()
    assert ok.source_sub_sample_pk == v1.id
    assert bare.source_sub_sample_pk is None
    assert cross.source_sub_sample_pk is None
    assert manual.source_sub_sample_pk is None
    assert already.source_sub_sample_pk == v1.id
    # idempotent: second apply finds nothing new
    assert backfill(db_session, apply=True)["resolved"] == 0
