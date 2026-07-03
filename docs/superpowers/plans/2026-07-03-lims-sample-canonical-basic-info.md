# LimsSample Canonical Basic-Info Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lims_samples` a complete, canonical local registry of sample basic info — one population helper used by create/refresh/backfill, a throttled resumable backfill of every SENAITE sample, and full-field refresh wired into the existing 5-minute reconcile path.

**Architecture:** All population logic consolidates into `_populate_basic_info` in `backend/sub_samples/service.py` (single definition of "basic info"). A new paged enumerator in `backend/sub_samples/senaite.py` feeds a standalone backfill script under `backend/scripts/`. The refresh piggybacks on `_reconcile_from_senaite`, the one existing staleness trigger — no new refresh events, no per-read SENAITE calls.

**Tech Stack:** Python 3.11 / SQLAlchemy 2.0 ORM / FastAPI backend / pytest (sqlite in-memory for unit tests) / SENAITE jsonapi over `requests`.

**Spec:** `C:\tmp\canonical-basic-info\docs\superpowers\specs\2026-07-02-lims-sample-canonical-basic-info-design.md` (approved 2026-07-03). Read it before starting if anything here seems ambiguous — the spec wins.

## Global Constraints

- **Working tree:** `C:\tmp\canonical-basic-info` (git worktree, branch `feat/canonical-basic-info`, remote `Zstar0/Accu-Mk1`). All paths below are relative to this root.
- **Additive only.** No schema changes (every column already exists on `LimsSample`, `backend/models.py:721-780`). No behavior change to SENAITE writes. SENAITE stays the edit surface.
- **SENAITE bulk-scan safety is load-bearing:** SENAITE runs a single Zope core; an unthrottled sweep over ~1,200+ ARs has taken it down for ~15 minutes. The backfill MUST page in modest batches, sleep between every request, run strictly sequentially (concurrency 1), and be resumable. Never weaken these properties.
- **`container_mode` gate must stay state-gated** (`_PRE_RECEIVED_STATES` at `backend/sub_samples/service.py:45`) — never simplify to always-TRUE (memory: container-mode parent is deliberately lazy-first-touch gated).
- **Fields that are NOT basic info** and must never be written by the new helper: `container_mode` (owned by the create-time gate), `assignment_role`, `in_variance_set`/variance fields, `customer_remarks*`, `is_retest`.
- **Git hygiene:** commit with explicit file paths — NEVER `git add -A` (worktrees carry unrelated dirty files).
- **Test baseline:** the repo has ~19 known full-suite failures. Gate on the targeted test files listed per task, not the full suite.
- **Running tests:** primary loop is `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/<file> -q` on the laptop (unit tests are sqlite-only, no Postgres/SENAITE needed). If the laptop lacks the Python deps (first task verifies), fall back to copying files into a running Mk1 backend container: `docker cp backend/. <container>:/app/` then `docker exec <container> sh -c "cd /app && python -m pytest tests/<file> -q"`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/sub_samples/service.py` | Modify | `_parse_senaite_date` + `_populate_basic_info` helpers; `_create_sample_row` split out of `ensure_sample_row`; `_refresh_parent_from_senaite` goes full-field; `_reconcile_from_senaite` gains the best-effort basic-info refresh |
| `backend/sub_samples/senaite.py` | Modify | `iter_all_sample_ids()` paged enumeration (mechanism only — throttling/skipping is the caller's policy) |
| `backend/scripts/__init__.py` | Create | empty package marker |
| `backend/scripts/backfill_lims_sample_basic_info.py` | Create | one-time backfill: enumerate → skip secondaries → fetch-once → upsert; checkpoint/resume, throttle, error isolation, coverage stats |
| `backend/tests/test_lims_sample_basic_info.py` | Create | unit tests for date parsing, the helper, create/refresh/reconcile wiring |
| `backend/tests/test_backfill_basic_info.py` | Create | unit tests for the enumerator and the backfill script |

---

### Task 1: `_parse_senaite_date` helper

**Files:**
- Modify: `backend/sub_samples/service.py` (add helper near `_extract_label`, ~line 113; extend the `datetime` import on line 15)
- Test: `backend/tests/test_lims_sample_basic_info.py` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `_parse_senaite_date(value) -> Optional[datetime]` in `sub_samples/service.py` — Task 2's `_populate_basic_info` calls it for `DateReceived`/`DateSampled`.

- [ ] **Step 1: Sanity-check the test environment**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_sub_samples_service.py -q`
Expected: mostly passing (a couple of baseline failures are acceptable if they reproduce on the untouched tree — check `git stash` state is clean first). If `pytest`/imports are missing on the laptop, use the container fallback from Global Constraints for every test step in this plan.

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_lims_sample_basic_info.py`:

```python
"""Unit tests for the canonical basic-info registry
(2026-07-02-lims-sample-canonical-basic-info-design.md)."""
import pytest
from datetime import datetime
from unittest.mock import patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsSample, LimsSubSample
from sub_samples import service
from sub_samples.service import (
    _parse_senaite_date,
    ensure_sample_row,
    list_sub_samples,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def _full_meta(**overrides):
    """A fetch_parent_metadata payload carrying the FULL basic-info set,
    shaped like the raw complete=true item (dates as ISO strings with
    offset, reference fields as dicts)."""
    meta = {
        "uid": "PARENT_UID",
        "ClientUID": "C_UID",
        "ClientID": "client-8",
        "ContactUID": "CT_UID",
        "SampleType": {"uid": "ST_UID", "url": "http://senaite/st"},
        "ClientSampleID": "CS-001",
        "Analyte1Peptide": {"uid": "PEP_UID", "title": "BPC-157"},
        "DateReceived": "2026-05-01T10:23:00+00:00",
        "DateSampled": "2026-04-30T08:00:00+02:00",
        "review_state": "received",
    }
    meta.update(overrides)
    return meta


# --- _parse_senaite_date -----------------------------------------------------

def test_parse_date_offset_string_to_naive_utc():
    assert _parse_senaite_date("2026-05-01T10:23:00+00:00") == datetime(2026, 5, 1, 10, 23, 0)


def test_parse_date_nonzero_offset_normalized_to_utc():
    # +02:00 → UTC is two hours earlier
    assert _parse_senaite_date("2026-04-30T08:00:00+02:00") == datetime(2026, 4, 30, 6, 0, 0)


def test_parse_date_trailing_z():
    assert _parse_senaite_date("2026-05-01T10:23:00Z") == datetime(2026, 5, 1, 10, 23, 0)


def test_parse_date_naive_string_kept_naive():
    assert _parse_senaite_date("2026-05-01T10:23:00") == datetime(2026, 5, 1, 10, 23, 0)


def test_parse_date_none_empty_garbage():
    assert _parse_senaite_date(None) is None
    assert _parse_senaite_date("") is None
    assert _parse_senaite_date("not-a-date") is None
    assert _parse_senaite_date({"uid": "X"}) is None  # non-string never raises
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py -q`
Expected: FAIL — `ImportError: cannot import name '_parse_senaite_date'`

- [ ] **Step 4: Implement the helper**

In `backend/sub_samples/service.py`, change line 15 from
`from datetime import datetime, timedelta` to
`from datetime import datetime, timedelta, timezone`, then add after `_extract_label` (after line 112):

```python
def _parse_senaite_date(value) -> Optional[datetime]:
    """SENAITE serializes dates as ISO-8601 strings, usually with a TZ offset
    (e.g. '2026-05-01T10:23:00+00:00'), occasionally with a trailing 'Z'.
    lims_samples date columns are naive UTC (datetime.utcnow() convention),
    so normalize aware → UTC and strip tzinfo. Returns None for empty or
    unparseable values — basic-info population is best-effort, never fatal."""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        log.debug("sub_samples.basic_info: unparseable SENAITE date %r", value)
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py -q`
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/tests/test_lims_sample_basic_info.py
git commit -m "feat(registry): SENAITE ISO date parser for basic-info population"
```

---

### Task 2: `_populate_basic_info` + create-path refactor

**Files:**
- Modify: `backend/sub_samples/service.py` (`ensure_sample_row` at :48-86; new `_populate_basic_info` + `_create_sample_row`)
- Test: `backend/tests/test_lims_sample_basic_info.py` (extend)

**Interfaces:**
- Consumes: `_parse_senaite_date` (Task 1), existing `_extract_uid`/`_extract_label`.
- Produces:
  - `_populate_basic_info(row: LimsSample, meta: dict) -> None` — writes the full basic-info field set + `last_synced_at`; Tasks 3 and 6 call it.
  - `_create_sample_row(db: Session, parent_sample_id: str, meta: dict) -> LimsSample` — constructs + populates + flushes a new row (owns the `container_mode` gate); Task 6's backfill calls it so the gate is defined in exactly one place.
  - `ensure_sample_row(db, parent_sample_id) -> LimsSample` — unchanged signature/behavior, now also sets the dates on create.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_lims_sample_basic_info.py`:

```python
# --- _populate_basic_info + create path -------------------------------------

def test_populate_basic_info_writes_full_field_set(db):
    row = LimsSample(sample_id="P-0134")
    service._populate_basic_info(row, _full_meta())
    assert row.external_lims_uid == "PARENT_UID"
    assert row.external_lims_system == "senaite"
    assert row.client_id == "client-8"
    assert row.client_uid == "C_UID"
    assert row.contact_uid == "CT_UID"
    assert row.sample_type == "ST_UID"            # uid-extracted from dict
    assert row.client_sample_id == "CS-001"
    assert row.peptide_name == "BPC-157"          # label-extracted from dict
    assert row.date_received == datetime(2026, 5, 1, 10, 23, 0)
    assert row.date_sampled == datetime(2026, 4, 30, 6, 0, 0)  # +02:00 → UTC
    assert row.status == "received"
    assert row.last_synced_at is not None


def test_populate_basic_info_never_touches_non_basic_fields(db):
    row = LimsSample(sample_id="P-0134", container_mode=True,
                     assignment_role="ster", in_variance_set=False)
    service._populate_basic_info(row, _full_meta())
    assert row.container_mode is True
    assert row.assignment_role == "ster"
    assert row.in_variance_set is False


def test_ensure_sample_row_now_sets_dates_on_create(db):
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()):
        row = ensure_sample_row(db, "P-0134")
    assert row.date_received == datetime(2026, 5, 1, 10, 23, 0)
    assert row.date_sampled == datetime(2026, 4, 30, 6, 0, 0)
    assert row.client_sample_id == "CS-001"


def test_create_gate_container_mode_still_state_gated(db):
    # received at first touch → legacy (parent-is-vial-1), NOT container
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta(review_state="received")):
        received = ensure_sample_row(db, "P-0200")
    assert received.container_mode is False
    # pre-received at first touch → container family
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta(uid="U2", review_state="sample_due")):
        due = ensure_sample_row(db, "P-0201")
    assert due.container_mode is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py -q`
Expected: the 4 new tests FAIL (`AttributeError: module ... has no attribute '_populate_basic_info'`; dates `None`); Task 1's 5 still pass.

- [ ] **Step 3: Implement**

In `backend/sub_samples/service.py`, add after `_parse_senaite_date`:

```python
def _populate_basic_info(row: LimsSample, meta: dict) -> None:
    """Write the FULL canonical basic-info field set from a
    fetch_parent_metadata payload (the raw complete=true item). The single
    definition of "basic info" — create (ensure_sample_row), refresh
    (_refresh_parent_from_senaite), and the backfill script all route through
    here so rows come out identical and complete
    (2026-07-02-lims-sample-canonical-basic-info-design.md).

    Deliberately NOT basic info (owned elsewhere — never write here):
    container_mode, assignment_role, variance fields, customer_remarks*,
    is_retest."""
    row.external_lims_uid = meta.get("uid")
    row.external_lims_system = "senaite"
    row.client_id = meta.get("ClientID")
    row.client_uid = _extract_uid(meta.get("ClientUID") or meta.get("Client"))
    row.contact_uid = _extract_uid(meta.get("ContactUID") or meta.get("Contact"))
    row.sample_type = _extract_uid(meta.get("SampleType"))
    row.client_sample_id = meta.get("ClientSampleID")
    row.peptide_name = _extract_label(meta.get("Analyte1Peptide"))
    row.date_received = _parse_senaite_date(meta.get("DateReceived"))
    row.date_sampled = _parse_senaite_date(meta.get("DateSampled"))
    row.status = meta.get("review_state")
    row.last_synced_at = datetime.utcnow()


def _create_sample_row(db: Session, parent_sample_id: str, meta: dict) -> LimsSample:
    """Construct + populate + flush a new lims_samples row from an
    already-fetched meta payload. Owns the container_mode first-touch gate —
    the backfill script reuses this so the gate is defined exactly once."""
    row = LimsSample(
        sample_id=parent_sample_id,
        # Container family iff this row is born BEFORE check-in: pre-received
        # families have no parent-as-vial-1 history, so they start as pure
        # report depositories (2026-06-10-container-parent-design.md).
        # Already-received families predate the cutover -> legacy.
        container_mode=meta.get("review_state") in _PRE_RECEIVED_STATES,
    )
    _populate_basic_info(row, meta)
    db.add(row)
    db.flush()
    return row
```

Then replace the body of `ensure_sample_row` (keep its docstring) so lines 55-86 become:

```python
    existing = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()
    if existing:
        return existing

    meta = senaite.fetch_parent_metadata(parent_sample_id)
    return _create_sample_row(db, parent_sample_id, meta)
```

(The old inline `LimsSample(...)` construction — including its comments about `Analyte1Peptide` and container_mode — moves into the two new helpers; delete it from `ensure_sample_row`.)

- [ ] **Step 4: Run the new tests AND the existing sub-samples suites**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py tests/test_sub_samples_service.py tests/test_container_mode.py tests/test_customer_remarks.py -q`
Expected: all pass (`test_sub_samples_service` / `test_container_mode` exercise `ensure_sample_row` with date-less metas — dates simply come out `None`). Any failure here that also reproduces on the pre-task tree is baseline; anything else is a regression you introduced.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/tests/test_lims_sample_basic_info.py
git commit -m "feat(registry): consolidate basic-info population into _populate_basic_info (create path)"
```

---

### Task 3: Full-field refresh in `_refresh_parent_from_senaite`

**Files:**
- Modify: `backend/sub_samples/service.py:115-124` (`_refresh_parent_from_senaite`)
- Test: `backend/tests/test_lims_sample_basic_info.py` (extend)

**Interfaces:**
- Consumes: `_populate_basic_info` (Task 2).
- Produces: `_refresh_parent_from_senaite(db, parent) -> None` — same signature, now writes the full field set. Task 4 wires it into the reconcile path.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_lims_sample_basic_info.py`:

```python
# --- full-field refresh ------------------------------------------------------

def test_refresh_writes_full_set_not_subset(db):
    """Rev-1 gap: refresh only wrote 5 fields, letting client_sample_id,
    peptide_name, client_id and the dates go stale forever."""
    db.add(LimsSample(sample_id="P-0134", external_lims_uid="OLD_UID",
                      client_sample_id="STALE-CSID", peptide_name="Old Peptide",
                      client_id="old-client"))
    db.commit()
    parent = db.query(LimsSample).filter_by(sample_id="P-0134").one()
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()):
        service._refresh_parent_from_senaite(db, parent)
    assert parent.external_lims_uid == "PARENT_UID"
    assert parent.client_sample_id == "CS-001"      # the real drift source
    assert parent.peptide_name == "BPC-157"
    assert parent.client_id == "client-8"
    assert parent.date_received == datetime(2026, 5, 1, 10, 23, 0)
    assert parent.status == "received"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py::test_refresh_writes_full_set_not_subset -q`
Expected: FAIL — `client_sample_id` still `"STALE-CSID"`

- [ ] **Step 3: Implement**

Replace the body of `_refresh_parent_from_senaite` (`service.py:115-124`) with:

```python
def _refresh_parent_from_senaite(db: Session, parent: LimsSample) -> None:
    """Refresh the cached lims_samples row from SENAITE in place. Writes the
    FULL basic-info set via _populate_basic_info (it used to write a 5-field
    subset, which let client_sample_id / peptide_name / client_id / dates go
    permanently stale)."""
    meta = senaite.fetch_parent_metadata(parent.sample_id)
    _populate_basic_info(parent, meta)
    db.flush()
```

- [ ] **Step 4: Run targeted suites**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py tests/test_sub_samples_service.py -q`
Expected: all pass (the stale-UID-retry test at `test_sub_samples_service.py:97` still sees `fetch_parent_metadata` called twice — the refresh's fetch count is unchanged).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/tests/test_lims_sample_basic_info.py
git commit -m "feat(registry): refresh writes the full basic-info set"
```

---

### Task 4: Piggyback basic-info refresh on `_reconcile_from_senaite`

**Files:**
- Modify: `backend/sub_samples/service.py:447-505` (`_reconcile_from_senaite`)
- Test: `backend/tests/test_lims_sample_basic_info.py` (extend)

**Interfaces:**
- Consumes: `_refresh_parent_from_senaite` (Task 3).
- Produces: no new symbols — `_reconcile_from_senaite` (triggered by `list_sub_samples` when `last_synced_at` > 5-min `CACHE_FRESHNESS`) now refreshes parent basic info first, best-effort.

**Design decisions locked by the spec:**
1. Refresh fires for ANY parent with `external_lims_uid` — **including Model-D native families** (their parent AR still lives in SENAITE; only the sub-sample set is Mk1-owned), so it goes BEFORE the Model-D early-return.
2. **Best-effort:** a SENAITE hiccup must not break `list_sub_samples` (today the reconcile path can propagate errors; do not add a new failure mode). Wrap in try/except, log a warning.
3. Cost note: `fetch_parent_metadata` is two GETs (id-lookup + uid-detail), added only on the ≥5-min-stale path.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_lims_sample_basic_info.py`:

```python
# --- reconcile piggyback -----------------------------------------------------
from datetime import timedelta


def _stale_parent(db, **kw):
    row = LimsSample(sample_id="P-0134", external_lims_uid="PARENT_UID",
                     client_sample_id="STALE-CSID",
                     last_synced_at=datetime.utcnow() - timedelta(minutes=10),
                     **kw)
    db.add(row)
    db.commit()
    return row


def test_stale_list_view_refreshes_basic_info(db):
    _stale_parent(db)
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()) as fpm, \
         patch("sub_samples.service.senaite.fetch_secondaries", return_value=[]):
        parent, _subs = list_sub_samples(db, "P-0134")
    fpm.assert_called_once()
    assert parent.client_sample_id == "CS-001"
    assert parent.date_received == datetime(2026, 5, 1, 10, 23, 0)


def test_fresh_parent_skips_refresh(db):
    row = LimsSample(sample_id="P-0134", external_lims_uid="PARENT_UID",
                     last_synced_at=datetime.utcnow())
    db.add(row)
    db.commit()
    with patch("sub_samples.service.senaite.fetch_parent_metadata") as fpm:
        list_sub_samples(db, "P-0134")
    fpm.assert_not_called()


def test_refresh_failure_does_not_break_list(db):
    _stale_parent(db)
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               side_effect=RuntimeError("senaite down")), \
         patch("sub_samples.service.senaite.fetch_secondaries", return_value=[]):
        parent, subs = list_sub_samples(db, "P-0134")   # must not raise
    assert parent.client_sample_id == "STALE-CSID"      # stale but served


def test_native_family_still_gets_basic_info_refresh(db, monkeypatch):
    """Model-D guard skips the SUB-SAMPLE pull, not the parent refresh —
    a native family's parent AR still lives in SENAITE."""
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    _stale_parent(db)
    with patch("sub_samples.service.senaite.fetch_parent_metadata",
               return_value=_full_meta()) as fpm, \
         patch("sub_samples.service.senaite.fetch_secondaries") as fsec:
        parent, _subs = list_sub_samples(db, "P-0134")
    fpm.assert_called_once()          # basic info refreshed
    fsec.assert_not_called()          # Model-D: sub-sample pull skipped
    assert parent.client_sample_id == "CS-001"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py -q`
Expected: `test_stale_list_view_refreshes_basic_info` and `test_native_family_still_gets_basic_info_refresh` FAIL (`fetch_parent_metadata` never called); the other two may pass already — that's fine, they pin the invariants.

- [ ] **Step 3: Implement**

In `_reconcile_from_senaite`, insert between the `if not parent.external_lims_uid: return` guard (line 458-459) and the Model-D guard comment (line 461):

```python
    # Basic-info freshness piggyback (2026-07-02 canonical basic-info spec):
    # this staleness path is the one existing re-sync trigger, so refresh the
    # parent's basic info here too. Runs BEFORE the Model-D guard on purpose —
    # native families' parent AR still lives in SENAITE (only the sub-sample
    # set is Mk1-owned). Best-effort: a SENAITE hiccup must not take down
    # list_sub_samples; stale-but-served beats 500.
    try:
        _refresh_parent_from_senaite(db, parent)
    except Exception as e:
        log.warning(
            "sub_samples.basic_info_refresh_failed parent=%s err=%s",
            parent.sample_id, e,
        )
```

Also update the function's docstring first line to mention it: after `"""SENAITE is canonical; insert SENAITE-only sub-samples missing locally.` add a line `Also refreshes the parent's basic info (best-effort) — the 5-minute staleness trigger doubles as the registry's eventual-consistency mechanism.`

- [ ] **Step 4: Run targeted suites**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py tests/test_sub_samples_service.py tests/test_sub_samples_cutover.py tests/test_container_mode.py -q`
Expected: all pass. Watch specifically for existing tests that call `list_sub_samples` with a stale parent and no `fetch_parent_metadata` patch — the try/except means they still pass (refresh fails quietly); if any test asserts on log records and now sees the new warning, adjust that test's expectation, not the code.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/service.py backend/tests/test_lims_sample_basic_info.py
git commit -m "feat(registry): wire basic-info refresh into the 5-min reconcile path"
```

---

### Task 5: SENAITE paged enumeration `iter_all_sample_ids`

**Files:**
- Modify: `backend/sub_samples/senaite.py` (add after `fetch_parent_metadata`, ~line 259)
- Test: `backend/tests/test_backfill_basic_info.py` (create)

**Interfaces:**
- Consumes: existing `_get` + `SENAITE_BASE_URL` module globals in `senaite.py`.
- Produces: `iter_all_sample_ids(batch_size: int = 50, start: int = 0) -> Iterator[tuple[str, int]]` — yields `(sample_id, b_start_of_its_page)`; Task 6's backfill consumes it. Mechanism only: no sleeping, no filtering — that's the caller's policy.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_backfill_basic_info.py`:

```python
"""Unit tests for the basic-info backfill: enumeration, upsert, safety rails
(2026-07-02-lims-sample-canonical-basic-info-design.md)."""
import json
import pytest
from datetime import datetime
from unittest.mock import patch, MagicMock, call
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsSample
from sub_samples import senaite


@pytest.fixture
def db_factory():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _page(ids):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"items": [{"id": i, "uid": f"UID-{i}"} for i in ids]}
    return resp


# --- iter_all_sample_ids -----------------------------------------------------

def test_enumeration_pages_until_empty():
    pages = [_page(["P-0001", "P-0002"]), _page(["P-0003"]), _page([])]
    with patch("sub_samples.senaite._get", side_effect=pages) as g:
        out = list(senaite.iter_all_sample_ids(batch_size=2))
    assert out == [("P-0001", 0), ("P-0002", 0), ("P-0003", 2)]
    # b_start advanced by batch_size each page
    starts = [c.kwargs["params"]["b_start"] if "params" in c.kwargs
              else c.args[1]["b_start"] if len(c.args) > 1 else c.kwargs.get("params", {}).get("b_start")
              for c in g.call_args_list]
    assert g.call_count == 3


def test_enumeration_resumes_from_start_cursor():
    pages = [_page(["P-0101"]), _page([])]
    with patch("sub_samples.senaite._get", side_effect=pages) as g:
        out = list(senaite.iter_all_sample_ids(batch_size=50, start=100))
    assert out == [("P-0101", 100)]
    first_params = g.call_args_list[0].kwargs.get("params") or g.call_args_list[0].args[1]
    assert first_params["b_start"] == 100


def test_enumeration_raises_on_http_error():
    resp = MagicMock()
    resp.status_code = 500
    resp.text = "boom"
    with patch("sub_samples.senaite._get", return_value=resp):
        with pytest.raises(RuntimeError, match="enumerate"):
            list(senaite.iter_all_sample_ids())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_backfill_basic_info.py -q`
Expected: FAIL — `AttributeError: module ... has no attribute 'iter_all_sample_ids'`

- [ ] **Step 3: Implement**

In `backend/sub_samples/senaite.py`, add after `fetch_parent_metadata` (after line 258). Also add `Iterator, Tuple` to the `typing` import on line 18 (`from typing import Optional, List, Any, Iterator, Tuple`):

```python
def iter_all_sample_ids(batch_size: int = 50, start: int = 0) -> Iterator[Tuple[str, int]]:
    """Yield (sample_id, page_b_start) for EVERY AnalysisRequest in SENAITE,
    paged via b_size/b_start against the plain list endpoint (minimal
    projection — deliberately NOT complete=true; per-sample detail is the
    caller's separate, throttled fetch).

    Yields the page cursor alongside each id so callers can checkpoint and
    resume via `start`. NOTE: includes secondary ARs (…-S01) and retests —
    filtering is caller policy. Mechanism only: no sleeping here; bulk-scan
    throttling (single Zope core!) is the caller's responsibility."""
    b_start = start
    while True:
        resp = _get(
            f"{SENAITE_BASE_URL}/@@API/senaite/v1/AnalysisRequest",
            params={"b_size": batch_size, "b_start": b_start, "sort_on": "created"},
        )
        if resp.status_code >= 300:
            raise RuntimeError(
                f"SENAITE enumerate failed ({resp.status_code}): {resp.text}"
            )
        items = resp.json().get("items", [])
        if not items:
            return
        for item in items:
            sid = item.get("id")
            if sid:
                yield sid, b_start
        b_start += batch_size
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_backfill_basic_info.py -q`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/sub_samples/senaite.py backend/tests/test_backfill_basic_info.py
git commit -m "feat(registry): paged SENAITE AnalysisRequest enumeration for the backfill"
```

---

### Task 6: Backfill core — skip secondaries, fetch-once, upsert, error isolation

**Files:**
- Create: `backend/scripts/__init__.py` (empty)
- Create: `backend/scripts/backfill_lims_sample_basic_info.py`
- Test: `backend/tests/test_backfill_basic_info.py` (extend)

**Interfaces:**
- Consumes: `senaite.iter_all_sample_ids` (Task 5), `senaite.fetch_parent_metadata`, `service._create_sample_row` + `service._populate_basic_info` (Task 2), `database.SessionLocal`.
- Produces: `backfill(db_factory, *, sleep_s, batch_size, checkpoint_path, dry_run, limit) -> dict` (stats) and `load_checkpoint`/`save_checkpoint` in the script module. Task 7 adds the CLI around them.

**CRITICAL — skip secondary ARs:** SENAITE's `AnalysisRequest` listing includes sub-sample secondaries (id format `<parent>-S<NN>`, e.g. `P-0134-S01`, per the `LimsSubSample` docstring at `backend/models.py:788-790`). Creating `lims_samples` rows for those would register vials as parents. The backfill must skip any id matching `-S\d+`. Plain retests (`P-0134-R01`) are real ARs and ARE backfilled.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_backfill_basic_info.py`:

```python
# --- backfill core -----------------------------------------------------------
from scripts.backfill_lims_sample_basic_info import backfill


def _full_meta(sid="P-0001", state="received"):
    return {
        "uid": f"UID-{sid}", "ClientUID": "C_UID", "ClientID": "client-8",
        "ContactUID": "CT_UID", "SampleType": "ST_UID",
        "ClientSampleID": f"CS-{sid}", "Analyte1Peptide": "BPC-157",
        "DateReceived": "2026-05-01T10:23:00+00:00",
        "DateSampled": "2026-04-30T08:00:00+00:00",
        "review_state": state,
    }


def _run(db_factory, ids, metas=None, tmp_path=None, **kw):
    """Drive backfill() with mocked enumeration + per-sample fetch."""
    metas = metas or {i: _full_meta(i) for i, _ in ids}
    ckpt = str((tmp_path / "ckpt.json")) if tmp_path else "/tmp/test-ckpt.json"
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep") as slp:
        sen.iter_all_sample_ids.return_value = iter(ids)
        sen.fetch_parent_metadata.side_effect = (
            lambda sid: metas[sid] if not isinstance(metas.get(sid), Exception)
            else (_ for _ in ()).throw(metas[sid])
        )
        stats = backfill(db_factory, sleep_s=0.5, batch_size=50,
                         checkpoint_path=ckpt, dry_run=False, limit=None, **kw)
    return stats, sen, slp


def test_backfill_creates_missing_and_updates_existing(db_factory, tmp_path):
    db = db_factory()
    db.add(LimsSample(sample_id="P-0002", external_lims_uid="OLD",
                      client_sample_id="STALE"))
    db.commit(); db.close()

    stats, sen, _ = _run(db_factory, [("P-0001", 0), ("P-0002", 0)], tmp_path=tmp_path)
    assert stats["created"] == 1 and stats["updated"] == 1 and stats["errors"] == 0

    db = db_factory()
    created = db.query(LimsSample).filter_by(sample_id="P-0001").one()
    assert created.date_received == datetime(2026, 5, 1, 10, 23, 0)
    updated = db.query(LimsSample).filter_by(sample_id="P-0002").one()
    assert updated.client_sample_id == "CS-P-0002"     # refreshed, not stale
    db.close()


def test_backfill_skips_secondary_ars(db_factory, tmp_path):
    stats, sen, _ = _run(db_factory,
                         [("P-0001", 0), ("P-0001-S01", 0), ("P-0001-S02-R01", 0)],
                         metas={"P-0001": _full_meta("P-0001")}, tmp_path=tmp_path)
    assert stats["skipped_secondary"] == 2
    # fetch never even attempted for secondaries
    sen.fetch_parent_metadata.assert_called_once_with("P-0001")
    db = db_factory()
    assert db.query(LimsSample).count() == 1
    db.close()


def test_backfill_fetches_once_per_sample(db_factory, tmp_path):
    _, sen, _ = _run(db_factory, [("P-0001", 0)], tmp_path=tmp_path)
    assert sen.fetch_parent_metadata.call_count == 1


def test_backfill_one_error_does_not_abort(db_factory, tmp_path):
    metas = {"P-0001": RuntimeError("senaite hiccup"), "P-0002": _full_meta("P-0002")}
    stats, _, _ = _run(db_factory, [("P-0001", 0), ("P-0002", 0)],
                       metas=metas, tmp_path=tmp_path)
    assert stats["errors"] == 1 and stats["created"] == 1


def test_backfill_throttles_between_samples(db_factory, tmp_path):
    _, _, slp = _run(db_factory, [("P-0001", 0), ("P-0002", 0)], tmp_path=tmp_path)
    assert slp.call_count >= 2 and slp.call_args == call(0.5)


def test_backfill_dry_run_writes_nothing(db_factory, tmp_path):
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"):
        sen.iter_all_sample_ids.return_value = iter([("P-0001", 0)])
        sen.fetch_parent_metadata.return_value = _full_meta("P-0001")
        stats = backfill(db_factory, sleep_s=0, batch_size=50,
                         checkpoint_path=str(tmp_path / "c.json"),
                         dry_run=True, limit=None)
    db = db_factory()
    assert db.query(LimsSample).count() == 0
    assert stats["seen"] == 1
    db.close()


def test_backfill_respects_limit(db_factory, tmp_path):
    stats, _, _ = _run(db_factory,
                       [("P-0001", 0), ("P-0002", 0), ("P-0003", 0)],
                       tmp_path=tmp_path, limit=2)
    assert stats["seen"] == 2


def test_backfill_container_mode_gate_applies(db_factory, tmp_path):
    metas = {"P-0001": _full_meta("P-0001", state="received"),
             "P-0002": _full_meta("P-0002", state="sample_due")}
    _run(db_factory, [("P-0001", 0), ("P-0002", 0)], metas=metas, tmp_path=tmp_path)
    db = db_factory()
    assert db.query(LimsSample).filter_by(sample_id="P-0001").one().container_mode is False
    assert db.query(LimsSample).filter_by(sample_id="P-0002").one().container_mode is True
    db.close()
```

Note the `limit` kwarg flows through `_run(**kw)` into `backfill(...)` — `_run` passes `limit=None` by default; `test_backfill_respects_limit` overrides it. Adjust `_run` so `**kw` overrides its defaults:

```python
        kwargs = dict(sleep_s=0.5, batch_size=50, checkpoint_path=ckpt,
                      dry_run=False, limit=None)
        kwargs.update(kw)
        stats = backfill(db_factory, **kwargs)
```

(Use this version of `_run` when writing the file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_backfill_basic_info.py -q`
Expected: new tests FAIL — `ModuleNotFoundError: No module named 'scripts'`

- [ ] **Step 3: Implement**

Create empty `backend/scripts/__init__.py`, then `backend/scripts/backfill_lims_sample_basic_info.py`:

```python
"""One-time backfill: populate lims_samples with COMPLETE basic info for every
SENAITE AnalysisRequest (2026-07-02-lims-sample-canonical-basic-info-design.md).

Run INSIDE the backend container so the app's modules and env are available:

    docker exec -w /app -i <backend-container> \
        python -m scripts.backfill_lims_sample_basic_info --sleep 0.5 --batch-size 50

Idempotent: re-running only fills gaps / refreshes; never duplicates. Resumable
via --checkpoint (JSON file holding the last page cursor). Use --dry-run for an
enumerate-only rehearsal and --limit N for a smoke run.

SENAITE BULK-SCAN SAFETY (load-bearing — do not "optimize" away): SENAITE runs
a single Zope core; an unthrottled jsonapi sweep over the full ~1,200+ AR set
has taken it down for ~15 minutes before. This script therefore pages in modest
batches, sleeps between EVERY per-sample fetch, runs strictly sequentially
(concurrency 1), and must be run off-hours.

The final stats line on stdout is the ISO 17025 coverage evidence (7.4.2 /
7.11.2) — retain it with the run record.
"""
import argparse
import json
import logging
import os
import re
import sys
import time

# Make the /app package root importable when run as a file (python -m from
# /app makes this a no-op).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from database import SessionLocal
from models import LimsSample
from sub_samples import senaite
from sub_samples.service import _create_sample_row, _populate_basic_info

log = logging.getLogger("backfill_basic_info")

# Sub-sample secondaries use `<parent>-S<NN>` ids (models.LimsSubSample); they
# are vials, NOT parents — creating lims_samples rows for them would corrupt
# the registry. Matches anywhere so `P-0134-S01-R01` (secondary retest) is
# also excluded. Plain retests (P-0134-R01) ARE backfilled.
_SECONDARY_ID = re.compile(r"-S\d+")

DEFAULT_CHECKPOINT = "/tmp/backfill_lims_sample_basic_info.checkpoint.json"


def load_checkpoint(path: str) -> int:
    """Return the b_start cursor to resume from (0 = fresh run)."""
    try:
        with open(path) as f:
            return int(json.load(f).get("b_start", 0))
    except (OSError, ValueError):
        return 0


def save_checkpoint(path: str, b_start: int, last_id: str) -> None:
    """Persist the page cursor. Page-granular: resuming re-processes the
    current page, which is safe because the upsert is idempotent."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"b_start": b_start, "last_id": last_id}, f)
    os.replace(tmp, path)


def backfill(db_factory, *, sleep_s: float, batch_size: int,
             checkpoint_path: str, dry_run: bool, limit) -> dict:
    """Enumerate every SENAITE AR; for each PARENT id, fetch meta ONCE and
    upsert the full basic-info set. One sample's failure never aborts the run.
    Returns coverage stats."""
    stats = {"seen": 0, "created": 0, "updated": 0,
             "skipped_secondary": 0, "errors": 0}
    start = load_checkpoint(checkpoint_path)
    if start:
        log.info("resuming from checkpoint b_start=%s", start)

    for sample_id, b_start in senaite.iter_all_sample_ids(
            batch_size=batch_size, start=start):
        if limit is not None and stats["seen"] >= limit:
            break
        stats["seen"] += 1

        if _SECONDARY_ID.search(sample_id):
            stats["skipped_secondary"] += 1
            continue

        try:
            meta = senaite.fetch_parent_metadata(sample_id)  # fetch ONCE
            if not dry_run:
                db = db_factory()
                try:
                    row = db.execute(
                        select(LimsSample).where(LimsSample.sample_id == sample_id)
                    ).scalar_one_or_none()
                    if row is None:
                        _create_sample_row(db, sample_id, meta)
                        stats["created"] += 1
                    else:
                        _populate_basic_info(row, meta)
                        stats["updated"] += 1
                    db.commit()
                finally:
                    db.close()
        except Exception as e:
            stats["errors"] += 1
            log.warning("backfill error sample=%s err=%s", sample_id, e)

        save_checkpoint(checkpoint_path, b_start, sample_id)
        time.sleep(sleep_s)  # bulk-scan safety: throttle EVERY sample

    log.info("backfill done: %s", stats)
    return stats
```

(CLI `main()` comes in Task 7 — this task ends with the importable core.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_backfill_basic_info.py tests/test_lims_sample_basic_info.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/scripts/__init__.py backend/scripts/backfill_lims_sample_basic_info.py backend/tests/test_backfill_basic_info.py
git commit -m "feat(registry): throttled resumable basic-info backfill core (skips secondary ARs)"
```

---

### Task 7: Backfill CLI + checkpoint round-trip

**Files:**
- Modify: `backend/scripts/backfill_lims_sample_basic_info.py` (add `main()`)
- Test: `backend/tests/test_backfill_basic_info.py` (extend)

**Interfaces:**
- Consumes: `backfill`, `load_checkpoint`, `save_checkpoint` (Task 6).
- Produces: `main(argv: list[str] | None = None) -> int` — argparse CLI; stats JSON printed to stdout as the coverage/evidence line.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_backfill_basic_info.py`:

```python
# --- checkpoint + CLI --------------------------------------------------------
from scripts.backfill_lims_sample_basic_info import (
    load_checkpoint, save_checkpoint, main,
)


def test_checkpoint_round_trip(tmp_path):
    p = str(tmp_path / "ckpt.json")
    assert load_checkpoint(p) == 0                    # missing file → fresh
    save_checkpoint(p, 150, "P-0150")
    assert load_checkpoint(p) == 150
    (tmp_path / "ckpt.json").write_text("garbage")
    assert load_checkpoint(p) == 0                    # corrupt file → fresh


def test_backfill_resumes_from_checkpoint(db_factory, tmp_path):
    ckpt = str(tmp_path / "ckpt.json")
    save_checkpoint(ckpt, 100, "P-0100")
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"):
        sen.iter_all_sample_ids.return_value = iter([])
        backfill(db_factory, sleep_s=0, batch_size=50,
                 checkpoint_path=ckpt, dry_run=False, limit=None)
    sen.iter_all_sample_ids.assert_called_once_with(batch_size=50, start=100)


def test_main_prints_stats_json(db_factory, tmp_path, capsys):
    with patch("scripts.backfill_lims_sample_basic_info.senaite") as sen, \
         patch("scripts.backfill_lims_sample_basic_info.time.sleep"), \
         patch("scripts.backfill_lims_sample_basic_info.SessionLocal", db_factory):
        sen.iter_all_sample_ids.return_value = iter([("P-0001", 0)])
        sen.fetch_parent_metadata.return_value = _full_meta("P-0001")
        rc = main(["--checkpoint", str(tmp_path / "c.json"), "--sleep", "0"])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert stats["created"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_backfill_basic_info.py -q`
Expected: `test_main_prints_stats_json` FAILS (`ImportError: cannot import name 'main'`); the checkpoint tests pass already (Task 6 wrote those functions) — they pin behavior.

- [ ] **Step 3: Implement `main()`**

Append to `backend/scripts/backfill_lims_sample_basic_info.py`:

```python
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Backfill lims_samples basic info from SENAITE "
                    "(throttled, resumable — see module docstring).")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds between per-sample fetches (bulk-scan safety; default 0.5)")
    ap.add_argument("--batch-size", type=int, default=50,
                    help="enumeration page size (default 50)")
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT,
                    help=f"resume-cursor JSON path (default {DEFAULT_CHECKPOINT})")
    ap.add_argument("--dry-run", action="store_true",
                    help="enumerate + fetch but write nothing")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N samples (smoke runs)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stats = backfill(SessionLocal, sleep_s=args.sleep, batch_size=args.batch_size,
                     checkpoint_path=args.checkpoint, dry_run=args.dry_run,
                     limit=args.limit)
    print(json.dumps(stats))  # coverage evidence line — retain (ISO 17025)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the full new-file suites**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_backfill_basic_info.py tests/test_lims_sample_basic_info.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/canonical-basic-info
git add backend/scripts/backfill_lims_sample_basic_info.py backend/tests/test_backfill_basic_info.py
git commit -m "feat(registry): backfill CLI with checkpoint resume + coverage stats"
```

---

### Task 8: Regression gate + push

**Files:** none new — verification only.

- [ ] **Step 1: Run the full targeted regression set**

Run: `cd C:/tmp/canonical-basic-info/backend && python -m pytest tests/test_lims_sample_basic_info.py tests/test_backfill_basic_info.py tests/test_sub_samples_service.py tests/test_sub_samples_cutover.py tests/test_container_mode.py tests/test_customer_remarks.py tests/test_sub_samples_native.py -q`
Expected: all pass except failures that ALSO reproduce on the pre-branch tree (baseline). To check a suspect: `git stash && python -m pytest <test> -q && git stash pop`. (If `tests/test_sub_samples_native.py` doesn't exist, drop it from the list — glob `tests/test_sub_samples_*` for the real set.)

- [ ] **Step 2: Push the branch**

```bash
cd C:/tmp/canonical-basic-info
git push
```

- [ ] **Step 3: Report**

State plainly: tests run + counts, any baseline failures identified (with proof they reproduce pre-branch), branch pushed at `<sha>`.

---

### Task 9 (Handler-gated): Live verification + production backfill rehearsal

**Do not start without the Handler's go-ahead** — needs a devbox stack mounting THIS worktree (the existing `cat1d`/`catalog` stacks mount other worktrees), or any Mk1 backend container wired to a SENAITE instance.

- [ ] **Step 1: Smoke the backfill against a live stack** (dry-run first, then tiny limit)

```bash
docker exec -w /app -i <backend-container> python -m scripts.backfill_lims_sample_basic_info --dry-run --limit 20
docker exec -w /app -i <backend-container> python -m scripts.backfill_lims_sample_basic_info --limit 5 --sleep 1.0
```
Expected: stats JSON with `errors: 0`; secondaries skipped; re-run of the same 5 → `created: 0, updated: 5` (idempotent).

- [ ] **Step 2: Verify a backfilled row is complete**

```bash
docker exec <postgres-container> psql -U postgres -d accumark_mk1 -c \
  "SELECT sample_id, client_id, client_sample_id, sample_type, date_received, date_sampled, status, peptide_name FROM lims_samples ORDER BY id DESC LIMIT 5;"
```
Expected: every basic-info column populated (peptide_name NULL only for non-peptide samples; dates NULL only if SENAITE has none).

- [ ] **Step 3: Verify the reconcile piggyback live**

Edit `ClientSampleID` on a test sample in SENAITE, wait >5 min (or set the row's `last_synced_at` back via SQL), view the family in the Mk1 UI, re-query: `client_sample_id` matches SENAITE.

- [ ] **Step 4: Production run (off-hours, Handler present)**

`--sleep 0.75 --batch-size 50`, watch SENAITE responsiveness for the first ~100 samples; abort = Ctrl-C (checkpoint resumes). Retain the stats line per ISO 17025.

---

## Self-Review (completed)

- **Spec coverage:** §1 consolidate → Tasks 1-3; §2 backfill → Tasks 5-7 (+9 live); §3 refresh wiring + drift → Task 4; testing section → mirrored per-task; bulk-safety → Task 6 throttle test + Task 7 CLI defaults; ISO evidence → stats line (Task 7) + retention note (Task 9). Open item "Model-D × refresh" → resolved in Task 4 (refresh before guard, covering native families).
- **Placeholder scan:** none — every step carries the actual code/commands.
- **Type consistency:** `_populate_basic_info(row, meta)`, `_create_sample_row(db, sample_id, meta)`, `iter_all_sample_ids(batch_size, start)` yielding `(sid, b_start)`, `backfill(db_factory, *, sleep_s, batch_size, checkpoint_path, dry_run, limit)` — names verified consistent across Tasks 2/3/4/5/6/7 and the tests.
- **Known judgment call baked in:** enumerator lists with `sort_on=created`; if a live SENAITE rejects that param it's ignored by jsonapi (falls back to catalog order) — Task 9's dry-run confirms.
