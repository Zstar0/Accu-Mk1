"""In mk1 authority the SENAITE-sourced writers stop touching
lims_samples.status; every other field still mirrors."""
import json
from datetime import datetime, timezone
from unittest.mock import patch

from models import LimsSample, Settings


def _mode(db, authority):
    from workflow.catalog import clear_sample_state_cache
    from workflow.seeds import seed_workflow_catalog
    clear_sample_state_cache()
    seed_workflow_catalog(db)
    db.add(Settings(key="registry_read_source",
                    value=json.dumps({"sample_status": authority})))
    db.flush()


META = {"review_state": "verified", "ClientSampleID": "X-1", "Analyte1Peptide": "BPC-157",
        "getClientTitle": "Acme", "DateReceived": "2026-09-01T00:00:00+00:00"}


def test_refresh_mirrors_fields_but_not_status_in_mk1(db_session):
    from sub_samples.service import _refresh_parent_from_senaite
    _mode(db_session, "mk1")
    row = LimsSample(sample_id="P-GATE-1", status="sample_received",
                     external_lims_uid="U-GATE-1")
    db_session.add(row)
    db_session.flush()
    with patch("sub_samples.senaite.fetch_parent_metadata", return_value=dict(META, uid="U-GATE-1")):
        _refresh_parent_from_senaite(db_session, row)
    assert row.client_sample_id == "X-1"
    assert row.status == "sample_received"


def test_refresh_still_mirrors_status_in_senaite_mode(db_session):
    from sub_samples.service import _refresh_parent_from_senaite
    _mode(db_session, "senaite")
    row = LimsSample(sample_id="P-GATE-2", status="sample_received",
                     external_lims_uid="U-GATE-2")
    db_session.add(row)
    db_session.flush()
    with patch("sub_samples.senaite.fetch_parent_metadata", return_value=dict(META, uid="U-GATE-2")):
        _refresh_parent_from_senaite(db_session, row)
    assert row.status == "verified"


def test_is_event_heal_skipped_in_mk1(db_session):
    from workflow.is_event_stream import _heal_status
    _mode(db_session, "mk1")
    row = LimsSample(sample_id="P-GATE-3", status="sample_received")
    db_session.add(row)
    db_session.flush()
    stats = {"healed": 0, "errors": 0}
    _heal_status(db_session, row.id, "verified", datetime.now(timezone.utc), stats)
    assert row.status == "sample_received"
    assert stats["healed"] == 0
    assert stats.get("skipped_authority") == 1
