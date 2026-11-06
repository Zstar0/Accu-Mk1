"""MB5: coa/bw_shim.py wire helpers. A native-born Bac Water row rides the
legacy-rows wire under the SENAITE keyword/title COABuilder's
GenericAssayEngine already reads (spec 2026-10-05 MB5)."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from coa.bw_shim import (
    BW_NATIVE_KEYWORDS, bw_wire_keyword, bw_wire_title, is_native_bw_row,
)
from database import Base
from models import AnalysisService  # registers tables on Base.metadata before create_all


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.mark.parametrize("kw,expected", [
    ("PH-BW", "PH-DETERM"),
    ("BENZYL-ALCOHOL-BW", "Benzyl_Alcohol_Assay"),
    ("FILL-VOLUME-BW", "FILL-NET-CONTENT"),
    ("ph-bw", "PH-DETERM"),
])
def test_bw_wire_keyword_table(kw, expected):
    assert bw_wire_keyword(kw) == expected


def test_every_native_keyword_has_a_wire_keyword():
    assert {bw_wire_keyword(k) for k in BW_NATIVE_KEYWORDS} == {
        "PH-DETERM", "Benzyl_Alcohol_Assay", "FILL-NET-CONTENT"}


@pytest.mark.parametrize("kw", ["PH-DETERM", "HPLC-PURITY", "", None])
def test_bw_wire_keyword_rejects_non_bw(kw):
    with pytest.raises(ValueError):
        bw_wire_keyword(kw)


@pytest.mark.parametrize("origin,kw,expected", [
    ("mk1", "PH-BW", True),
    ("mk1", "benzyl-alcohol-bw", True),
    ("mk1", "FILL-VOLUME-BW", True),
    ("senaite", "PH-BW", False),
    ("mk1", "PH-DETERM", False),
    ("mk1", "HPLC-PURITY", False),
    (None, "PH-BW", False),
    ("mk1", None, False),
])
def test_is_native_bw_row(origin, kw, expected):
    assert is_native_bw_row(SimpleNamespace(service_origin=origin, keyword=kw)) is expected


def test_bw_wire_title_reads_the_legacy_senaite_service_title(db):
    db.add_all([
        AnalysisService(title="pH Determination", keyword="PH-DETERM", origin="senaite"),
        AnalysisService(title="pH (native)", keyword="PH-BW", origin="mk1"),
    ])
    db.flush()
    assert bw_wire_title(db, "PH-BW", "pH (native)") == "pH Determination"


def test_bw_wire_title_ignores_a_same_keyword_mk1_service(db):
    # uq_analysis_services_mk1_keyword is partial on origin='mk1', so an mk1
    # row may share the legacy keyword string; only origin='senaite' counts.
    db.add(AnalysisService(title="decoy", keyword="PH-DETERM", origin="mk1"))
    db.flush()
    assert bw_wire_title(db, "PH-BW", "pH (native)") == "pH (native)"


def test_bw_wire_title_is_deterministic_lowest_id_wins(db):
    db.add(AnalysisService(title="Fill volume / Net content",
                           keyword="FILL-NET-CONTENT", origin="senaite"))
    db.flush()
    db.add(AnalysisService(title="Fill / Net Content",
                           keyword="FILL-NET-CONTENT", origin="senaite"))
    db.flush()
    assert bw_wire_title(db, "FILL-VOLUME-BW", "x") == "Fill volume / Net content"


def test_bw_wire_title_falls_back_without_a_catalog():
    assert bw_wire_title(None, "PH-BW", "pH (native)") == "pH (native)"
