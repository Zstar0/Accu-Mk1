"""Samples-list read endpoint sourced from lims_samples (no SENAITE round-trip).

Authenticated (not admin-only) — same access-control rationale as
test_registry_read_endpoint.py's /registry/sample/{id}/details."""
import json
from unittest.mock import patch
from sub_samples.registry_list import registry_rows_to_list
from models import LimsSample
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
import main
from auth import get_current_user


def _row(**kw):
    r = LimsSample(sample_id=kw.get('sample_id', 'P-1'))
    for k, v in kw.items():
        setattr(r, k, v)
    return r


def test_maps_core_fields_and_parses_analytes():
    row = _row(sample_id='P-9', external_lims_uid='u9', client_order_number='WP-1',
               status='sample_due', sample_type_title='Peptide', contact_title='Acme',
               analytes=json.dumps([{'name': 'DSIP - Identity (HPLC)', 'declared_quantity': None}]))
    [out] = registry_rows_to_list([row])
    assert out['id'] == 'P-9'
    assert out['uid'] == 'u9'
    assert out['client_order_number'] == 'WP-1'
    assert out['review_state'] == 'sample_due'
    assert out['sample_type'] == 'Peptide'
    assert out['contact'] == 'Acme'
    assert out['analytes'] == ['DSIP - Identity (HPLC)']


def test_analytes_empty_when_missing_or_bad_json():
    assert registry_rows_to_list([_row(analytes=None)])[0]['analytes'] == []
    assert registry_rows_to_list([_row(analytes='not json')])[0]['analytes'] == []


def test_analyte_details_carry_declared_quantity():
    row = _row(analytes=json.dumps([
        {'name': 'BPC-157 - Identity (HPLC)', 'declared_quantity': '10 mg'},
        {'name': 'Semax - Identity (HPLC)', 'declared_quantity': None},
        {'name': 'Tirzepatide - Identity (HPLC)', 'declared_quantity': 30},
    ]))
    [out] = registry_rows_to_list([row])
    assert out['analyte_details'] == [
        {'name': 'BPC-157 - Identity (HPLC)', 'declared_quantity': '10 mg'},
        {'name': 'Semax - Identity (HPLC)', 'declared_quantity': None},
        {'name': 'Tirzepatide - Identity (HPLC)', 'declared_quantity': '30'},
    ]
    assert registry_rows_to_list([_row(analytes=None)])[0]['analyte_details'] == []


def test_client_id_prefers_client_title_parity_with_senaite_samples():
    # /senaite/samples maps client_id from getClientTitle or ClientID (main.py
    # _item_to_model) — mirror that precedence here so the "Client" column and
    # the hide-test email filter match in Accu-Mk1 mode.
    row = _row(client_id='forrest-valenceanalytical-com-WP',
               client_title='forrest@valenceanalytical.com')
    [out] = registry_rows_to_list([row])
    assert out['client_id'] == 'forrest@valenceanalytical.com'


def test_client_id_falls_back_to_slug_when_no_client_title():
    row = _row(client_id='forrest-valenceanalytical-com-WP', client_title=None)
    [out] = registry_rows_to_list([row])
    assert out['client_id'] == 'forrest-valenceanalytical-com-WP'


@pytest.fixture
def client():
    # StaticPool + check_same_thread=False (per test_registry_read_endpoint.py
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
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "standard"}
    c = TestClient(main.app)
    c._Session = Session
    # No IS DB in the test env — default the code overlay to "nothing found"
    # (stored values stand). Overlay-specific tests re-patch inside their body.
    with patch("integration_db.fetch_verification_codes_for_samples", return_value={}):
        yield c
    main.app.dependency_overrides.clear()


def _seed(client, **kw):
    db = client._Session()
    kw.setdefault("external_lims_uid", "u1")
    row = LimsSample(sample_id=kw.pop("sample_id", "P-1"), **kw)
    db.add(row)
    db.commit()
    db.close()


def test_authenticated_returns_200_with_items_total_bstart(client):
    _seed(client, sample_id="P-1", status="sample_due")
    r = client.get("/registry/samples")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["b_start"] == 0
    assert len(body["items"]) == 1
    assert body["items"][0]["id"] == "P-1"


def test_review_state_filter_narrows(client):
    _seed(client, sample_id="P-1", external_lims_uid="u1", status="sample_due")
    _seed(client, sample_id="P-2", external_lims_uid="u2", status="verified")
    r = client.get("/registry/samples", params={"review_state": "verified"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == ["P-2"]


def test_review_state_filter_accepts_comma_separated_multi_state(client):
    _seed(client, sample_id="P-1", external_lims_uid="u1", status="sample_due")
    _seed(client, sample_id="P-2", external_lims_uid="u2", status="sample_received")
    _seed(client, sample_id="P-3", external_lims_uid="u3", status="to_be_verified")
    _seed(client, sample_id="P-4", external_lims_uid="u4", status="published")
    r = client.get(
        "/registry/samples",
        params={"review_state": "sample_due,sample_received,to_be_verified"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert sorted(item["id"] for item in body["items"]) == ["P-1", "P-2", "P-3"]


def test_unauthenticated_rejected_401():
    from database import Base as B
    eng = create_engine("sqlite:///:memory:")
    B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get("/registry/samples")
    assert r.status_code == 401


def test_null_uid_falls_back_to_sample_id_not_500(client):
    _seed(client, sample_id="P-3", external_lims_uid=None, status="sample_due")
    r = client.get("/registry/samples")
    assert r.status_code == 200
    assert r.json()["items"][0]["uid"] == "P-3"


# ── Verification code: IS DB is the authority ────────────────────────────────
# Codes are minted at order time and REPLACED on COA regeneration — an IS-side
# mutation the registry never sees (BW-0002 drift, 2026-07-09). The stored
# lims_samples.verification_code is only a fallback cache.

def test_verification_code_overlaid_from_is_db(client):
    _seed(client, sample_id="P-1", verification_code="OLD1-OLD1")
    with patch("integration_db.fetch_verification_codes_for_samples",
               return_value={"P-1": "NEW1-NEW1"}) as m:
        r = client.get("/registry/samples")
    assert r.status_code == 200
    assert r.json()["items"][0]["verification_code"] == "NEW1-NEW1"
    m.assert_called_once_with(["P-1"])


def test_verification_code_falls_back_to_stored_when_is_db_unavailable(client):
    _seed(client, sample_id="P-1", verification_code="OLD1-OLD1")
    with patch("integration_db.fetch_verification_codes_for_samples",
               side_effect=RuntimeError("IS db down")):
        r = client.get("/registry/samples")
    assert r.status_code == 200
    assert r.json()["items"][0]["verification_code"] == "OLD1-OLD1"


def test_verification_code_missing_in_is_keeps_stored(client):
    # A sample the IS DB has no code for (e.g. pre-IS legacy) keeps the
    # backfilled SENAITE value.
    _seed(client, sample_id="P-1", verification_code="OLD1-OLD1")
    with patch("integration_db.fetch_verification_codes_for_samples",
               return_value={}):
        r = client.get("/registry/samples")
    assert r.json()["items"][0]["verification_code"] == "OLD1-OLD1"


def test_search_by_verification_code_resolves_via_is_db(client):
    # Searching a REGENERATED code must find the sample even though the stored
    # column still holds the old code — parity with /senaite/samples' search.
    _seed(client, sample_id="P-1", verification_code="OLD1-OLD1")
    _seed(client, sample_id="P-2", external_lims_uid="u2",
          verification_code="XXXX-YYYY")
    with patch("integration_db.search_sample_ids_by_verification_code",
               return_value=["P-1"]) as m, \
         patch("integration_db.fetch_verification_codes_for_samples",
               return_value={"P-1": "NEW1-NEW1"}):
        r = client.get("/registry/samples",
                       params={"search": "NEW1", "search_field": "verification_code"})
    body = r.json()
    assert [i["id"] for i in body["items"]] == ["P-1"]
    assert body["items"][0]["verification_code"] == "NEW1-NEW1"
    m.assert_called_once()


def test_search_by_verification_code_falls_back_to_stored_column_on_is_error(client):
    _seed(client, sample_id="P-1", verification_code="OLD1-OLD1")
    with patch("integration_db.search_sample_ids_by_verification_code",
               side_effect=RuntimeError("down")):
        r = client.get("/registry/samples",
                       params={"search": "OLD1", "search_field": "verification_code"})
    assert [i["id"] for i in r.json()["items"]] == ["P-1"]


def test_client_lot_passthrough_in_list_shape():
    row = _row(sample_id='P-77', client_lot='LOT-555')
    [out] = registry_rows_to_list([row])
    assert out['client_lot'] == 'LOT-555'


def test_client_lot_null_when_missing():
    row = _row(sample_id='P-78')
    [out] = registry_rows_to_list([row])
    assert out['client_lot'] is None


def test_search_by_lot_ilike_substring(client):
    _seed(client, sample_id="P-1", external_lims_uid="u1", client_lot="LOT-555-A")
    _seed(client, sample_id="P-2", external_lims_uid="u2", client_lot="LOT-111")
    _seed(client, sample_id="P-3", external_lims_uid="u3")  # no lot
    r = client.get("/registry/samples", params={"search": "555", "search_field": "lot"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == ["P-1"]
    assert body["items"][0]["client_lot"] == "LOT-555-A"


def test_search_by_lot_case_insensitive(client):
    _seed(client, sample_id="P-1", external_lims_uid="u1", client_lot="LOT-ABC")
    r = client.get("/registry/samples", params={"search": "lot-abc", "search_field": "lot"})
    assert r.status_code == 200
    assert r.json()["total"] == 1


def test_registry_list_emits_shipping_fields():
    from models import LimsSample
    from sub_samples.registry_list import registry_rows_to_list
    row = LimsSample(sample_id="P-9301", shipping_carrier="FedEx",
                     tracking_number="9999", tracking_url="https://f/9999")
    out = registry_rows_to_list([row])[0]
    assert out["shipping_carrier"] == "FedEx"
    assert out["tracking_number"] == "9999"
    assert out["tracking_url"] == "https://f/9999"


# ── Customer note column (2026-08-30) ───────────────────────────────────────
# The receive page surfaces the customer's order note. lims_sample_remarks
# holds three kinds of row and only ONE of them is customer-origin:
#   * customer order note  — author_user_id NULL *and* author_label NULL
#   * lab remark           — real author_user_id (receive / Add Remark form)
#   * backfilled SENAITE   — author_label carries the SENAITE login
# Mixing them would make the column untrustworthy at a glance, so the query
# is deliberately narrow (Handler ruling 2026-08-30: customer-only).

@pytest.fixture
def notes_db():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _persist(db, sample_id):
    row = LimsSample(sample_id=sample_id)
    db.add(row)
    db.flush()
    return row


def test_customer_note_is_none_when_no_map_supplied():
    [out] = registry_rows_to_list([_row(sample_id='P-9')])
    assert out['customer_note'] is None


def test_customer_note_is_attached_to_the_matching_row():
    from sub_samples.registry_list import registry_rows_to_list as to_list
    a, b = _row(sample_id='P-1'), _row(sample_id='P-2')
    a.id, b.id = 1, 2
    out = to_list([a, b], customer_notes={2: 'Customer note (order #77): rush'})
    assert out[0]['customer_note'] is None
    assert out[1]['customer_note'] == 'Customer note (order #77): rush'


def test_fetch_customer_notes_returns_only_customer_origin_remarks(notes_db):
    from models import LimsSampleRemark
    from sub_samples.registry_list import fetch_customer_notes
    row = _persist(notes_db, 'P-100')
    notes_db.add_all([
        # Lab remark — a tech wrote it.
        LimsSampleRemark(lims_sample_pk=row.id, content='Vial cracked',
                         author_user_id=7),
        # Backfilled from SENAITE — author_label carries the login.
        LimsSampleRemark(lims_sample_pk=row.id, content='old AR remark',
                         author_label='admin'),
        # The one we want.
        LimsSampleRemark(lims_sample_pk=row.id,
                         content='Customer note (order #12): handle cold'),
    ])
    notes_db.flush()
    assert fetch_customer_notes(notes_db, [row]) == {
        row.id: 'Customer note (order #12): handle cold'
    }


def test_fetch_customer_notes_takes_the_earliest_when_several_exist(notes_db):
    from datetime import datetime
    from models import LimsSampleRemark
    from sub_samples.registry_list import fetch_customer_notes
    row = _persist(notes_db, 'P-101')
    notes_db.add_all([
        LimsSampleRemark(lims_sample_pk=row.id, content='second',
                         created_at=datetime(2026, 8, 30, 12, 0, 0)),
        LimsSampleRemark(lims_sample_pk=row.id, content='first',
                         created_at=datetime(2026, 8, 30, 9, 0, 0)),
    ])
    notes_db.flush()
    assert fetch_customer_notes(notes_db, [row]) == {row.id: 'first'}


def test_fetch_customer_notes_is_empty_for_no_rows(notes_db):
    from sub_samples.registry_list import fetch_customer_notes
    assert fetch_customer_notes(notes_db, []) == {}
