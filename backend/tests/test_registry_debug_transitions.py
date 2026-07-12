"""Tests for Task 8: registry-inspect debug panel's recent-transitions tail
(2026-07-07-sample-registry-debug-panel-design.md, Task 8 brief).

Covers `main._build_sample_transitions` (native `lims_sample_transitions`
query — own try/except, own error surface `transitions.error`, same
independent-failure posture as the analyses section built in Task 10; see
test_registry_debug_analyses.py) and its wiring into
`_build_registry_debug_response`'s `"transitions"` key across all three
return paths (row missing -> None, senaite meta missing -> populated,
full happy path -> populated).

House pattern: TestClient(main.app) with `require_admin` dependency-
overridden (test_workflow_catalog_api.py idiom — no `get_db` override, the
app's real dependency talks to the same live dev DB the `SessionLocal()`
fixtures seed into). TEST-prefixed sample_id, FK-safe cleanup (transitions
before the sample row) adapted from test_sample_transition_log.py.

DB-error try/except path is not exercised here: unlike the analyses
section's SENAITE fetch (trivially mocked to raise), there is no clean seam
to force a `lims_sample_transitions` SELECT to fail without monkeypatching
SQLAlchemy internals the test would then be coupled to. The posture (mirror
of the analyses section's `except Exception as e: return {"rows": [],
"error": str(e)}`) is inspectable by code review — same acknowledged gap the
Task 8 brief calls out.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import require_admin
from database import SessionLocal
from models import LimsSample, LimsSampleTransition

TEST_SAMPLE_ID = "TEST-RDT8-PARENT"


# ── fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[require_admin] = (
        lambda: SimpleNamespace(id=1, role="admin", email="admin@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


@pytest.fixture
def seed_parent(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="received",
                        external_lims_uid="SENAITE-UID-RDT8")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id == TEST_SAMPLE_ID))
    db.commit()


def _seed_transitions(db, parent, n: int):
    """`n` rows, occurred_at strictly increasing by 1 minute each (index 0 =
    oldest). to_status = "s{i+1}" so ordering is unambiguous from the row
    content alone."""
    base = datetime(2026, 1, 1, 12, 0, 0)
    rows = []
    for i in range(n):
        r = LimsSampleTransition(
            lims_sample_pk=parent.id, verb=f"v{i}", from_status=f"s{i}",
            to_status=f"s{i + 1}", source="mk1", occurred_at=base + timedelta(minutes=i),
        )
        db.add(r)
        rows.append(r)
    db.commit()
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# main._build_registry_debug_response — "transitions" key
# ═══════════════════════════════════════════════════════════════════════════


def test_newest_5_of_6_returned_desc(db, seed_parent):
    _seed_transitions(db, seed_parent, 6)
    out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)
    tx = out["transitions"]
    assert tx["error"] is None
    assert len(tx["rows"]) == 5
    # Newest (i=5, to_status="s6") first; oldest (i=0, to_status="s1") dropped.
    assert [r["to_status"] for r in tx["rows"]] == ["s6", "s5", "s4", "s3", "s2"]


def test_row_fields_serialized(db, seed_parent):
    _seed_transitions(db, seed_parent, 1)
    out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)
    row = out["transitions"]["rows"][0]
    assert row["verb"] == "v0"
    assert row["from_status"] == "s0"
    assert row["to_status"] == "s1"
    assert row["source"] == "mk1"
    assert row["occurred_at"] == datetime(2026, 1, 1, 12, 0, 0).isoformat()


def test_id_desc_tiebreaks_equal_occurred_at(db, seed_parent):
    """Two rows sharing the same occurred_at: the secondary `id DESC` sort
    key must decide the order (higher id — the later insert — first)."""
    same_ts = datetime(2026, 2, 1, 9, 0, 0)
    r1 = LimsSampleTransition(
        lims_sample_pk=seed_parent.id, verb="a", to_status="s1",
        source="mk1", occurred_at=same_ts,
    )
    r2 = LimsSampleTransition(
        lims_sample_pk=seed_parent.id, verb="b", to_status="s2",
        source="mk1", occurred_at=same_ts,
    )
    db.add_all([r1, r2])
    db.commit()
    assert r2.id > r1.id  # inserted second -> higher autoincrement id

    out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)
    to_statuses = [r["to_status"] for r in out["transitions"]["rows"]]
    assert to_statuses == ["s2", "s1"]


def test_empty_rows_when_no_transitions_logged(db, seed_parent):
    out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)
    assert out["transitions"] == {"rows": [], "error": None}


def test_transitions_none_when_row_missing(db):
    out = main._build_registry_debug_response(db, "TEST-RDT8-NOPE")
    assert out["load"]["exists"] is False
    assert out["transitions"] is None


def test_transitions_populated_on_senaite_meta_missing_path(db, seed_parent):
    """The `meta is None` early-return (senaite fetch_parent_metadata raised)
    must still carry a populated transitions section — same independent-
    failure posture the analyses section already proves for this path."""
    _seed_transitions(db, seed_parent, 2)
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("no AR")):
        out = main._build_registry_debug_response(db, TEST_SAMPLE_ID)
    assert out["senaite_error"] is not None
    assert out["transitions"]["error"] is None
    assert len(out["transitions"]["rows"]) == 2


# ═══════════════════════════════════════════════════════════════════════════
# Endpoint wiring — GET /debug/sample-registry/{sample_id}
# ═══════════════════════════════════════════════════════════════════════════


def test_endpoint_includes_transitions(client, db, seed_parent):
    _seed_transitions(db, seed_parent, 2)
    with patch.object(main.senaite, "fetch_parent_metadata", side_effect=RuntimeError("no AR")):
        r = client.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}")
    assert r.status_code == 200
    body = r.json()
    assert body["transitions"]["error"] is None
    assert len(body["transitions"]["rows"]) == 2
    assert body["transitions"]["rows"][0]["to_status"] == "s2"  # newest first


def test_endpoint_requires_admin():
    # No override -> real require_admin -> unauthenticated request rejected.
    c = TestClient(main.app)
    r = c.get(f"/debug/sample-registry/{TEST_SAMPLE_ID}")
    assert r.status_code in (401, 403)
