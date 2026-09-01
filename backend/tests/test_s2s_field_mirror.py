"""POST /s2s/lims-samples/fields — targeted mirror, pre-received gate, alias
cleanup (customer portal Slice B, 2026-08-31).

Fixture idiom copied from test_s2s_shipping_update.py (StaticPool in-memory
SQLite + get_db override, ACCUMK1_INTERNAL_SERVICE_TOKEN patched in per-test
via patch.dict for run-order determinism).
"""
import json
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from database import get_db, Base
from models import LimsSample, SampleAnalyteAlias

SVC_TOKEN = "test-svc-token"
HDR = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/lims-samples/fields"


def _all_analyte_slots(slot1_peptide="TB-500 - Identity (HPLC)", slot1_qty="10"):
    """8-slot Analyte{N}Peptide/DeclaredQuantity payload with only slot 1
    populated — mirrors what IS sends when a customer edits down to one
    analyte in the portal."""
    fields = {"Analyte1Peptide": slot1_peptide, "Analyte1DeclaredQuantity": slot1_qty}
    for i in range(2, 9):
        fields[f"Analyte{i}Peptide"] = ""
        fields[f"Analyte{i}DeclaredQuantity"] = ""
    return fields


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db


# 1. auth: no X-Service-Token -> 401/403.
def test_rejects_without_service_token(client, db_session):
    body = {"samples": [{"sample_id": "P-8100", "fields": {"CoaCompanyName": "NewCo"}}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body)
    assert r.status_code in (401, 403)


# 2. happy branding: row status sample_due; branding fields -> 200
#    updated=[sid]; row.coa_meta reflects the merge; logo mirrored.
def test_happy_branding_update(client, db_session):
    db_session.add(LimsSample(
        sample_id="P-8100", status="sample_due",
        coa_meta=json.dumps({"CoaAddress": "addr", "CoaCompanyName": "OldCo",
                              "CoaEmail": "old@x.com", "CoaWebsite": None}),
    ))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-8100", "fields": {
        "CoaCompanyName": "NewCo", "CoaEmail": "", "CompanyLogoUrl": "https://x/l.png",
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    out = r.json()
    assert out["updated"] == ["P-8100"]
    assert out["locked"] == []
    assert out["missing"] == []
    row = db_session.query(LimsSample).filter_by(sample_id="P-8100").one()
    meta = json.loads(row.coa_meta)
    assert meta["CoaCompanyName"] == "NewCo"
    assert meta["CoaEmail"] is None          # "" clears
    assert meta["CoaAddress"] == "addr"      # untouched key preserved
    assert row.company_logo_url == "https://x/l.png"


# 3. happy analytes: 8-slot payload -> analytes JSON rebuilt to 1 slot,
#    peptide_name re-derived, PRE-EXISTING alias rows for the sample DELETED.
def test_happy_analyte_update_rebuilds_slots_and_clears_aliases(client, db_session):
    db_session.add(LimsSample(
        sample_id="P-8200", status="sample_due",
        analytes=json.dumps([
            {"name": "BPC-157", "declared_quantity": "5.00"},
            {"name": "GHK-Cu", "declared_quantity": "2.00"},
        ]),
        peptide_name="BPC-157",
    ))
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8200", slot=1, alias="Old Alias 1"))
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8200", slot=2, alias="Old Alias 2"))
    # A different sample's alias row must survive — the cleanup is
    # per-sample, not a blanket delete of the whole table.
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8299", slot=1, alias="Other Sample"))
    db_session.commit()

    body = {"samples": [{"sample_id": "P-8200", "fields": _all_analyte_slots()}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    assert r.json()["updated"] == ["P-8200"]

    row = db_session.query(LimsSample).filter_by(sample_id="P-8200").one()
    slots = json.loads(row.analytes)
    assert slots == [{"name": "TB-500 - Identity (HPLC)", "declared_quantity": "10"}]
    assert row.peptide_name == "TB-500 - Identity (HPLC)"

    remaining = db_session.query(SampleAnalyteAlias).filter_by(senaite_sample_id="P-8200").all()
    assert remaining == []
    other = db_session.query(SampleAnalyteAlias).filter_by(senaite_sample_id="P-8299").all()
    assert len(other) == 1
    assert other[0].alias == "Other Sample"


# 4. alias preservation: branding-only fields (no Analyte keys) -> alias
#    rows UNTOUCHED.
def test_branding_only_update_leaves_aliases_untouched(client, db_session):
    db_session.add(LimsSample(sample_id="P-8300", status="sample_due"))
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8300", slot=1, alias="Keep Me"))
    db_session.commit()

    body = {"samples": [{"sample_id": "P-8300", "fields": {"CoaCompanyName": "NewCo"}}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    assert r.json()["updated"] == ["P-8300"]

    remaining = db_session.query(SampleAnalyteAlias).filter_by(senaite_sample_id="P-8300").all()
    assert len(remaining) == 1
    assert remaining[0].alias == "Keep Me"


# 5. lock: row status sample_received -> locked=[sid], row unchanged,
#    aliases unchanged.
def test_received_row_is_locked(client, db_session):
    db_session.add(LimsSample(
        sample_id="P-8400", status="sample_received",
        coa_meta=json.dumps({"CoaCompanyName": "OldCo"}),
    ))
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8400", slot=1, alias="Keep Me"))
    db_session.commit()

    body = {"samples": [{"sample_id": "P-8400", "fields": {
        "CoaCompanyName": "NewCo", **_all_analyte_slots(),
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    out = r.json()
    assert out["locked"] == ["P-8400"]
    assert out["updated"] == []
    assert out["missing"] == []

    row = db_session.query(LimsSample).filter_by(sample_id="P-8400").one()
    assert json.loads(row.coa_meta)["CoaCompanyName"] == "OldCo"   # unchanged
    assert row.analytes is None                                    # unchanged

    remaining = db_session.query(SampleAnalyteAlias).filter_by(senaite_sample_id="P-8400").all()
    assert len(remaining) == 1


# 6. missing id -> missing=[sid].
def test_missing_sample_id_reported(client, db_session):
    body = {"samples": [{"sample_id": "P-9999", "fields": {"CoaCompanyName": "NewCo"}}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    out = r.json()
    assert out["missing"] == ["P-9999"]
    assert out["updated"] == []
    assert out["locked"] == []


# Mixed batch (the real IS-Task-4 shape: one order, multiple samples in one
# request/commit) — pins per-sid scoping (updated vs locked vs missing) AND
# cross-sample alias isolation under a SINGLE shared db.commit().
def test_mixed_batch_scopes_updates_locks_and_alias_cleanup_independently(client, db_session):
    db_session.add(LimsSample(sample_id="P-8500", status="sample_due"))
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8500", slot=1, alias="Due Alias"))
    db_session.add(LimsSample(
        sample_id="P-8501", status="sample_received",
        coa_meta=json.dumps({"CoaCompanyName": "OldCo"}),
    ))
    db_session.add(SampleAnalyteAlias(senaite_sample_id="P-8501", slot=1, alias="Received Alias"))
    db_session.commit()

    body = {"samples": [
        {"sample_id": "P-8500", "fields": _all_analyte_slots()},
        {"sample_id": "P-8501", "fields": {**_all_analyte_slots(), "CoaCompanyName": "NewCo"}},
        {"sample_id": "P-9404", "fields": {"CoaCompanyName": "NewCo"}},
    ]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    out = r.json()
    assert out["updated"] == ["P-8500"]
    assert out["locked"] == ["P-8501"]
    assert out["missing"] == ["P-9404"]

    due_aliases = db_session.query(SampleAnalyteAlias).filter_by(senaite_sample_id="P-8500").all()
    assert due_aliases == []                      # rebuilt -> cleaned up
    received_aliases = db_session.query(SampleAnalyteAlias).filter_by(senaite_sample_id="P-8501").all()
    assert len(received_aliases) == 1              # locked row -> untouched
    assert received_aliases[0].alias == "Received Alias"
    received_row = db_session.query(LimsSample).filter_by(sample_id="P-8501").one()
    assert json.loads(received_row.coa_meta)["CoaCompanyName"] == "OldCo"  # locked -> unchanged
