"""Registry analyte slots keep SENAITE slot POSITIONS (PB-0469, 2026-09-08).

Blanking slot 2 of a 4-analyte blend used to compact ``lims_samples.analytes``
to 3 entries, so every consumer that derives ``Analyte{N}`` from list
position (registry details ``slot_number``, the COA name resolver,
``coa.sample_meta``, the inbox overlay) re-labelled slots 3/4 as 2/3:
BPC-157 rendered as "Analyte 2" against the slot-2 results, TB500 became an
unlabeled "Analyte 4", and COABuilder's declared list no longer lined up with
its measured slots. An empty slot below the last occupied one is now stored
as a ``{"name": None, "declared_quantity": None}`` placeholder; trailing
empties are trimmed.
"""
from __future__ import annotations

import json

from models import LimsSample

META = {
    "Analyte1Peptide": "GHK-Cu - Identity (HPLC)",
    "Analyte1DeclaredQuantity": "50.00",
    "Analyte2Peptide": "",
    "Analyte2DeclaredQuantity": "",
    "Analyte3Peptide": "BPC-157 - Identity (HPLC)",
    "Analyte3DeclaredQuantity": "10.00",
    "Analyte4Peptide": "TB500 (17-23 Fragment) - Identity (HPLC)",
    "Analyte4DeclaredQuantity": "10.00",
}


def test_parse_keeps_an_empty_slot_below_the_last_occupied_one():
    from sub_samples.service import _parse_analyte_slots

    slots = _parse_analyte_slots(META)
    assert [s["name"] for s in slots] == [
        "GHK-Cu - Identity (HPLC)",
        None,
        "BPC-157 - Identity (HPLC)",
        "TB500 (17-23 Fragment) - Identity (HPLC)",
    ]
    assert slots[1] == {"name": None, "declared_quantity": None}
    assert slots[0]["declared_quantity"] == "50.00"
    assert slots[3]["declared_quantity"] == "10.00"


def test_parse_trims_trailing_empty_slots():
    from sub_samples.service import _parse_analyte_slots

    meta = {"Analyte1Peptide": "X", "Analyte2Peptide": None, "Analyte5Peptide": ""}
    assert _parse_analyte_slots(meta) == [{"name": "X", "declared_quantity": None}]


def test_parse_all_empty_is_an_empty_list():
    from sub_samples.service import _parse_analyte_slots

    assert _parse_analyte_slots({"Analyte2Peptide": "", "Analyte3Peptide": None}) == []


def test_positional_consumers_keep_the_senaite_slot_numbers():
    """The three ``Analyte{N}``-by-position readers all see slots 1, 3, 4 --
    never 1, 2, 3 -- for a blend whose slot 2 was cleared."""
    from coa.sample_meta import _analyte_slots
    from sub_samples.registry_details import analytes_from_registry_json
    from sub_samples.registry_inbox import _analyte_slot_fields
    from sub_samples.service import _parse_analyte_slots

    raw = json.dumps(_parse_analyte_slots(META))

    assert set(_analyte_slot_fields(raw)) == {
        "Analyte1Peptide", "Analyte3Peptide", "Analyte4Peptide",
    }

    class _Parent:
        analytes = raw

    assert set(_analyte_slots(_Parent())) == {
        "Analyte1Peptide", "Analyte3Peptide", "Analyte4Peptide",
    }
    assert [a.slot_number for a in analytes_from_registry_json(raw)] == [1, 3, 4]
    assert [a.raw_name for a in analytes_from_registry_json(raw)][1] == (
        "BPC-157 - Identity (HPLC)"
    )


def test_mirror_blank_of_a_middle_slot_keeps_positions(db_session):
    """The dual-write mirror (Clear / inline blank) must not compact either."""
    from sub_samples.service import apply_senaite_fields_to_row

    row = LimsSample(
        sample_id="PB-SLOTS-1", external_lims_uid="U-SLOTS-1",
        analytes=json.dumps([
            {"name": "A", "declared_quantity": "1"},
            {"name": "B", "declared_quantity": "2"},
            {"name": "C", "declared_quantity": "3"},
        ]),
    )
    db_session.add(row)
    db_session.flush()

    ok = apply_senaite_fields_to_row(
        db_session, "U-SLOTS-1",
        {"Analyte2Peptide": "", "Analyte2DeclaredQuantity": ""},
    )
    assert ok is True
    assert json.loads(row.analytes) == [
        {"name": "A", "declared_quantity": "1"},
        {"name": None, "declared_quantity": None},
        {"name": "C", "declared_quantity": "3"},
    ]
    assert row.peptide_name == "A"


def test_mirror_blank_of_the_last_slot_trims_it(db_session):
    from sub_samples.service import apply_senaite_fields_to_row

    row = LimsSample(
        sample_id="PB-SLOTS-2", external_lims_uid="U-SLOTS-2",
        analytes=json.dumps([
            {"name": "A", "declared_quantity": None},
            {"name": "B", "declared_quantity": None},
        ]),
    )
    db_session.add(row)
    db_session.flush()

    apply_senaite_fields_to_row(db_session, "U-SLOTS-2", {"Analyte2Peptide": ""})
    assert json.loads(row.analytes) == [{"name": "A", "declared_quantity": None}]


def test_mirror_blank_of_every_slot_clears_the_list(db_session):
    from sub_samples.service import apply_senaite_fields_to_row

    row = LimsSample(
        sample_id="PB-SLOTS-3", external_lims_uid="U-SLOTS-3",
        analytes=json.dumps([{"name": "A", "declared_quantity": None}]),
    )
    db_session.add(row)
    db_session.flush()

    apply_senaite_fields_to_row(db_session, "U-SLOTS-3", {"Analyte1Peptide": ""})
    assert row.analytes is None
    assert row.peptide_name is None
