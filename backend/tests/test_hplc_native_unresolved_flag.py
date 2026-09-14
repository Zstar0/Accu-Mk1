"""D5 / Handler ruling 4 (2026-09-14): an analyte name that doesn't resolve to
a peptide at native seed time raises ONE open flag on the sample (not just
the silent `reportable_reason`), deduped across both seed sites
(parent_placeholders registration seed + hplc_native vial seed), and
auto-resolved by relabel_native_slot once every slot resolves."""
import json

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from catalog.hplc_native_seed import HPLC_NATIVE_PROFILE_KEY
from database import Base
from flags import seams as flag_seams
from flags.models import FlagEvent, FlagFlag
from flags.types_service import seed_builtins
from lims_analyses.hplc_native import (
    UNRESOLVED_FLAG_TYPE,
    relabel_native_slot,
    resolve_slot_peptides,
    seed_native_hplc_rows,
)
from lims_analyses.parent_placeholders import seed_parent_placeholders
from models import LimsSample, LimsSubSample, LimsSubSampleEvent, Peptide
from tests.hplc_native_family import native_catalog


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _setup(db):
    seed_builtins(db)
    flag_seams.register_mk1_entities()
    return native_catalog(db)


def _blend_parent(db, sample_id, *, slot2_name):
    """slot 1 resolves (BPC-157); slot 2 is `slot2_name`, unresolved unless
    it's also given a peptide_id by the caller."""
    bpc = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(bpc); db.flush()
    analytes = [
        {"name": "BPC-157", "declared_quantity": None, "peptide_id": bpc.id},
        {"name": slot2_name, "declared_quantity": None, "peptide_id": None},
    ]
    parent = LimsSample(sample_id=sample_id, external_lims_system="mk1",
                        sample_type_title="Peptide Blend", analytes=json.dumps(analytes))
    db.add(parent); db.flush()
    return parent, bpc


def _open_flags(db, parent):
    return db.execute(select(FlagFlag).where(
        FlagFlag.entity_type == "sample", FlagFlag.entity_id == str(parent.id),
        FlagFlag.type == UNRESOLVED_FLAG_TYPE, FlagFlag.status == "open",
    )).scalars().all()


def test_unresolved_slot_at_registration_raises_one_open_flag(db):
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9001", slot2_name="Mystery-Peptide")
    seed_parent_placeholders(db, parent=parent, services={HPLC_NATIVE_PROFILE_KEY: True})

    flags = _open_flags(db, parent)
    assert len(flags) == 1
    flag = flags[0]
    assert flag.title == "PB-9001: analyte unresolved — Mystery-Peptide (slot 2)"
    ev = db.execute(select(FlagEvent).where(
        FlagEvent.flag_id == flag.id, FlagEvent.event_type == "raised")).scalar_one()
    assert ev.details["automated"] is True
    assert ev.details["slots"] == [2]
    assert ev.details["raw"] == ["Mystery-Peptide"]


def test_vial_seed_after_placeholder_seed_does_not_duplicate(db):
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9002", slot2_name="Mystery-Peptide")
    seed_parent_placeholders(db, parent=parent, services={HPLC_NATIVE_PROFILE_KEY: True})
    assert len(_open_flags(db, parent)) == 1

    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="PB-9002-S01",
                         external_lims_uid="uid-PB-9002-S01", vial_sequence=1)
    db.add(vial); db.flush()
    seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                          existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert len(_open_flags(db, parent)) == 1


def test_relabel_resolves_the_flag(db):
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9003", slot2_name="Mystery-Peptide")
    seed_parent_placeholders(db, parent=parent, services={HPLC_NATIVE_PROFILE_KEY: True})
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="PB-9003-S01",
                         external_lims_uid="uid-PB-9003-S01", vial_sequence=1)
    db.add(vial); db.flush()
    seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                          existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert len(_open_flags(db, parent)) == 1

    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True)
    db.add(ghk); db.flush()
    relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)

    assert _open_flags(db, parent) == []
    flag = db.execute(select(FlagFlag).where(
        FlagFlag.entity_type == "sample", FlagFlag.entity_id == str(parent.id),
        FlagFlag.type == UNRESOLVED_FLAG_TYPE,
    )).scalars().one()
    assert flag.status == "resolved"


def test_fully_resolved_parent_never_gets_a_flag(db):
    _setup(db)
    bpc = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    tb = Peptide(name="TB-500", abbreviation="TB500", active=True)
    db.add_all([bpc, tb]); db.flush()
    analytes = [
        {"name": "BPC-157", "declared_quantity": None, "peptide_id": bpc.id},
        {"name": "TB-500", "declared_quantity": None, "peptide_id": tb.id},
    ]
    parent = LimsSample(sample_id="PB-9004", external_lims_system="mk1",
                        sample_type_title="Peptide Blend", analytes=json.dumps(analytes))
    db.add(parent); db.flush()
    seed_parent_placeholders(db, parent=parent, services={HPLC_NATIVE_PROFILE_KEY: True})

    assert not any(r.reason for r in resolve_slot_peptides(db, parent))
    assert _open_flags(db, parent) == []


def test_flag_type_is_a_seeded_type(db):
    _setup(db)
    from flags.types_service import get_type_by_slug
    assert get_type_by_slug(db, UNRESOLVED_FLAG_TYPE) is not None


def test_seed_commit_false_leaves_flag_pending_until_callers_own_commit(db):
    """Fix round 1 / Finding 1: seed_native_hplc_rows(commit=False) (the
    set_assignment_role atomic contract, sub_samples/service.py:~2367) must
    not force a commit underneath the caller. The flag row is flushed and
    visible in this transaction, but a db.rollback() with no intervening
    commit removes it entirely — proof no commit happened."""
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9010", slot2_name="Mystery-Peptide")
    parent_id = parent.id
    vial = LimsSubSample(parent_sample_pk=parent_id, sample_id="PB-9010-S01",
                         external_lims_uid="uid-PB-9010-S01", vial_sequence=1)
    db.add(vial); db.flush()
    seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                          existing_service_ids=set(), created_by_user_id=None, commit=False)

    def _open_flags_for(pid):
        return db.execute(select(FlagFlag).where(
            FlagFlag.entity_type == "sample", FlagFlag.entity_id == str(pid),
            FlagFlag.type == UNRESOLVED_FLAG_TYPE, FlagFlag.status == "open",
        )).scalars().all()

    assert len(_open_flags_for(parent_id)) == 1  # flushed, visible pre-commit
    db.rollback()
    assert _open_flags_for(parent_id) == []      # never committed -> gone


def test_relabel_commit_false_leaves_event_and_resolution_pending(db):
    """Fix round 1 / Finding 2: relabel_native_slot(commit=False) must leave
    the native_slot_relabeled event AND the flag resolution inside its own
    (not-yet-taken) commit, alongside the restamp — a rollback undoes all
    three together, proving none of them committed early on their own."""
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9011", slot2_name="Mystery-Peptide")
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="PB-9011-S01",
                         external_lims_uid="uid-PB-9011-S01", vial_sequence=1)
    db.add(vial); db.flush()
    seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                          existing_service_ids=set(), created_by_user_id=None, commit=True)
    db.commit()  # committed baseline: one open flag + the seeded rows
    parent_id = parent.id

    ghk = Peptide(name="GHK-Cu", abbreviation="GHKCU", active=True)
    db.add(ghk); db.flush()
    relabel_native_slot(db, parent=parent, slot=2, new_peptide_id=ghk.id, user_id=1, commit=False)

    def _events():
        return db.execute(select(LimsSubSampleEvent).where(
            LimsSubSampleEvent.lims_sample_pk == parent_id,
            LimsSubSampleEvent.event == "native_slot_relabeled")).scalars().all()

    def _flag():
        return db.execute(select(FlagFlag).where(
            FlagFlag.entity_type == "sample", FlagFlag.entity_id == str(parent_id),
            FlagFlag.type == UNRESOLVED_FLAG_TYPE)).scalars().one()

    # visible pre-commit within the still-open transaction
    assert len(_events()) == 1
    assert _flag().status == "resolved"

    db.rollback()
    assert _events() == []              # event never committed -> gone
    assert _flag().status == "open"     # resolution never committed -> reverted


def test_commit_false_seed_never_auto_emits_and_rollback_clears_pending(db):
    """Fix round 2: a commit=False caller that never commits emits nothing —
    and if it rolls back instead, the after_rollback listener
    (flags/service.py) clears the staged event so a later, unrelated
    emit_pending_events call in the same session can't re-emit it."""
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9012", slot2_name="Mystery-Peptide")
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="PB-9012-S01",
                         external_lims_uid="uid-PB-9012-S01", vial_sequence=1)
    db.add(vial); db.flush()
    seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                          existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert db.info.get("flag_pending_events")  # staged, never auto-emitted

    from flags import service as flags_service
    db.rollback()
    assert flags_service.emit_pending_events(db) == 0
    assert "flag_pending_events" not in db.info


def test_set_assignment_role_emits_the_unresolved_flag_event_after_its_commit(monkeypatch):
    """Fix round 2 / coordinator finding: set_assignment_role seeds with
    commit=False (sub_samples/service.py's atomic "seed then one commit"
    unit, ~2367-2387) so the flag write must not commit — or emit — early.
    After the function's single db.commit(), it now calls
    flags_service.emit_pending_events(db) itself; this proves the sink sees
    the "raised" event exactly once. Live dev Postgres (ZZTEST- prefix,
    matching tests/test_assignment_kind.py's convention), explicit cleanup."""
    from sqlalchemy import text

    import sub_samples.service as sub_service
    from database import SessionLocal
    from flags import seams as flag_seams
    from flags.types_service import seed_builtins as seed_flag_types

    class _Sink:
        def __init__(self):
            self.events = []

        def emit(self, event):
            self.events.append(event)

    db = SessionLocal()
    try:
        seed_flag_types(db)
        flag_seams.register_mk1_entities()
        bpc = Peptide(name="ZZTEST-BPC-FR2", abbreviation="ZZBPCFR2", active=True)
        db.add(bpc); db.flush()
        analytes = [
            {"name": "ZZTEST-BPC-FR2", "declared_quantity": None, "peptide_id": bpc.id},
            {"name": "ZZTEST-Mystery-FR2", "declared_quantity": None, "peptide_id": None},
        ]
        parent = LimsSample(sample_id="ZZTEST-FR2-001", external_lims_system="mk1",
                            sample_type_title="Peptide Blend", analytes=json.dumps(analytes))
        db.add(parent); db.flush()
        db.add(LimsSubSample(parent_sample_pk=parent.id, sample_id="ZZTEST-FR2-001-S01",
                             external_lims_uid="zz-fr2-001-s01", vial_sequence=1))
        db.commit()

        sink = _Sink()
        monkeypatch.setattr(flag_seams, "EVENT_SINK", sink)
        sub_service.set_assignment_role(db, "ZZTEST-FR2-001-S01", "hplc", user_id=1, wp_services={"hplcpurity_identity": True})

        raised = [e for e in sink.events
                 if e["event_type"] == "raised" and e["details"].get("type") == UNRESOLVED_FLAG_TYPE]
        assert len(raised) == 1
    finally:
        db.rollback()
        db.execute(text("DELETE FROM flag_events WHERE flag_id IN "
                        "(SELECT id FROM flag_flags WHERE entity_id IN "
                        "(SELECT id::text FROM lims_samples WHERE sample_id LIKE 'ZZTEST-FR2-%'))"))
        db.execute(text("DELETE FROM flag_flags WHERE entity_id IN "
                        "(SELECT id::text FROM lims_samples WHERE sample_id LIKE 'ZZTEST-FR2-%')"))
        db.execute(text("DELETE FROM lims_analyses WHERE lims_sub_sample_pk IN "
                        "(SELECT id FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-FR2-%')"))
        db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-FR2-%'"))
        db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-FR2-%'"))
        db.execute(text("DELETE FROM peptides WHERE name LIKE 'ZZTEST-%'"))
        db.commit()
        db.close()


def test_relabel_commit_true_emits_the_resolved_event_once(monkeypatch):
    """relabel_native_slot(commit=True) resolves the flag inside its own
    commit (round 1) and now emits the "resolved" event right after that
    commit (round 2). Live dev Postgres, ZZTEST- prefix, explicit cleanup."""
    from sqlalchemy import text

    from database import SessionLocal
    from flags import seams as flag_seams
    from flags.types_service import seed_builtins as seed_flag_types

    class _Sink:
        def __init__(self):
            self.events = []

        def emit(self, event):
            self.events.append(event)

    db = SessionLocal()
    try:
        seed_flag_types(db)
        flag_seams.register_mk1_entities()
        bpc = Peptide(name="ZZTEST-BPC-FR2B", abbreviation="ZZBPCFR2B", active=True)
        db.add(bpc); db.flush()
        analytes = [{"name": "ZZTEST-Mystery-FR2B", "declared_quantity": None, "peptide_id": None}]
        parent = LimsSample(sample_id="ZZTEST-FR2B-001", external_lims_system="mk1",
                            sample_type_title="Peptide", analytes=json.dumps(analytes))
        db.add(parent); db.flush()
        vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="ZZTEST-FR2B-001-S01",
                             external_lims_uid="zz-fr2b-001-s01", vial_sequence=1)
        db.add(vial); db.flush()
        seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                              existing_service_ids=set(), created_by_user_id=None, commit=True)
        db.commit()
        assert len(_open_flags(db, parent)) == 1

        sink = _Sink()
        monkeypatch.setattr(flag_seams, "EVENT_SINK", sink)
        relabel_native_slot(db, parent=parent, slot=1, new_peptide_id=bpc.id, user_id=1, commit=True)

        resolved = [e for e in sink.events
                   if e["event_type"] == "status_changed" and e["to_value"] == "resolved"]
        assert len(resolved) == 1
    finally:
        db.rollback()
        db.execute(text("DELETE FROM flag_events WHERE flag_id IN "
                        "(SELECT id FROM flag_flags WHERE entity_id IN "
                        "(SELECT id::text FROM lims_samples WHERE sample_id LIKE 'ZZTEST-FR2B-%'))"))
        db.execute(text("DELETE FROM flag_flags WHERE entity_id IN "
                        "(SELECT id::text FROM lims_samples WHERE sample_id LIKE 'ZZTEST-FR2B-%')"))
        db.execute(text("DELETE FROM lims_analyses WHERE lims_sub_sample_pk IN "
                        "(SELECT id FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-FR2B-%')"))
        db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-FR2B-%'"))
        db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-FR2B-%'"))
        db.execute(text("DELETE FROM peptides WHERE name LIKE 'ZZTEST-%'"))
        db.commit()
        db.close()

def test_bare_commit_after_commit_false_seed_emits_once_via_listener(db, monkeypatch):
    """Fix round 3: a commit=False caller whose OUTER code does a bare db.commit()
    (placeholder seed under seed_parent_from_services, main.py) still reaches the
    sink exactly once, via the session-wide after_commit listener; no per-caller
    emit_pending_events wiring needed."""
    from flags import seams
    received = []

    class _Sink:
        def emit(self, e):
            received.append(e)

    monkeypatch.setattr(seams, "EVENT_SINK", _Sink())
    _setup(db)
    parent, _bpc = _blend_parent(db, "PB-9013", slot2_name="Mystery-Peptide")
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="PB-9013-S01",
                         external_lims_uid="uid-PB-9013-S01", vial_sequence=1)
    db.add(vial); db.flush()
    seed_native_hplc_rows(db, sub_sample=vial, parent=parent, existing_keys=set(),
                          existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert received == []
    db.commit()
    assert len(received) == 1 and received[0]["event_type"] == "raised"
    assert received[0]["event_id"] is not None
    assert "flag_pending_events" not in db.info
    db.commit()
    assert len(received) == 1
