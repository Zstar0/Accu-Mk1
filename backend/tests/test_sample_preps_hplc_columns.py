"""sample_preps carries what a worksheet-born prep needs for Process HPLC (plan
2026-11-12-hplc-prep-worksheet, Task 2): its form, the declared volume of a liquid, the
capsule count, the diluent, the intermediate vial's three weighings, and the worksheet
item it was promoted from (one prep per item, enforced by a unique partial index).

Runs against the real sample_preps table of the database mk1_db is configured for, and
skips where there is none. Every row it creates is deleted afterwards. Locally:

    HPLC_SCRATCH=t2 bash C:/tmp/hplc-build/local-pytest.sh ws tests/test_sample_preps_hplc_columns.py -q
"""
import psycopg2
import pytest

import mk1_db

NEW_COLUMNS = {
    "prep_form": "character varying",
    "declared_volume_ml": "double precision",
    "capsules_used": "integer",
    "diluent": "character varying",
    "int_vial_empty_mg": "double precision",
    "int_vial_with_diluent_mg": "double precision",
    "int_vial_final_mg": "double precision",
    "worksheet_item_id": "integer",
}
# Far above any real worksheet_items id, so a test never collides with a dev-copy row.
ITEM = 2_000_000_000 - 17


@pytest.fixture
def mk1():
    try:
        mk1_db.ensure_sample_preps_table()
    except psycopg2.OperationalError:
        pytest.skip("no Postgres reachable at the configured MK1_DB_* address")
    created: list[int] = []

    def make(**data):
        row = mk1_db.create_sample_prep({"peptide_id": 1, "status": "awaiting_hplc", **data})
        created.append(row["id"])
        return row

    try:
        yield make
    finally:
        for prep_id in created:
            mk1_db.delete_sample_prep(prep_id)


def test_the_eight_columns_and_the_unique_index_exist(mk1):
    with mk1_db.get_mk1_db() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'sample_preps' AND column_name = ANY(%s)",
            [list(NEW_COLUMNS)],
        )
        found = {name: (dtype, nullable) for name, dtype, nullable in cur.fetchall()}
        cur.execute(
            "SELECT indexdef FROM pg_indexes "
            "WHERE tablename = 'sample_preps' AND indexname = 'uq_sample_preps_worksheet_item'"
        )
        index = cur.fetchone()
    assert found == {name: (dtype, "YES") for name, dtype in NEW_COLUMNS.items()}
    assert index is not None
    assert "UNIQUE" in index[0] and "worksheet_item_id IS NOT NULL" in index[0]


def test_create_and_update_round_trip_the_new_keys(mk1):
    values = {
        "prep_form": "capsule",
        "declared_volume_ml": None,
        "capsules_used": 4,
        "diluent": "Water",
        "int_vial_empty_mg": 500.5,
        "int_vial_with_diluent_mg": 1900.25,
        "int_vial_final_mg": 2000.0,
        "worksheet_item_id": ITEM,
    }
    row = mk1(**values)
    assert {k: row[k] for k in values} == values

    changes = {
        "prep_form": "liquid",
        "declared_volume_ml": 2.5,
        "capsules_used": None,
        "diluent": "50:50 ACN:Water",
        "int_vial_empty_mg": None,
        "int_vial_with_diluent_mg": None,
        "int_vial_final_mg": None,
        "worksheet_item_id": ITEM + 1,
    }
    updated = mk1_db.update_sample_prep(row["id"], changes)
    assert {k: updated[k] for k in changes} == changes
    assert mk1_db.list_sample_preps_for_worksheet_items([ITEM + 1])[0]["id"] == row["id"]


def test_a_vial_data_entry_carries_its_intermediate_weighings(mk1):
    from psycopg2.extras import Json

    entry = {"vial_number": 1, "int_vial_empty_mg": 1.5, "int_vial_with_diluent_mg": 2.5, "int_vial_final_mg": 3.5}
    row = mk1(is_blend=True, vial_data=Json([entry]))
    assert mk1_db.get_sample_prep(row["id"])["vial_data"] == [entry]


def test_two_preps_cannot_share_a_worksheet_item(mk1):
    mk1(worksheet_item_id=ITEM)
    with pytest.raises(psycopg2.IntegrityError):
        mk1(worksheet_item_id=ITEM)


def test_a_prep_with_no_worksheet_item_is_unconstrained(mk1):
    first = mk1(worksheet_item_id=None)
    second = mk1()
    assert first["worksheet_item_id"] is None and second["worksheet_item_id"] is None


def test_list_for_worksheet_items_finds_only_those_items(mk1):
    assert mk1_db.list_sample_preps_for_worksheet_items([]) == []
    a = mk1(worksheet_item_id=ITEM)
    b = mk1(worksheet_item_id=ITEM + 2)
    mk1(worksheet_item_id=ITEM + 3)
    found = mk1_db.list_sample_preps_for_worksheet_items([ITEM, ITEM + 2, ITEM + 4])
    assert sorted((r["id"], r["worksheet_item_id"]) for r in found) == [(a["id"], ITEM), (b["id"], ITEM + 2)]


def test_the_post_deploy_check_wants_the_eight_columns_and_the_index(mk1):
    from scripts.check_hplc_columns import (
        PREPS_EXPECTED,
        PREPS_INDEX,
        evaluate_sample_preps,
    )

    assert set(PREPS_EXPECTED) == set(NEW_COLUMNS) and PREPS_INDEX == "uq_sample_preps_worksheet_item"
    with mk1_db.get_mk1_db() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'sample_preps' AND column_name = ANY(%s)",
            [list(PREPS_EXPECTED)],
        )
        found = {name: (dtype, nullable) for name, dtype, nullable in cur.fetchall()}
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", [PREPS_INDEX])
        indexdef = cur.fetchone()[0]
    assert evaluate_sample_preps(found, indexdef)[1] == 0
    assert evaluate_sample_preps(found, None)[1] == 1
    assert evaluate_sample_preps({k: v for k, v in found.items() if k != "diluent"}, indexdef)[1] == 1
