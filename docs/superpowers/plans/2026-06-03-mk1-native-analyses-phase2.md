# Mk1-Native Analyses Phase 2 — Receive Wizard Backend Swap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the Receive Wizard backend over from SENAITE-secondary-AR creation to Mk1-native sub-sample creation. New vials get `lims_sub_samples` + `lims_analyses` rows in Mk1; no SENAITE secondary AR is created. Sample ID generation moves to Mk1. Photo upload moves to the parent AR with a vial-tag carried in the attachment's Description so the existing photo-fetch UI keeps working without frontend changes.

**Architecture:** Replace the `senaite.create_secondary()` call in `backend/sub_samples/service.py:create_sub_sample` with a Mk1-side sample_id generator (`{parent}-S{NN}` using the existing `_next_vial_sequence` lock). After insertion, seed `lims_analyses` rows for the assigned role via a new `lims_analyses_seeder` module that reads the parent's WP profile services (existing `fetch_sample_services` from IS) and filters Mk1's `analysis_services` catalog by keyword + role. Wire `set_assignment_role` to seed-on-flip so XTRA → HPLC (or any role assignment) materializes the right analyses lazily. Photo upload retargets to the parent AR with the vial sample_id stamped into the attachment Description for round-trip identification.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (Accu-Mk1 backend), pytest. Existing `lims_analyses` service from Phase 1 is the only new dependency. No frontend changes.

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md`
**Phase 1 plan (predecessor):** `docs/superpowers/plans/2026-06-02-mk1-native-analyses-phase1.md`

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (made up-front; flag if you disagree before executing)

These are the three decisions I baked in that the SPEC left partially open. Each cites the SPEC line it's anchored to.

1. **XTRA vials seed no `lims_analyses` rows at create-time.** Seeding happens at the *moment of role assignment* (the wizard's Assign step, or `compute_vial_plan` auto-assignment). This is SPEC §"After" option (a) — "Mk1 inserts no analyses; the Assign step's later patch can populate them". The alternative (speculative-seed + reportable flip per Open Question 1 recommendation b) is deferred to a follow-up because it materially expands the role-flip code path and isn't needed for Phase 2 acceptance.

2. **The SENAITE secondary AR is NOT created.** No `senaite.create_secondary()` call, no analysis cloning, no `senaite.update_secondary_fields()` call, no `senaite.delete_secondary()` compensation. Sample ID generation moves to Mk1. This matches SPEC §"After" literally ("no SENAITE AR call"). `lims_sub_samples.external_lims_uid` becomes NULL for new vials — existing rows keep their non-NULL value. SPEC §Migration explicitly endorses this cutover ("no data migration script is required").

3. **Photo upload retargets to the parent AR.** The attachment's `Description` (or `Title`, whichever SENAITE supports — verified in Task 1) carries the vial's sample_id as a tag (e.g. `vial:P-0134-S01`). `lims_sub_samples.photo_external_uid` stores `{parent_path}|vial:{sample_id}`. The photo-fetch route splits on `|`, fetches the parent AR's attachments, and filters by Description. Existing vials with a secondary-AR-path-only `photo_external_uid` keep working (the absence of `|vial:` indicates the legacy path). Per SPEC §Open Question 3 recommendation, with a fallback to "keep secondary AR for photo only" if Description-field tagging proves unworkable.

If any of these is wrong, redirect before Task 1.

---

## File Structure

**Backend (new):**
- `backend/lims_analyses/seeder.py` — pure-ish module: given a parent's WP services dict + a role, return the set of `analysis_services` to seed; plus a DB-aware `seed_analyses_for_vial(db, sub_sample, role)` that creates `lims_analyses` rows idempotently.
- `backend/tests/test_lims_analyses_seeder.py` — unit + integration tests for the seeder.

**Backend (modified):**
- `backend/sub_samples/service.py` — rewrite `create_sub_sample` (lines 108-234) for the Mk1-native path; add `_mk1_sample_id(parent, seq) -> str` helper; modify `set_assignment_role` (lines 519-544) to call the seeder on role-flip.
- `backend/sub_samples/senaite.py` — modify `upload_photo` to accept an optional `description` kwarg (so the existing 4-arg call sites stay backward-compatible); add `fetch_attachment_by_description(parent_path, description) -> bytes` for the new photo-fetch path.
- `backend/sub_samples/routes.py` — update the photo-fetch route (current lines ~269-356) to detect the new `{path}|vial:{id}` storage format and route to the new fetch helper.
- `backend/tests/test_sub_samples_service.py` — replace the SENAITE-create assertions with Mk1-create assertions; add seeding-on-flip tests.

**Out of scope for this plan:**
- Worksheet routing (`worksheet_items.lims_analysis_id`) — Phase 3.
- `AnalysisTable.tsx` adapter so the UI reads from Mk1 — Phase 3.
- The `promote_to_parent` service + verification UI — Phase 4.
- Speculative seeding for XTRA — explicitly deferred per scope decision #1.
- Backfilling `lims_analyses` rows for vials created before Phase 2 — no production sub-AR data per SPEC §Migration.

---

## How to run tests

- Single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Full suite: same harness, no `-m` flag. Baseline has 13 known failures (per Phase 1's full-suite run); Phase 2 must not regress beyond that.
- Frontend typecheck (sanity, even though no FE changes): `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`

---

## Task 1: Probe SENAITE for Description-field tagging support

This is verification-only — no code commit. We need to know whether SENAITE's `@@attachments_view/add` endpoint accepts a `Description` form field that round-trips into the attachment listing. The scope decisions above assume yes; this task validates that assumption before we depend on it.

- [ ] **Step 1: Read the existing `upload_photo` implementation to see what form fields it sends today**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -nA 30 "def upload_photo" /app/sub_samples/senaite.py
```

Expected: should show a POST to `{page_url}/@@attachments_view/add` with a multipart form including at least `AttachmentFile`, `AttachmentType:list`, `RenderInReport:boolean`, `_authenticator`. Note any other field names.

- [ ] **Step 2: Send a test upload to a parent AR with `Description` set, then list attachments and check if Description came back**

```bash
docker exec accumark-subvial-accu-mk1-backend python << 'PYEOF'
"""Smoke: upload a 1-byte image to the BW-0013 parent AR with Description set,
then list attachments and look for the Description field."""
from sub_samples import senaite
from database import SessionLocal
from sqlalchemy import select
from models import LimsSample

db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id.like('BW-0013%')).limit(1)).scalar_one_or_none()
if parent is None:
    parent = db.execute(select(LimsSample).limit(1)).scalar_one()
print(f"using parent sample_id={parent.sample_id}")

# Reach into the SENAITE module to find the parent's path. The existing
# upload_photo takes a `path` string; for the parent, we can derive it via
# senaite.fetch_parent_metadata (it returns a `path` key) or by inspecting
# the SENAITE client config. Easiest path: re-use whatever the service
# layer uses to find a parent AR.
meta = senaite.fetch_parent_metadata(parent.sample_id)
parent_path = meta.get("path") or meta.get("@id") or ""
print(f"parent_path={parent_path!r}")

# Run the existing upload_photo with a one-byte test image AND attempt a
# Description override via a kwarg if the function takes one — it may not yet.
# If it doesn't, we'll learn that and fix in Task 5.
test_blob = b"\\x89PNG\\r\\n\\x1a\\n"  # PNG magic bytes; SENAITE may sniff content-type
try:
    senaite.upload_photo(parent_path, test_blob, "probe_vial_tag.png")
    print("uploaded (without Description). Next: list attachments and inspect.")
except Exception as e:
    print(f"upload failed: {type(e).__name__}: {e}")

# List attachments — SENAITE has a JSON endpoint at /attachments?parent_path=...
# OR we use the existing read path the photo-fetch route already implements.
# Find that route:
import subprocess
out = subprocess.run(
    ["grep", "-n", "attachments", "/app/sub_samples/routes.py"],
    capture_output=True, text=True,
).stdout
print("photo route attachment-listing refs:")
print(out)

db.close()
PYEOF
```

Expected outputs to capture:
- Does `upload_photo` currently take a Description kwarg, or only `path`/`bytes`/`filename`?
- Does the attachment listing return a `Description` (or `Title`) field per attachment?

- [ ] **Step 3: Make the call**

Based on Step 2 evidence, decide:
- **GREEN** (Description field round-trips): proceed with the plan as-written. The photo work in Task 5 is the documented approach.
- **YELLOW** (Title round-trips but not Description): swap "Description" → "Title" throughout Task 5. Same shape, different field name.
- **RED** (neither works, or SENAITE rejects the upload to the parent AR): stop and renegotiate. Likely fallback: keep the SENAITE secondary AR purely as a photo container (drop scope decision #2 from "no SENAITE call" to "no analyses inherited"). Update this plan before continuing.

No commit. Document the verdict (Green/Yellow/Red) in a comment on PR #9 or back to the user.

---

## Task 2: Profile-services helper module

**Files:**
- Create: `backend/lims_analyses/seeder.py`
- Test: `backend/tests/test_lims_analyses_seeder.py`

This task ships the *pure mapping* logic only. Task 3 wraps it in DB-aware insert calls.

- [ ] **Step 1: Inspect the `derive_demand` function to see what role keys we need to map**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -nA 15 "def derive_demand" /app/sub_samples/service.py
```

Note the exact services dict keys (e.g. `hplcpurity_identity`, `bac_water_panel`, `endotoxin`, `sterility_pcr`). The seeder reuses these to know which analyses each role needs.

- [ ] **Step 2: Inspect `analysis_services` to confirm the filterable columns**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import AnalysisService
db = SessionLocal()
rows = db.execute(select(AnalysisService).limit(20)).scalars().all()
print(f'{len(rows)} rows; columns we can filter on:')
for r in rows[:10]:
    print(f'  id={r.id} keyword={r.keyword!r:30s} title={r.title!r:40s} category={getattr(r, \"category\", None)!r}')
db.close()
"
```

Capture the live keyword strings. The mapping in Step 3 must match what's in the DB exactly (case-sensitive).

- [ ] **Step 3: Write `backend/lims_analyses/seeder.py`**

```python
"""
Mk1-native analyses seeder.

Given a sub-sample + a role, work out which analyses should exist on that
vial and insert lims_analyses rows for them. Reads the parent's WP profile
via the existing IS bridge in sub_samples.service, then filters Mk1's
analysis_services catalog by keyword + role.

This is the Phase 2 hook point: Receive Wizard insert + role-assignment
patch both call seed_analyses_for_vial(). Idempotent — calling twice with
the same args is a no-op the second time (deduped by the partial unique
index on (lims_sub_sample_pk, keyword)).
"""

from __future__ import annotations

import logging
from typing import Dict, Iterable, List, Optional, Set

from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses import service as la_service
from models import AnalysisService, LimsAnalysis, LimsSubSample

log = logging.getLogger(__name__)

# Role → set of WP service keys that imply analyses at this role.
#
# These are the same keys returned by IS's /explorer/orders/sample-services
# endpoint. Source of truth for the key list: derive_demand() in
# backend/sub_samples/service.py — kept in sync by-hand. If a key is added
# there, mirror the addition here.
ROLE_TO_WP_KEYS: Dict[str, Set[str]] = {
    "hplc": {"hplcpurity_identity", "bac_water_panel"},
    "endo": {"endotoxin"},
    "ster": {"sterility_pcr"},
    "xtra": set(),  # XTRA vials seed nothing; see scope decision #1
}

# Role → analysis_services.keyword prefix(es) or exact matches that select
# the right analyses for the role.
#
# These are matched against the live analysis_services rows seeded from
# SENAITE. The mapping is intentionally permissive (substring match on the
# keyword) because keyword conventions vary per analyte. If your DB has a
# row whose keyword doesn't match the convention, add an explicit override
# here rather than renaming the SENAITE row.
ROLE_TO_KEYWORD_MATCHERS: Dict[str, List[str]] = {
    "hplc": ["HPLC", "PURITY", "IDENTITY"],  # case-insensitive contains
    "endo": ["ENDO", "LAL"],
    "ster": ["STER", "PCR"],
    "xtra": [],
}


def role_implies_seeding(role: Optional[str], wp_services: Dict[str, bool]) -> bool:
    """True iff this role's analyses are requested by the WP profile."""
    if not role or role == "xtra":
        return False
    role_keys = ROLE_TO_WP_KEYS.get(role, set())
    return any(wp_services.get(k) for k in role_keys)


def select_services_for_role(
    db: Session,
    role: str,
) -> List[AnalysisService]:
    """Return the analysis_services rows whose keyword matches the role's
    matcher list. Case-insensitive substring match."""
    matchers = ROLE_TO_KEYWORD_MATCHERS.get(role, [])
    if not matchers:
        return []
    rows = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().all()
    out: List[AnalysisService] = []
    for r in rows:
        kw_upper = (r.keyword or "").upper()
        if any(m.upper() in kw_upper for m in matchers):
            out.append(r)
    return out


def seed_analyses_for_vial(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    role: str,
    wp_services: Dict[str, bool],
    created_by_user_id: Optional[int] = None,
) -> List[LimsAnalysis]:
    """
    Insert lims_analyses rows for this vial based on its role + the parent's
    WP profile. Idempotent: any (sub_sample_pk, keyword) pair that already
    exists is skipped silently.

    Returns the list of newly-inserted rows (empty if nothing was needed).
    """
    if not role_implies_seeding(role, wp_services):
        log.info(
            "seeder.skip_no_seeding sub=%s role=%s wp_keys=%s",
            sub_sample.sample_id, role, sorted(wp_services.keys()),
        )
        return []

    services = select_services_for_role(db, role)
    if not services:
        log.warning(
            "seeder.no_matching_services sub=%s role=%s — nothing to seed",
            sub_sample.sample_id, role,
        )
        return []

    # Already-seeded keywords for this vial — skip them
    existing = db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id
        )
    ).scalars().all()
    existing_kw = set(existing)

    inserted: List[LimsAnalysis] = []
    for svc in services:
        if svc.keyword in existing_kw:
            continue
        row = la_service.create_analysis(
            db,
            host_kind="sub_sample",
            host_pk=sub_sample.id,
            analysis_service_id=svc.id,
            keyword=svc.keyword,
            title=svc.title or svc.keyword,
            created_by_user_id=created_by_user_id,
        )
        inserted.append(row)
        log.info(
            "seeder.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )
    return inserted
```

- [ ] **Step 4: Verify the module imports**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.seeder import (
    ROLE_TO_WP_KEYS, ROLE_TO_KEYWORD_MATCHERS,
    role_implies_seeding, select_services_for_role, seed_analyses_for_vial,
)
print('roles:', sorted(ROLE_TO_WP_KEYS))
print('hplc keys:', sorted(ROLE_TO_WP_KEYS['hplc']))
print('hplc matchers:', ROLE_TO_KEYWORD_MATCHERS['hplc'])
print('role_implies_seeding(hplc, {bac_water_panel:True}):',
      role_implies_seeding('hplc', {'bac_water_panel': True}))
print('role_implies_seeding(xtra, {hplcpurity_identity:True}):',
      role_implies_seeding('xtra', {'hplcpurity_identity': True}))
"
```

Expected: `roles: ['endo', 'hplc', 'ster', 'xtra']`; `True` then `False`.

- [ ] **Step 5: Write unit tests**

```python
# backend/tests/test_lims_analyses_seeder.py
"""Tests for the lims_analyses seeder.

Pure tests run against a live DB session for the catalog-filter logic
(needs real AnalysisService rows). DB writes (the seed_analyses_for_vial
call) are integration-tested with cleanup.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.seeder import (
    ROLE_TO_KEYWORD_MATCHERS,
    ROLE_TO_WP_KEYS,
    role_implies_seeding,
    seed_analyses_for_vial,
    select_services_for_role,
)
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSubSample


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no lims_sub_samples row available")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Each seeder test that creates rows tags them by re-writing the title
    to start with 'SEEDER-TEST:' after seeding. Cleanup matches that tag.
    The transitions delete is scoped to the same analyses via a subquery —
    NEVER blanket-match by reason like 'initial insert' (that would wipe
    other tests' audit rows). The lims_analyses cascade FK then removes
    transitions in the same transaction."""
    yield
    # Cascade: deleting LimsAnalysis ON DELETE CASCADE removes the matching
    # LimsAnalysisTransition rows automatically (per the Phase 1 migration).
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.title.like("%SEEDER-TEST%")
    ))
    db.commit()


# ── pure logic ──────────────────────────────────────────────────────────────


def test_role_implies_seeding_hplc_yes_when_bac_water_panel():
    assert role_implies_seeding("hplc", {"bac_water_panel": True})


def test_role_implies_seeding_hplc_yes_when_hplcpurity_identity():
    assert role_implies_seeding("hplc", {"hplcpurity_identity": True})


def test_role_implies_seeding_hplc_no_when_neither():
    assert not role_implies_seeding("hplc", {"endotoxin": True, "sterility_pcr": True})


def test_role_implies_seeding_endo_yes_when_endotoxin():
    assert role_implies_seeding("endo", {"endotoxin": True})


def test_role_implies_seeding_ster_yes_when_sterility_pcr():
    assert role_implies_seeding("ster", {"sterility_pcr": True})


def test_role_implies_seeding_xtra_always_no():
    assert not role_implies_seeding("xtra", {"hplcpurity_identity": True, "endotoxin": True})


def test_role_implies_seeding_null_role_no():
    assert not role_implies_seeding(None, {"hplcpurity_identity": True})


# ── live catalog filter (skips if no rows) ──────────────────────────────────


def test_select_services_for_hplc_returns_at_least_one(db):
    rows = select_services_for_role(db, "hplc")
    if not rows:
        pytest.skip("no analysis_services rows match HPLC matcher set")
    keywords = [(r.keyword or "").upper() for r in rows]
    assert any(any(m in k for m in ("HPLC", "PURITY", "IDENTITY")) for k in keywords)


def test_select_services_for_endo_returns_only_endo_matched(db):
    rows = select_services_for_role(db, "endo")
    for r in rows:
        kw_upper = (r.keyword or "").upper()
        assert "ENDO" in kw_upper or "LAL" in kw_upper, (
            f"endo seeder returned unrelated row keyword={r.keyword}"
        )


def test_select_services_for_xtra_returns_nothing(db):
    assert select_services_for_role(db, "xtra") == []


# ── seed_analyses_for_vial integration ──────────────────────────────────────


def test_seed_for_hplc_creates_lims_analyses_rows(db, sub_sample):
    inserted = seed_analyses_for_vial(
        db,
        sub_sample=sub_sample,
        role="hplc",
        wp_services={"bac_water_panel": True},
    )
    if not inserted:
        pytest.skip("no analysis_services rows match HPLC matcher set")
    for r in inserted:
        assert r.lims_sub_sample_pk == sub_sample.id
        assert r.review_state == "unassigned"
    # Cleanup hook in fixture matches title; tag the inserted titles so
    # cleanup catches them
    for r in inserted:
        r.title = f"SEEDER-TEST: {r.title}"
    db.commit()


def test_seed_is_idempotent(db, sub_sample):
    first = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"bac_water_panel": True},
    )
    if not first:
        pytest.skip("no analysis_services rows match HPLC matcher set")
    for r in first:
        r.title = f"SEEDER-TEST: {r.title}"
    db.commit()
    # Second call inserts nothing
    second = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"bac_water_panel": True},
    )
    assert second == []


def test_seed_xtra_inserts_nothing(db, sub_sample):
    inserted = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="xtra",
        wp_services={"hplcpurity_identity": True, "endotoxin": True},
    )
    assert inserted == []
```

- [ ] **Step 6: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_seeder.py -v"
```

Expected: all pass, with possible skips on the catalog-filter tests if your dev DB doesn't have matching `analysis_services` rows.

- [ ] **Step 7: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/seeder.py backend/tests/test_lims_analyses_seeder.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): seeder module — role-aware lims_analyses insertion from WP profile"
```

---

## Task 3: Mk1-native sample_id generator

**Files:**
- Modify: `backend/sub_samples/service.py` (add helper near `_next_vial_sequence` at line ~85)
- Test: extend `backend/tests/test_sub_samples_service.py`

- [ ] **Step 1: Add the helper after `_next_vial_sequence`**

Add this function in `backend/sub_samples/service.py`, immediately after `_next_vial_sequence` (which currently ends near line 106):

```python
def _mk1_format_sample_id(parent_sample_id: str, vial_sequence: int) -> str:
    """Generate the Mk1-native sub-sample sample_id.

    Format mirrors what SENAITE used to generate: {parent}-S{NN} with the
    sequence zero-padded to 2 digits. Sequences beyond 99 are uncommon but
    we widen padding rather than truncate (NSS = vial 100, 101, ...).
    """
    if vial_sequence < 1:
        raise ValueError(f"vial_sequence must be >= 1, got {vial_sequence}")
    if vial_sequence < 100:
        return f"{parent_sample_id}-S{vial_sequence:02d}"
    return f"{parent_sample_id}-S{vial_sequence}"
```

- [ ] **Step 2: Add a focused unit test in `test_sub_samples_service.py`**

Find any existing test that imports from `sub_samples.service` (the file uses an in-memory SQLite fixture per the Phase 1 explore). Add:

```python
def test_mk1_format_sample_id_pads_to_two_digits():
    from sub_samples.service import _mk1_format_sample_id
    assert _mk1_format_sample_id("BW-0013", 1) == "BW-0013-S01"
    assert _mk1_format_sample_id("BW-0013", 9) == "BW-0013-S09"
    assert _mk1_format_sample_id("BW-0013", 17) == "BW-0013-S17"


def test_mk1_format_sample_id_widens_past_99():
    from sub_samples.service import _mk1_format_sample_id
    assert _mk1_format_sample_id("BW-0013", 100) == "BW-0013-S100"
    assert _mk1_format_sample_id("BW-0013", 999) == "BW-0013-S999"


def test_mk1_format_sample_id_rejects_zero_or_negative():
    import pytest
    from sub_samples.service import _mk1_format_sample_id
    with pytest.raises(ValueError):
        _mk1_format_sample_id("BW-0013", 0)
    with pytest.raises(ValueError):
        _mk1_format_sample_id("BW-0013", -1)
```

- [ ] **Step 3: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_sub_samples_service.py -v -k mk1_format"
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/service.py backend/tests/test_sub_samples_service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): Mk1-native sample_id generator for sub-samples"
```

---

## Task 4: Rewrite `create_sub_sample` for the Mk1-native path

This is the main behavioral change. The function moves from "create SENAITE secondary AR → upload photo → mirror locally" to "generate sample_id locally → insert local row → upload photo to PARENT AR → seed analyses if role known".

**Files:**
- Modify: `backend/sub_samples/service.py:108-234`

- [ ] **Step 1: Read the current implementation carefully + identify the call sites**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -nA 5 "create_sub_sample" /app/sub_samples/routes.py
docker exec accumark-subvial-accu-mk1-backend grep -n "create_sub_sample\|create_secondary" /app/sub_samples/service.py
```

Confirm the only caller is `POST /api/sub-samples` (the wizard handler). The new signature stays the same so the caller doesn't need to change.

- [ ] **Step 2: Replace the function body**

Replace the entire `create_sub_sample` function (currently lines 108-234 of `backend/sub_samples/service.py`) with:

```python
def create_sub_sample(
    db: Session,
    parent_sample_id: str,
    photo_bytes: bytes,
    photo_filename: str,
    remarks: Optional[str],
    user_id: int,
) -> LimsSubSample:
    """Create a sub-sample atomically — Mk1-native path.

    Phase 2 of the mk1-native-analyses spec. No SENAITE secondary AR is
    created; sample_id generation, vial row insert, and analysis seeding
    all happen in Mk1. Photo uploads to the parent AR with the vial
    sample_id stamped into the attachment Description so the existing
    photo-fetch route can resolve it on demand.
    """
    parent = ensure_sample_row(db, parent_sample_id)

    # Defense-in-depth: parent must have a contact (used downstream for
    # COA generation, customer notifications). Cheap local check.
    if not parent.contact_uid:
        raise RuntimeError(
            f"Cannot create sub-sample for {parent_sample_id}: parent has no "
            f"contact_uid. Set a Contact on the parent in SENAITE first, or "
            f"re-receive it through the order processor which sets one."
        )

    # Defense-in-depth: refresh cache if SENAITE doesn't recognize the parent UID.
    # Photo upload still needs a live parent path, so we still validate against SENAITE.
    if not senaite.uid_exists(parent.external_lims_uid):
        log.warning("sub_samples.parent_uid_stale parent=%s uid=%s; refreshing",
                    parent_sample_id, parent.external_lims_uid)
        _refresh_parent_from_senaite(db, parent)
        if not parent.external_lims_uid:
            raise RuntimeError(
                f"Cannot create sub-sample for {parent_sample_id}: parent has no "
                f"external_lims_uid even after refresh."
            )
        if not parent.contact_uid:
            raise RuntimeError(
                f"Cannot create sub-sample for {parent_sample_id}: parent has no "
                f"contact_uid even after refresh from SENAITE."
            )

    # Fetch parent metadata to get the parent's SENAITE path (needed for photo
    # attachment). Best-effort: if this fails we can't upload the photo, but
    # we also don't want to fail the whole vial create — log loudly and
    # proceed with NULL photo_external_uid; the user can upload later via
    # the photo step on the sub-sample detail page.
    parent_meta: dict = {}
    try:
        parent_meta = senaite.fetch_parent_metadata(parent_sample_id)
    except Exception as e:
        log.warning(
            "sub_samples.parent_meta_fetch_failed parent=%s err=%s",
            parent_sample_id, e,
        )
    parent_path = parent_meta.get("path") or parent_meta.get("@id") or ""

    # Allocate sample_id locally. Row lock on parent ensures vial_sequence
    # is monotonically allocated across concurrent creates.
    vial_seq = _next_vial_sequence(db, parent.id)
    sample_id = _mk1_format_sample_id(parent_sample_id, vial_seq)

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=None,           # no SENAITE secondary AR exists
        sample_id=sample_id,
        vial_sequence=vial_seq,
        received_by_user_id=user_id,
        photo_external_uid=None,          # filled in after photo upload below
        remarks=remarks,
    )
    db.add(sub)
    db.flush()  # populate sub.id

    # Upload photo to the parent AR with the vial sample_id in Description.
    # The Description acts as the vial-tag for the photo-fetch route to filter on.
    if parent_path and photo_bytes:
        vial_tag = f"vial:{sample_id}"
        try:
            senaite.upload_photo(
                parent_path, photo_bytes, photo_filename,
                description=vial_tag,
            )
            # Store the parent path + vial tag so the photo-fetch route can
            # resolve. The '|' delimiter distinguishes new Mk1-style storage
            # from legacy secondary-AR paths (which never contain '|').
            sub.photo_external_uid = f"{parent_path}|{vial_tag}"
        except Exception as e:
            # Photo upload failed but the vial row exists. Log + leave
            # photo_external_uid as NULL; user can re-upload via the photo
            # cell. This is a degradation, not a failure of the create.
            log.warning(
                "sub_samples.photo_upload_failed sub=%s parent=%s err=%s",
                sample_id, parent_sample_id, e,
            )

    parent.last_synced_at = datetime.utcnow()
    db.commit()
    db.refresh(sub)

    # Seed lims_analyses rows IF a role has already been assigned at create-time.
    # Today the wizard flow assigns the role in a later step, so this is usually
    # a no-op here; the seeding happens via the role-flip hook (Task 5). But if
    # a caller does pre-assign (e.g. compute_vial_plan auto-assign), seed here.
    if sub.assignment_role and sub.assignment_role != "xtra":
        wp_services = _fetch_wp_services_for_parent(parent_sample_id) or {}
        from lims_analyses.seeder import seed_analyses_for_vial
        seed_analyses_for_vial(
            db,
            sub_sample=sub,
            role=sub.assignment_role,
            wp_services=wp_services,
            created_by_user_id=user_id,
        )
        db.refresh(sub)

    return sub


def _fetch_wp_services_for_parent(parent_sample_id: str) -> Optional[Dict[str, bool]]:
    """Wrapper around fetch_sample_services that returns the services dict or None.
    Lifted to its own helper so the role-flip hook in set_assignment_role can
    reuse it without duplicating the None-handling."""
    raw = fetch_sample_services(parent_sample_id)
    if not raw:
        return None
    return raw.get("services") or {}
```

You'll need `from typing import Dict` if not already imported, and `senaite.upload_photo` will gain a `description=` kwarg in Task 5.

- [ ] **Step 3: Confirm the call site still works (no changes to the route handler)**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -B 2 -A 20 "def create_sub_sample" /app/sub_samples/routes.py
```

Expected: the handler still calls `create_sub_sample(db, parent_sample_id, photo_bytes, photo_filename, remarks, user_id)` — same signature, no edits needed.

- [ ] **Step 4: Sanity-import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from sub_samples.service import create_sub_sample, _fetch_wp_services_for_parent, _mk1_format_sample_id
print('imports ok')
"
```

Expected: `imports ok`. If `seed_analyses_for_vial` is missing, Task 2 didn't complete.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): cut create_sub_sample over to Mk1-native path"
```

---

## Task 5: Photo upload to parent AR + photo-fetch route adaptation

**Files:**
- Modify: `backend/sub_samples/senaite.py:upload_photo` (add `description=` kwarg)
- Add: `backend/sub_samples/senaite.py:fetch_attachment_by_description` (new helper)
- Modify: `backend/sub_samples/routes.py` photo-fetch route (currently lines ~269-356)
- Tests: extend `backend/tests/test_sub_samples_senaite.py` if it exists, else add to `test_sub_samples_service.py`

- [ ] **Step 1: Add `description=` to `upload_photo`**

Read the current function:

```bash
docker exec accumark-subvial-accu-mk1-backend grep -nA 60 "def upload_photo" /app/sub_samples/senaite.py
```

Modify the signature to:

```python
def upload_photo(
    path: str,
    photo_bytes: bytes,
    filename: str,
    *,
    description: Optional[str] = None,
) -> None:
    """Upload an attachment to a SENAITE sample AR.

    If `description` is set, it's sent as the Description form field, which
    SENAITE persists onto the Attachment object. Phase 2's vial-tag approach
    uses this to stamp the vial sample_id onto photos that live on the
    parent AR. Callers in the legacy secondary-AR path leave it unset.
    """
```

Then inside the function, where the multipart form data is being built, conditionally add:

```python
if description is not None:
    form_data["Description"] = description
```

The exact insertion point depends on how the form is built (`requests.post(..., data=form_data, files=files)` is the likely shape). If the function uses `aiohttp.FormData`, it's `form.add_field("Description", description)`. Make the change idiomatic to the existing code.

- [ ] **Step 2: Add a fetch-by-description helper**

After `upload_photo`, add:

```python
def fetch_attachment_by_description(
    parent_path: str,
    description: str,
) -> Optional[bytes]:
    """List the attachments on a SENAITE sample AR; return the bytes of the
    first attachment whose Description matches exactly. None if no match.

    Used by the photo-fetch route to resolve Phase 2 vial photos that live
    on the parent AR with a vial-tag Description (e.g. 'vial:P-0134-S01').
    """
    # The SENAITE attachments-list endpoint is typically GET {path}/@@attachments_view
    # returning HTML or JSON depending on Accept. Investigate the existing
    # photo-fetch route to see how the listing is done and reuse that
    # mechanism. The filter is: parsed_attachments.filter(a => a.Description == description).
    raise NotImplementedError(
        "fetch_attachment_by_description: implement using the same listing "
        "mechanism the existing photo-fetch route in routes.py uses. "
        "See routes.py:get_photo (or similar) for the read-side pattern."
    )
```

Then read the existing photo-fetch route to understand the listing mechanism:

```bash
docker exec accumark-subvial-accu-mk1-backend grep -nA 80 "def get_photo\|photo.*GET" /app/sub_samples/routes.py
```

Replace the `NotImplementedError` with a real implementation that mirrors the route's read logic, filtered by the Description field. Common patterns:
- HTML scraping: parse the attachments-view HTML and look for `data-description="..."` attributes.
- JSON: GET `{parent_path}/@@API/senaite/v1/Attachment?parent_path={parent_path}` returns a list with each item carrying a Description field.

Use whichever the existing route uses.

- [ ] **Step 3: Update the photo-fetch route to detect the Phase 2 storage format**

In `backend/sub_samples/routes.py`, find the GET-photo endpoint. The existing logic resolves the photo by treating `photo_external_uid` as a SENAITE AR path and listing its attachments. New logic:

```python
@router.get("/{sample_id}/photo")
def get_photo(sample_id: str, db: Session = Depends(get_db)):
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sub is None:
        raise HTTPException(status_code=404, detail="not found")
    uid = sub.photo_external_uid
    if not uid:
        raise HTTPException(status_code=404, detail="no photo")

    if "|" in uid:
        # Phase 2 vial-tag format: {parent_path}|vial:{sample_id}
        parent_path, vial_tag = uid.split("|", 1)
        photo_bytes = senaite.fetch_attachment_by_description(parent_path, vial_tag)
        if photo_bytes is None:
            raise HTTPException(status_code=404, detail="photo not found on parent AR")
        return Response(content=photo_bytes, media_type="image/jpeg")

    # Legacy: uid is a SENAITE secondary AR path. Use the existing fetch
    # path (whatever's already there — leave that code unchanged).
    return _legacy_fetch_photo_by_secondary_path(uid)
```

If the existing route is shaped differently (e.g., it doesn't `raise HTTPException` directly, or uses a different response class), preserve the existing shape and only swap the resolution mechanism.

- [ ] **Step 4: Test the upload+fetch round-trip against a live parent AR**

```bash
docker exec accumark-subvial-accu-mk1-backend python << 'PYEOF'
"""Round-trip: upload a PNG with description, then fetch it back by description."""
from sub_samples import senaite
from database import SessionLocal
from sqlalchemy import select
from models import LimsSample

db = SessionLocal()
parent = db.execute(
    select(LimsSample).where(LimsSample.sample_id.like('BW-0013%')).limit(1)
).scalar_one_or_none()
if parent is None:
    parent = db.execute(select(LimsSample).limit(1)).scalar_one()
print(f"using parent sample_id={parent.sample_id}")

meta = senaite.fetch_parent_metadata(parent.sample_id)
parent_path = meta.get("path") or meta.get("@id")
print(f"parent_path={parent_path}")

# A 1x1 PNG (transparent)
png_bytes = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "89000000004949454e44ae426082"
)
tag = "vial:SMOKE-TEST-001"

# Upload
senaite.upload_photo(parent_path, png_bytes, "smoke.png", description=tag)
print("uploaded with description=", tag)

# Fetch
fetched = senaite.fetch_attachment_by_description(parent_path, tag)
if fetched is None:
    print("FAIL: fetch returned None")
elif fetched.startswith(b"\x89PNG"):
    print(f"OK: round-tripped {len(fetched)} bytes, starts with PNG magic")
else:
    print(f"PARTIAL: fetched {len(fetched)} bytes but no PNG magic — content may have been re-encoded")

db.close()
PYEOF
```

Expected: `OK: round-tripped N bytes, starts with PNG magic`.

If `PARTIAL` (SENAITE may rewrite uploaded images): the round-trip still works for the photo-fetch UI; just note it.
If `FAIL`: re-examine the fetch implementation. The description filter may need normalization (whitespace, case).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/senaite.py backend/sub_samples/routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): photo upload to parent AR with vial-tag Description; fetch route adapts"
```

---

## Task 6: Hook seeding into `set_assignment_role` for role-flip

**Files:**
- Modify: `backend/sub_samples/service.py:set_assignment_role` (currently lines 519-544)

- [ ] **Step 1: Read the current implementation**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -nA 30 "def set_assignment_role" /app/sub_samples/service.py
```

Confirm the current shape: validates role, writes to `lims_sub_samples.assignment_role`, commits.

- [ ] **Step 2: Add the seeding hook**

After the `db.commit()` for the role update (but inside `set_assignment_role`), add:

```python
    # If this assignment transitioned a sub-sample into a non-XTRA role,
    # seed its lims_analyses rows. Idempotent — re-running on an already-
    # seeded vial is a no-op. Best-effort: failure to fetch WP services or
    # to seed analyses must NOT roll back the role assignment — the user
    # can manually seed later via a follow-up patch if needed.
    if isinstance(target, LimsSubSample) and role and role != "xtra":
        try:
            # Look up the parent's sample_id by FK rather than relying on a
            # relationship attribute (LimsSubSample.parent may or may not
            # be defined). Safe + cheap.
            parent_row = db.get(LimsSample, target.parent_sample_pk)
            parent_sid = parent_row.sample_id if parent_row else None
            if parent_sid:
                wp_services = _fetch_wp_services_for_parent(parent_sid) or {}
                from lims_analyses.seeder import seed_analyses_for_vial
                seed_analyses_for_vial(
                    db,
                    sub_sample=target,
                    role=role,
                    wp_services=wp_services,
                )
        except Exception as e:
            log.warning(
                "sub_samples.role_flip_seed_failed sub=%s role=%s err=%s",
                target.sample_id, role, e,
            )
```

(The exact variable names — `target`, `role`, `parent_sample_id` — depend on the existing function's locals. Adapt to match.)

- [ ] **Step 3: Run the existing assignment tests + a new one**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -v -k assignment -x"
```

Add a focused test to `test_sub_samples_service.py`:

```python
def test_set_assignment_role_seeds_lims_analyses_on_first_flip(
    db, monkeypatch, sub_sample,
):
    """When a sub-sample's role flips from xtra to hplc, the seeder runs."""
    from sqlalchemy import select
    from sub_samples import service as ss_service
    from models import LimsAnalysis

    # Pin WP services so the seeder thinks this parent wants HPLC
    monkeypatch.setattr(
        ss_service, "_fetch_wp_services_for_parent",
        lambda sid: {"bac_water_panel": True},
    )

    # Start with no role
    sub_sample.assignment_role = None
    db.commit()
    # Pre-condition: no lims_analyses for this vial
    pre = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id
        )
    ).scalars().all()
    assert pre == []

    # Flip to hplc
    ss_service.set_assignment_role(
        db, sample_id=sub_sample.sample_id, role="hplc",
    )

    # Post-condition: at least one lims_analyses row exists
    post = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id
        )
    ).scalars().all()
    if not post:
        pytest.skip("no analysis_services rows match HPLC matcher set in this env")
    for r in post:
        assert r.review_state == "unassigned"
        # tag for cleanup
        r.title = f"SEEDER-TEST: {r.title}"
    db.commit()
```

- [ ] **Step 4: Run tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_sub_samples_service.py -v -k 'set_assignment_role or seed'"
```

Expected: existing assignment tests pass; new test_set_assignment_role_seeds passes (or skips if no matching catalog rows).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/service.py backend/tests/test_sub_samples_service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): set_assignment_role seeds lims_analyses on first flip to a real role"
```

---

## Task 7: Live verification through the Receive Wizard

This is verification-only — no code commit. Validates the Phase 2 acceptance criteria against the running stack.

- [ ] **Step 1: Pick a parent without sub-samples (or note an existing one)**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select, func
from models import LimsSample, LimsSubSample
db = SessionLocal()
parents = db.execute(
    select(LimsSample.sample_id, func.count(LimsSubSample.id).label('n_subs'))
    .outerjoin(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
    .group_by(LimsSample.id, LimsSample.sample_id)
    .order_by(LimsSample.id.desc())
    .limit(10)
).all()
for p in parents:
    print(f'  {p.sample_id}  ({p.n_subs} existing subs)')
db.close()
"
```

Pick one with `0 existing subs` for the cleanest smoke. BW-0013 already has 5 from prior sessions — fine for a "create the 6th" smoke if you prefer real data.

- [ ] **Step 2: Open the Receive Wizard frontend**

```
1. Go to http://localhost:5532
2. sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530'); location.reload()
3. Log in as forrest@valenceanalytical.com / test123
4. Navigate to Worksheets → click "Add Vial" on the chosen parent
5. Complete photo capture → enter remarks → confirm → on the Assign step, pick role HPLC
```

- [ ] **Step 3: Inspect the resulting DB state**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select, desc
from models import LimsSubSample, LimsAnalysis

db = SessionLocal()
last = db.execute(
    select(LimsSubSample).order_by(desc(LimsSubSample.id)).limit(1)
).scalar_one()
print('NEWEST SUB:')
print(f'  id={last.id}  sample_id={last.sample_id}  parent_pk={last.parent_sample_pk}')
print(f'  external_lims_uid={last.external_lims_uid!r}  ← should be None (Phase 2)')
print(f'  photo_external_uid={last.photo_external_uid!r}  ← should contain |vial: (Phase 2)')
print(f'  assignment_role={last.assignment_role!r}')

analyses = db.execute(
    select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == last.id)
).scalars().all()
print(f'lims_analyses rows for this vial: {len(analyses)}')
for a in analyses:
    print(f'  id={a.id} keyword={a.keyword!r} state={a.review_state}')
db.close()
"
```

Expected (Phase 2 acceptance):
- `external_lims_uid=None` — no SENAITE secondary AR was created.
- `photo_external_uid` contains `|vial:` — Phase 2 photo storage format.
- 1+ `lims_analyses` rows exist; all in `review_state=unassigned`.

- [ ] **Step 4: Open the photo on the sub-sample detail page**

In the frontend, navigate to the new vial's detail page. The photo cell should render the uploaded image. If broken, the photo-fetch route in Task 5 has a bug — debug from the network panel.

- [ ] **Step 5: Confirm no SENAITE secondary AR was created**

In the SENAITE UI (http://localhost:5538), search for the new sample_id (e.g. `BW-0013-S06`). Expected: not found. If found, the cutover in Task 4 didn't take effect.

---

## Verification (Phase 2 acceptance)

- [ ] **Vial check-in via the wizard inserts `lims_sub_samples` + `lims_analyses` rows.** (Task 7 step 3.)
- [ ] **No SENAITE sub-AR is created.** (Task 7 step 5.)
- [ ] **The vial's lims_analyses rows are queryable via `GET /api/lims-analyses?host_kind=sub_sample&host_pk=<id>`.** (Phase 1 endpoint; sanity-curl this against the new vial.)
- [ ] **Photo uploads via the new path and renders in the existing photo cell.** (Task 7 step 4.)
- [ ] **Role-flip on an existing XTRA vial seeds its analyses.** (Task 6 test + a manual flip on a vial created XTRA in step 2.)
- [ ] **All Phase 2 tests pass.** Run:

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_seeder.py tests/test_sub_samples_service.py -v"
```

- [ ] **Full backend suite has no NEW regressions beyond the 13-failure baseline.** Run the full suite and confirm the failure list matches what Phase 1 left.

---

## Risks and unknowns

- **The IS `/explorer/orders/sample-services` endpoint may be down or rate-limited.** If `fetch_sample_services` returns None or raises, the seeder skips silently and the vial gets zero `lims_analyses` rows. This is a degraded but recoverable state — the operator can re-trigger via a re-flip of the role. Phase 2 logs the failure loudly; Phase 3 will surface it in the UI.

- **The `ROLE_TO_KEYWORD_MATCHERS` substring approach is permissive.** If your `analysis_services` catalog has a row with a keyword that incidentally contains "HPLC" but isn't actually an HPLC analysis (e.g. an obscure historical row), the seeder will pick it up. Mitigation: review the Task 2 Step 2 catalog dump; if any rows look like false positives, add an explicit exclusion list in the seeder module.

- **Description-field tagging assumes SENAITE persists the field round-trip.** If Task 1's probe came back YELLOW or RED, the Task 5 implementation needs to swap to `Title` or pivot to keeping the secondary AR for photos only. The plan calls this out at Task 1 — don't skip it.

- **Existing sub-samples with a populated `external_lims_uid` are not touched.** The new path applies only to new vials. The photo-fetch route in Task 5 falls back to legacy resolution when `photo_external_uid` lacks `|vial:`. This is intentional.

- **The wizard's "Assign step Remarks" feature** (shipped on a recent commit in this branch — `b668f9b`) writes to the parent AR's Remarks via `senaite.update_remarks`. That path is untouched by Phase 2 and continues to work for both legacy and new sub-samples.

## Open questions (carried forward from spec)

These are spec-level open questions Phase 2 does NOT resolve:

1. **Speculative analysis seeding for XTRA vials** (SPEC §Open Questions §1). Phase 2 ships option (a). Re-evaluate if Phase 4's verification UX needs option (b).
2. **Retest UI** (SPEC §Open Questions §2). Data column exists from Phase 1; UI deferred.
3. **Photo storage long-term** (SPEC §Open Questions §3). Phase 2 ships the parent-AR-with-tag intermediate; Mk1-side blob store is a future migration.
4. **`source_analysis_uid` polymorphism for the COA resolver** (SPEC §Open Questions §4). Phase 4 work.

## Out of scope (carried forward)

- Worksheet routing (`worksheet_items.lims_analysis_id`, inbox query rewrite) — Phase 3.
- `AnalysisTable.tsx` adapter so the bench-tech UI reads from Mk1 — Phase 3.
- `promote_to_parent` service + verification UI — Phase 4.
- COA resolver default-path simplification — Phase 5.
- Family-state derivation + WP signaling — Phase 5.
- Prelim-COA opt-in customer flow — Phase 6.
