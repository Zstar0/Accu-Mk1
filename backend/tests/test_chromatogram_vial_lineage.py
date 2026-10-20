"""Chromatogram ↔ vial lineage (P-2627, 2026-09-14): per-vial COAs read ONLY
the chromatogram row linked to their vial (fail-closed), the parent COA
prefers the core vial's row and falls back to newest, and the one-time
backfill stamps `source_sub_sample_pk` from our own push filenames."""
import logging

import pytest
from sqlalchemy import select

from coa.native_sections import NativeSectionsError
from coa.sample_meta import select_chromatogram_row
from hplc_csv import build_chromatogram_csv
from models import HPLCAnalysis, LimsParentAttachment, LimsSample, LimsSubSample, Peptide
from scripts.backfill_chromatogram_source_vial import backfill
from sub_samples.photo_storage import get_storage, set_storage_for_tests


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


# --- vial-trace fallback (P-5324, 2026-10-19) --------------------------------
# No stamped row for the vial: the vial's own HPLC analysis (exact label) is
# serialized to a stamped row and returned; anything else still fails closed.

class _FakeStorage:
    def __init__(self):
        self.calls: list[tuple[str, bytes, str]] = []

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        self.calls.append((sample_id, photo_bytes, filename))
        return f"fake-key/{sample_id}/{filename}"


@pytest.fixture
def fake_storage():
    prev = get_storage()
    fake = _FakeStorage()
    set_storage_for_tests(fake)
    yield fake
    set_storage_for_tests(prev)


def _analysis(db, label, *, chrom):
    abbr = f"PEP-{label}"
    pep = db.execute(select(Peptide).where(Peptide.abbreviation == abbr)).scalar_one_or_none()
    if pep is None:
        pep = Peptide(name=f"pep {label}", abbreviation=abbr)
        db.add(pep); db.flush()
    row = HPLCAnalysis(
        sample_id_label=label, peptide_id=pep.id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        chromatogram_data=chrom,
    )
    db.add(row); db.flush()
    return row


def test_vial_without_linked_row_materializes_its_own_analysis_trace(
        db_session, fake_storage, caplog):
    p = _parent(db_session)
    v1, v2 = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    _chrom(db_session, p, source=v2)            # sibling's row
    _chrom(db_session, p)                       # newer, unlinked
    _analysis(db_session, v1.sample_id, chrom={"times": [0.0], "signals": [1.0]})
    newest = _analysis(db_session, v1.sample_id,
                       chrom={"times": [0.0, 0.1], "signals": [1.0, 2.5]})
    with caplog.at_level(logging.INFO, logger="coa.sample_meta"):
        row = select_chromatogram_row(db_session, p, vial=v1)
    assert row.source_sub_sample_pk == v1.id
    assert row.kind == "chromatogram"
    assert row.attachment_type == "HPLC Graph"
    assert row.render_in_report is False
    assert row.filename == "chromatogram_P-2627-S01.csv"
    assert fake_storage.calls == [
        (p.sample_id, build_chromatogram_csv(newest), row.filename)]
    assert row.storage_key == f"fake-key/{p.sample_id}/{row.filename}"
    assert any(f"materialized from HPLC analysis {newest.id}" in r.message
               for r in caplog.records)
    # The next read finds the stamped row; nothing is written twice.
    assert select_chromatogram_row(db_session, p, vial=v1).id == row.id
    assert len(fake_storage.calls) == 1


def test_vial_without_linked_row_or_qualifying_analysis_still_fails_closed(
        db_session, fake_storage):
    p = _parent(db_session)
    v1 = _vial(db_session, p, 1)
    _analysis(db_session, v1.sample_id, chrom=None)                        # no trace
    _analysis(db_session, v1.sample_id, chrom={"times": [], "signals": []})  # empty
    _analysis(db_session, p.sample_id, chrom={"times": [0.0], "signals": [1.0]})  # parent label
    with pytest.raises(NativeSectionsError) as ei:
        select_chromatogram_row(db_session, p, vial=v1)
    assert "P-2627-S01" in ei.value.detail
    assert fake_storage.calls == []
    assert db_session.execute(select(LimsParentAttachment)).scalars().all() == []


def test_vial_fallback_never_uses_a_sibling_vials_analysis(db_session, fake_storage):
    p = _parent(db_session)
    v1, v2 = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    _analysis(db_session, v2.sample_id, chrom={"times": [0.0], "signals": [1.0]})
    with pytest.raises(NativeSectionsError):
        select_chromatogram_row(db_session, p, vial=v1)
    assert fake_storage.calls == []
    assert db_session.execute(select(LimsParentAttachment)).scalars().all() == []


# --- parent guard (P-5324 follow-up, 2026-10-19) ------------------------------
# The vial fallback stamps rows with variance vials too, so the parent COA must
# never inherit one through the newest rule: it materializes the core vial's
# own trace first, and the newest rule skips rows stamped with another vial.

def test_parent_prefers_unstamped_core_push_over_newer_variance_stamped_row(
        db_session, fake_storage):
    p = _parent(db_session)
    _vial(db_session, p, 1); var = _vial(db_session, p, 2, kind="variance")
    core_push = _chrom(db_session, p, filename="chromatogram_P-2627.csv")   # source NULL
    _chrom(db_session, p, source=var)                                      # newer, variance
    assert select_chromatogram_row(db_session, p).id == core_push.id
    assert fake_storage.calls == []


def test_parent_with_no_core_row_materializes_the_core_vials_own_analysis(
        db_session, fake_storage, caplog):
    p = _parent(db_session)
    core, var = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    _chrom(db_session, p, source=var)                                      # variance only
    _analysis(db_session, var.sample_id, chrom={"times": [0.0], "signals": [9.0]})
    a = _analysis(db_session, core.sample_id,
                  chrom={"times": [0.0, 0.1], "signals": [1.0, 2.0]})
    with caplog.at_level(logging.INFO, logger="coa.sample_meta"):
        picked = select_chromatogram_row(db_session, p)
    assert picked.source_sub_sample_pk == core.id
    assert picked.filename == "chromatogram_P-2627-S01.csv"
    assert fake_storage.calls == [(p.sample_id, build_chromatogram_csv(a), picked.filename)]
    assert any("core-vial materialized" in r.message for r in caplog.records)
    # The next read finds the core-stamped row; nothing is written twice.
    assert select_chromatogram_row(db_session, p).id == picked.id
    assert len(fake_storage.calls) == 1


def test_parent_with_only_a_variance_stamped_row_and_no_core_trace_returns_none(
        db_session, fake_storage):
    p = _parent(db_session)
    core, var = _vial(db_session, p, 1), _vial(db_session, p, 2, kind="variance")
    _chrom(db_session, p, source=var)
    _analysis(db_session, var.sample_id, chrom={"times": [0.0], "signals": [9.0]})
    _analysis(db_session, core.sample_id, chrom=None)
    # Missing parent chromatogram contract: None, not a sibling's trace.
    assert select_chromatogram_row(db_session, p) is None
    assert fake_storage.calls == []


def test_parent_without_hplc_vials_keeps_newest_even_when_stamped(
        db_session, fake_storage):
    p = _parent(db_session)
    micro = _vial(db_session, p, 1, role="micro")
    _chrom(db_session, p)
    newest = _chrom(db_session, p, source=micro)
    assert select_chromatogram_row(db_session, p).id == newest.id
    assert fake_storage.calls == []
