"""Twin contract test — coab side: tests/test_legacy_rows_contract.py in the
coabuilder repo pins the same FIELD_CONTRACT tuple and row shapes. Move them
together."""
from types import SimpleNamespace

import pytest

import coa.legacy_rows as lr
from coa.legacy_rows import FIELD_CONTRACT, build_legacy_rows
from coa.native_sections import NativeSectionsError


def _shaped(**over):
    base = dict(
        uid="mk1:144", keyword="HPLC-PUR", title="Peptide Purity (HPLC)",
        result="12", unit="%", review_state="published",
        captured="2026-08-25T04:26:00+00:00", service_origin="senaite",
    )
    base.update(over)
    return SimpleNamespace(**base)


_PARENT = SimpleNamespace(sample_id="P-0161")


def test_field_contract_pinned():
    assert FIELD_CONTRACT == (
        "uid", "Keyword", "Title", "ServiceTitle",
        "Result", "Unit", "review_state", "ResultCaptureDate",
    )


def test_projection_recases_and_duplicates_title(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped()])
    rows = build_legacy_rows(None, _PARENT)
    assert rows == [{
        "uid": "mk1:144", "Keyword": "HPLC-PUR",
        "Title": "Peptide Purity (HPLC)", "ServiceTitle": "Peptide Purity (HPLC)",
        "Result": "12", "Unit": "%", "review_state": "published",
        "ResultCaptureDate": "2026-08-25T04:26:00+00:00",
    }]
    assert set(rows[0].keys()) == set(FIELD_CONTRACT)


def test_native_family_rows_filtered_out(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(),
        _shaped(uid="mk1:200", keyword="STERILITY_USP71", service_origin="mk1"),
    ])
    rows = build_legacy_rows(None, _PARENT)
    assert [r["Keyword"] for r in rows] == ["HPLC-PUR"]


def test_pending_row_survives_with_empty_result(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(keyword="ENDO-LAL", result=None, review_state="unassigned"),
    ])
    assert build_legacy_rows(None, _PARENT)[0]["Result"] is None


def test_zero_legacy_rows_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(service_origin="mk1"),
    ])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_row_without_keyword_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(keyword=None)])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_empty_string_keyword_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(keyword="")])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_whitespace_only_keyword_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_shaped(keyword="   ")])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)


def test_unresolvable_service_origin_aborts(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _shaped(),
        _shaped(uid="mk1:300", keyword="HEAVY-METALS", service_origin=None),
    ])
    with pytest.raises(NativeSectionsError):
        build_legacy_rows(None, _PARENT)
