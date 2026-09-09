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


def test_refresh_logs_senaite_state_as_reconcile_in_mk1(db_session):
    """The status column is the engine's under mk1 authority, but SENAITE's
    live review_state must still be LOGGED — that row is how a SENAITE-UI
    transition after the flip shows up as a divergence (spec §4.2) and what
    §10's rollback sweep reads."""
    from sqlalchemy import select
    from models import LimsSampleTransition
    from sub_samples.service import _refresh_parent_from_senaite
    _mode(db_session, "mk1")
    row = LimsSample(sample_id="P-GATE-4", status="sample_received",
                     external_lims_uid="U-GATE-4")
    db_session.add(row)
    db_session.flush()
    with patch("sub_samples.senaite.fetch_parent_metadata", return_value=dict(META, uid="U-GATE-4")):
        _refresh_parent_from_senaite(db_session, row)
    assert row.status == "sample_received"        # engine still owns the column
    rows = db_session.execute(select(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk == row.id,
        LimsSampleTransition.source == "reconcile")).scalars().all()
    assert len(rows) == 1
    assert (rows[0].to_status, rows[0].from_status) == ("verified", "sample_received")


def test_is_event_heal_accepts_a_runtime_catalog_state(db_session):
    """spec §7.1: the heal guard reads the LIVE catalog, not the code
    constant, so a state added in the Settings -> Workflow pane heals from IS
    events in senaite mode. The two SENAITE-only legacy values the catalog
    doesn't carry (`rejected`, `stored`) must keep healing too."""
    from models import LimsWorkflowState
    from workflow.catalog import clear_sample_state_cache
    from workflow.is_event_stream import _heal_status
    _mode(db_session, "senaite")
    db_session.add(LimsWorkflowState(entity_scope="sample", slug="on_hold", label="On hold",
                                     category="active", sort_order=55, is_builtin=False,
                                     is_active=True))
    row = LimsSample(sample_id="P-GATE-5", status="sample_received")
    db_session.add(row)
    db_session.flush()
    clear_sample_state_cache()
    stats = {"healed": 0, "errors": 0}
    now = datetime.utcnow()          # occurred_at is NAIVE UTC (is_event_stream docstring)
    _heal_status(db_session, row.id, "on_hold", now, stats)
    assert row.status == "on_hold" and stats["healed"] == 1
    _heal_status(db_session, row.id, "rejected", now, stats)
    assert row.status == "rejected" and stats["healed"] == 2
    _heal_status(db_session, row.id, "analyzing", now, stats)      # IS vocab, never
    assert row.status == "rejected" and stats["healed"] == 2


def test_refresh_reconcile_row_not_repeated_while_diverged_in_mk1(db_session):
    """mk1 authority: the column never converges to SENAITE's state, so a
    diverged sample must not re-log a reconcile row on every page view —
    only when SENAITE's state CHANGES again."""
    from sqlalchemy import select
    from models import LimsSampleTransition
    from sub_samples.service import _refresh_parent_from_senaite
    _mode(db_session, "mk1")
    row = LimsSample(sample_id="P-GATE-5", status="sample_received",
                     external_lims_uid="U-GATE-5")
    db_session.add(row)
    db_session.flush()

    def _rows():
        return db_session.execute(select(LimsSampleTransition).where(
            LimsSampleTransition.lims_sample_pk == row.id,
            LimsSampleTransition.source == "reconcile")).scalars().all()

    with patch("sub_samples.senaite.fetch_parent_metadata", return_value=dict(META, uid="U-GATE-5")):
        _refresh_parent_from_senaite(db_session, row)
        _refresh_parent_from_senaite(db_session, row)      # same SENAITE state again
    assert [r.to_status for r in _rows()] == ["verified"]
    with patch("sub_samples.senaite.fetch_parent_metadata",
               return_value=dict(META, uid="U-GATE-5", review_state="published")):
        _refresh_parent_from_senaite(db_session, row)      # SENAITE moved on
    assert [r.to_status for r in _rows()] == ["verified", "published"]
    assert row.status == "sample_received"
