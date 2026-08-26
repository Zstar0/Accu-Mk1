"""coa_generation_source: fail-safe reader of the Data Source map's
coa_generation key. Default is ALWAYS senaite."""
import json

import pytest

from coa.source_setting import (COA_SOURCE_KEY, READ_SOURCE_SETTING_KEY,
                                coa_generation_source)
from models import Settings


def _set(db, value):
    row = db.query(Settings).filter(Settings.key == READ_SOURCE_SETTING_KEY).one_or_none()
    if row is None:
        row = Settings(key=READ_SOURCE_SETTING_KEY, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()


def test_absent_row_defaults_senaite(db_session):
    assert coa_generation_source(db_session) == "senaite"


def test_map_without_key_defaults_senaite(db_session):
    _set(db_session, json.dumps({"sample_details": "mk1"}))
    assert coa_generation_source(db_session) == "senaite"


def test_mk1_value_read(db_session):
    _set(db_session, json.dumps({"sample_details": "mk1", COA_SOURCE_KEY: "mk1"}))
    assert coa_generation_source(db_session) == "mk1"


def test_senaite_value_read(db_session):
    _set(db_session, json.dumps({COA_SOURCE_KEY: "senaite"}))
    assert coa_generation_source(db_session) == "senaite"


@pytest.mark.parametrize("raw", ["not json", "[]", json.dumps({"coa_generation": "bogus"}), ""])
def test_malformed_or_unknown_defaults_senaite(db_session, raw):
    _set(db_session, raw)
    assert coa_generation_source(db_session) == "senaite"
