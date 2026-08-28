"""Unit tests for the chromatogram-snapshot backfill (COA read-independence
spec §6, Task 6): pure parent-resolution + cohort/write behavior."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import HPLCAnalysis, LimsParentAttachment, LimsSample, LimsSubSample
from scripts.backfill_chromatogram_snapshots import (
    resolve_parent_pk_for_analysis, backfill, main,
)


def _manual_attachment(db, parent, *, filename, content_type=None,
                        attachment_type=None, storage="s3"):
    row = LimsParentAttachment(
        lims_sample_pk=parent.id, kind="manual", filename=filename,
        content_type=content_type, storage=storage, storage_key="k0",
        render_in_report=False, attachment_type=attachment_type,
    )
    db.add(row); db.flush()
    return row


# --- resolve_parent_pk_for_analysis (pure, fakes only) -----------------------

def _analysis(prep_id=None, label=None):
    return SimpleNamespace(sample_prep_id=prep_id, sample_id_label=label)


def test_resolves_via_vial_path():
    pk = resolve_parent_pk_for_analysis(
        _analysis(prep_id=10, label="P-9999"),   # label would resolve differently
        vial_pk_by_prep_id={10: 5}, parent_pk_by_vial_pk={5: 1},
        parent_pk_by_sample_id={"P-9999": 99},
    )
    assert pk == 1   # vial path wins over label path when both resolve


def test_falls_back_to_label_when_no_prep_id():
    pk = resolve_parent_pk_for_analysis(
        _analysis(prep_id=None, label="P-0142"),
        vial_pk_by_prep_id={}, parent_pk_by_vial_pk={},
        parent_pk_by_sample_id={"P-0142": 7},
    )
    assert pk == 7


def test_falls_back_to_label_when_prep_unresolvable():
    pk = resolve_parent_pk_for_analysis(
        _analysis(prep_id=10, label="P-0142"),
        vial_pk_by_prep_id={}, parent_pk_by_vial_pk={},   # prep 10 not in map
        parent_pk_by_sample_id={"P-0142": 7},
    )
    assert pk == 7


def test_falls_back_to_label_when_prep_not_vial_tagged():
    pk = resolve_parent_pk_for_analysis(
        _analysis(prep_id=10, label="P-0142"),
        vial_pk_by_prep_id={10: None},   # prep exists but lims_sub_sample_pk is NULL
        parent_pk_by_vial_pk={}, parent_pk_by_sample_id={"P-0142": 7},
    )
    assert pk == 7


def test_unresolvable_when_neither_path_matches():
    pk = resolve_parent_pk_for_analysis(
        _analysis(prep_id=10, label="P-GHOST"),
        vial_pk_by_prep_id={}, parent_pk_by_vial_pk={}, parent_pk_by_sample_id={},
    )
    assert pk is None


def test_unresolvable_when_label_is_none_and_prep_missing():
    pk = resolve_parent_pk_for_analysis(
        _analysis(prep_id=None, label=None),
        vial_pk_by_prep_id={}, parent_pk_by_vial_pk={}, parent_pk_by_sample_id={},
    )
    assert pk is None


# --- backfill() (in-memory sqlite db_factory + patched mk1_db/storage) ------

class _FakePhotoStorage:
    def __init__(self, *, raise_on_save=False):
        self.calls: list[tuple[str, bytes, str]] = []
        self.raise_on_save = raise_on_save

    def save_photo(self, sample_id: str, photo_bytes: bytes, filename: str) -> str:
        if self.raise_on_save:
            raise RuntimeError("fake storage boom")
        self.calls.append((sample_id, photo_bytes, filename))
        return f"fake-key/{sample_id}/{filename}"


@pytest.fixture
def db_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _parent(db, sample_id):
    row = LimsSample(sample_id=sample_id)
    db.add(row); db.flush()
    return row


def _vial(db, parent, sample_id, seq=1):
    row = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid=f"UID-{sample_id}",
        sample_id=sample_id, vial_sequence=seq,
    )
    db.add(row); db.flush()
    return row


def _analysis_row(db, *, label, prep_id=None, times=(0.0, 0.5), signals=(10, 20)):
    row = HPLCAnalysis(
        sample_id_label=label, peptide_id=1,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        sample_prep_id=prep_id,
        chromatogram_data={"times": list(times), "signals": list(signals)} if times else None,
    )
    db.add(row); db.flush()
    return row


def _existing_chromatogram_attachment(db, parent, *, storage="s3"):
    row = LimsParentAttachment(
        lims_sample_pk=parent.id, kind="chromatogram", filename="old.csv",
        content_type="text/csv", storage=storage, storage_key="k0",
        render_in_report=False, attachment_type="HPLC Graph",
    )
    db.add(row); db.flush()
    return row


def _patched(preps=None):
    """Patch mk1_db.list_sample_preps_by_ids (real module — imported
    locally inside the script) and the photo-storage singleton."""
    fake_storage = _FakePhotoStorage()
    ctx = (
        patch("mk1_db.list_sample_preps_by_ids", return_value=preps or []),
        patch("sub_samples.photo_storage.get_storage", return_value=fake_storage),
    )
    return ctx, fake_storage


def test_dry_run_writes_nothing(db_factory):
    db = db_factory()
    parent = _parent(db, "P-0001")
    _analysis_row(db, label="P-0001")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=False, limit=None)

    assert stats["analyses_with_data"] == 1
    assert stats["parents_with_chromatogram_data"] == 1
    assert stats["already_covered"] == 0
    assert stats["backfilled"] == 1
    assert fake_storage.calls == []   # dry-run never touches storage
    db = db_factory()
    assert db.query(LimsParentAttachment).count() == 0
    db.close()


def test_apply_mints_row_with_expected_shape(db_factory):
    db = db_factory()
    parent = _parent(db, "P-0001")
    a = _analysis_row(db, label="P-0001", times=[0.0, 0.5], signals=[10, 20])
    db.commit(); parent_id = parent.id; db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["backfilled"] == 1 and stats["errors"] == 0
    assert fake_storage.calls == [("P-0001", b"0.0,10\r\n0.5,20\r\n",
                                    "chromatogram_P-0001.csv")]
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.lims_sample_pk == parent_id
    assert row.kind == "chromatogram"
    assert row.storage == "s3"
    assert row.storage_key == "fake-key/P-0001/chromatogram_P-0001.csv"
    assert row.content_type == "text/csv"
    assert row.render_in_report is False
    assert row.attachment_type == "HPLC Graph"
    db.close()


def test_resolves_via_vial_tagged_prep(db_factory):
    db = db_factory()
    parent = _parent(db, "P-0001")
    vial = _vial(db, parent, "P-0001-S01")
    a = _analysis_row(db, label="P-0001-S01", prep_id=77)   # label is the VIAL id
    db.commit(); parent_id, vial_id = parent.id, vial.id; db.close()

    preps = [{"id": 77, "sample_id": "SP-1", "senaite_sample_id": "P-0001-S01",
              "lims_sub_sample_pk": vial_id}]
    ctx, fake_storage = _patched(preps=preps)
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["backfilled"] == 1
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.lims_sample_pk == parent_id   # attached to the PARENT, not the vial
    db.close()


def test_already_covered_parent_skipped(db_factory):
    db = db_factory()
    parent = _parent(db, "P-0001")
    _existing_chromatogram_attachment(db, parent)
    _analysis_row(db, label="P-0001")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["already_covered"] == 1
    assert stats["backfilled"] == 0
    assert fake_storage.calls == []
    db = db_factory()
    assert db.query(LimsParentAttachment).count() == 1   # unchanged
    db.close()


def test_senaite_stored_row_does_not_count_as_covered(db_factory):
    """_newest (coa/sample_meta.py) only reads storage='s3' rows — a
    senaite-stored chromatogram row must NOT block the backfill."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _existing_chromatogram_attachment(db, parent, storage="senaite")
    _analysis_row(db, label="P-0001")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["already_covered"] == 0
    assert stats["backfilled"] == 1


def test_multiple_analyses_same_parent_uses_newest(db_factory):
    db = db_factory()
    parent = _parent(db, "P-0001")
    _analysis_row(db, label="P-0001", times=[0.0], signals=[1])   # older, id 1
    newer = _analysis_row(db, label="P-0001", times=[0.0, 1.0], signals=[9, 8])  # id 2
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["parents_with_chromatogram_data"] == 1
    assert stats["backfilled"] == 1
    assert fake_storage.calls[0][1] == b"0.0,9\r\n1.0,8\r\n"   # newest analysis' data


def test_unresolvable_parent_counted_and_skipped(db_factory):
    db = db_factory()
    _analysis_row(db, label="P-GHOST")   # no matching LimsSample at all
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["unresolved_parent"] == 1
    assert stats["backfilled"] == 0
    assert stats["analyses_with_data"] == 1


def test_malformed_chromatogram_data_excluded(db_factory):
    db = db_factory()
    parent = _parent(db, "P-0001")
    row = HPLCAnalysis(
        sample_id_label="P-0001", peptide_id=1,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        chromatogram_data={"times": [], "signals": []},   # empty — malformed
    )
    db.add(row)
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["analyses_with_data"] == 0
    assert stats["backfilled"] == 0


def test_limit_caps_gap_parents(db_factory):
    db = db_factory()
    for i in range(3):
        p = _parent(db, f"P-000{i}")
        _analysis_row(db, label=f"P-000{i}")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=2)

    assert stats["backfilled"] == 2


def test_one_error_does_not_abort_other_parents(db_factory):
    db = db_factory()
    _parent(db, "P-0001")
    _analysis_row(db, label="P-0001")
    _parent(db, "P-0002")
    _analysis_row(db, label="P-0002")
    db.commit(); db.close()

    fake_storage = _FakePhotoStorage(raise_on_save=True)
    with patch("mk1_db.list_sample_preps_by_ids", return_value=[]), \
         patch("sub_samples.photo_storage.get_storage", return_value=fake_storage):
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["errors"] == 2 and stats["backfilled"] == 0


def test_race_skipped_when_row_landed_concurrently(db_factory):
    """A live push mints the s3 row AFTER the cohort snapshot but BEFORE
    this parent's apply-time re-check — must skip, not duplicate."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _analysis_row(db, label="P-0001")
    db.commit(); parent_id = parent.id; db.close()

    real_factory = db_factory
    call_count = {"n": 0}

    def racing_factory():
        s = real_factory()
        call_count["n"] += 1
        # call 1 = the reclassify pass's read session (no manual rows here,
        # so no apply calls); call 2 = the main cohort/already_covered read
        # session; call 3 = the write-loop's per-parent session.
        if call_count["n"] == 3:   # the write-loop's per-parent session
            live_push = LimsParentAttachment(
                lims_sample_pk=parent_id, kind="chromatogram", filename="live.csv",
                content_type="text/csv", storage="s3", storage_key="k-live",
                render_in_report=False, attachment_type="HPLC Graph",
            )
            other = real_factory()
            other.add(live_push); other.commit(); other.close()
        return s

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(racing_factory, apply=True, limit=None)

    assert stats["race_skipped"] == 1
    assert stats["backfilled"] == 0
    assert fake_storage.calls == []
    db = real_factory()
    assert db.query(LimsParentAttachment).count() == 1   # only the live push
    db.close()


# --- reclassify pass: manual-kind historical chromatogram CSVs (UAT F-1, R-16) --

def test_reclassify_retags_manual_chromatogram_csv_apply_only_dry_run_counts(db_factory):
    """(a) A manual chromatogram_*.csv row gets retagged in APPLY; dry-run
    only counts it (does not write)."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="chromatogram_P-0001.csv",
                        content_type="text/csv")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        dry_stats = backfill(db_factory, apply=False, limit=None)
    assert dry_stats["reclassified"] == 1
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.kind == "manual"   # dry-run: untouched
    db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        apply_stats = backfill(db_factory, apply=True, limit=None)
    assert apply_stats["reclassified"] == 1
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.kind == "chromatogram"
    assert row.attachment_type == "HPLC Graph"
    db.close()


def test_reclassify_matches_via_content_type_and_attachment_type(db_factory):
    """The second disjunct: content_type='text/csv' AND
    attachment_type='HPLC Graph' also qualifies, even without the
    chromatogram_*.csv filename shape."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="hplc_export.csv",
                        content_type="text/csv", attachment_type="HPLC Graph")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)
    assert stats["reclassified"] == 1
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.kind == "chromatogram"
    db.close()


def test_reclassify_ignores_non_matching_manual_row(db_factory):
    """(b) A manual row that doesn't match either disjunct (e.g. a PDF) is
    left untouched."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="report.pdf",
                        content_type="application/pdf")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)
    assert stats["reclassified"] == 0
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.kind == "manual"
    db.close()


def test_reclassify_idempotent_on_rerun(db_factory):
    """(c) Re-running APPLY after a successful reclassify counts 0 — the
    retagged row no longer matches kind='manual'."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="chromatogram_P-0001.csv",
                        content_type="text/csv")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        first = backfill(db_factory, apply=True, limit=None)
    assert first["reclassified"] == 1

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        second = backfill(db_factory, apply=True, limit=None)
    assert second["reclassified"] == 0


def test_reclassify_runs_before_rebuild_so_already_covered_absorbs_it(db_factory):
    """Reclassification happens before the rebuild pass: a parent whose only
    chromatogram coverage comes from a reclassified manual row must show up
    as already_covered, not backfilled again."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="chromatogram_P-0001.csv",
                        content_type="text/csv")
    _analysis_row(db, label="P-0001")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)

    assert stats["reclassified"] == 1
    assert stats["already_covered"] == 1
    assert stats["backfilled"] == 0
    assert fake_storage.calls == []
    db = db_factory()
    assert db.query(LimsParentAttachment).count() == 1   # unchanged, just retagged
    db.close()


def test_reclassify_dry_run_already_covered_matches_apply_semantics(db_factory):
    """Dry-run must report exactly what an apply run would do: a parent
    satisfied purely by reclassification shows as already_covered — not a
    rebuild-pass gap — in DRY-RUN too, even though nothing was written."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="chromatogram_P-0001.csv",
                        content_type="text/csv")
    _analysis_row(db, label="P-0001")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=False, limit=None)

    assert stats["reclassified"] == 1
    assert stats["already_covered"] == 1
    assert stats["backfilled"] == 0
    assert fake_storage.calls == []
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.kind == "manual"   # dry-run never writes
    db.close()


def test_reclassify_row_error_counts_as_error_and_does_not_block_others(db_factory):
    """A per-row retag failure folds into stats["errors"] (the script's
    exit-code contract: 1 = run completed but something errored) and does
    not stop the other matching row from being retagged."""
    db = db_factory()
    p1 = _parent(db, "P-0001")
    p2 = _parent(db, "P-0002")
    _manual_attachment(db, p1, filename="chromatogram_P-0001.csv",
                        content_type="text/csv")
    _manual_attachment(db, p2, filename="chromatogram_P-0002.csv",
                        content_type="text/csv")
    db.commit(); db.close()

    real_factory = db_factory
    call_count = {"n": 0}

    class _BoomOnCommitSession:
        """Wraps a real session; the reclassify write loop only calls
        get/commit/close on it, so duck-typing those three is enough."""
        def __init__(self, inner):
            self._inner = inner

        def get(self, *a, **kw):
            return self._inner.get(*a, **kw)

        def commit(self):
            raise RuntimeError("boom")

        def close(self):
            self._inner.close()

    def boom_factory():
        call_count["n"] += 1
        s = real_factory()
        # call 1 = reclassify's read session; calls 2 and 3 = the two
        # matched rows' per-row write sessions — make the first one boom.
        if call_count["n"] == 2:
            return _BoomOnCommitSession(s)
        return s

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(boom_factory, apply=True, limit=None)

    assert stats["errors"] == 1
    assert stats["reclassified"] == 1   # the other row still succeeded
    db = real_factory()
    kinds = sorted(r.kind for r in db.query(LimsParentAttachment).all())
    assert kinds == ["chromatogram", "manual"]   # one retagged, one not
    db.close()


def test_reclassify_storage_not_s3_untouched(db_factory):
    """Only storage='s3' manual rows qualify — a senaite-stored manual row
    is left alone even if the filename matches."""
    db = db_factory()
    parent = _parent(db, "P-0001")
    _manual_attachment(db, parent, filename="chromatogram_P-0001.csv",
                        content_type="text/csv", storage="senaite")
    db.commit(); db.close()

    ctx, fake_storage = _patched()
    with ctx[0], ctx[1]:
        stats = backfill(db_factory, apply=True, limit=None)
    assert stats["reclassified"] == 0
    db = db_factory()
    row = db.query(LimsParentAttachment).one()
    assert row.kind == "manual"
    db.close()


# --- main() / APPLY env gate --------------------------------------------------

def test_main_defaults_to_dry_run(db_factory, monkeypatch, capsys):
    monkeypatch.delenv("APPLY", raising=False)
    with patch("scripts.backfill_chromatogram_snapshots.SessionLocal", db_factory), \
         patch("mk1_db.list_sample_preps_by_ids", return_value=[]):
        rc = main([])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["mode"] == "DRY-RUN"


def test_main_apply_requires_env_flag(db_factory, monkeypatch, capsys):
    monkeypatch.setenv("APPLY", "1")
    with patch("scripts.backfill_chromatogram_snapshots.SessionLocal", db_factory), \
         patch("mk1_db.list_sample_preps_by_ids", return_value=[]):
        rc = main([])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["mode"] == "APPLY"


def test_main_exit_code_reflects_errors(db_factory, monkeypatch, capsys):
    monkeypatch.delenv("APPLY", raising=False)
    db = db_factory()
    _parent(db, "P-0001")
    _analysis_row(db, label="P-0001")
    db.commit(); db.close()

    fake_storage = _FakePhotoStorage(raise_on_save=True)
    monkeypatch.setenv("APPLY", "1")
    with patch("scripts.backfill_chromatogram_snapshots.SessionLocal", db_factory), \
         patch("mk1_db.list_sample_preps_by_ids", return_value=[]), \
         patch("sub_samples.photo_storage.get_storage", return_value=fake_storage):
        rc = main([])
    assert rc == 1
    stats = json.loads(capsys.readouterr().out.strip())
    assert stats["errors"] == 1
