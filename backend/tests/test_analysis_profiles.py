"""Analysis Profile: the sellable test. Many-to-many over services."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_profile_persists_with_defaults(db_session):
    from models import AnalysisProfile
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    assert p.id is not None
    assert p.vials_required == 0
    assert p.fulfillment_dim == "role"
    assert p.active is True


def test_profile_key_is_unique(db_session):
    from models import AnalysisProfile
    db_session.add(AnalysisProfile(key="heavy_metals", name="A", is_addon=True))
    db_session.commit()
    db_session.add(AnalysisProfile(key="heavy_metals", name="B", is_addon=True))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_a_service_can_belong_to_several_profiles(db_session):
    """pH is sold a la carte AND is a member of a panel."""
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
    ph = AnalysisService(title="pH", keyword="PH-DETERM", origin="mk1")
    db_session.add(ph)
    db_session.commit()
    solo = AnalysisProfile(key="ph_testing", name="pH Testing", is_addon=True)
    panel = AnalysisProfile(key="bac_water_panel", name="Bac Water", is_addon=False)
    db_session.add_all([solo, panel])
    db_session.commit()
    for pid in (solo.id, panel.id):
        db_session.execute(analysis_profile_members.insert().values(
            analysis_profile_id=pid, analysis_service_id=ph.id, sort_order=0))
    db_session.commit()

    db_session.refresh(solo); db_session.refresh(panel)
    assert [s.keyword for s in solo.analysis_services] == ["PH-DETERM"]
    assert [s.keyword for s in panel.analysis_services] == ["PH-DETERM"]


def test_members_are_ordered_by_sort_order_not_insertion(db_session):
    """sort_order IS the future COA section row order — the relationship must
    read it back, not fall through to incidental DB/insertion order."""
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
    svc_a = AnalysisService(title="A", keyword="SVC-A", origin="mk1")
    svc_b = AnalysisService(title="B", keyword="SVC-B", origin="mk1")
    prof = AnalysisProfile(key="ordered_panel", name="Ordered Panel", is_addon=False)
    db_session.add_all([svc_a, svc_b, prof])
    db_session.commit()
    # Insert A first (lower rowid / insertion order) but give it the HIGHER
    # sort_order, so an insertion-order read and a sort_order read disagree.
    db_session.execute(analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc_a.id, sort_order=1))
    db_session.execute(analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc_b.id, sort_order=0))
    db_session.commit()
    db_session.refresh(prof)
    assert [s.id for s in prof.analysis_services] == [svc_b.id, svc_a.id]


def test_membership_is_unique_per_pair(db_session):
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
    svc = AnalysisService(title="pH", keyword="PH-DETERM", origin="mk1")
    prof = AnalysisProfile(key="ph_testing", name="pH Testing", is_addon=True)
    db_session.add_all([svc, prof])
    db_session.commit()
    ins = analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=0)
    db_session.execute(ins)
    db_session.commit()
    # A Core insert() executes against the connection immediately (unlike
    # session.add(), which defers to flush/commit) — SQLite raises the
    # UNIQUE-constraint IntegrityError right here, not at db_session.commit().
    with pytest.raises(IntegrityError):
        db_session.execute(ins)
    db_session.rollback()
