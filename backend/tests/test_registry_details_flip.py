"""Endpoint flip (read-flip Layer 4 / Task 3): `GET /registry/sample/{id}
/details` delegates unconditionally to `build_native_details` — zero
SENAITE HTTP, `response_model=RegistrySampleReadResult` validation intact.

This is the canonical route-level zero-SENAITE proof (mirrors
test_registry_details_builder.py's `test_zero_senaite_http_builder_
returns_complete_result`, but through the actual HTTP route + FastAPI's
response_model validation instead of calling the builder directly).
Field-by-field sourcing facts that changed with the flip are covered in
test_registry_read_endpoint.py; deep builder edge cases live in
test_registry_details_builder.py. This file stays route-level: does the
endpoint wire the builder in correctly, end-to-end, for a fully seeded
sample and for a missing one, with the SENAITE lookup patched to raise so a
regression back to the old wrap-and-overlay behavior fails loudly.
"""
import json
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base, get_db
from auth import get_current_user
from models import AnalysisService, LimsAnalysis, LimsParentAttachment, LimsSample, LimsSampleRemark
import main

SID = "L4T3-P1"


@pytest.fixture
def client():
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
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def _mock_lookup_raises():
    """Patch lookup_senaite_sample to raise on any call — if the route ever
    regresses back to wrapping it, every test in this file fails loudly."""
    return patch.object(
        main, "lookup_senaite_sample",
        AsyncMock(side_effect=AssertionError("SENAITE HTTP attempted")))


def _seed_full_sample(client, sample_id=SID):
    db = client._Session()
    parent = LimsSample(
        sample_id=sample_id, external_lims_uid="UID-L4T3-1",
        status="sample_received", client_title="RegistryCo",
        contact_title="Reg Contact", sample_type_title="Peptide",
        date_received=datetime(2026, 1, 1, 12, 0, 0),
        date_sampled=datetime(2026, 1, 2, 12, 0, 0),
        client_order_number="WP-3300", client_sample_id="CS-1",
        client_lot="LOT-9", declared_total_quantity="10",
        analytes=json.dumps([{"name": "BPC-157", "declared_quantity": "5"}]),
        verification_code="OLD1-OLD1",
    )
    db.add(parent)
    db.flush()

    db.add(LimsSampleRemark(lims_sample_pk=parent.id,
                            content="<p>native remark</p>",
                            author_label="native.author"))

    svc = AnalysisService(keyword="ANALYTE-1-PUR", title="Analyte 1 (Purity)")
    db.add(svc)
    db.flush()
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword="ANALYTE-1-PUR",
        title="Analyte 1 (Purity)", review_state="verified",
        provenance="canonical", retested=False,
    ))

    db.add(LimsParentAttachment(
        lims_sample_pk=parent.id, kind="vial_image", filename="v-1.png",
        content_type="image/png", storage="s3", storage_key="k/v-1.png",
        attachment_type="Sample Image",
    ))

    db.commit()
    db.close()


def test_mk1_get_succeeds_seeded_sample_end_to_end_zero_senaite(client):
    """The binding contract: mk1 GET succeeds with lookup_senaite_sample
    patched to raise, for a sample carrying analyses + remarks +
    attachments — proving the route serves the builder's output (not a
    wrapped SENAITE lookup) and that response_model validation passes on
    the full, richly-populated shape."""
    _seed_full_sample(client)
    with _mock_lookup_raises() as mocked:
        r = client.get(f"/registry/sample/{SID}/details")
    mocked.assert_not_called()
    assert r.status_code == 200
    body = r.json()

    assert body["read_source"] == "mk1"
    assert body["registry_missing"] is False
    assert body["sample_id"] == SID
    assert body["sample_uid"] == "UID-L4T3-1"
    assert body["client"] == "RegistryCo"
    assert body["client_lot"] == "LOT-9"
    assert body["review_state"] == "sample_received"
    assert [a["raw_name"] for a in body["analytes"]] == ["BPC-157"]
    assert [a["title"] for a in body["analyses"]] == ["Analyte 1 (Purity)"]
    assert [r_["content"] for r_ in body["remarks"]] == ["<p>native remark</p>"]
    assert len(body["attachments"]) == 1
    att = body["attachments"][0]
    assert att["uid"].startswith("mk1att:")  # no adopted SENAITE uid for this s3 row
    att_id = att["uid"].removeprefix("mk1att:")
    assert att["download_url"] == f"/registry/sample/{SID}/attachments/{att_id}/download"
    assert body["published_coa"] is None
    assert body["field_sources"]["published_coa"] == "senaite"


def test_mk1_get_registry_missing_zero_senaite(client):
    """No lims_samples row for the requested id: the endpoint still never
    calls SENAITE and still returns a valid, fully-typed empty result."""
    with _mock_lookup_raises() as mocked:
        r = client.get("/registry/sample/NO-SUCH-SAMPLE/details")
    mocked.assert_not_called()
    assert r.status_code == 200
    body = r.json()
    assert body["registry_missing"] is True
    assert body["read_source"] == "mk1"
    assert body["sample_id"] == "NO-SUCH-SAMPLE"
    assert body["analytes"] == []
    assert body["analyses"] == []
    assert body["remarks"] == []
    assert body["attachments"] == []


def test_response_model_validation_intact_for_response_shape(client):
    """response_model=RegistrySampleReadResult still gates the route: a
    seeded sample's response round-trips through FastAPI's response_model
    validation without the endpoint needing to construct the payload dict
    itself anymore (the builder already returns a typed instance)."""
    _seed_full_sample(client)
    with _mock_lookup_raises():
        r = client.get(f"/registry/sample/{SID}/details")
    assert r.status_code == 200
    body = r.json()
    # Exactly the response model's fields are present (FastAPI serializes
    # strictly against response_model — a shape mismatch would 500, not
    # silently add/drop keys).
    from sub_samples.lookup_models import RegistrySampleReadResult
    assert set(body.keys()) == set(RegistrySampleReadResult.model_fields.keys())


def test_unauthenticated_rejected_401():
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get(f"/registry/sample/{SID}/details")
    assert r.status_code == 401
