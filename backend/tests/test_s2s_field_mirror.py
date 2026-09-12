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
from models import LimsAnalysis, LimsSample, LimsSubSampleEvent, SampleAnalyteAlias

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


# 3b. native-born: blanking one Analyte{N}Peptide slot restamps ONLY that
#    slot's pristine native rows (peptide_id None, reportable_reason
#    "analyte_cleared"), title left as-is; the other slot is untouched
#    (final-review finding #5).
def test_native_born_analyte_clear_restamps_only_that_slot(client, db_session):
    from sqlalchemy import select
    from tests.hplc_native_family import native_family

    parent, services, peps, vial_rows = native_family(
        db_session, sample_id="PB-S2S-CLEAR",
        slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")],
    )
    db_session.commit()

    body = {"samples": [{"sample_id": "PB-S2S-CLEAR", "fields": {
        "Analyte2Peptide": "", "Analyte2DeclaredQuantity": "",
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    assert r.json()["updated"] == ["PB-S2S-CLEAR"]

    rows2 = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.slot == 2)).scalars().all()
    assert rows2 and all(r.peptide_id is None and r.reportable_reason == "analyte_cleared" for r in rows2)

    rows1 = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.slot == 1)).scalars().all()
    assert rows1 and all(r.peptide_id == peps[1].id and r.reportable_reason is None for r in rows1)


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


# 9. sample-type mirror (Slice B.1): SampleType uid + SampleTypeTitle land in
#    their columns; nothing else on the row moves; a dict-shaped SampleType
#    (SENAITE reference form) is coerced to its uid.
def test_sample_type_fields_mirror_to_columns(client, db_session):
    db_session.add(LimsSample(
        sample_id="P-8300", status="sample_due",
        sample_type="uid-single", sample_type_title="Peptide",
        analytes=json.dumps([{"name": "BPC-157", "declared_quantity": "5"}]),
    ))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-8300", "fields": {
        "SampleType": "uid-blend", "SampleTypeTitle": "Peptide Blend",
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    assert r.json()["updated"] == ["P-8300"]
    row = db_session.query(LimsSample).filter_by(sample_id="P-8300").one()
    assert row.sample_type == "uid-blend"
    assert row.sample_type_title == "Peptide Blend"
    assert json.loads(row.analytes) == [{"name": "BPC-157", "declared_quantity": "5"}]  # untouched


def test_sample_type_dict_form_is_coerced_to_uid(client, db_session):
    db_session.add(LimsSample(sample_id="P-8301", status="sample_due", sample_type="uid-single"))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-8301", "fields": {
        "SampleType": {"uid": "uid-blend", "title": "Peptide Blend"},
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    row = db_session.query(LimsSample).filter_by(sample_id="P-8301").one()
    assert row.sample_type == "uid-blend"


# =============================================================================
# Slice B.1 follow-up (Handler, arcitest UAT 2026-09-10)
#
# A pre-receipt conversion REPLACES the AR's service set in SENAITE (profile
# swap + identity swap), but this endpoint only mirrors scalars and the analyte
# slot JSON. The shadow analysis LINES stayed frozen at whatever the sample was
# registered with: SENAITE 17 lines vs registry 5, one of them (HPLC-PUR) a
# ghost. And the edit left no trace on the sample's Activity log at all — the
# only record was a WooCommerce order note the bench never sees.
# =============================================================================


def _line(keyword):
    """Minimal analysis item in the NORMALISED shape select_current_lines()
    reads — fetch_parent_analyses() maps SENAITE's getKeyword to `keyword`."""
    return {"keyword": keyword, "uid": "uid-" + keyword, "review_state": "registered"}


def test_analyte_push_schedules_the_shadow_resync(client, db_session):
    db_session.add(LimsSample(sample_id="P-9001", status="sample_due"))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-9001", "fields": {
        "SampleTypeTitle": "Peptide Blend", "Analyte1Peptide": "KPV - Identity (HPLC)",
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("main._resync_shadow_analyses_after_field_edit_bg") as bg:
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    assert r.json()["updated"] == ["P-9001"]
    bg.assert_called_once_with("P-9001")


def test_branding_only_push_does_not_schedule_a_resync(client, db_session):
    """Branding never changes the AR's service set — no SENAITE round trip."""
    db_session.add(LimsSample(sample_id="P-9002", status="sample_due"))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-9002", "fields": {"CoaCompanyName": "NewCo"}}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("main._resync_shadow_analyses_after_field_edit_bg") as bg:
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    bg.assert_not_called()


def test_locked_row_neither_resyncs_nor_logs(client, db_session):
    db_session.add(LimsSample(sample_id="P-9003", status="sample_received"))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-9003", "fields": {"Analyte1Peptide": "KPV - Identity (HPLC)"}}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("main._resync_shadow_analyses_after_field_edit_bg") as bg:
        r = client.post(URL, json=body, headers=HDR)
    assert r.json()["locked"] == ["P-9003"]
    bg.assert_not_called()
    assert db_session.query(LimsSubSampleEvent).count() == 0


def test_edit_writes_a_customer_edit_activity_event(client, db_session):
    db_session.add(LimsSample(
        sample_id="P-9004", status="sample_due", sample_type_title="Peptide",
        client_sample_id="BPC-157", declared_total_quantity="5",
        analytes=json.dumps([{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"}]),
    ))
    db_session.commit()
    row_pk = db_session.query(LimsSample).filter_by(sample_id="P-9004").one().id

    body = {"samples": [{"sample_id": "P-9004", "fields": {
        "SampleTypeTitle": "Peptide Blend",
        "Analyte1Peptide": "KPV - Identity (HPLC)", "Analyte1DeclaredQuantity": "1",
        "Analyte2Peptide": "GHK-Cu - Identity (HPLC)", "Analyte2DeclaredQuantity": "2",
        "DeclaredTotalQuantity": "3",
    }}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("main._resync_shadow_analyses_after_field_edit_bg"):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200

    ev = db_session.query(LimsSubSampleEvent).filter_by(lims_sample_pk=row_pk).one()
    assert ev.event == "customer_sample_edit"
    assert ev.user_id is None, "the actor is a WordPress customer, not an Mk1 user"
    d = ev.details
    assert d["source"] == "customer_portal"
    assert d["type_from"] == "Peptide" and d["type_to"] == "Peptide Blend"
    assert d["declared_total_from"] == "5" and d["declared_total_to"] == "3"
    # Readable analyte names, not the raw slot JSON, and no service suffix.
    assert d["analytes_from"] == ["BPC-157 (5 mg)"]
    assert d["analytes_to"] == ["KPV (1 mg)", "GHK-Cu (2 mg)"]


def test_no_op_push_writes_no_event(client, db_session):
    """Re-sending identical values must not litter the Activity log."""
    db_session.add(LimsSample(sample_id="P-9005", status="sample_due", client_sample_id="Same"))
    db_session.commit()
    body = {"samples": [{"sample_id": "P-9005", "fields": {"ClientSampleID": "Same"}}]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("main._resync_shadow_analyses_after_field_edit_bg"):
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200
    assert db_session.query(LimsSubSampleEvent).count() == 0


# ── the prune itself ─────────────────────────────────────────────────────
# sync_parent_shadows_from_items only UPSERTS (correct for the event-driven
# hooks it was built for). These cover the pruning half; the "creates the
# missing lines" half is already covered by the registration-sync tests, and
# needs catalog rows this bare fixture has no reason to carry.

# analysis_service_id is NOT NULL; the id itself is irrelevant to pruning and
# SQLite does not enforce the FK, so a stable synthetic id keeps these focused.
def _shadow(pk, keyword, service_id=1):
    return LimsAnalysis(lims_sample_pk=pk, keyword=keyword, title=keyword,
                        analysis_service_id=service_id,
                        review_state="senaite_mirror", provenance="shadow")


def test_prune_drops_shadow_lines_senaite_no_longer_has(db_session):
    from lims_analyses.parent_mirror import resync_and_prune_parent_shadows
    db_session.add(LimsSample(sample_id="P-9010", status="sample_due"))
    db_session.commit()
    pk = db_session.query(LimsSample).filter_by(sample_id="P-9010").one().id
    db_session.add_all([_shadow(pk, "HPLC-PUR"), _shadow(pk, "PEPT-Total"), _shadow(pk, "ID_BPC157")])
    db_session.commit()

    stats = resync_and_prune_parent_shadows(
        db_session, sample_id="P-9010", sample_pk=pk,
        items=[_line("PEPT-Total"), _line("ID_BPC157"), _line("BLEND-PUR")],
    )
    db_session.commit()

    assert stats["pruned"] == 1, "only the ghost goes"
    left = sorted(k for (k,) in db_session.query(LimsAnalysis.keyword).filter_by(lims_sample_pk=pk))
    assert left == ["ID_BPC157", "PEPT-Total"]


def test_prune_never_runs_on_an_empty_senaite_result(db_session):
    """A SENAITE hiccup that returns nothing must not wipe the registry."""
    from lims_analyses.parent_mirror import resync_and_prune_parent_shadows
    db_session.add(LimsSample(sample_id="P-9011", status="sample_due"))
    db_session.commit()
    pk = db_session.query(LimsSample).filter_by(sample_id="P-9011").one().id
    db_session.add_all([_shadow(pk, "HPLC-PUR"), _shadow(pk, "PEPT-Total")])
    db_session.commit()

    stats = resync_and_prune_parent_shadows(db_session, sample_id="P-9011", sample_pk=pk, items=[])
    db_session.commit()

    assert stats["pruned"] == 0
    assert db_session.query(LimsAnalysis).filter_by(lims_sample_pk=pk).count() == 2


def test_prune_leaves_non_shadow_rows_alone(db_session):
    """Native/real analyses are not ours to delete, whatever SENAITE says."""
    from lims_analyses.parent_mirror import resync_and_prune_parent_shadows
    db_session.add(LimsSample(sample_id="P-9012", status="sample_due"))
    db_session.commit()
    pk = db_session.query(LimsSample).filter_by(sample_id="P-9012").one().id
    native = LimsAnalysis(lims_sample_pk=pk, keyword="MOISTURE", title="Moisture",
                          analysis_service_id=2,
                          review_state="pending", provenance="native")
    db_session.add_all([native, _shadow(pk, "HPLC-PUR")])
    db_session.commit()

    stats = resync_and_prune_parent_shadows(
        db_session, sample_id="P-9012", sample_pk=pk, items=[_line("PEPT-Total")])
    db_session.commit()

    assert stats["pruned"] == 1
    left = sorted(k for (k,) in db_session.query(LimsAnalysis.keyword).filter_by(lims_sample_pk=pk))
    assert left == ["MOISTURE"]
