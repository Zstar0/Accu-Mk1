"""registry_read_source.sample_status decides who writes lims_samples.status.
Absent / malformed / unknown value -> 'senaite' (today's behavior)."""
import json

from models import Settings


def _set(db, value):
    row = Settings(key="registry_read_source", value=value)
    db.add(row)
    db.flush()


def test_absent_row_is_senaite(db_session):
    from workflow.authority import sample_status_authority
    assert sample_status_authority(db_session) == "senaite"


def test_key_mk1_is_mk1(db_session):
    from workflow.authority import sample_status_authority
    _set(db_session, json.dumps({"sample_details": "mk1", "sample_status": "mk1"}))
    assert sample_status_authority(db_session) == "mk1"


def test_missing_key_or_bad_value_is_senaite(db_session):
    from workflow.authority import sample_status_authority
    _set(db_session, json.dumps({"sample_details": "mk1", "sample_status": "bogus"}))
    assert sample_status_authority(db_session) == "senaite"


def test_malformed_json_is_senaite(db_session):
    from workflow.authority import sample_status_authority
    _set(db_session, "{not json")
    assert sample_status_authority(db_session) == "senaite"
