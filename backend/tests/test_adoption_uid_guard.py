import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Base, LimsSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_quarantine_columns_default_clean(db):
    db.add(LimsSample(sample_id="ZZQ-1"))
    db.commit()
    row = db.query(LimsSample).filter_by(sample_id="ZZQ-1").one()
    assert row.quarantined is False
    assert row.quarantine_reason is None


def test_identity_collision_flag_type_seeded(db):
    from flags import types_service
    types_service.seed_builtins(db)
    assert types_service.kind_for_type(db, "identity_collision") == "issue"


from unittest.mock import patch

from sub_samples.service import upsert_sample_from_signal, QUARANTINE_SEP


def _seeded_flags(db):
    from flags import seams, types_service
    types_service.seed_builtins(db)
    # create_flag's entity_type="sample" gate needs the Mk1 entity registered
    # (flags/seams.py register_mk1_entities, called at app startup in
    # main.py:348) — a real request path always has it; this SQLite-session
    # test never boots main.py, so it must register explicitly, same as every
    # other flags/tests/test_flags_*.py fixture.
    seams.register_mk1_entities()


def test_signal_matching_uid_refreshes_normally(db):
    db.add(LimsSample(sample_id="P-0200", external_lims_uid="UID-A"))
    db.commit()
    row = upsert_sample_from_signal(db, "P-0200", "UID-A", {"ClientID": "C1"})
    assert row.sample_id == "P-0200"
    assert row.external_lims_uid == "UID-A"
    assert row.quarantined is False
    assert db.query(LimsSample).count() == 1


def test_signal_null_stored_uid_attaches(db):
    db.add(LimsSample(sample_id="P-0201", external_lims_uid=None))
    db.commit()
    row = upsert_sample_from_signal(db, "P-0201", "UID-B", {})
    assert row.external_lims_uid == "UID-B"
    assert row.quarantined is False
    assert db.query(LimsSample).count() == 1


def test_signal_uid_mismatch_quarantines(db, caplog):
    _seeded_flags(db)
    db.add(LimsSample(sample_id="P-0202", external_lims_uid="UID-OLD",
                      client_id="KEEP-ME"))
    db.commit()
    with caplog.at_level("ERROR"):
        row = upsert_sample_from_signal(
            db, "P-0202", "UID-NEW-12345678", {"ClientID": "OTHER"})
    # incoming order parked on a NEW deterministic quarantine row
    assert row.sample_id == f"P-0202{QUARANTINE_SEP}UID-NEW-1234"
    assert row.quarantined is True
    assert "UID-OLD" in row.quarantine_reason
    assert row.native_id is None  # never mint native ids for quarantine rows
    # original row untouched
    orig = db.query(LimsSample).filter_by(sample_id="P-0202").one()
    assert orig.external_lims_uid == "UID-OLD"
    assert orig.client_id == "KEEP-ME"
    assert orig.quarantined is False
    # loud log + flag on the ORIGINAL sample
    assert "identity_collision" in caplog.text
    from flags.models import FlagFlag
    flags = db.query(FlagFlag).filter_by(
        entity_type="sample", type="identity_collision", status="open").all()
    assert len(flags) == 1
    assert flags[0].entity_id == str(orig.id)


def test_signal_uid_mismatch_replay_idempotent(db):
    _seeded_flags(db)
    db.add(LimsSample(sample_id="P-0203", external_lims_uid="UID-OLD"))
    db.commit()
    r1 = upsert_sample_from_signal(db, "P-0203", "UID-NEW-12345678", {})
    r2 = upsert_sample_from_signal(db, "P-0203", "UID-NEW-12345678", {})
    assert r1.id == r2.id
    assert db.query(LimsSample).filter(
        LimsSample.quarantined.is_(True)).count() == 1
    from flags.models import FlagFlag
    assert db.query(FlagFlag).filter_by(type="identity_collision").count() == 1


def test_refresh_uid_mismatch_refuses_fail_closed(db, caplog):
    _seeded_flags(db)
    from sub_samples.service import _refresh_parent_from_senaite
    row = LimsSample(sample_id="P-0204", external_lims_uid="UID-OLD",
                     client_id="KEEP-ME")
    db.add(row)
    db.commit()
    fake_meta = {"uid": "UID-DIFFERENT", "ClientID": "OTHER",
                 "review_state": "received"}
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=fake_meta):
        with caplog.at_level("ERROR"):
            _refresh_parent_from_senaite(db, row)
    assert row.external_lims_uid == "UID-OLD"   # refused, nothing written
    assert row.client_id == "KEEP-ME"
    assert "identity_collision_refresh" in caplog.text
    from flags.models import FlagFlag
    assert db.query(FlagFlag).filter_by(type="identity_collision").count() == 1


def test_refresh_uid_mismatch_no_duplicate_flag(db):
    _seeded_flags(db)
    from sub_samples.service import _refresh_parent_from_senaite
    row = LimsSample(sample_id="P-0205", external_lims_uid="UID-OLD")
    db.add(row)
    db.commit()
    fake_meta = {"uid": "UID-DIFFERENT", "review_state": "received"}
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=fake_meta):
        _refresh_parent_from_senaite(db, row)
        _refresh_parent_from_senaite(db, row)
    from flags.models import FlagFlag
    assert db.query(FlagFlag).filter_by(type="identity_collision").count() == 1


def test_refresh_null_stored_uid_populates(db):
    from sub_samples.service import _refresh_parent_from_senaite
    row = LimsSample(sample_id="P-0206", external_lims_uid=None)
    db.add(row)
    db.commit()
    fake_meta = {"uid": "UID-FRESH", "review_state": "received"}
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=fake_meta):
        _refresh_parent_from_senaite(db, row)
    assert row.external_lims_uid == "UID-FRESH"
