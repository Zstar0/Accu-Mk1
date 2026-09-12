"""lims_analyses/hplc_native.py — the native-born HPLC seeding model (spec
2026-09-10, M4): slot→peptide resolution from lims_samples.analytes, stamped
per-row titles, unresolved ⇒ NULL peptide + reason (Handler ruling), blend
aggregates only for N>1."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import AnalysisService, Base, LimsAnalysis, LimsSample, LimsSubSample, Peptide


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        db.add(AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                               origin="mk1", variance_capable=vc))
    db.flush()


def _peptides(db):
    db.add(Peptide(name="BPC-157", abbreviation="BPC157", hplc_aliases=["BPC"]))
    db.add(Peptide(name="TB-500", abbreviation="TB500", display_aliases=["Thymosin Beta-4"]))
    db.add(Peptide(name="TB-500 (17-23)", abbreviation="TB500-17-23"))
    db.flush()


def _native_parent(db, analytes, sample_id="P-5000"):
    p = LimsSample(sample_id=sample_id, external_lims_system="mk1", sample_type_title="Peptide",
                   analytes=json.dumps(analytes))
    db.add(p); db.flush()
    return p


def _vial(db, parent, seq=1):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"zz-{parent.sample_id}-{seq}",
                      assignment_role="hplc")
    db.add(v); db.flush()
    return v


def test_constants_match_slice1_catalog():
    from lims_analyses import hplc_native as h
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES, HPLC_NATIVE_PROFILE_KEY
    assert h.TRIO == ("HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY")
    assert h.AGGREGATES == ("HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL")
    assert set(h.TRIO + h.AGGREGATES) == {kw for kw, *_ in HPLC_NATIVE_SERVICES}
    assert h.HPLC_NATIVE_PROFILE_KEY == HPLC_NATIVE_PROFILE_KEY


def test_is_native_born(db):
    from lims_analyses.hplc_native import is_native_born
    assert is_native_born(LimsSample(sample_id="a", external_lims_system="mk1"))
    assert not is_native_born(LimsSample(sample_id="b", external_lims_system="senaite"))
    assert not is_native_born(LimsSample(sample_id="c"))   # NULL = legacy default


def test_titles():
    from lims_analyses.hplc_native import identity_title, purity_title, quantity_title
    assert identity_title("BPC-157") == "BPC-157 - Identity (HPLC)"
    assert purity_title("BPC-157") == "BPC-157 - Purity (HPLC)"
    assert quantity_title("BPC-157") == "BPC-157 - Quantity (HPLC)"


def test_resolve_prefers_peptide_id_then_exact_name_then_alias(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    _peptides(db)
    bpc = db.query(Peptide).filter_by(name="BPC-157").one()
    p = _native_parent(db, [
        {"name": "Whatever - Identity (HPLC)", "declared_quantity": "10", "peptide_id": bpc.id},
        {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None},
        {"name": "bpc - Identity (HPLC)", "declared_quantity": None},
    ])
    res = resolve_slot_peptides(db, p)
    assert [(r.slot, r.peptide_id, r.reason) for r in res] == [
        (1, bpc.id, None), (2, db.query(Peptide).filter_by(name="TB-500").one().id, None), (3, bpc.id, None)]
    assert res[0].display_name == "BPC-157"          # from the peptide row, not the raw label
    assert res[1].raw_name == "TB-500 - Identity (HPLC)"


def test_resolve_marks_unresolved_and_ambiguous_without_guessing(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    _peptides(db)
    db.add(Peptide(name="Dup", abbreviation="DUP1", hplc_aliases=["SAMEALIAS"]))
    db.add(Peptide(name="Dup Two", abbreviation="DUP2", hplc_aliases=["SAMEALIAS"]))
    db.flush()
    p = _native_parent(db, [
        {"name": "Nonexistent Peptide - Identity (HPLC)", "declared_quantity": None},
        {"name": "SAMEALIAS", "declared_quantity": None},
    ])
    res = resolve_slot_peptides(db, p)
    assert (res[0].peptide_id, res[0].reason, res[0].display_name) == (None, "unresolved", "Nonexistent Peptide")
    assert (res[1].peptide_id, res[1].reason) == (None, "ambiguous")


def test_resolve_skips_middle_placeholder_but_keeps_slot_numbers(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    _peptides(db)
    p = _native_parent(db, [
        {"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
        {"name": None, "declared_quantity": None},
        {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None},
    ])
    assert [r.slot for r in resolve_slot_peptides(db, p)] == [1, 3]


def test_resolve_ignores_inactive_peptides(db):
    from lims_analyses.hplc_native import resolve_slot_peptides
    db.add(Peptide(name="Retired", abbreviation="RET", active=False)); db.flush()
    p = _native_parent(db, [{"name": "Retired - Identity (HPLC)", "declared_quantity": None}])
    assert resolve_slot_peptides(db, p)[0].reason == "unresolved"


def test_native_hplc_services_fail_closed(db, caplog):
    from lims_analyses.hplc_native import native_hplc_services
    assert native_hplc_services(db) == {}
    assert any("hplc_native.catalog_incomplete" in r.message for r in caplog.records)
    _catalog(db)
    assert set(native_hplc_services(db)) == {"HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY",
                                            "HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL"}


def test_seed_single_peptide_three_rows(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    bpc = db.query(Peptide).filter_by(name="BPC-157").one()
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "10"}])
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    got = sorted((r.keyword, r.slot, r.peptide_id, r.title) for r in rows)
    assert got == [
        ("HPLC-IDENTITY", 1, bpc.id, "BPC-157 - Identity (HPLC)"),
        ("HPLC-PURITY", 1, bpc.id, "BPC-157 - Purity (HPLC)"),
        ("HPLC-QUANTITY", 1, bpc.id, "BPC-157 - Quantity (HPLC)"),
    ]
    assert all(r.lims_sub_sample_pk == v.id and r.review_state == "unassigned" for r in rows)


def test_seed_blend_three_per_slot_plus_two_aggregates(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"},
                            {"name": "TB-500 - Identity (HPLC)", "declared_quantity": "5"}], sample_id="PB-1000")
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert len(rows) == 8
    agg = [r for r in rows if r.keyword.startswith("HPLC-BLEND-")]
    assert {(r.slot, r.peptide_id, r.title) for r in agg} == {
        (None, None, "HPLC Blend Purity (mass-weighted)"), (None, None, "HPLC Blend Total Quantity")}


def test_seed_unresolved_slot_gets_null_peptide_and_reason(db, caplog):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [{"name": "Mystery - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert len(rows) == 3
    assert all(r.peptide_id is None and r.reportable_reason == "analyte_unresolved: Mystery - Identity (HPLC)"
               for r in rows)
    assert rows[0].title == "Mystery - Identity (HPLC)"
    assert any("seeder.native_hplc.unresolved_slot" in r.message for r in caplog.records)


def test_seed_is_idempotent_via_slot_aware_keys(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    keys, ids = set(), set()
    first = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=keys,
                                  existing_service_ids=ids, created_by_user_id=None, commit=False)
    second = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=keys,
                                   existing_service_ids=ids, created_by_user_id=None, commit=False)
    assert len(first) == 3 and second == []
    assert ("HPLC-PURITY", 1) in keys


def test_seed_logs_error_and_skips_when_no_occupied_slots(db, caplog):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _catalog(db); _peptides(db)
    p = _native_parent(db, [])
    v = _vial(db, p)
    rows = seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False)
    assert rows == []
    assert any("seeder.native_hplc.no_analyte_slots" in r.message for r in caplog.records)


def test_seed_refuses_when_catalog_incomplete(db):
    from lims_analyses.hplc_native import seed_native_hplc_rows
    _peptides(db)
    p = _native_parent(db, [{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    assert seed_native_hplc_rows(db, sub_sample=v, parent=p, existing_keys=set(),
                                 existing_service_ids=set(), created_by_user_id=None, commit=False) == []


from lims_analyses.hplc_native import native_category, KW_IDENTITY, KW_PURITY, KW_QUANTITY, KW_BLEND_PURITY, KW_BLEND_TOTAL


def test_native_category_trio_and_aggregates():
    assert native_category(KW_IDENTITY) == "identity"
    assert native_category(KW_PURITY) == "purity"
    assert native_category(KW_QUANTITY) == "quantity"
    assert native_category("hplc-purity") == "purity"          # case-insensitive
    # Aggregates are not a bridged/stamped category (mirrors legacy BLEND-PUR /
    # PEPT-Total handling: owned by bridge_blend_aggregates, never a direct target).
    assert native_category(KW_BLEND_PURITY) is None
    assert native_category(KW_BLEND_TOTAL) is None
    # Legacy keywords are NOT this helper's business.
    assert native_category("HPLC-PUR") is None
    assert native_category("ID_BPC157") is None
    assert native_category(None) is None
