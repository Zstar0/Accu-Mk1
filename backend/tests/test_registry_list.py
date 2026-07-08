"""Samples-list read endpoint sourced from lims_samples (no SENAITE round-trip).

Authenticated (not admin-only) — same access-control rationale as
test_registry_read_endpoint.py's /registry/sample/{id}/details."""
import json
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
