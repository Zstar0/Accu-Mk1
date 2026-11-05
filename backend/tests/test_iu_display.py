"""HGH quantity in IU: lims_analyses stays mg, the COA wire converts from the
peptide's iu_from cutoff forward, earlier samples never flip. Spec:
docs/superpowers/specs/2026-11-04-hgh-iu-display-design.md"""
from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import coa.legacy_rows as lr
from auth import get_current_user
from coa.hplc_shim import SlotWire
from coa.iu_display import declared_payload, iu_factor_for_sample, iu_factors, to_iu
from coa.legacy_rows import build_legacy_rows
from coa.variance_series import (
    build_variance_analyte_series,
    build_variance_replicates,
    list_vials_for_certificates,
)
from database import Base, get_db
from main import _attach_sample_form, _worksheet_item_parent_facts, app
from models import (
    AnalysisService,
    AnalysisServiceSpec,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    Peptide,
)
from tests.hplc_native_family import native_catalog

CUTOFF = datetime(2026, 11, 10)
AFTER = CUTOFF + timedelta(days=1)
BEFORE = CUTOFF - timedelta(days=1)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _peptide(db, name="HGH (Somatropin)", abbr="HGH", factor=Decimal("3.0"), start=CUTOFF):
    p = Peptide(name=name, abbreviation=abbr, active=True, iu_per_mg=factor, iu_from=start)
    db.add(p)
    db.flush()
    return p


def _service(db, keyword, peptide_id=None, unit=None, variance_capable=False):
    svc = db.query(AnalysisService).filter_by(keyword=keyword).one_or_none()
    if svc is None:
        svc = AnalysisService(title=keyword, keyword=keyword, peptide_id=peptide_id, origin="senaite",
                              unit=unit, variance_capable=variance_capable)
        db.add(svc)
        db.flush()
    return svc


def _sample(db, peptides, ordered=AFTER, sample_id="P-6000", declared="36"):
    """A parent anchored on `peptides` through peptide-linked identity rows."""
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}", container_mode=True,
                        date_created=ordered, declared_total_quantity=declared)
    db.add(parent)
    db.flush()
    for pep in peptides:
        svc = _service(db, f"ID_{pep.abbreviation}", pep.id)
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
                            title=svc.title, review_state="verified", reportable=True))
    db.flush()
    return parent


def _wire_row(keyword, result, unit, uid="a:1", peptide_id=None, svc_id=None, origin="senaite", slot=None):
    return SimpleNamespace(uid=uid, keyword=keyword, title=keyword, result=result, unit=unit,
                           review_state="verified", captured=None, service_origin=origin,
                           peptide_id=peptide_id, slot=slot, analysis_service_id=svc_id)


def _stub(monkeypatch, rows, wires=()):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: rows)
    monkeypatch.setattr(lr, "slot_wires", lambda db, parent: list(wires))


# to_iu ---------------------------------------------------------------------

@pytest.mark.parametrize("value,unit,want", [
    ("18.55", "mg", ("55.65", "IU")),
    ("18.55", "MG ", ("55.65", "IU")),
    ("18.55", None, ("55.65", "IU")),   # the generic row has no unit of its own
    ("12", "mg", ("36", "IU")),
    (None, "mg", (None, "IU")),         # pending row: unit follows, nothing to convert
    ("", "mg", ("", "IU")),
    ("55.65", "IU", ("55.65", "IU")),   # P-2878 row 43971 stays as filed
    ("4.2", "mg/mL", ("4.2", "mg/mL")),
    ("N/A", "mg", ("N/A", "mg")),       # never relabel a value it could not convert
])
def test_to_iu(value, unit, want):
    assert to_iu(value, unit, Decimal("3.0")) == want


def test_to_iu_without_factor_changes_nothing():
    assert to_iu("18.55", "mg", None) == ("18.55", "mg")


# the gate ------------------------------------------------------------------

@pytest.mark.parametrize("ordered,want", [
    (BEFORE, None),
    (CUTOFF, Decimal("3.0")),
    (AFTER, Decimal("3.0")),
])
def test_factor_applies_from_the_cutoff_forward(db, ordered, want):
    assert iu_factor_for_sample(db, _sample(db, [_peptide(db)], ordered=ordered)) == want


@pytest.mark.parametrize("factor,start", [(None, CUTOFF), (Decimal("3.0"), None)])
def test_inert_until_both_fields_are_set(db, factor, start):
    assert iu_factor_for_sample(db, _sample(db, [_peptide(db, factor=factor, start=start)])) is None


def test_other_peptides_never_convert(db):
    _peptide(db)
    other = _peptide(db, name="BPC-157", abbr="BPC157", factor=None, start=None)
    assert iu_factor_for_sample(db, _sample(db, [other])) is None


def test_blend_never_converts(db):
    hgh = _peptide(db)
    other = _peptide(db, name="BPC-157", abbr="BPC157", factor=None, start=None)
    assert iu_factor_for_sample(db, _sample(db, [hgh, other])) is None


def test_created_at_stands_in_for_a_missing_date_created(db):
    parent = _sample(db, [_peptide(db)], ordered=None)
    parent.created_at = BEFORE
    assert iu_factor_for_sample(db, parent) is None
    parent.created_at = AFTER
    assert iu_factor_for_sample(db, parent) == Decimal("3.0")


def test_parent_without_an_order_time_does_not_convert(db):
    _peptide(db)
    assert iu_factor_for_sample(db, SimpleNamespace(sample_id="P-1")) is None


def test_iu_factors_stays_two_queries_however_many_parents(db):
    hgh = _peptide(db)
    parents = [_sample(db, [hgh], sample_id=f"P-61{i}") for i in range(3)]
    statements = []
    event.listen(db.get_bind(), "before_cursor_execute",
                 lambda conn, cur, stmt, params, ctx, many: statements.append(stmt))
    got = iu_factors(db, parents)
    assert got == {p.id: Decimal("3.0") for p in parents}
    assert len(statements) == 2


def _retest(db, hgh, of, sample_id="P-6100"):
    retest = _sample(db, [hgh], sample_id=sample_id)
    retest.retest_of_sample_id = of
    db.flush()
    return retest


def test_retest_of_an_earlier_sample_stays_on_the_original_side(db):
    # A retest copies the original's declared amount, entered under the mg label.
    hgh = _peptide(db)
    original = _sample(db, [hgh], ordered=BEFORE)
    assert iu_factor_for_sample(db, _retest(db, hgh, original.sample_id)) is None


def test_retest_of_a_later_sample_converts(db):
    hgh = _peptide(db)
    original = _sample(db, [hgh], ordered=AFTER)
    assert iu_factor_for_sample(db, _retest(db, hgh, original.sample_id)) == Decimal("3.0")


def test_retest_of_a_retest_follows_the_chain_to_the_original(db):
    hgh = _peptide(db)
    original = _sample(db, [hgh], ordered=BEFORE)
    first = _retest(db, hgh, original.sample_id)
    assert iu_factor_for_sample(db, _retest(db, hgh, first.sample_id, sample_id="P-6101")) is None


def test_retest_of_an_original_mk1_does_not_hold_stays_mg(db):
    assert iu_factor_for_sample(db, _retest(db, _peptide(db), "P-0001")) is None


@pytest.mark.parametrize("state", ["rejected", "retracted", "cancelled"])
def test_a_removed_row_from_another_peptide_does_not_turn_iu_off(db, state):
    hgh = _peptide(db)
    other = _peptide(db, name="BPC-157", abbr="BPC157", factor=None, start=None)
    parent = _sample(db, [hgh])
    svc = _service(db, "ID_BPC157", other.id)
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
                        title=svc.title, review_state=state, reportable=True))
    db.flush()
    assert iu_factor_for_sample(db, parent) == Decimal("3.0")


# page 1 --------------------------------------------------------------------

def test_legacy_quantity_prints_iu_after_the_cutoff(db, monkeypatch):
    parent = _sample(db, [_peptide(db)])
    _stub(monkeypatch, [_wire_row("PEPT-Total", "18.55", "mg")])
    row = build_legacy_rows(db, parent)[0]
    assert (row["Result"], row["Unit"]) == ("55.65", "IU")


def test_legacy_quantity_stays_mg_before_the_cutoff(db, monkeypatch):
    parent = _sample(db, [_peptide(db)], ordered=BEFORE)
    _stub(monkeypatch, [_wire_row("PEPT-Total", "18.55", "mg")])
    row = build_legacy_rows(db, parent)[0]
    assert (row["Result"], row["Unit"]) == ("18.55", "mg")


def test_purity_row_is_untouched(db, monkeypatch):
    parent = _sample(db, [_peptide(db)])
    _stub(monkeypatch, [_wire_row("HPLC-PUR", "99.1", "%")])
    row = build_legacy_rows(db, parent)[0]
    assert (row["Result"], row["Unit"]) == ("99.1", "%")


def test_row_already_in_iu_is_untouched(db, monkeypatch):
    parent = _sample(db, [_peptide(db)])
    _stub(monkeypatch, [_wire_row("PEPT-Total", "55.65", "IU")])
    row = build_legacy_rows(db, parent)[0]
    assert (row["Result"], row["Unit"]) == ("55.65", "IU")


def test_native_quantity_converts_and_the_spec_judges_raw_mg(db, monkeypatch):
    svcs = native_catalog(db)
    hgh = _peptide(db)
    qty = svcs["HPLC-QUANTITY"]
    # In range on 18.55 mg, out of range on 55.65: only a raw judgement conforms.
    db.add(AnalysisServiceSpec(analysis_service_id=qty.id, peptide_id=hgh.id, rule_kind="range",
                               min_value=Decimal("10"), max_value=Decimal("20"), unit="mg"))
    parent = _sample(db, [hgh])
    _stub(monkeypatch,
          [_wire_row("HPLC-QUANTITY", "18.55", "mg", uid="mk1:1", peptide_id=hgh.id, svc_id=qty.id,
                     origin="mk1", slot=1)],
          [SlotWire(1, "HGH (Somatropin)", hgh.id, None)])
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", lambda db, parent: {})
    row = build_legacy_rows(db, parent)[0]
    assert (row["Keyword"], row["Result"], row["Unit"]) == ("PEPT-Total", "55.65", "IU")
    assert row["conforms"] is True


# variance + per-vial -------------------------------------------------------

def _variance_world(db, ordered=AFTER):
    hgh = _peptide(db)
    parent = _sample(db, [hgh], ordered=ordered)
    qty = _service(db, "PEPT-Total", unit="mg", variance_capable=True)
    pur = _service(db, "HPLC-PUR", unit="%")
    idsvc = _service(db, "ID_HGH")
    for seq, kind, value in ((1, "core", "18"), (2, "variance", "18.55"), (3, "variance", "19")):
        sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"mk1://v{seq}",
                            sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                            assignment_role="hplc", assignment_kind=kind, in_variance_set=True)
        db.add(sub)
        db.flush()
        for svc, val, unit in ((qty, value, "mg"), (pur, "99.1", None), (idsvc, "HGH", None)):
            db.add(LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id, keyword=svc.keyword,
                                title=svc.title, result_value=val, result_unit=unit,
                                review_state="variance_verified", reportable=True))
    db.commit()
    return parent


def test_variance_replicates_print_iu(db):
    recs = build_variance_replicates(db, _variance_world(db))["HGH (Somatropin)"]
    assert [r["QUANTITY"] for r in recs] == ["54 IU", "55.65 IU", "57 IU"]
    assert recs[1]["PURITY"] == "99.1%"


def test_variance_replicates_stay_mg_before_the_cutoff(db):
    recs = build_variance_replicates(db, _variance_world(db, ordered=BEFORE))["HGH (Somatropin)"]
    assert [r["QUANTITY"] for r in recs] == ["18 mg", "18.55 mg", "19 mg"]


def test_variance_series_carries_iu_for_the_headline(db):
    series = build_variance_analyte_series(db, _variance_world(db))["PEPT-Total"]
    assert series == {"unit": "IU", "values": ["55.65", "57"]}


def test_variance_series_stays_mg_before_the_cutoff(db):
    series = build_variance_analyte_series(db, _variance_world(db, ordered=BEFORE))["PEPT-Total"]
    assert series == {"unit": "mg", "values": ["18.55", "19"]}


def test_per_vial_certificates_print_iu(db):
    vials = list_vials_for_certificates(db, _variance_world(db))
    assert vials[1][1]["HGH (Somatropin)"]["QUANTITY"] == "55.65 IU"


# prep ----------------------------------------------------------------------

def test_declared_payload_divides_iu_back_to_mg(db):
    parent = _sample(db, [_peptide(db)])
    assert declared_payload(db, parent) == {"declared_unit": "IU", "declared_prep_mg": 12.0}


def test_declared_payload_is_empty_before_the_cutoff_and_without_a_row(db):
    parent = _sample(db, [_peptide(db)], ordered=BEFORE)
    empty = {"declared_unit": None, "declared_prep_mg": None}
    assert declared_payload(db, parent) == empty
    assert declared_payload(db, None) == empty


def test_declared_payload_keeps_the_unit_when_nothing_is_declared(db):
    parent = _sample(db, [_peptide(db)], declared=None)
    assert declared_payload(db, parent) == {"declared_unit": "IU", "declared_prep_mg": None}


@pytest.mark.parametrize("stored", ["36", None])
def test_lookup_divides_the_value_it_shows_not_the_stored_one(db, stored):
    # The SENAITE path shows its live figure; prep has to divide that one.
    parent = _sample(db, [_peptide(db)], declared=stored)
    result = {"declared_weight_mg": 24.0}
    _attach_sample_form(db, result, parent)
    assert (result["declared_unit"], result["declared_prep_mg"]) == ("IU", 8.0)


def test_worksheet_facts_hand_prep_mg(db):
    parent = _sample(db, [_peptide(db)])
    assert _worksheet_item_parent_facts(parent)["declared_weight_mg"] == 36.0
    assert _worksheet_item_parent_facts(parent, iu_factor=Decimal("3.0"))["declared_weight_mg"] == 12.0


# PUT /peptides/{id} --------------------------------------------------------

@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=7, email="t@example.test")
    tc = TestClient(app)
    tc.session = session
    tc.peptide = _peptide(session, factor=None, start=None)
    session.commit()
    yield tc
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)
    session.close()


def _put(client, **body):
    return client.put(f"/peptides/{client.peptide.id}", json=body)


SOON = datetime.utcnow().replace(microsecond=0) + timedelta(days=30)
PASSED = datetime(2026, 1, 1)


def _z(dt):
    return f"{dt.isoformat()}Z"


def _cutoff_has_passed(client):
    client.peptide.iu_per_mg, client.peptide.iu_from = Decimal("3.0"), PASSED
    client.session.commit()


def test_api_round_trips_and_stores_naive_utc(client):
    resp = _put(client, iu_per_mg=3.0, iu_from=_z(SOON))
    assert resp.status_code == 200
    assert resp.json()["iu_per_mg"] == 3.0
    assert resp.json()["iu_from"].startswith(SOON.isoformat())
    assert client.peptide.iu_from == SOON


def test_api_factor_can_be_edited_with_no_cutoff(client):
    assert _put(client, iu_per_mg=2.5).status_code == 200
    assert _put(client, iu_per_mg=3.0).status_code == 200


def test_api_scheduled_cutoff_can_be_changed_or_cleared_before_it_arrives(client):
    assert _put(client, iu_per_mg=3.0, iu_from=_z(SOON)).status_code == 200
    assert _put(client, iu_from=_z(SOON + timedelta(days=1))).status_code == 200
    assert _put(client, iu_per_mg=2.5).status_code == 200
    assert _put(client, iu_per_mg=None).status_code == 422  # would leave a cutoff with no factor
    assert _put(client, iu_per_mg=None, iu_from=None).status_code == 200
    assert client.peptide.iu_from is None and client.peptide.iu_per_mg is None


@pytest.mark.parametrize("body", [
    {"iu_from": "2030-12-01T00:00:00Z"},
    {"iu_from": None},
    {"iu_per_mg": 2.5},
    {"iu_per_mg": None},
])
def test_api_locks_both_fields_once_the_cutoff_has_passed(client, body):
    _cutoff_has_passed(client)
    assert _put(client, **body).status_code == 409


def test_api_resending_the_same_values_is_not_a_change(client):
    _cutoff_has_passed(client)
    assert _put(client, iu_per_mg=3.0, iu_from=_z(PASSED)).status_code == 200


def test_api_locked_peptide_still_takes_other_edits(client):
    _cutoff_has_passed(client)
    assert _put(client, display_aliases=["Somatropin"]).status_code == 200


def test_api_cutoff_needs_a_factor(client):
    assert _put(client, iu_from=_z(SOON)).status_code == 422


def test_api_refuses_a_cutoff_in_the_past(client):
    # Those orders were declared in mg; backdating would flip them at their next regen.
    assert _put(client, iu_per_mg=3.0, iu_from=_z(PASSED)).status_code == 422
    assert client.peptide.iu_from is None


def test_api_refuses_iu_on_a_blend_record(client):
    client.peptide.is_blend = True
    client.session.commit()
    assert _put(client, iu_per_mg=3.0).status_code == 422
    assert _put(client, display_aliases=["x"]).status_code == 200


@pytest.mark.parametrize("value", [0, -3])
def test_api_factor_must_be_positive(client, value):
    assert _put(client, iu_per_mg=value).status_code == 422
