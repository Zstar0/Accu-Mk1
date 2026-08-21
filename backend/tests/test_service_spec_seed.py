"""Parity seed of the five native specs + the audited write path.

Values are frozen at the 2026-08-03 BAKED_SPECS state; STERILITY_USP71's
spec unit is NULL on purpose (BAKED_SPECS carries no unit key for it — a
non-NULL unit would newly arm the divergence warning against Pos/Neg)."""
from decimal import Decimal

from catalog.service_spec_seed import seed_service_specs
from models import AnalysisService, AnalysisServiceSpec  # register tables on Base before conftest's create_all


def _mk_native_services(db, keywords=("HM-PB", "HM-AS", "HM-CD", "HM-HG",
                                      "STERILITY_USP71")):
    from models import AnalysisService
    out = {}
    for kw in keywords:
        svc = AnalysisService(title=kw, keyword=kw, origin="mk1")
        db.add(svc)
        db.flush()
        out[kw] = svc
    return out


def test_seed_creates_five_parity_rows(db_session):
    from models import AnalysisServiceSpec
    svcs = _mk_native_services(db_session)
    assert seed_service_specs(db_session) == 5
    rows = {r.analysis_service_id: r
            for r in db_session.query(AnalysisServiceSpec).all()}
    pb = rows[svcs["HM-PB"].id]
    assert (pb.rule_kind, pb.max_value, pb.min_value, pb.unit, pb.matrix,
            pb.display_override) == ("range", Decimal("0.5"), None, "ppm",
                                     None, None)
    assert rows[svcs["HM-AS"].id].max_value == Decimal("1.5")
    assert rows[svcs["HM-CD"].id].max_value == Decimal("0.5")
    assert rows[svcs["HM-HG"].id].max_value == Decimal("1.5")
    ster = rows[svcs["STERILITY_USP71"].id]
    assert (ster.rule_kind, ster.equals_value, ster.unit,
            ster.min_value, ster.max_value) == ("equals", "Not Detected",
                                                None, None, None)


def test_seed_is_idempotent(db_session):
    from models import AnalysisServiceSpec
    _mk_native_services(db_session)
    seed_service_specs(db_session)
    assert seed_service_specs(db_session) == 0
    assert db_session.query(AnalysisServiceSpec).count() == 5


def test_seed_skips_missing_services_silently(db_session):
    # Fresh DB without the native services: seed is a quiet no-op.
    assert seed_service_specs(db_session) == 0


def test_seed_leaves_edited_rows_alone(db_session):
    from models import AnalysisServiceSpec
    svcs = _mk_native_services(db_session, keywords=("HM-PB",))
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs["HM-PB"].id, matrix=None,
        rule_kind="range", max_value=Decimal("9.9"), unit="ppm"))
    db_session.flush()
    seed_service_specs(db_session)
    row = db_session.query(AnalysisServiceSpec).one()
    assert row.max_value == Decimal("9.9")   # the lab's edit survives


def test_seed_does_not_resurrect_deactivated_rows(db_session):
    from models import AnalysisServiceSpec
    svcs = _mk_native_services(db_session, keywords=("HM-PB",))
    seed_service_specs(db_session)
    row = db_session.query(AnalysisServiceSpec).one()
    row.active = False
    db_session.commit()
    assert seed_service_specs(db_session) == 0
    rows = db_session.query(AnalysisServiceSpec).all()
    assert len(rows) == 1 and rows[0].active is False   # the lab's deactivation survives boots


def test_seed_skips_peptide_tier_row_and_still_seeds_wildcard(db_session):
    """A peptide-tier spec row on a seeded keyword's service must not be
    mistaken for the wildcard slot: the seeder's existing-row lookup has to
    filter on peptide_id IS NULL too, or (a) a second boot with more than
    one seeded keyword raises MultipleResultsFound on .one_or_none() (the
    peptide row plus a real match), silently killing the whole seed via
    database.py's broad catch, and (b) a lone peptide row makes the seeder
    believe the wildcard slot is already taken and skip it forever."""
    from models import AnalysisServiceSpec
    svcs = _mk_native_services(db_session, keywords=("HM-PB", "HM-AS"))
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs["HM-PB"].id, matrix=None, peptide_id=1,
        rule_kind="range", max_value=Decimal("9.9"), unit="ppm"))
    db_session.flush()

    # First boot: must not raise, and must still create both wildcard rows.
    assert seed_service_specs(db_session) == 2
    wildcards = (db_session.query(AnalysisServiceSpec)
                 .filter(AnalysisServiceSpec.matrix.is_(None),
                         AnalysisServiceSpec.peptide_id.is_(None))
                 .all())
    assert len(wildcards) == 2

    # Second boot: idempotent, no raise, no duplicate wildcard row.
    assert seed_service_specs(db_session) == 0
    wildcards_again = (db_session.query(AnalysisServiceSpec)
                       .filter(AnalysisServiceSpec.matrix.is_(None),
                               AnalysisServiceSpec.peptide_id.is_(None))
                       .all())
    assert len(wildcards_again) == 2


def test_seed_writes_audit_rows(db_session):
    from models import AuditLog
    _mk_native_services(db_session)
    seed_service_specs(db_session)
    logs = (db_session.query(AuditLog)
            .filter(AuditLog.operation == "analysis_service_spec_changed")
            .all())
    assert len(logs) == 5
    entry = logs[0]
    assert entry.entity_type == "analysis_service_spec"
    assert entry.details["before"] is None
    assert entry.details["actor_user_id"] is None
    assert entry.details["after"]["rule_kind"] in ("range", "equals")
