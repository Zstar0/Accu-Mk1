"""S6b: on-demand per-substance PUR_/QTY_ reconciler — report shape,
idempotence, and the admin route wiring.

The reconciler's SQL is Postgres-only (NOW(), substring(... from ...),
left()); the functional tests below run against the live accumark_mk1
Postgres catalog via SessionLocal and skip cleanly on any other dialect
(e.g. a contributor's sqlite-only environment).
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from database import SessionLocal
import main
from auth import require_admin


def _skip_unless_postgres(db):
    if db.bind.dialect.name != "postgresql":
        pytest.skip("per-substance reconciler SQL is Postgres-only")


def test_report_has_expected_keys_and_int_counts():
    db = SessionLocal()
    _skip_unless_postgres(db)
    try:
        from catalog.per_substance_reconciler import reconcile_per_substance_services
        report = reconcile_per_substance_services(db)
        db.commit()
    finally:
        db.close()

    assert set(report.keys()) == {
        "id_links", "pur_minted", "qty_minted", "group_memberships", "missing",
    }
    for key in ("id_links", "pur_minted", "qty_minted", "group_memberships"):
        assert isinstance(report[key], int)
    assert isinstance(report["missing"], list)


def test_second_run_is_a_no_op():
    """Every statement is idempotent (NOT EXISTS / ON CONFLICT DO NOTHING
    guards) — a second consecutive call must mint/link/group nothing new
    and find no service still missing its twin."""
    db = SessionLocal()
    _skip_unless_postgres(db)
    try:
        from catalog.per_substance_reconciler import reconcile_per_substance_services
        reconcile_per_substance_services(db)   # first run: heal any live drift
        db.commit()
        report = reconcile_per_substance_services(db)   # second run: must be a no-op
        db.commit()
    finally:
        db.close()

    assert report == {
        "id_links": 0,
        "pur_minted": 0,
        "qty_minted": 0,
        "group_memberships": 0,
        "missing": [],
    }


def test_reconciler_mints_pur_qty_for_a_synthetic_identity_service():
    """Real, non-zero counts: every other test in this file has only ever
    observed an already-reconciled dev catalog (all zeros), which would
    pass identically even if the mint statements were deleted. This seeds
    a synthetic peptide + ID_ service inside a SAVEPOINT (house pattern:
    test_workflow_engine.py's sbs-boot-statements test at
    tests/test_workflow_engine.py:446-452 — conn.begin_nested() / rollback),
    runs the reconciler, asserts the counters that must fire actually do,
    then rolls back so nothing leaks into the dev catalog."""
    db = SessionLocal()
    _skip_unless_postgres(db)
    try:
        from catalog.per_substance_reconciler import reconcile_per_substance_services
        from models import Peptide, AnalysisService

        nested = db.begin_nested()
        try:
            peptide = Peptide(name="ZZ Synthetic Test Peptide", abbreviation="ZZSYNTH")
            db.add(peptide)
            db.flush()
            id_svc = AnalysisService(
                title="ZZ Synthetic - Identity (HPLC)",
                keyword="ID_ZZSYNTH",
                peptide_id=peptide.id,
                peptide_name=peptide.name,
            )
            db.add(id_svc)
            db.flush()

            report = reconcile_per_substance_services(db)

            assert report["pur_minted"] == 1
            assert report["qty_minted"] == 1
            # This ID_ row was seeded already linked (peptide_id set at
            # creation), so the link statement has nothing to do for it.
            assert report["id_links"] == 0
            # Dev catalog carries a service_groups row named 'Analytics'
            # (verified live) — both freshly minted rows land in it.
            assert report["group_memberships"] == 2
            assert report["missing"] == []

            minted = set(db.execute(text(
                "SELECT keyword FROM analysis_services "
                "WHERE keyword IN ('PUR_ZZSYNTH', 'QTY_ZZSYNTH')"
            )).scalars().all())
            assert minted == {"PUR_ZZSYNTH", "QTY_ZZSYNTH"}
        finally:
            nested.rollback()

        # Confirm the rollback actually left the dev catalog clean — this
        # test must not be the thing that leaks synthetic rows into it.
        leaked = db.execute(text(
            "SELECT count(*) FROM analysis_services WHERE keyword IN "
            "('ID_ZZSYNTH', 'PUR_ZZSYNTH', 'QTY_ZZSYNTH')"
        )).scalar_one()
        assert leaked == 0
    finally:
        db.rollback()
        db.close()


# ── admin route ──────────────────────────────────────────────────────────
#
# Two complementary tests: one mocks the reconciler out (house pattern, see
# test_registry_debug_endpoint.py's senaite patching) to pin the route's own
# wiring — status code, pass-through of the report, admin gate — without a
# live-DB dependency; the other makes no such substitution and runs the real
# reconciler through the real route, proving the P-1500 heal path actually
# works end to end, not just that the plumbing calls *something*.

@pytest.fixture
def client(monkeypatch):
    main.app.dependency_overrides[require_admin] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    yield c
    main.app.dependency_overrides.clear()


def test_admin_route_returns_the_report(client, monkeypatch):
    canned = {
        "id_links": 1, "pur_minted": 2, "qty_minted": 2,
        "group_memberships": 4, "missing": [],
    }
    calls = []

    def _fake(db):
        calls.append(db)
        return canned

    monkeypatch.setattr(
        "catalog.per_substance_reconciler.reconcile_per_substance_services", _fake
    )

    r = client.post("/catalog/reconcile-per-substance")

    assert r.status_code == 200
    assert r.json() == canned
    assert len(calls) == 1


def test_admin_route_requires_admin():
    # No override → real require_admin → unauthenticated request rejected.
    c = TestClient(main.app)
    r = c.post("/catalog/reconcile-per-substance")
    assert r.status_code in (401, 403)


def test_admin_route_runs_the_real_reconciler_end_to_end(client):
    """Complements the mocked wiring test above: no `get_db` override here,
    so this exercises the actual P-1500 heal path for real — POST hits the
    route, the real reconciler runs against live Postgres on the request's
    own session, and db.commit() lands. Idempotent against an
    already-reconciled catalog (same live-DB posture as the rest of this
    file), so no synthetic seed/rollback needed here."""
    db = SessionLocal()
    _skip_unless_postgres(db)
    db.close()

    r = client.post("/catalog/reconcile-per-substance")

    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {
        "id_links", "pur_minted", "qty_minted", "group_memberships", "missing",
    }
