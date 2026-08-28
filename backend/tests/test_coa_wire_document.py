"""Assembly wrapper: native_sections + (mk1 mode) legacy_rows block."""
import logging
from types import SimpleNamespace

import coa.wire_document as wd
from coa.wire_document import (build_coa_wire_document,
                               build_vial_wire_document,
                               warn_if_source_ignored)

_PARENT = SimpleNamespace(sample_id="P-0161")
_NATIVE_DOC = {"sample_id": "P-0161", "ordered_profiles": ["heavy_metals"],
               "sections": [{"profile_key": "heavy_metals"}]}
_ROWS = [{"uid": "mk1:1", "Keyword": "HPLC-PUR", "Title": "t",
          "ServiceTitle": "t", "Result": "12", "Unit": "%",
          "review_state": "published", "ResultCaptureDate": None}]


def _patch(monkeypatch, source):
    monkeypatch.setattr(wd, "build_native_sections", lambda db, p: dict(_NATIVE_DOC))
    monkeypatch.setattr(wd, "build_legacy_rows", lambda db, p: list(_ROWS))
    monkeypatch.setattr(wd, "coa_generation_source", lambda db: source)


def test_senaite_mode_doc_unchanged(monkeypatch):
    _patch(monkeypatch, "senaite")
    doc = build_coa_wire_document(None, _PARENT)
    assert doc == _NATIVE_DOC
    assert "legacy_rows" not in doc


def test_mk1_mode_attaches_legacy_block(monkeypatch):
    _patch(monkeypatch, "mk1")
    doc = build_coa_wire_document(None, _PARENT)
    assert doc["legacy_rows"] == {"source": "mk1", "rows": _ROWS}
    assert doc["ordered_profiles"] == ["heavy_metals"]   # native part intact


def test_vial_doc_none_in_senaite_mode(monkeypatch):
    _patch(monkeypatch, "senaite")
    assert build_vial_wire_document(None, _PARENT) is None


def test_vial_doc_is_legacy_only_in_mk1_mode(monkeypatch):
    # Vial certificates have never rendered native sections and must not
    # start now — sections stay empty on purpose.
    _patch(monkeypatch, "mk1")
    doc = build_vial_wire_document(None, _PARENT)
    assert doc == {"sample_id": "P-0161", "ordered_profiles": [],
                   "sections": [], "legacy_rows": {"source": "mk1", "rows": _ROWS}}


def test_warn_fires_on_source_mismatch(caplog):
    doc = {"legacy_rows": {"rows": _ROWS}}
    with caplog.at_level(logging.WARNING):
        warn_if_source_ignored(doc, {"data_sources": {"legacy_rows": "senaite"}}, "P-1")
    assert any("mk1" in r.message for r in caplog.records)


def test_warn_silent_when_honored_or_not_requested(caplog):
    with caplog.at_level(logging.WARNING):
        warn_if_source_ignored({"legacy_rows": {}}, {"data_sources": {"legacy_rows": "mk1"}}, "P-1")
        warn_if_source_ignored({"sections": []}, {}, "P-1")
        warn_if_source_ignored(None, {}, "P-1")
    assert caplog.records == []
