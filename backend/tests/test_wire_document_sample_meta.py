"""mk1-mode wire documents carry sample_meta beside legacy_rows (spec §2),
including the vial doc; senaite mode is untouched; the drift detector warns
when coab ignored the block."""
import logging
from unittest.mock import patch

import pytest

from coa import wire_document


@pytest.fixture
def mk1_mode():
    with patch.object(wire_document, "coa_generation_source", return_value="mk1"):
        yield


@pytest.fixture
def senaite_mode():
    with patch.object(wire_document, "coa_generation_source", return_value="senaite"):
        yield


def test_parent_doc_carries_sample_meta_in_mk1_mode(mk1_mode):
    with patch.object(wire_document, "build_native_sections",
                      return_value={"sample_id": "S", "ordered_profiles": [], "sections": []}), \
         patch.object(wire_document, "build_legacy_rows", return_value=[{"Keyword": "X"}]), \
         patch.object(wire_document, "build_sample_meta",
                      return_value={"source": "mk1", "SampleID": "S", "attachments": []}):
        doc = wire_document.build_coa_wire_document(object(), object())
    assert doc["sample_meta"]["source"] == "mk1"
    assert "legacy_rows" in doc


def test_parent_doc_omits_sample_meta_in_senaite_mode(senaite_mode):
    with patch.object(wire_document, "build_native_sections",
                      return_value={"sample_id": "S", "ordered_profiles": [], "sections": []}):
        doc = wire_document.build_coa_wire_document(object(), object())
    assert "sample_meta" not in doc and "legacy_rows" not in doc


def test_vial_doc_carries_sample_meta_in_mk1_mode(mk1_mode):
    with patch.object(wire_document, "build_legacy_rows", return_value=[{"Keyword": "X"}]), \
         patch.object(wire_document, "build_sample_meta",
                      return_value={"source": "mk1", "SampleID": "S", "attachments": []}):
        class P: sample_id = "S"
        doc = wire_document.build_vial_wire_document(object(), P())
    assert doc["sample_meta"]["source"] == "mk1"


def test_vial_doc_none_in_senaite_mode(senaite_mode):
    assert wire_document.build_vial_wire_document(object(), object()) is None


def test_drift_warns_on_ignored_sample_meta(caplog):
    doc = {"sample_meta": {"source": "mk1"}, "legacy_rows": {"source": "mk1"}}
    resp = {"data_sources": {"legacy_rows": "mk1"}}  # sample_meta missing
    with caplog.at_level(logging.WARNING):
        wire_document.warn_if_source_ignored(doc, resp, "S-1")
    assert any("sample_meta" in r.message for r in caplog.records)


def test_drift_quiet_when_both_honored(caplog):
    doc = {"sample_meta": {"source": "mk1"}, "legacy_rows": {"source": "mk1"}}
    resp = {"data_sources": {"legacy_rows": "mk1", "sample_meta": "mk1"}}
    with caplog.at_level(logging.WARNING):
        wire_document.warn_if_source_ignored(doc, resp, "S-1")
    assert not caplog.records
