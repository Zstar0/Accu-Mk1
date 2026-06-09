"""Unit tests for the parent-analysis SENAITE reads (response parsing only;
the HTTP layer is monkeypatched)."""
import pytest

import sub_samples.senaite as sn


class _Resp:
    def __init__(self, payload, status=200):
        self._p = payload
        self.status_code = status
    def json(self):
        return self._p
    def raise_for_status(self):
        if self.status_code >= 300:
            raise RuntimeError(f"status {self.status_code}")


def test_fetch_parent_analysis_keywords_parses_getKeyword(monkeypatch):
    payload = {"items": [
        {"getKeyword": "ANALYTE-1-PUR"},
        {"getKeyword": "ID_GHKCU"},
        {"getKeyword": "HPLC-ID"},
        {"getKeyword": None},          # skipped
    ]}
    monkeypatch.setattr(sn, "_get", lambda url, **kw: _Resp(payload))
    kws = sn.fetch_parent_analysis_keywords("PB-0076")
    assert kws == ["ANALYTE-1-PUR", "ID_GHKCU", "HPLC-ID"]


def test_fetch_parent_analysis_keywords_raises_on_http_error(monkeypatch):
    monkeypatch.setattr(sn, "_get", lambda url, **kw: _Resp({}, status=502))
    with pytest.raises(Exception):
        sn.fetch_parent_analysis_keywords("PB-0076")


def test_fetch_parent_analyte_slots_parses_AnalyteNPeptide(monkeypatch):
    payload = {"items": [{
        "Analyte1Peptide": "GHK-Cu - Identity (HPLC)",
        "Analyte2Peptide": {"title": "BPC-157 - Identity (HPLC)"},  # dict shape
        "Analyte3Peptide": None,
        "Analyte4Peptide": "",
    }]}
    monkeypatch.setattr(sn, "_get", lambda url, **kw: _Resp(payload))
    slots = sn.fetch_parent_analyte_slots("PB-0076")
    assert slots == {1: "GHK-Cu - Identity (HPLC)", 2: "BPC-157 - Identity (HPLC)"}
