"""Sample-details read endpoint (read-flip Layer 4 / Task 3): auth gate +
route-level field-sourcing checks for the native `mk1` builder.

Pre-flip (through commit 47341d3) this endpoint wrapped `lookup_senaite_
sample` and overlaid registry basic-info fields on top, falling back to the
live SENAITE value wherever the registry column was null (a per-field
'mk1'/'senaite' hybrid). That hybrid is GONE: the endpoint now delegates
unconditionally to `build_native_details` (sub_samples/registry_details.py)
via run_in_threadpool — zero SENAITE HTTP, no per-field fallback. Every test
below patches `lookup_senaite_sample` to RAISE, proving the route never
calls it (the zero-SENAITE contract, re-asserted at the route layer).

Deep field-by-field builder coverage (analytes adapter edge cases,
attachment storage routing, COA IS-DB fallbacks, download route) lives in
test_registry_details_builder.py; this file stays route-level (auth +
response shape) plus the specific field-sourcing facts that flipped, so the
before/after story stays documented where a future reader will actually
look. The canonical zero-SENAITE / registry_missing / response_model-intact
proof lives in test_registry_details_flip.py (new, this task)."""
import json
from unittest.mock import AsyncMock, patch
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
from models import AnalysisService, LimsAnalysis, LimsSample
import main
from auth import get_current_user


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
    # Endpoint is gated by get_current_user now (any authenticated user), not
    # role — most tests below don't care whether this is an admin or not.
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def _seed(client, **kw):
    db = client._Session()
    row = LimsSample(sample_id="P-1", external_lims_uid="AR_UID", **kw)
    db.add(row)
    db.commit()
    db.close()


def _seed_analysis(client, sample_id="P-1", keyword="ANALYTE-1-PUR", title="Purity"):
    db = client._Session()
    parent = db.query(LimsSample).filter_by(sample_id=sample_id).one()
    svc = AnalysisService(keyword=keyword, title=title)
    db.add(svc)
    db.flush()
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=keyword, title=title,
        review_state="verified", provenance="canonical", retested=False,
    ))
    db.commit()
    db.close()


def _mock_lookup_raises():
    """Patch lookup_senaite_sample to raise on any call — proves the mk1
    route never touches SENAITE (spec §9 invariant 2), re-asserted here at
    the route layer per the flip's behavior contract."""
    return patch.object(
        main, "lookup_senaite_sample",
        AsyncMock(side_effect=AssertionError("SENAITE HTTP attempted")))


def test_mk1_route_serves_native_client_field(client):
    # REWRITE of test_overlay_applies_registry_over_senaite.
    # OLD: registry client_title overlaid a mocked SENAITE client="SenaiteCo"
    #      -> body["client"] == "RegistryCo" (overlay wins).
    # NEW: there is no SENAITE value to overlay at all (lookup_senaite_sample
    #      raises if called) -> body["client"] == "RegistryCo" sourced
    #      natively, field_sources["client"] == "mk1".
    _seed(client, client_title="RegistryCo")
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["client"] == "RegistryCo"
    assert body["field_sources"]["client"] == "mk1"


def test_sample_uid_is_native_external_lims_uid(client):
    # REWRITE of test_sample_uid_never_overlaid.
    # OLD: sample_uid always came from the fresh SENAITE lookup (never
    #      overlaid — a drifted registry uid could misdirect a write to the
    #      wrong AR); field_sources had NO "sample_uid" entry (implicitly
    #      always-SENAITE).
    # NEW: there is no SENAITE lookup to source it from; the builder maps
    #      sample_uid straight from lims_samples.external_lims_uid, and
    #      (unlike the old overlay-only field_sources map, which covered
    #      only OVERLAY_FIELDS) it now gets an honest "mk1" entry like every
    #      other response field.
    _seed(client, client_title="RegistryCo")  # external_lims_uid="AR_UID" (seed default)
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["sample_uid"] == "AR_UID"
    assert body["field_sources"]["sample_uid"] == "mk1"


def test_null_registry_field_serves_none_no_senaite_fallback(client):
    # REWRITE of test_fallback_keeps_senaite_where_registry_null.
    # OLD: a null registry column (client_lot) fell back to the live
    #      SENAITE value ("L-SEN") and field_sources tagged it "senaite".
    # NEW: there is no per-field SENAITE fallback in mk1 mode at all — a
    #      null registry column serves None, and field_sources still says
    #      "mk1" (the source is the registry unconditionally, whether or
    #      not the column happened to have a value).
    _seed(client, client_title="RegistryCo")  # client_lot deliberately left None
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["client_lot"] is None
    assert body["field_sources"]["client_lot"] == "mk1"


def test_analyses_come_from_native_parent_tier_listing(client):
    # REWRITE of test_analyses_never_overlaid.
    # OLD: analyses always passed through verbatim from the mocked SENAITE
    #      lookup (2 fixed items) — proved the overlay loop never touched
    #      analyses (there was no registry-analyses concept at all then).
    # NEW: there is no SENAITE lookup; analyses come from lims_analyses via
    #      the Task-1 parent-tier senaite-shape listing
    #      (list_parent_analyses_senaite_shape). Seed one native analysis
    #      row and confirm it — not a SENAITE value — is what's served.
    _seed(client, client_title="RegistryCo")
    _seed_analysis(client)
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert [a["title"] for a in body["analyses"]] == ["Purity"]
    assert body["field_sources"]["analyses"] == "mk1"


def test_missing_row_returns_complete_empty_result_zero_senaite(client):
    # REWRITE of test_missing_row_returns_senaite_and_flag.
    # OLD: no lims_samples row meant the WHOLE payload fell back to a live
    #      SENAITE lookup (registry_missing=True, but client/client_lot/etc.
    #      all SENAITE-sourced; only remarks stayed native at []).
    # NEW: the builder never calls SENAITE regardless of row presence — a
    #      missing row returns a complete EMPTY result (registry_missing=
    #      True, every field None/[]/empty), not a SENAITE-sourced one.
    with _mock_lookup_raises():
        r = client.get("/registry/sample/NOPE/details")
    assert r.status_code == 200
    body = r.json()
    assert body["registry_missing"] is True
    assert body["client"] is None
    assert body["client_lot"] is None
    assert body["remarks"] == []
    assert body["analyses"] == []
    assert body["attachments"] == []
    assert body["analytes"] == []
    assert body["field_sources"]["remarks"] == "mk1"
    assert body["field_sources"]["client"] == "mk1"


def test_field_sources_covers_every_response_field(client):
    # REWRITE of test_field_sources_covers_overlay_fields.
    # OLD: field_sources covered only OVERLAY_FIELDS ∪ {"remarks"} — 11 of
    #      21 response fields (only the ones the overlay loop touched).
    # NEW: the builder tags EVERY SenaiteLookupResult field (a deliberately
    #      explicit literal, per registry_details._MK1_FIELD_SOURCES), so
    #      coverage is the full model field set, not a subset.
    from sub_samples.lookup_models import SenaiteLookupResult

    _seed(client, client_title="RegistryCo")
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert set(body["field_sources"].keys()) == set(SenaiteLookupResult.model_fields.keys())


def test_review_state_is_native_lims_samples_status(client):
    # REWRITE of test_review_state_is_never_overlaid.
    # OLD: review_state always came from the live SENAITE lookup
    #      ("published") and was deliberately ABSENT from field_sources —
    #      workflow state was SENAITE-owned and the registry's cached
    #      status could lag/shadow it.
    # NEW: the slice-3 state-mirror + healing work (2026-07-12, full parent
    #      lifecycle live-confirmed 0-drift) makes lims_samples.status
    #      trustworthy, so the builder now sources review_state natively
    #      and tags it "mk1" like every other field (registry_details.py's
    #      field-source matrix, spec §8).
    _seed(client, status="verified")  # stale-looking but now the authority
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["review_state"] == "verified"
    assert body["field_sources"]["review_state"] == "mk1"


def test_analytes_are_the_typed_adapter_output(client):
    # REWRITE of test_analytes_shape_mismatch_guarded.
    # OLD: this test guarded a REAL collision risk — the overlay loop
    #      blindly assigning the registry's raw {"name",
    #      "declared_quantity"} dict shape onto the response's typed
    #      SenaiteAnalyte field would raise a Pydantic ValidationError (500)
    #      on every sample with registry-populated analytes; SENAITE's
    #      typed analytes had to survive untouched instead.
    # NEW: that collision is structurally IMPOSSIBLE now — there is no
    #      overlay merge of two shapes anymore. analytes come exclusively
    #      from analytes_from_registry_json's typed output (deep adapter
    #      edge-case coverage: test_registry_details_builder.py). This test
    #      proves the typed shape survives the HTTP round-trip end-to-end.
    _seed(client, client_title="RegistryCo",
          analytes=json.dumps([{"name": "KPV", "declared_quantity": "2.00"}]))
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["analytes"] == [{
        "raw_name": "KPV", "slot_number": 1,
        "matched_peptide_id": None, "matched_peptide_name": None,
        "declared_quantity": 2.0,
    }]
    assert body["field_sources"]["analytes"] == "mk1"


def test_unauthenticated_rejected_401():
    # UNCHANGED — auth gate is untouched by the flip.
    # No override, no bearer token -> real get_current_user -> 401, not 403.
    from database import Base as B
    eng = create_engine("sqlite:///:memory:")
    B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get("/registry/sample/P-1/details")
    assert r.status_code == 401


def test_authenticated_non_admin_can_read(client):
    # REWRITE of the same-named pre-flip test (auth-shape unchanged, but no
    # SENAITE mock return value to assert over anymore).
    # OLD: non-admin auth + registry overlay winning over a mocked SENAITE
    #      client value.
    # NEW: non-admin auth + zero-SENAITE native read.
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "u@x", "role": "standard"}
    _seed(client, client_title="RegistryCo")
    with _mock_lookup_raises():
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    assert r.json()["client"] == "RegistryCo"
