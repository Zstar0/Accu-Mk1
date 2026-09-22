"""Slice 8: the `legacy_hplc` COA archetype (main.py COA_ARCHETYPES), the
seeded shape (profile archetype + HPLC-IDENTITY as a select), and the
guarded one-shot upgrade that retrofits that shape onto rows minted by an
older build of seed_hplc_native_catalog. sqlite in-memory, mirroring
test_hplc_native_catalog_seed.py -- no shared-Postgres cleanup needed here.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import Base


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


IDENTITY_OPTIONS = [
    {"value": "Conforms", "label": "Conforms"},
    {"value": "Does Not Conform", "label": "Does Not Conform"},
]


# --- fresh seed carries the slice-8 shape directly ---------------------

def test_fresh_seed_profile_archetype_is_legacy_hplc(db_session):
    from catalog.hplc_native_seed import (
        HPLC_NATIVE_PROFILE_KEY,
        seed_hplc_native_catalog,
    )
    from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
    from models import AnalysisProfile
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    assert prof.coa_archetype == LEGACY_HPLC_ARCHETYPE == "legacy_hplc"


def test_fresh_seed_identity_service_is_a_select(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisService
    seed_hplc_native_catalog(db_session)
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-IDENTITY").one()
    assert svc.result_type == "select"
    assert svc.result_options == IDENTITY_OPTIONS


# --- guarded upgrade: profile archetype NULL -> legacy_hplc ------------

def test_upgrade_sets_null_archetype_to_legacy_hplc(db_session):
    from catalog.hplc_native_seed import (
        HPLC_NATIVE_PROFILE_KEY,
        seed_hplc_native_catalog,
        upgrade_hplc_native_catalog,
    )
    from models import AnalysisProfile, CatalogChangeLog
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    prof.coa_archetype = None  # simulate an older-build row
    db_session.commit()

    report = upgrade_hplc_native_catalog(db_session)
    assert report["profile"] == 1

    db_session.refresh(prof)
    assert prof.coa_archetype == "legacy_hplc"
    rows = (db_session.query(CatalogChangeLog)
            .filter_by(entity_type="profile", entity_pk=prof.id, action="update").all())
    assert len(rows) == 1
    assert rows[0].details["changed"]["coa_archetype"] == {"before": None, "after": "legacy_hplc"}


def test_upgrade_never_touches_a_non_null_archetype(db_session):
    from catalog.hplc_native_seed import (
        HPLC_NATIVE_PROFILE_KEY,
        seed_hplc_native_catalog,
        upgrade_hplc_native_catalog,
    )
    from models import AnalysisProfile
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    prof.coa_archetype = "limit_table"  # admin already flipped it
    db_session.commit()

    report = upgrade_hplc_native_catalog(db_session)
    assert report["profile"] == 0
    db_session.refresh(prof)
    assert prof.coa_archetype == "limit_table"


# --- guarded upgrade: HPLC-IDENTITY string -> select --------------------

def test_upgrade_converts_string_identity_service_to_select(db_session):
    from catalog.hplc_native_seed import (
        seed_hplc_native_catalog,
        upgrade_hplc_native_catalog,
    )
    from models import AnalysisService, CatalogChangeLog
    seed_hplc_native_catalog(db_session)
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-IDENTITY").one()
    svc.result_type = "string"  # simulate an older-build row
    svc.result_options = None
    db_session.commit()

    report = upgrade_hplc_native_catalog(db_session)
    assert report["service"] == 1

    db_session.refresh(svc)
    assert svc.result_type == "select"
    assert svc.result_options == IDENTITY_OPTIONS
    rows = (db_session.query(CatalogChangeLog)
            .filter_by(entity_type="service", entity_pk=svc.id, action="update").all())
    assert len(rows) == 1
    assert rows[0].details["changed"]["result_type"] == {"before": "string", "after": "select"}


def test_upgrade_never_touches_a_service_that_already_has_options(db_session):
    from catalog.hplc_native_seed import (
        seed_hplc_native_catalog,
        upgrade_hplc_native_catalog,
    )
    from models import AnalysisService
    seed_hplc_native_catalog(db_session)
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-IDENTITY").one()
    svc.result_type = "select"
    svc.result_options = [{"value": "Custom", "label": "Custom"}]  # admin edit
    db_session.commit()

    report = upgrade_hplc_native_catalog(db_session)
    assert report["service"] == 0
    db_session.refresh(svc)
    assert svc.result_options == [{"value": "Custom", "label": "Custom"}]


def test_upgrade_never_touches_a_non_string_result_type(db_session):
    """A service that isn't 'string' (e.g. already 'numeric' by some other
    edit) is out of scope for this guarded upgrade even with no options."""
    from catalog.hplc_native_seed import (
        seed_hplc_native_catalog,
        upgrade_hplc_native_catalog,
    )
    from models import AnalysisService
    seed_hplc_native_catalog(db_session)
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-IDENTITY").one()
    svc.result_type = "numeric"
    svc.result_options = None
    db_session.commit()

    report = upgrade_hplc_native_catalog(db_session)
    assert report["service"] == 0
    db_session.refresh(svc)
    assert svc.result_type == "numeric"


# --- second run is a no-op ----------------------------------------------

def test_upgrade_is_idempotent(db_session):
    from catalog.hplc_native_seed import (
        HPLC_NATIVE_PROFILE_KEY,
        seed_hplc_native_catalog,
        upgrade_hplc_native_catalog,
    )
    from models import AnalysisProfile, AnalysisService
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    prof.coa_archetype = None
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-IDENTITY").one()
    svc.result_type = "string"
    svc.result_options = None
    db_session.commit()

    first = upgrade_hplc_native_catalog(db_session)
    assert first == {"profile": 1, "service": 1}

    second = upgrade_hplc_native_catalog(db_session)
    assert second == {"profile": 0, "service": 0}


# --- route guard (PATCH /analysis-profiles/{id}) ------------------------

def test_coa_archetypes_accepts_legacy_hplc_and_rejects_bogus():
    from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
    from main import COA_ARCHETYPES
    assert COA_ARCHETYPES == {"limit_table", LEGACY_HPLC_ARCHETYPE}
    assert "bogus" not in COA_ARCHETYPES
