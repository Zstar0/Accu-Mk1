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
