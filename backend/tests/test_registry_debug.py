"""Pure registry-vs-SENAITE diff (2026-07-07 debug-panel spec)."""
import json
from datetime import datetime
from models import LimsSample
from sub_samples.registry_debug import diff_registry_vs_senaite


def _meta(**over):
    m = {
        "uid": "AR_UID", "ClientID": "client-8", "getClientTitle": "acme@x.com",
        "ContactFullName": "Ada L", "ContactEmail": "ada@x.com",
        "ClientUID": "C_UID", "ContactUID": "CT_UID", "SampleType": "ST_UID",
        "getSampleTypeTitle": "Peptide", "ClientSampleID": "CS-1",
        "ClientOrderNumber": "WP-1", "VerificationCode": "AB12-CD34",
        "Analyte1Peptide": "BPC-157", "Analyte1DeclaredQuantity": "10.00",
        "DeclaredTotalQuantity": "10.00", "ClientLot": "L1", "ClientReference": "r1",
        "CompanyLogoUrl": "/logo.jpg", "CoaCompanyName": "Acme",
        "DateReceived": "2026-05-01T10:00:00+00:00",
        "DateSampled": "2026-04-30T00:00:00+00:00",
        "created": "2026-04-29T00:00:00+00:00", "review_state": "sample_received",
    }
    m.update(over)
    return m


def _row_from(meta):
    """A row that already matches the meta (the in-sync baseline)."""
    from sub_samples.service import _populate_basic_info
    r = LimsSample(sample_id="P-1")
    _populate_basic_info(r, meta)
    return r


def _status_of(result, field):
    return next(f["status"] for f in result["fields"] if f["field"] == field)


def test_all_agree_when_row_matches_meta():
    meta = _meta()
    res = diff_registry_vs_senaite(_row_from(meta), meta)
    assert res["summary"]["drift"] == 0
    assert res["summary"]["registry_null"] == 0
    assert res["summary"]["senaite_null"] == 0
    assert res["summary"]["agree"] == len(res["fields"])


def test_drift_on_client_sample_id():
    """The real drift source: SENAITE-side Replace-Analyte edits ClientSampleID."""
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(ClientSampleID="CS-CHANGED"))
    assert _status_of(res, "client_sample_id") == "drift"
    assert res["summary"]["drift"] == 1


def test_registry_null_when_row_missing_a_field():
    row = _row_from(_meta())
    row.sample_type_title = None          # reconcile-fill candidate
    res = diff_registry_vs_senaite(row, _meta())
    assert _status_of(res, "sample_type_title") == "registry_null"


def test_senaite_null_when_meta_missing_a_field():
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(ClientLot=None))
    assert _status_of(res, "client_lot") == "senaite_null"


def test_analyte_structural_drift():
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(Analyte1Peptide="TB-500"))
    assert _status_of(res, "analytes") == "drift"


def test_coa_meta_map_drift():
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(CoaCompanyName="NewCo"))
    assert _status_of(res, "coa_meta") == "drift"


def test_date_formatting_is_not_drift():
    """Offset string vs stored naive-UTC must compare equal, not drift."""
    row = _row_from(_meta())
    res = diff_registry_vs_senaite(row, _meta(DateReceived="2026-05-01T06:00:00-04:00"))
    assert _status_of(res, "date_received") == "agree"   # same instant
