"""Admin registry-overlay read endpoint: gate, overlay-vs-fallback, analytes-shape guard."""
import json
from datetime import datetime
from unittest.mock import AsyncMock, patch
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
from models import LimsSample
import main
from auth import require_admin, get_current_user
from sub_samples.registry_read import OVERLAY_FIELDS


@pytest.fixture
def client():
    # StaticPool + check_same_thread=False (per test_registry_debug_endpoint.py
    # convention): TestClient dispatches the ASGI app on a different thread than
    # this fixture, so tables created here would be invisible to the request
    # ("no such table") without a pool shared across threads.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[require_admin] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def _seed(client, **kw):
    db = client._Session()
    row = LimsSample(sample_id="P-1", external_lims_uid="AR_UID",
                      last_synced_at=datetime(2026, 1, 1), **kw)
    db.add(row)
    db.commit()
    db.close()


def _senaite_result(**overrides):
    """A SenaiteLookupResult with known values, standing in for a live SENAITE
    lookup. analytes/analyses use their real typed shapes (SenaiteAnalyte has
    required raw_name/slot_number; SenaiteAnalysis has required title) so the
    mock itself validates the same way lookup_senaite_sample's real return
    would."""
    defaults = dict(
        sample_id="P-1",
        sample_uid="SEN-UID",
        client="SenaiteCo",
        contact="Senaite Contact",
        sample_type="Peptide",
        date_received="2026-01-01T00:00:00",
        date_sampled="2026-01-02T00:00:00",
        client_order_number="WP-100",
        client_sample_id="CS-SEN",
        client_lot="L-SEN",
        review_state="sample_received",
        declared_weight_mg=5.0,
        analytes=[main.SenaiteAnalyte(raw_name="BPC-157", slot_number=1)],
        analyses=[main.SenaiteAnalysis(title="Purity"), main.SenaiteAnalysis(title="Identity")],
    )
    defaults.update(overrides)
    return main.SenaiteLookupResult(**defaults)


def _mock_lookup(result):
    return patch.object(main, "lookup_senaite_sample", AsyncMock(return_value=result))


def test_overlay_applies_registry_over_senaite(client):
    _seed(client, client_title="RegistryCo")
    with _mock_lookup(_senaite_result(client="SenaiteCo")):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["client"] == "RegistryCo"
    assert body["field_sources"]["client"] == "mk1"


def test_sample_uid_never_overlaid(client):
    # sample_uid keys real SENAITE writes (inline field edits, sub-sample
    # wizard parent uid). It must always come from the fresh SENAITE lookup,
    # even in mk1 read mode — overlaying a drifted registry uid could
    # misdirect a write to the wrong AR. The seeded row's external_lims_uid
    # ("AR_UID") deliberately differs from the mocked SENAITE uid
    # ("SEN-UID") so a regression here would fail loudly.
    _seed(client, client_title="RegistryCo")
    with _mock_lookup(_senaite_result(sample_uid="SEN-UID")):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["sample_uid"] == "SEN-UID"
    # sample_uid is no longer an overlay field, so it has no entry in
    # field_sources at all (it's implicitly always SENAITE-sourced).
    assert "sample_uid" not in body["field_sources"]


def test_fallback_keeps_senaite_where_registry_null(client):
    _seed(client, client_title="RegistryCo")  # client_lot deliberately left None
    with _mock_lookup(_senaite_result(client_lot="L-SEN")):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["client_lot"] == "L-SEN"
    assert body["field_sources"]["client_lot"] == "senaite"


def test_analyses_never_overlaid(client):
    _seed(client, client_title="RegistryCo")
    with _mock_lookup(_senaite_result()):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert len(body["analyses"]) == 2
    assert [a["title"] for a in body["analyses"]] == ["Purity", "Identity"]


def test_missing_row_returns_senaite_and_flag(client):
    # No LimsSample seeded for this id.
    with _mock_lookup(_senaite_result()):
        r = client.get("/registry/sample/NOPE/details")
    assert r.status_code == 200
    body = r.json()
    assert body["registry_missing"] is True
    assert set(body["field_sources"].values()) == {"senaite"}
    assert body["client"] == "SenaiteCo"
    assert body["client_lot"] == "L-SEN"


def test_field_sources_covers_overlay_fields(client):
    _seed(client, client_title="RegistryCo")
    with _mock_lookup(_senaite_result()):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert set(body["field_sources"].keys()) == set(OVERLAY_FIELDS)


def test_non_admin_rejected():
    # No override -> real require_admin -> unauthenticated request rejected.
    from database import Base as B
    eng = create_engine("sqlite:///:memory:")
    B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get("/registry/sample/P-1/details")
    assert r.status_code in (401, 403)


def test_analytes_shape_mismatch_guarded(client):
    # Registry `analytes` (Task 1's registry_row_to_display) is a list of
    # {"name", "declared_quantity"} dicts -- NOT the SenaiteAnalyte
    # {"raw_name", "slot_number", ...} shape the response_model requires for
    # the `analytes` field. If the overlay loop blindly overwrote
    # payload["analytes"] with the registry shape, reconstructing
    # RegistrySampleReadResult would raise a Pydantic ValidationError (500)
    # on every sample with registry-populated analytes. SENAITE's typed
    # analytes must survive untouched, and field_sources must honestly say
    # "senaite" for that field since that's what's actually shown.
    _seed(client, client_title="RegistryCo",
          analytes=json.dumps([{"name": "KPV", "declared_quantity": "2.00"}]))
    with _mock_lookup(_senaite_result()):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["analytes"] == [{
        "raw_name": "BPC-157", "slot_number": 1,
        "matched_peptide_id": None, "matched_peptide_name": None,
        "declared_quantity": None,
    }]
    assert body["field_sources"]["analytes"] == "senaite"
