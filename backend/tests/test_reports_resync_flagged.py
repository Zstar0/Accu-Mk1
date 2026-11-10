"""Re-sync writes a flagged (a la carte) certificate's reporting row the way IS does.

Twin of IS ``app/services/generation_service.py`` (IS plan Task 2): one row per
flagged certificate, add-on flags from ``coa_data.native_sections`` by
``profile_key``, ``is_blend_overall`` equal to ``is_blend``, no result values.
Unflagged certificates keep today's rows.
"""
import asyncio
import re
from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace

import pytest

import main as main_module
from reports_flagged_row import (
    ENDOTOXIN_PROFILE_KEYS,
    STERILITY_PROFILE_KEYS,
    is_flagged,
    native_section_flag,
)


def test_constants_match_is():
    assert ENDOTOXIN_PROFILE_KEYS == frozenset({"endotoxin-usp85-lal"})
    assert STERILITY_PROFILE_KEYS == frozenset({"rapid-sterility-pcr", "sterility-usp71"})


@pytest.mark.parametrize(
    "coa_data,expected",
    [
        ({"page1": "none"}, True),
        ({}, False),
        ({"page1": "None"}, False),
        ({"page1": ""}, False),
        ({"page1": None}, False),
        ({"page1": "NONE"}, False),
    ],
)
def test_is_flagged(coa_data, expected):
    assert is_flagged(coa_data) is expected


# Cases copied verbatim from IS tests/unit/test_generation_service.py
# (test_flagged_row_takes_flags_from_native_sections and
# test_flagged_malformed_native_sections_still_writes_one_row).
ENDO, PCR, USP71 = "endotoxin-usp85-lal", "rapid-sterility-pcr", "sterility-usp71"


def _sec(key, *conforms):
    return {"profile_key": key, "title": key,
            "rows": [{"name": key, "result": "1", "conforms": c} for c in conforms]}


def _flags(sections):
    return (*native_section_flag(sections, ENDOTOXIN_PROFILE_KEYS),
            *native_section_flag(sections, STERILITY_PROFILE_KEYS))


@pytest.mark.parametrize(("sections", "expected"), [
    ([_sec(ENDO, True)], (True, True, False, None)),
    ([_sec(ENDO, False)], (True, False, False, None)),
    ([_sec(ENDO, True, None)], (True, True, False, None)),
    ([_sec(ENDO, None)], (True, None, False, None)),
    ([_sec(PCR, True)], (False, None, True, True)),
    ([_sec(USP71, False)], (False, None, True, False)),
    ([_sec(PCR, True), _sec(USP71, False)], (False, None, True, False)),
    ([_sec(ENDO, True), _sec(USP71, True)], (True, True, True, True)),
    ([_sec("vial-vacuum-test", None)], (False, None, False, None)),
    ([_sec("heavy_metals", True, True)], (False, None, False, None)),
])
def test_native_section_flag(sections, expected):
    assert _flags(sections) == expected


@pytest.mark.parametrize(("native_sections", "has_endo"), [
    (None, False), ({}, False), ("x", False), ([None, "x", 3], False),
    ([{"profile_key": ENDO}], True), ([{"profile_key": ENDO, "rows": None}], True),
    ([{"profile_key": ENDO, "rows": ["x", None]}], True),
    ([{"profile_key": [ENDO]}], False), ([{"profile_key": {ENDO: True}}], False),
])
def test_native_section_flag_malformed_never_raises(native_sections, has_endo):
    assert native_section_flag(native_sections, ENDOTOXIN_PROFILE_KEYS) == (has_endo, None)


# ── Route tests through the real INSERT ─────────────────────────────

_INSERT_PREFIX = "INSERT INTO published_coa_results"


class _FakeCursor:
    def __init__(self, missing_rows, inserts):
        self._missing_rows = missing_rows
        self._inserts = inserts
        self.rowcount = 0

    def execute(self, sql, params=None):
        if sql.strip().startswith(_INSERT_PREFIX):
            cols = re.search(r"\((.*?)\)\s*VALUES", sql, re.S).group(1)
            names = [c.strip() for c in cols.split(",")]
            assert len(names) == len(params)
            self._inserts.append(dict(zip(names, params)))
        self.rowcount = 0

    def fetchall(self):
        return self._missing_rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self):
        pass


def _resync(monkeypatch, coa_data):
    inserts = []
    now = datetime(2026, 11, 9, 12, 0, 0)
    cursor = _FakeCursor([(101, "P-0001", "VC-0001", coa_data, now, now)], inserts)

    @contextmanager
    def fake_db():
        yield _FakeConn(cursor)

    monkeypatch.setattr(main_module, "get_integration_db", fake_db)
    result = asyncio.run(main_module.reports_resync(_current_user=SimpleNamespace(id=1)))
    assert result["synced"] == 1
    return inserts


_RESULT_COLUMNS = (
    "purity_percent", "purity_conforms", "purity_spec",
    "identity_conforms", "quantity_value", "quantity_unit",
)


def _flagged_doc(components, **extra):
    doc = {
        "page1": "none",
        "sample": {"name": "Client S1", "batch_id": "LOT1", "matrix_type": "Lyophilized",
                   "received_date": "11/01/2026"},
        "client": {"name": "Acme"},
        "product": {"components": components},
        "results": {},
        "native_sections": [{"profile_key": "endotoxin-usp85-lal", "rows": [{"conforms": True}]}],
        "overall_status": "PASSED",
    }
    doc.update(extra)
    return doc


def test_resync_flagged_single_takes_flags_from_native_sections(monkeypatch):
    rows = _resync(monkeypatch, _flagged_doc(["BPC-157"]))
    assert len(rows) == 1
    row = rows[0]
    assert row["analyte_name"] == "BPC-157"
    assert row["is_blend"] is False
    assert row["is_blend_overall"] is False
    assert row["has_endotoxin"] is True
    assert row["endotoxin_conforms"] is True
    assert row["has_sterility"] is False
    assert row["sterility_conforms"] is None
    assert row["overall_status"] == "PASSED"
    for col in _RESULT_COLUMNS:
        assert row[col] is None, col


def test_resync_flagged_ignores_addons(monkeypatch):
    doc = _flagged_doc(["BPC-157"], native_sections=[],
                       results={"addons": [{"test_name": "Endotoxin", "status": "CONFORMS"}]})
    rows = _resync(monkeypatch, doc)
    assert len(rows) == 1
    assert rows[0]["has_endotoxin"] is False
    assert rows[0]["endotoxin_conforms"] is None


def test_resync_flagged_sterility_from_native_sections(monkeypatch):
    doc = _flagged_doc(["BPC-157"], native_sections=[
        {"profile_key": "sterility-usp71", "rows": [{"conforms": False}]},
    ])
    row = _resync(monkeypatch, doc)[0]
    assert row["has_endotoxin"] is False
    assert row["has_sterility"] is True
    assert row["sterility_conforms"] is False


def test_resync_flagged_blend_writes_one_overall_row(monkeypatch):
    rows = _resync(monkeypatch, _flagged_doc(["BPC-157", "TB-500"]))
    assert len(rows) == 1
    assert rows[0]["analyte_name"] == "BPC-157, TB-500"
    assert rows[0]["is_blend"] is True
    assert rows[0]["is_blend_overall"] is True


def test_resync_flagged_bw_retest_names_the_product(monkeypatch):
    doc = _flagged_doc([], product={"components": [], "name": "Bacteriostatic Water 30mL"})
    rows = _resync(monkeypatch, doc)
    assert len(rows) == 1
    assert rows[0]["analyte_name"] == "Bacteriostatic Water 30mL"
    assert rows[0]["product_name"] == "Bacteriostatic Water 30mL"
    assert rows[0]["is_blend"] is False


def test_resync_flagged_no_name_falls_back_to_unknown(monkeypatch):
    rows = _resync(monkeypatch, _flagged_doc([], product={}))
    assert len(rows) == 1
    assert rows[0]["analyte_name"] == "Unknown"


def test_resync_flagged_malformed_native_sections_still_writes_one_row(monkeypatch):
    rows = _resync(monkeypatch, _flagged_doc(["BPC-157"], native_sections="garbage"))
    assert len(rows) == 1
    assert rows[0]["has_endotoxin"] is False
    assert rows[0]["has_sterility"] is False
    assert rows[0]["endotoxin_conforms"] is None
    assert rows[0]["sterility_conforms"] is None


def test_resync_flagged_skips_malformed_addons(monkeypatch):
    rows = _resync(monkeypatch, _flagged_doc(["BPC-157"], results={"addons": [{"test_name": None}]}))
    assert len(rows) == 1
    assert rows[0]["has_endotoxin"] is True


def test_resync_passes_measured_through(monkeypatch):
    rows = _resync(monkeypatch, _flagged_doc(["BPC-157"], overall_status="MEASURED"))
    assert rows[0]["overall_status"] == "MEASURED"


def _hplc_single_doc():
    return {
        "sample": {"name": "Client S1", "batch_id": "LOT1", "matrix_type": "Lyophilized",
                   "received_date": "11/01/2026"},
        "client": {"name": "Acme"},
        "product": {"components": ["BPC-157"]},
        "results": {
            "purity": {"analyte": "BPC-157", "result": "99.1%", "conforms": True,
                       "specification": ">= 98%"},
            "identity": {"conforms": True},
            "quantity": {"result": "10.2 mg", "unit": "mg"},
            "addons": [{"test_name": "Endotoxin (LAL)", "status": "CONFORMS"}],
        },
        "native_sections": [{"profile_key": "sterility-usp71", "rows": [{"conforms": False}]}],
        "overall_status": "PASSED",
    }


@pytest.mark.parametrize("page1", ["absent", "None", ""])
def test_resync_unflagged_rows_unchanged(monkeypatch, page1):
    doc = _hplc_single_doc()
    if page1 != "absent":
        doc["page1"] = page1
    rows = _resync(monkeypatch, doc)
    assert rows == [{
        "coa_generation_id": 101, "verification_code": "VC-0001", "sample_id": "P-0001",
        "published_at": datetime(2026, 11, 9, 12, 0, 0),
        "received_date": datetime(2026, 11, 1).date(),
        "client_name": "Acme", "client_sample_id": "Client S1", "lot_code": "LOT1",
        "order_number": None, "product_name": "BPC-157", "sample_type": "Lyophilized",
        "is_blend": False, "analyte_name": "BPC-157", "is_blend_overall": False,
        "purity_percent": 99.1, "purity_conforms": True, "purity_spec": ">= 98%",
        "identity_conforms": True, "quantity_value": 10.2, "quantity_unit": "mg",
        "overall_status": "PASSED",
        "has_endotoxin": True, "endotoxin_conforms": True,
        "has_sterility": False, "sterility_conforms": None,
    }]
