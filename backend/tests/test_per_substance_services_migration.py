"""The per-substance PUR_/QTY_ services exist for every identity peptide,
share the identity service's peptide_id, and are in the Analytics group.
Runs against the live accumark_mk1 catalog.

S6b: the derivation these tests exercise moved out of _run_migrations()
into catalog.per_substance_reconciler.reconcile_per_substance_services —
same statements, same assertions here, new call site."""
from sqlalchemy import select, text
from database import SessionLocal
from catalog.per_substance_reconciler import reconcile_per_substance_services


def _missing(db):
    # identity peptides lacking a PUR_ or QTY_ sibling (same peptide_id)
    return db.execute(text(
        """
        SELECT idsvc.keyword
        FROM analysis_services idsvc
        WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
          AND (NOT EXISTS (SELECT 1 FROM analysis_services p
                           WHERE p.peptide_id = idsvc.peptide_id AND left(p.keyword,4) = 'PUR_')
            OR NOT EXISTS (SELECT 1 FROM analysis_services q
                           WHERE q.peptide_id = idsvc.peptide_id AND left(q.keyword,4) = 'QTY_'))
        """
    )).scalars().all()


def test_migration_creates_per_substance_services_for_all_identity_peptides():
    db = SessionLocal()
    reconcile_per_substance_services(db)
    db.commit()
    try:
        assert _missing(db) == []
        rows = db.execute(text(
            "SELECT keyword, peptide_id, title FROM analysis_services "
            "WHERE keyword IN ('PUR_GHKCU','QTY_GHKCU') ORDER BY keyword"
        )).all()
        kws = {r[0] for r in rows}
        assert kws == {"PUR_GHKCU", "QTY_GHKCU"}
        assert all(r[1] == 26 for r in rows)
        titles = {r[0]: r[2] for r in rows}   # keyword -> title
        assert titles["PUR_GHKCU"] == "GHK-Cu - Purity"
        assert titles["QTY_GHKCU"] == "GHK-Cu - Quantity"
        grouped = db.execute(text(
            """
            SELECT s.keyword FROM analysis_services s
            JOIN service_group_members m ON m.analysis_service_id = s.id
            JOIN service_groups g ON g.id = m.service_group_id
            WHERE g.name = 'Analytics' AND s.keyword IN ('PUR_GHKCU','QTY_GHKCU')
            """
        )).scalars().all()
        assert set(grouped) == {"PUR_GHKCU", "QTY_GHKCU"}
    finally:
        db.close()


def test_migration_is_idempotent_no_duplicate_for_existing():
    db = SessionLocal()
    reconcile_per_substance_services(db)
    db.commit()
    try:
        n = db.execute(text(
            "SELECT count(*) FROM analysis_services WHERE keyword = 'PUR_BPC157'"
        )).scalar_one()
        assert n == 1
    finally:
        db.close()
