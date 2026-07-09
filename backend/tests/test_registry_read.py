"""Registry-row -> SenaiteLookupResult display mapper (read-source toggle)."""
import json
from datetime import datetime
import pytest
from models import LimsSample
from sub_samples.registry_read import registry_row_to_display, OVERLAY_FIELDS


def _row(**kw):
    return LimsSample(sample_id="PB-0073", **kw)


def test_scalar_fields_map_to_lookup_shape():
    row = _row(client_title="Acme", contact_title="Jane Doe",
               sample_type_title="Peptide Blend", client_order_number="WP-1", client_sample_id="CS-9",
               client_lot="L1", status="sample_received")
    out = registry_row_to_display(row)
    assert out["client"] == "Acme"
    assert out["contact"] == "Jane Doe"
    assert out["sample_type"] == "Peptide Blend"
    assert out["client_order_number"] == "WP-1"
    assert out["client_sample_id"] == "CS-9"
    assert out["client_lot"] == "L1"
    # review_state is SENAITE-owned; the mapper never emits it even when the
    # registry row has a populated status.
    assert "review_state" not in out


def test_dates_render_iso():
    row = _row(date_received=datetime(2026, 3, 8, 3, 42, 17),
               date_sampled=datetime(2026, 3, 7, 8, 0, 0))
    out = registry_row_to_display(row)
    assert out["date_received"] == "2026-03-08T03:42:17"
    assert out["date_sampled"] == "2026-03-07T08:00:00"


def test_declared_weight_parses_float_else_omitted():
    assert registry_row_to_display(_row(declared_total_quantity="10.00"))["declared_weight_mg"] == 10.0
    assert "declared_weight_mg" not in registry_row_to_display(_row(declared_total_quantity="n/a"))
    assert "declared_weight_mg" not in registry_row_to_display(_row(declared_total_quantity=None))


def test_analytes_json_unpacks_to_list():
    row = _row(analytes=json.dumps([
        {"name": "KPV - Identity (HPLC)", "declared_quantity": "2.00"},
        {"name": "GHK-Cu - Identity (HPLC)", "declared_quantity": "3.00"},
    ]))
    out = registry_row_to_display(row)
    assert [a["name"] for a in out["analytes"]] == ["KPV - Identity (HPLC)", "GHK-Cu - Identity (HPLC)"]
    assert out["analytes"][0]["declared_quantity"] == "2.00"


def test_malformed_analytes_omitted_not_raised():
    assert "analytes" not in registry_row_to_display(_row(analytes="{not json"))
    assert "analytes" not in registry_row_to_display(_row(analytes=None))


def test_null_columns_are_omitted():
    out = registry_row_to_display(_row())  # everything None
    for f in ("client", "contact", "sample_type", "client_lot", "review_state"):
        assert f not in out


def test_overlay_fields_covers_mapper_keys():
    # Every key the mapper can emit must be declared in OVERLAY_FIELDS (so field_sources is complete).
    row = _row(external_lims_uid="U", client_title="C", contact_title="Ct", sample_type_title="T",
               date_received=datetime(2026, 1, 1), date_sampled=datetime(2026, 1, 1),
               client_order_number="O", client_sample_id="CS", client_lot="L", status="s",
               declared_total_quantity="1.0", analytes=json.dumps([{"name": "x", "declared_quantity": "1"}]))
    assert set(registry_row_to_display(row)).issubset(set(OVERLAY_FIELDS))
