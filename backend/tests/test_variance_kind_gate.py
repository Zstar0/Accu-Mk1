"""variance_verify gates on assignment_kind='variance', not commercial entitlement."""
from datetime import datetime
import pytest
from sqlalchemy import text
from database import SessionLocal
from lims_analyses import service
from lims_analyses.service import BadRequestError
from models import LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _mk_vial(db, parent, seq, kind):
    v = LimsSubSample(
        sample_id=f"ZZTEST-VK-S0{seq}",
        parent_sample_pk=parent.id,
        vial_sequence=seq,
        received_at=datetime.utcnow(),
        assignment_role="hplc",
        external_lims_uid=f"zz-vk-s0{seq}",
        assignment_kind=kind,
    )
    db.add(v)
    db.flush()
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    row = LimsAnalysis(
        lims_sub_sample_pk=v.id,
        analysis_service_id=svc_id,
        keyword=f"ZZTEST-VK-{seq}",
        title="ZZ",
        result_value="99",
        review_state="to_be_verified",
    )
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def fixture(db):
    p = LimsSample(sample_id="ZZTEST-VK", peptide_name="ZZ", status="received")
    db.add(p)
    db.flush()
    var_row = _mk_vial(db, p, 1, "variance")
    core_row = _mk_vial(db, p, 2, "core")
    db.commit()
    yield {"var": var_row.id, "core": core_row.id}
    db.rollback()
    db.execute(text("DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-VK%'"))
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-VK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VK%'"))
    db.commit()


def test_variance_verify_allowed_on_variance_kind(db, fixture):
    row = service.apply_transition(db, analysis_id=fixture["var"], kind="variance_verify")
    assert row.review_state == "variance_verified"


def test_variance_verify_rejected_on_core_kind(db, fixture):
    with pytest.raises(BadRequestError):
        service.apply_transition(db, analysis_id=fixture["core"], kind="variance_verify")


def test_variance_verify_rejected_on_null_kind(db, fixture):
    """NULL assignment_kind (no bucket assigned) is also rejected — same guard."""
    # Re-use the core vial but set its kind to NULL directly.
    db2 = SessionLocal()
    try:
        db2.execute(
            text("UPDATE lims_sub_samples SET assignment_kind = NULL WHERE sample_id = 'ZZTEST-VK-S02'")
        )
        db2.commit()
    finally:
        db2.close()
    with pytest.raises(BadRequestError):
        service.apply_transition(db, analysis_id=fixture["core"], kind="variance_verify")


def test_promote_rejected_on_variance_kind(db, fixture):
    """promote_to_parent must reject a source vial whose assignment_kind='variance'."""
    # The variance vial's analysis row is in 'to_be_verified' state — required for promote.
    # promote_to_parent needs at least one source with contribution_kind='chosen'.
    var_analysis_id = fixture["var"]
    with pytest.raises(BadRequestError, match="variance bucket"):
        service.promote_to_parent(
            db,
            keyword="ZZTEST-VK-1",
            result_value="99",
            result_unit=None,
            method_id=None,
            instrument_id=None,
            sources=[{"analysis_id": var_analysis_id, "contribution_kind": "chosen"}],
        )
