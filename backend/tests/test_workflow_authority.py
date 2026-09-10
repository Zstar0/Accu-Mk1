"""registry_read_source.sample_status decides who writes lims_samples.status.
Absent / malformed / unknown value -> 'senaite' (today's behavior)."""
import json

from models import LimsSample, LimsWorkflowState, Settings


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


def test_sample_state_slugs_reads_live_catalog(db_session):
    from workflow.catalog import sample_state_slugs, clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    slugs = sample_state_slugs(db_session)
    assert {"sample_received", "to_be_verified", "verified", "published", "cancelled"} <= slugs
    # a state added at runtime (the Settings -> Workflow pane) is honoured
    db_session.add(LimsWorkflowState(entity_scope="sample", slug="on_hold", label="On hold",
                                     category="active", sort_order=55, is_builtin=False,
                                     is_active=True))
    db_session.flush()
    clear_sample_state_cache()
    assert "on_hold" in sample_state_slugs(db_session)


def test_heal_accepts_runtime_state_in_senaite_mode(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.sample_log import heal_sample_status
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    db_session.add(LimsWorkflowState(entity_scope="sample", slug="on_hold", label="On hold",
                                     category="active", sort_order=55, is_builtin=False,
                                     is_active=True))
    db_session.add(LimsSample(sample_id="P-AUTH-1", status="sample_received"))
    db_session.flush()
    clear_sample_state_cache()
    assert heal_sample_status(db_session, "P-AUTH-1", "on_hold") is True
    assert heal_sample_status(db_session, "P-AUTH-1", "analyzing") is False  # IS vocab, never


def test_heal_in_mk1_mode_only_from_native_sources(db_session):
    from workflow.catalog import clear_sample_state_cache
    from workflow.sample_log import heal_sample_status
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db_session)
    _set(db_session, json.dumps({"sample_status": "mk1"}))
    row = LimsSample(sample_id="P-AUTH-2", status="sample_received")
    db_session.add(row)
    db_session.flush()
    assert heal_sample_status(db_session, "P-AUTH-2", "verified") is False          # senaite default
    assert row.status == "sample_received"
    assert heal_sample_status(db_session, "P-AUTH-2", "verified", source="mk1") is True
    assert row.status == "verified"


def test_sample_state_slugs_falls_back_to_seed_when_catalog_is_empty(db_session):
    """Boot before seed: the table exists but holds no sample states — the
    writers must keep the seed vocabulary, not an empty set."""
    from workflow.catalog import sample_state_slugs, clear_sample_state_cache
    from workflow.seeds import SEED_STATES
    clear_sample_state_cache()
    slugs = sample_state_slugs(db_session)          # nothing seeded in this session
    expected = frozenset(slug for (scope, slug, *_r) in SEED_STATES if scope == "sample")
    assert slugs == expected
