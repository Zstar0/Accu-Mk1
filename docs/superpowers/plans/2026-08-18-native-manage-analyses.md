# Native Manage Analyses + parent-row lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the lab add a native (mk1-origin) analysis *profile* to a parent sample after ordering — minting the parent placeholder rows and putting the analyses on the matching-role vial — remove native rows again, re-sync a sample from its WP order, and see mk1-only services in the vial-page picker.

**Architecture:** Backend orchestration lives in a new focused module `backend/lims_analyses/manage_native.py` that composes three existing primitives unchanged — `seed_parent_placeholders` (parent tier), custody edges (`VialProfileAssignment`, host relation) and the vial seeder's shared row builder `_seed_rows_from_services` — plus two tiny transition-writing helpers added to `lims_analyses/service.py` (so the amendment-audit AST guard sees them). Four routes under `/api/lims-analyses/parent/{sample_id}/…`; one hook in `set_assignment_role` unions the parent's placeholder-derived profile keys into the role-flip services map. Frontend: one new component `NativeManageAnalysesBlock` rendered inside the existing Manage Analyses overlay on parent pages; the vial-page picker switches to the local mk1 service list on native vials.

**Tech Stack:** FastAPI + SQLAlchemy 2 (backend, pytest with in-memory SQLite fixtures), React 19 + TanStack Query + vitest/RTL (frontend, **npm only**).

**Spec:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-18-native-manage-analyses-design.md`

## Global Constraints

- **Worktree:** `C:\tmp\Accu-Mk1-manage-analyses`, branch `feat/native-manage-analyses`, created from **`b30d9fc0`** (the #98 tip). Never build in `C:\tmp\Accu-Mk1-arcitest` (test composition, never push) or the main checkout.
- **Backend interpreter:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` — run pytest as `<python> -m pytest …` from `C:\tmp\Accu-Mk1-manage-analyses\backend`. **There must be NO `backend/.env` file in the worktree** (an empty-token `.env` fakes +23 failures).
- **Frontend:** `npm` only (`npm ci`, `npm run check:all`). Never pnpm.
- **Additive only.** Do not modify: `promote_to_parent`, `_TIER_ALLOWED_KINDS` / `state_machine.py`, `write_custody_edges`, `reprovision-snapshot`, `apply_transition`'s tier gate, `list_analysis_change_events_for_parent`.
- **Every new `LimsAnalysisTransition(...)` construction goes in `backend/lims_analyses/service.py`** (the AST guard `backend/tests/test_amendment_audit.py::test_grep_guard_every_construction_passes_details` scans only that file) and passes `details={"changed": {}}`; bump the guard's `>= 11` floor by the number of sites added.
- **Identity = `analysis_service_id`** in all new code paths; keyword is display only.
- Provenance for lab-minted parent rows = `'ordered'` (`lims_analyses.parent_placeholders.PROVENANCE_ORDERED`). No schema change anywhere.
- Test gate = **failure-SET diff** against the baseline captured in Task 1, never a count.
- Commit after every task with the exact message given. No pushes.
- Line numbers below are for the `b30d9fc0` base; re-locate by the quoted code if they drift.

---

### Task 1: Worktree, baseline, and frontend deps

**Files:**
- Create: worktree `C:\tmp\Accu-Mk1-manage-analyses`
- Create: `C:\tmp\Accu-Mk1-manage-analyses\.superpowers\sdd\baseline_failed.txt` (untracked; `.superpowers/` is gitignored — verify)

- [ ] **Step 1: Create the worktree from the base**

```bash
git -C "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" worktree add "C:/tmp/Accu-Mk1-manage-analyses" -b feat/native-manage-analyses b30d9fc0
git -C "C:/tmp/Accu-Mk1-manage-analyses" log --oneline -1
```
Expected: `b30d9fc0 test(audit): un-stale set_reportable idempotence test …`

- [ ] **Step 2: Confirm no `.env` in the worktree backend and that `.superpowers/` is ignored**

```bash
ls "C:/tmp/Accu-Mk1-manage-analyses/backend/.env" 2>/dev/null && echo "REMOVE IT" || echo "no .env — good"
git -C "C:/tmp/Accu-Mk1-manage-analyses" check-ignore -q .superpowers/x && echo "ignored" || echo "NOT ignored — keep ledger files out of commits"
mkdir -p "C:/tmp/Accu-Mk1-manage-analyses/.superpowers/sdd"
```

- [ ] **Step 3: Capture the backend failure-set baseline (full suite; takes several minutes)**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend"
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^FAILED " | sed 's/ - .*//' | sort -u > "C:/tmp/Accu-Mk1-manage-analyses/.superpowers/sdd/baseline_failed.txt"
wc -l "C:/tmp/Accu-Mk1-manage-analyses/.superpowers/sdd/baseline_failed.txt"
```
Expected: a few dozen lines (the known baseline, ~64–67 ids). Record the count in the ledger.

- [ ] **Step 4: Install frontend deps**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && npm ci
```
Expected: exits 0.

- [ ] **Step 5: Sanity: the two existing test files this slice extends pass at base**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend"
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_parent_placeholders.py tests/test_native_manage_analyses.py tests/test_amendment_audit.py tests/test_custody_edges.py
```
Expected: all pass. No commit for this task.

---

### Task 2: `seed_parent_placeholders` — re-add after `rejected`, `reason`/`user` audit

**Files:**
- Modify: `backend/lims_analyses/parent_placeholders.py` (`seed_parent_placeholders`, lines 29–76)
- Modify: `backend/lims_analyses/service.py` (add `record_placeholder_created` right after `create_analysis`, ~line 266)
- Modify: `backend/tests/test_amendment_audit.py:285` (guard floor 11 → 12)
- Test: `backend/tests/test_parent_placeholders.py`

**Interfaces:**
- Produces: `seed_parent_placeholders(db, *, parent, services: dict, package=None, reason: str | None = None, created_by_user_id: int | None = None) -> dict` returning `{"created": int, "existing": int, "skipped": int, "created_ids": list[int]}`.
- Produces: `service.record_placeholder_created(db, row, *, reason: str, user_id: int | None) -> LimsAnalysisTransition` (adds to session, flushes, no commit).

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_parent_placeholders.py`)

```python
# ── Manage-analyses slice: re-add after soft remove + audited reason ─────────

def test_rejected_placeholder_does_not_block_re_add(db, parent_sample, usp71_profile):
    """R1 soft-remove sets review_state='rejected'; the partial unique index
    excludes rejected rows, and so must the pre-check — otherwise a re-add
    reports `existing` and mints nothing."""
    first = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert first["created"] == 1
    row = db.query(LimsAnalysis).get(first["created_ids"][0])
    row.review_state = "rejected"
    db.commit()

    again = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert again["created"] == 1 and again["existing"] == 0
    live = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).all()
    assert sorted(r.review_state for r in live) == ["rejected", "unassigned"]


def test_reason_writes_an_auto_transition_with_empty_changed(db, parent_sample, usp71_profile):
    from models import LimsAnalysisTransition
    stats = seed_parent_placeholders(
        db, parent=parent_sample, services={"sterility_usp71": True},
        reason="manage_analyses:add profile=sterility_usp71", created_by_user_id=7,
    )
    db.commit()
    (aid,) = stats["created_ids"]
    trs = db.query(LimsAnalysisTransition).filter_by(analysis_id=aid).all()
    assert len(trs) == 1
    t = trs[0]
    assert t.transition_kind == "auto" and t.from_state is None and t.to_state == "unassigned"
    assert t.reason == "manage_analyses:add profile=sterility_usp71"
    assert t.user_id == 7
    assert t.details == {"changed": {}}


def test_no_reason_writes_no_transition(db, parent_sample, usp71_profile):
    """Registration-time seeding is unchanged: no transition row (today's behavior)."""
    from models import LimsAnalysisTransition
    stats = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.analysis_id.in_(stats["created_ids"])
    ).count() == 0
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_parent_placeholders.py -k "re_add or reason or no_reason"
```
Expected: 3 FAIL (`created_ids` KeyError / unexpected kwarg `reason`).

- [ ] **Step 3: Add `record_placeholder_created` to `backend/lims_analyses/service.py`** — insert immediately after `create_analysis`'s closing `return row` (~line 266):

```python
def record_placeholder_created(
    db: Session,
    row: LimsAnalysis,
    *,
    reason: str,
    user_id: Optional[int],
) -> LimsAnalysisTransition:
    """Audit row for a lab-minted parent placeholder (manage-analyses slice).

    Registration-time placeholders carry no transition (they are 'ordered' and
    nothing more); a lab-driven mint records *why it exists* on an 'auto'
    transition (from NULL → unassigned) whose `reason` names the action.
    Lives here — not in parent_placeholders.py — so the amendment-audit AST
    guard sees the construction and enforces details=. Flushes, never commits.
    """
    tr = LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=None,
        to_state="unassigned",
        transition_kind="auto",
        user_id=user_id,
        reason=reason,
        details={"changed": {}},
    )
    db.add(tr)
    db.flush()
    return tr
```

- [ ] **Step 4: Rewrite `seed_parent_placeholders` in `backend/lims_analyses/parent_placeholders.py`**

```python
def seed_parent_placeholders(
    db, *, parent, services: dict, package=None,
    reason: str | None = None, created_by_user_id: int | None = None,
) -> dict:
    """Mint a pending parent-tier row per ORDERED native analysis service.

    Idempotent: relies on uq_lims_analyses_parent_service_ordered, and also
    checks first so a re-run reports `existing` rather than raising. The
    pre-check mirrors the index predicate exactly — a 'rejected'/'retracted'
    placeholder (manage-analyses soft remove) does NOT block a fresh mint.

    Only native (origin='mk1') services are placeheld — SENAITE-sourced ones
    already get their 'shadow' row from the registration mirror.

    reason / created_by_user_id (manage-analyses slice): when `reason` is
    given, every CREATED row also gets an 'auto' transition naming the action
    (service.record_placeholder_created). Registration-time callers pass
    neither and behave exactly as before (no transition).

    Calls _ordered_native_profiles with require_archetype=False: a profile's
    coa_archetype governs whether a COA section can be RENDERED, not whether
    the customer paid for the test.
    """
    from models import LimsAnalysis
    from coa.native_sections import _ordered_native_profiles
    from lims_analyses.service import record_placeholder_created

    stats = {"created": 0, "existing": 0, "skipped": 0, "created_ids": []}
    profiles = _ordered_native_profiles(db, services or {}, package,
                                        require_archetype=False)

    for prof in profiles:
        for svc in prof.analysis_services:
            if (getattr(svc, "origin", None) or "") != "mk1":
                stats["skipped"] += 1
                continue
            exists = (
                db.query(LimsAnalysis)
                .filter_by(
                    lims_sample_pk=parent.id,
                    analysis_service_id=svc.id,
                    provenance=PROVENANCE_ORDERED,
                )
                .filter(LimsAnalysis.review_state.notin_(("rejected", "retracted")))
                .first()
            )
            if exists is not None:
                stats["existing"] += 1
                continue
            row = LimsAnalysis(
                lims_sample_pk=parent.id,
                lims_sub_sample_pk=None,
                analysis_service_id=svc.id,
                keyword=svc.keyword,
                title=svc.title,
                result_value=None,
                review_state="unassigned",
                provenance=PROVENANCE_ORDERED,
                created_by_user_id=created_by_user_id,
            )
            db.add(row)
            db.flush()
            if reason:
                record_placeholder_created(db, row, reason=reason, user_id=created_by_user_id)
            stats["created"] += 1
            stats["created_ids"].append(row.id)
    return stats
```
(Check `LimsAnalysis` has `created_by_user_id` — `create_analysis` sets it, so it does.)

- [ ] **Step 5: Bump the guard floor** in `backend/tests/test_amendment_audit.py` — find `assert len(sites) >= 11` (~line 285) and change to `>= 12`, updating the adjacent comment to name the new site (`record_placeholder_created`).

- [ ] **Step 6: Run the tests**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_parent_placeholders.py tests/test_amendment_audit.py
```
Expected: all pass (existing 16 + 3 new; audit guard green at floor 12).

- [ ] **Step 7: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/lims_analyses/parent_placeholders.py backend/lims_analyses/service.py backend/tests/test_parent_placeholders.py backend/tests/test_amendment_audit.py && git commit -m "feat(manage-native): placeholder seed skips dead rows on re-add; audited reason for lab mints"
```

---

### Task 3: `manage_native.py` — profile listing, placeholder-derived keys, `add_profile_to_parent`

**Files:**
- Create: `backend/lims_analyses/manage_native.py`
- Test: `backend/tests/test_manage_native.py` (new)

**Interfaces:**
- Consumes: `seed_parent_placeholders(...)` (Task 2), `lims_analyses.seeder._seed_rows_from_services(db, *, sub_sample, services, existing_kw, created_by_user_id, commit, log_event)`, `models.VialProfileAssignment`, `sub_samples.custody.current_custody(db, sub_pk) -> list[VialProfileAssignment]`.
- Produces (module `lims_analyses.manage_native`):
  - `class ProfileNotNativeError(BadRequestError)`, `class ProfileInactiveError(BadRequestError)`, `class ProfileHasNoMembersError(BadRequestError)`, `class ProfileAlreadyOnSampleError(ConflictError)` (subclass the existing `service.BadRequestError` / `service.ConflictError`; each carries `.code: str`).
  - `native_profiles_for_parent(db, *, parent) -> list[dict]` — each `{"id","key","name","fulfillment_role","members":[{"service_id","keyword","title"}],"on_sample":"none|partial|full","host_vials":[str]}`.
  - `placeholder_profile_keys(db, parent) -> dict[str, bool]`.
  - `add_profile_to_parent(db, *, parent, profile, user_id) -> dict` — `{"profile_key","profile_name","placeholders_created","placeholders_existing","hosts":[{"vial_id":str,"edge_created":bool,"vial_rows_created":int}],"no_host_vial":bool}`; **does not commit** (caller commits).
  - `_live_parent_service_ids(db, parent) -> set[int]` (helper; ordered or non-dead canonical).
  - `_native_members(profile) -> list[AnalysisService]` raising the three validation errors.

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_manage_native.py`:

```python
"""Tests for lims_analyses/manage_native.py (native Manage Analyses slice).

Self-contained in-memory SQLite (same idiom as test_parent_placeholders.py):
models.py registers everything on Base.metadata before create_all().
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from database import Base
from models import (
    AnalysisProfile, AnalysisService, LimsAnalysis, LimsAnalysisTransition,
    LimsSample, LimsSubSample, LimsSubSampleEvent, VialProfileAssignment,
)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from lims_analyses import manage_native as mn


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent(db):
    p = LimsSample(sample_id="MN-PARENT", sample_type="x", status="received",
                   external_lims_system="senaite")
    db.add(p); db.commit(); db.refresh(p)
    return p


def _svc(db, *, keyword, title, origin="mk1"):
    s = AnalysisService(title=title, keyword=keyword, origin=origin)
    db.add(s); db.commit(); db.refresh(s)
    return s


def _profile(db, *, key, name, members, role, active=True, dim="role"):
    p = AnalysisProfile(key=key, name=name, is_addon=True, coa_archetype="limit_table",
                        fulfillment_role=role, fulfillment_dim=dim, vials_required=1,
                        active=active)
    for m in members:
        p.analysis_services.append(m)
    db.add(p); db.commit(); db.refresh(p)
    return p


def _vial(db, parent, *, sid, seq, role):
    v = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"mk1://{sid}",
                      sample_id=sid, vial_sequence=seq, assignment_role=role)
    db.add(v); db.commit(); db.refresh(v)
    return v


@pytest.fixture
def moisture(db):
    kf = _svc(db, keyword="MOISTURE-KF", title="Residual Moisture")
    return _profile(db, key="moisture", name="Residual Moisture", members=[kf], role="kf")


@pytest.fixture
def heavy_metals(db):
    m = [_svc(db, keyword=k, title=t) for k, t in
         (("LEAD-PPM", "Lead"), ("ARSENIC-PPM", "Arsenic"),
          ("CADMIUM-PPM", "Cadmium"), ("MERCURY-PPM", "Mercury"))]
    return _profile(db, key="heavy_metals", name="Heavy Metals", members=m, role="hm")


# ── native_profiles_for_parent ────────────────────────────────────────────────

def test_lists_only_all_mk1_active_profiles_with_on_sample_and_hosts(db, parent, moisture, heavy_metals):
    legacy = _svc(db, keyword="ENDO-LAL", title="Endotoxin", origin="senaite")
    _profile(db, key="endotoxin", name="Endotoxin", members=[legacy], role="endo")
    _profile(db, key="dead", name="Dead", members=[_svc(db, keyword="D", title="D")], role="hm", active=False)
    _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")

    out = mn.native_profiles_for_parent(db, parent=parent)
    keys = {p["key"] for p in out}
    assert keys == {"moisture", "heavy_metals"}
    m = next(p for p in out if p["key"] == "moisture")
    assert m["on_sample"] == "none"
    assert m["host_vials"] == ["MN-PARENT-S04"]
    assert m["members"] == [{"service_id": moisture.analysis_services[0].id,
                             "keyword": "MOISTURE-KF", "title": "Residual Moisture"}]
    hm = next(p for p in out if p["key"] == "heavy_metals")
    assert hm["host_vials"] == []


def test_on_sample_partial_and_full(db, parent, heavy_metals):
    lead, arsenic = heavy_metals.analysis_services[0], heavy_metals.analysis_services[1]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=lead.id, keyword="LEAD-PPM",
                        title="Lead", review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.native_profiles_for_parent(db, parent=parent)[0]["on_sample"] == "partial"
    for s in heavy_metals.analysis_services[1:]:
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=s.id, keyword=s.keyword,
                            title=s.title, review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.native_profiles_for_parent(db, parent=parent)[0]["on_sample"] == "full"


def test_rejected_placeholder_does_not_count_as_on_sample(db, parent, moisture):
    kf = moisture.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="rejected", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.native_profiles_for_parent(db, parent=parent)[0]["on_sample"] == "none"


# ── placeholder_profile_keys ──────────────────────────────────────────────────

def test_placeholder_profile_keys_maps_live_ordered_rows_to_profile_keys(db, parent, moisture, heavy_metals):
    kf = moisture.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    assert mn.placeholder_profile_keys(db, parent) == {"moisture": True}


def test_placeholder_profile_keys_ignores_rejected_and_canonical(db, parent, moisture):
    kf = moisture.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="rejected", provenance=PROVENANCE_ORDERED))
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="verified", provenance="canonical"))
    db.commit()
    assert mn.placeholder_profile_keys(db, parent) == {}


# ── add_profile_to_parent ─────────────────────────────────────────────────────

def test_add_with_host_vial_mints_placeholder_edge_and_vial_row(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    res = mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=5)
    db.commit()
    assert res["placeholders_created"] == 1 and res["no_host_vial"] is False
    assert res["hosts"] == [{"vial_id": "MN-PARENT-S04", "edge_created": True, "vial_rows_created": 1}]
    kf = moisture.analysis_services[0]
    ph = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id,
                                               LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().all()
    assert [r.analysis_service_id for r in ph] == [kf.id]
    vr = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert [(r.analysis_service_id, r.review_state) for r in vr] == [(kf.id, "unassigned")]
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().all()
    assert [(e.analysis_profile_id, e.relation, e.assigned_by_id, e.superseded_at) for e in edges] == \
        [(moisture.id, "host", 5, None)]
    ev = db.execute(select(LimsSubSampleEvent).where(LimsSubSampleEvent.lims_sample_pk == parent.id)).scalars().one()
    assert ev.event == "native_profile_added" and ev.details["profile_key"] == "moisture" and ev.user_id == 5
    tr = db.execute(select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == ph[0].id)).scalars().one()
    assert tr.reason == "manage_analyses:add profile=moisture"


def test_add_without_host_vial_is_placeholder_only(db, parent, moisture):
    _vial(db, parent, sid="MN-PARENT-S01", seq=1, role="hplc")
    res = mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=None)
    db.commit()
    assert res["placeholders_created"] == 1 and res["no_host_vial"] is True and res["hosts"] == []
    assert db.query(VialProfileAssignment).count() == 0
    assert db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk.isnot(None)).count() == 0


def test_add_is_idempotent_and_partial_mints_only_missing(db, parent, heavy_metals):
    v = _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    lead = heavy_metals.analysis_services[0]
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=lead.id, keyword="LEAD-PPM",
                        title="Lead", review_state="unassigned", provenance=PROVENANCE_ORDERED))
    db.commit()
    res = mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    assert res["placeholders_created"] == 3 and res["placeholders_existing"] == 1
    assert res["hosts"][0]["vial_rows_created"] == 4
    # second run: everything exists
    with pytest.raises(mn.ProfileAlreadyOnSampleError):
        mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    assert db.query(VialProfileAssignment).filter_by(lims_sub_sample_pk=v.id).count() == 1


def test_add_seeds_every_matching_role_vial(db, parent, heavy_metals):
    _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    _vial(db, parent, sid="MN-PARENT-S03", seq=3, role="hm")
    res = mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    assert [h["vial_id"] for h in res["hosts"]] == ["MN-PARENT-S02", "MN-PARENT-S03"]
    assert all(h["vial_rows_created"] == 4 for h in res["hosts"])


def test_add_rejects_inactive_non_native_and_empty(db, parent):
    mk1 = _svc(db, keyword="A", title="A")
    sen = _svc(db, keyword="B", title="B", origin="senaite")
    inactive = _profile(db, key="i", name="I", members=[mk1], role="hm", active=False)
    mixed = _profile(db, key="m", name="M", members=[mk1, sen], role="hm")
    empty = _profile(db, key="e", name="E", members=[], role="hm")
    with pytest.raises(mn.ProfileInactiveError):
        mn.add_profile_to_parent(db, parent=parent, profile=inactive, user_id=1)
    with pytest.raises(mn.ProfileNotNativeError):
        mn.add_profile_to_parent(db, parent=parent, profile=mixed, user_id=1)
    with pytest.raises(mn.ProfileHasNoMembersError):
        mn.add_profile_to_parent(db, parent=parent, profile=empty, user_id=1)
    assert db.query(LimsAnalysis).count() == 0
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py
```
Expected: ImportError `lims_analyses.manage_native`.

- [ ] **Step 3: Create `backend/lims_analyses/manage_native.py`**

```python
"""Native Manage Analyses (spec docs/superpowers/specs/2026-08-18-native-manage-analyses-design.md).

Lab-side add / remove / re-sync of NATIVE (origin='mk1') analyses on a parent
sample and its vials, after an order exists. Composes three primitives that
stay unchanged:

  * parent tier   — lims_analyses.parent_placeholders.seed_parent_placeholders
                    (provenance='ordered' rows; the parent's "what is on this
                    sample" truth)
  * vial custody  — models.VialProfileAssignment host edges (spec 4). Since
                    spec 4 the vial seeder reads edges first and IGNORES
                    wp_services when edges exist, so "put a profile on a vial"
                    IS "write a host edge". write_custody_edges is never called
                    from here — it supersedes every current edge.
  * vial rows     — lims_analyses.seeder._seed_rows_from_services (the shared
                    row builder: dedupe by live keyword, create_analysis with
                    its 'auto' transition, log event)

Rulings baked in: A (provision-on-sample), P (profile-level add), R1 (soft
remove of the placeholder). Nothing here writes to WP or the IS.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample,
    LimsSubSampleEvent, VialProfileAssignment,
)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from lims_analyses.service import BadRequestError, ConflictError
# Module-level on purpose (tests monkeypatch mn.fetch_sample_services); same
# import coa/native_sections.py already makes at module level — no cycle.
from sub_samples.service import fetch_sample_services

log = logging.getLogger(__name__)

DEAD_STATES = ("rejected", "retracted")


class ProfileNotNativeError(BadRequestError):
    code = "profile_not_native"


class ProfileInactiveError(BadRequestError):
    code = "profile_inactive"


class ProfileHasNoMembersError(BadRequestError):
    code = "profile_has_no_members"


class ProfileAlreadyOnSampleError(ConflictError):
    code = "profile_already_on_sample"


# ── read helpers ─────────────────────────────────────────────────────────────

def _native_members(profile: AnalysisProfile) -> list[AnalysisService]:
    """The profile's member services, or raise. Same predicate as
    coa.native_sections._ordered_native_profiles: every member must be mk1."""
    if not profile.active:
        raise ProfileInactiveError(f"profile {profile.key!r} is inactive")
    members = list(profile.analysis_services)
    if not members:
        raise ProfileHasNoMembersError(f"profile {profile.key!r} has no member services")
    if any((getattr(s, "origin", None) or "") != "mk1" for s in members):
        raise ProfileNotNativeError(f"profile {profile.key!r} has a non-native member")
    return members


def _is_all_native(profile: AnalysisProfile) -> bool:
    try:
        _native_members(profile)
        return True
    except BadRequestError:
        return False


def _live_parent_service_ids(db: Session, parent: LimsSample) -> set[int]:
    """Service ids with a LIVE parent-tier row: an 'ordered' placeholder or a
    non-dead 'canonical' row (a promoted result counts as 'on the sample')."""
    rows = db.execute(
        select(LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.provenance.in_((PROVENANCE_ORDERED, "canonical")),
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all()
    return set(rows)


def _vials_of(db: Session, parent: LimsSample) -> list[LimsSubSample]:
    return db.execute(
        select(LimsSubSample)
        .where(LimsSubSample.parent_sample_pk == parent.id)
        .order_by(LimsSubSample.vial_sequence)
    ).scalars().all()


def _host_vials(db: Session, parent: LimsSample, profile: AnalysisProfile) -> list[LimsSubSample]:
    """Existing vials whose assignment_role is the profile's host role.
    Role-dimension profiles host on their own fulfillment_role; anything else
    (rider profiles) hosts nowhere here — they attach at check-in via
    resolve_catalog_fulfillment and are out of this slice's add path."""
    if profile.fulfillment_dim != "role" or not profile.fulfillment_role:
        return []
    return [v for v in _vials_of(db, parent) if v.assignment_role == profile.fulfillment_role]


def native_profiles_for_parent(db: Session, *, parent: LimsSample) -> list[dict]:
    """Picker payload: active all-mk1 profiles with membership, whether the
    sample already carries them, and which existing vials would host them."""
    live = _live_parent_service_ids(db, parent)
    out: list[dict] = []
    profiles = db.execute(
        select(AnalysisProfile).where(AnalysisProfile.active.is_(True))
        .order_by(AnalysisProfile.sort_order, AnalysisProfile.name)
    ).scalars().all()
    for prof in profiles:
        if not _is_all_native(prof):
            continue
        members = list(prof.analysis_services)
        have = sum(1 for m in members if m.id in live)
        on_sample = "none" if have == 0 else ("full" if have == len(members) else "partial")
        out.append({
            "id": prof.id,
            "key": prof.key,
            "name": prof.name,
            "fulfillment_role": prof.fulfillment_role,
            "members": [{"service_id": m.id, "keyword": m.keyword, "title": m.title} for m in members],
            "on_sample": on_sample,
            "host_vials": [v.sample_id for v in _host_vials(db, parent, prof)],
        })
    return out


def placeholder_profile_keys(db: Session, parent: LimsSample) -> dict[str, bool]:
    """{profile.key: True} for every active all-mk1 profile with ≥1 member that
    has a LIVE 'ordered' placeholder on the parent. Unioned into the role-flip
    services map (sub_samples.service.set_assignment_role) so a lab-added
    profile seeds when a matching-role vial appears — ruling A's promise."""
    live_ordered = set(db.execute(
        select(LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
            LimsAnalysis.provenance == PROVENANCE_ORDERED,
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all())
    if not live_ordered:
        return {}
    keys: dict[str, bool] = {}
    for prof in db.execute(select(AnalysisProfile).where(AnalysisProfile.active.is_(True))).scalars():
        if not _is_all_native(prof):
            continue
        if any(m.id in live_ordered for m in prof.analysis_services):
            keys[prof.key] = True
    return keys


# ── write path: add ──────────────────────────────────────────────────────────

def _ensure_host_edge(db: Session, *, vial: LimsSubSample, profile: AnalysisProfile,
                      user_id: Optional[int]) -> bool:
    """Add a current host edge (vial ↔ profile) if none exists. Returns True
    when a row was written. Never supersedes anything."""
    existing = db.execute(
        select(VialProfileAssignment).where(
            VialProfileAssignment.lims_sub_sample_pk == vial.id,
            VialProfileAssignment.analysis_profile_id == profile.id,
            VialProfileAssignment.superseded_at.is_(None),
        )
    ).scalars().first()
    if existing is not None:
        return False
    db.add(VialProfileAssignment(
        lims_sub_sample_pk=vial.id, analysis_profile_id=profile.id,
        relation="host", assigned_at=datetime.utcnow(), assigned_by_id=user_id,
    ))
    db.flush()
    return True


def _seed_members_on_vial(db: Session, *, vial: LimsSubSample, members: list[AnalysisService],
                          user_id: Optional[int]) -> int:
    """Seed exactly `members` on `vial` through the seeder's shared row builder
    (dedupe by live keyword; each row gets create_analysis's 'auto' transition).
    Bypasses seed_analyses_for_vial's role branching on purpose: we know the
    exact service list, and legacy roles (hplc/endo/ster) never take the
    catalog path there."""
    from lims_analyses.seeder import _seed_rows_from_services
    existing_kw = set(db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == vial.id,
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all())
    rows = _seed_rows_from_services(
        db, sub_sample=vial, services=members, existing_kw=existing_kw,
        created_by_user_id=user_id, commit=False, log_event="manage_native_seeded",
    )
    return len(rows)


def add_profile_to_parent(db: Session, *, parent: LimsSample, profile: AnalysisProfile,
                          user_id: Optional[int]) -> dict:
    """Ruling A + P: put a native PROFILE on the sample. Mints the parent
    placeholders (idempotent), and for every existing vial whose role hosts
    the profile writes a host custody edge and seeds the members. No host
    vial → placeholders only (the role-flip union hook seeds later).
    Raises ProfileInactiveError / ProfileHasNoMembersError /
    ProfileNotNativeError / ProfileAlreadyOnSampleError. Caller commits."""
    members = _native_members(profile)
    live = _live_parent_service_ids(db, parent)
    if all(m.id in live for m in members):
        raise ProfileAlreadyOnSampleError(f"profile {profile.key!r} is already on {parent.sample_id}")

    reason = f"manage_analyses:add profile={profile.key}"
    stats = seed_parent_placeholders(
        db, parent=parent, services={profile.key: True},
        reason=reason, created_by_user_id=user_id,
    )

    hosts: list[dict] = []
    for vial in _host_vials(db, parent, profile):
        edge_created = _ensure_host_edge(db, vial=vial, profile=profile, user_id=user_id)
        n = _seed_members_on_vial(db, vial=vial, members=members, user_id=user_id)
        hosts.append({"vial_id": vial.sample_id, "edge_created": edge_created, "vial_rows_created": n})

    db.add(LimsSubSampleEvent(
        lims_sample_pk=parent.id, event="native_profile_added",
        details={
            "profile_key": profile.key, "profile_name": profile.name,
            "placeholders_created": stats["created"], "hosts": hosts,
        },
        user_id=user_id,
    ))
    db.flush()
    log.info("manage_native.profile_added parent=%s profile=%s placeholders=%s hosts=%s",
             parent.sample_id, profile.key, stats["created"], [h["vial_id"] for h in hosts])
    return {
        "profile_key": profile.key,
        "profile_name": profile.name,
        "placeholders_created": stats["created"],
        "placeholders_existing": stats["existing"],
        "hosts": hosts,
        "no_host_vial": not hosts,
    }
```

- [ ] **Step 4: Run the tests**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py
```
Expected: 10 pass. If `LimsAnalysis(...)` in the tests complains about a missing NOT NULL (e.g. `title`), add the column to the test rows — do not loosen the model.

- [ ] **Step 5: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/lims_analyses/manage_native.py backend/tests/test_manage_native.py && git commit -m "feat(manage-native): profile picker read + add_profile_to_parent (placeholders + host edge + vial seed)"
```

---

### Task 4: Role-flip union hook in `set_assignment_role`

**Files:**
- Modify: `backend/sub_samples/service.py:1764-1769` (inside `set_assignment_role`, the `services_map` resolution)
- Test: `backend/tests/test_manage_native.py` (append)

**Interfaces:**
- Consumes: `manage_native.placeholder_profile_keys(db, parent_row)` (Task 3).

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_manage_native.py`)

```python
# ── role-flip union hook ──────────────────────────────────────────────────────

def test_role_flip_seeds_a_lab_added_profile_with_no_prior_host_vial(db, parent, moisture, monkeypatch):
    """Ruling A: placeholder first, vial later. When the vial gets role 'kf',
    set_assignment_role must union the placeholder-derived key {'moisture'}
    into its services map (the WP order doesn't carry it) so the custody edge
    is written and the member seeds."""
    import sub_samples.service as svc
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db)  # role gate is catalog-driven
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role=None)
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda sid: {"hplcpurity_identity": True})

    svc.set_assignment_role(db, v.sample_id, "kf", user_id=1)

    kf = moisture.analysis_services[0]
    rows = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert [r.analysis_service_id for r in rows] == [kf.id]
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id,
        VialProfileAssignment.superseded_at.is_(None))).scalars().all()
    assert [(e.analysis_profile_id, e.relation) for e in edges] == [(moisture.id, "host")]


def test_role_flip_without_placeholders_is_unchanged(db, parent, moisture, monkeypatch):
    import sub_samples.service as svc
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(db)
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role=None)
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent", lambda sid: {"hplcpurity_identity": True})
    svc.set_assignment_role(db, v.sample_id, "kf", user_id=1)
    assert db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk == v.id).count() == 0
    assert db.query(VialProfileAssignment).count() == 0
```
(`set_assignment_role`'s exact keyword names: check the base signature at `sub_samples/service.py:1672` — `set_assignment_role(db, sample_id, role, *, user_id=None, wp_services=None, …)`; adapt the call if a parameter is positional-only. If the `kf` role is not in `seed_vial_roles`, use `hm` for the profile + flip instead — the assertion is about the union, not the code.)

- [ ] **Step 2: Run to verify the first fails, the second passes**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py -k role_flip
```
Expected: `..._lab_added_profile...` FAILS (0 rows), `..._unchanged` passes.

- [ ] **Step 3: Add the union** in `backend/sub_samples/service.py` — replace

```python
        parent_sid = parent_row.sample_id if parent_row else None
        services_map = None
        if role and role != "xtra" and parent_sid:
            services_map = (
                wp_services if wp_services is not None
                else _fetch_wp_services_for_parent(parent_sid) or {}
            )
```
with
```python
        parent_sid = parent_row.sample_id if parent_row else None
        services_map = None
        if role and role != "xtra" and parent_sid:
            services_map = (
                wp_services if wp_services is not None
                else _fetch_wp_services_for_parent(parent_sid) or {}
            )
            # Manage-analyses slice (ruling A): a profile the lab added on the
            # parent (live 'ordered' placeholders) is not in the WP order, so
            # union its key in — resolve_catalog_fulfillment then hosts it and
            # the seeder seeds it. Adds nothing for a normal order (those keys
            # are already present); reads only, never writes.
            from lims_analyses.manage_native import placeholder_profile_keys
            services_map = {**services_map, **placeholder_profile_keys(db, parent_row)}
```

- [ ] **Step 4: Run the tests + the custody/seeding suites that exercise this function**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py tests/test_custody_edges.py tests/test_catalog_seeding.py tests/test_catalog_bench_acceptance.py
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/sub_samples/service.py backend/tests/test_manage_native.py && git commit -m "feat(manage-native): role-flip unions placeholder-derived profile keys so lab-added profiles seed later"
```

---

### Task 5: `remove_parent_native_analysis` (soft remove, cascade, edge supersede)

**Files:**
- Modify: `backend/lims_analyses/service.py` (add `soft_reject_parent_placeholder` after `record_placeholder_created`)
- Modify: `backend/lims_analyses/manage_native.py` (append)
- Modify: `backend/tests/test_amendment_audit.py` (floor 12 → 13)
- Test: `backend/tests/test_manage_native.py` (append)

**Interfaces:**
- Consumes: `service.delete_pristine_analysis(db, *, sub_sample_pk, keyword, user_id)` (commits; writes vial event first), `service.apply_transition(db, *, analysis_id, kind, reason, user_id)` (commits), `models.LimsAnalysisPromotion(parent_analysis_id, source_analysis_id)`.
- Produces:
  - `service.soft_reject_parent_placeholder(db, row, *, reason, user_id) -> LimsAnalysis` (sets `review_state='rejected'`, writes a `reject` transition, flushes, no commit).
  - `manage_native.RemovalNeedsConfirm(Exception)` with `.impact: dict` = `{"pristine": [...], "worked_unverified": [...], "blocked": []}` (row shape `{"sample_id","analysis_id","review_state","keyword"}` — same keys `RemovalConfirmModal` reads).
  - `manage_native.PromotedResultExistsError(ConflictError)` `.code="promoted_result_exists"`.
  - `manage_native.remove_parent_native_analysis(db, *, parent, analysis_id, confirm: bool, user_id) -> dict` = `{"analysis_id","keyword","analysis_service_id","vial_rows_deleted","vial_rows_rejected","edges_superseded"}`; **commits** (its vial-tier primitives commit as they go — documented).

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_manage_native.py`)

```python
# ── remove_parent_native_analysis ─────────────────────────────────────────────

def _placeholder_of(db, parent, svc_id):
    return db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == parent.id, LimsAnalysis.analysis_service_id == svc_id,
        LimsAnalysis.provenance == PROVENANCE_ORDERED,
        LimsAnalysis.review_state.notin_(("rejected", "retracted")))).scalars().one()


def test_remove_pristine_deletes_vial_rows_soft_rejects_placeholder_supersedes_edge(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)

    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)

    assert res == {"analysis_id": ph.id, "keyword": "MOISTURE-KF", "analysis_service_id": kf.id,
                   "vial_rows_deleted": 1, "vial_rows_rejected": 0, "edges_superseded": 1}
    db.refresh(ph)
    assert ph.review_state == "rejected"
    tr = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == ph.id).order_by(LimsAnalysisTransition.id)).scalars().all()
    assert [t.transition_kind for t in tr] == ["auto", "reject"]
    assert tr[-1].reason == "manage_analyses:remove" and tr[-1].details == {"changed": {}}
    assert db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk == v.id).count() == 0
    edge = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().one()
    assert edge.superseded_at is not None
    evs = [e.event for e in db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == parent.id)).scalars().all()]
    assert "native_analysis_removed" in evs
    # re-add works: the rejected placeholder does not block, a fresh one mints
    res2 = mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    assert res2["placeholders_created"] == 1


def test_remove_worked_vial_row_requires_confirm_then_rejects(db, parent, moisture):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    vr = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().one()
    vr.result_value = "0.42"; vr.review_state = "to_be_verified"; db.commit()

    with pytest.raises(mn.RemovalNeedsConfirm) as ei:
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)
    assert [r["sample_id"] for r in ei.value.impact["worked_unverified"]] == ["MN-PARENT-S04"]
    db.refresh(ph); assert ph.review_state == "unassigned"  # nothing changed

    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)
    assert res["vial_rows_rejected"] == 1 and res["vial_rows_deleted"] == 0
    db.refresh(vr); assert vr.review_state == "rejected"
    db.refresh(ph); assert ph.review_state == "rejected"


def test_remove_blocked_when_a_live_canonical_row_exists(db, parent, moisture):
    mn.add_profile_to_parent(db, parent=parent, profile=moisture, user_id=1)
    db.commit()
    kf = moisture.analysis_services[0]
    ph = _placeholder_of(db, parent, kf.id)
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="verified", provenance="canonical"))
    db.commit()
    with pytest.raises(mn.PromotedResultExistsError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=True, user_id=2)


def test_remove_only_supersedes_edge_when_no_member_row_remains(db, parent, heavy_metals):
    v = _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)
    db.commit()
    lead = heavy_metals.analysis_services[0]
    ph = _placeholder_of(db, parent, lead.id)
    res = mn.remove_parent_native_analysis(db, parent=parent, analysis_id=ph.id, confirm=False, user_id=2)
    assert res["edges_superseded"] == 0  # 3 members still live on the vial
    edge = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().one()
    assert edge.superseded_at is None


def test_remove_rejects_non_placeholder_targets(db, parent, moisture):
    kf = moisture.analysis_services[0]
    can = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                       title="Residual Moisture", review_state="verified", provenance="canonical")
    db.add(can); db.commit()
    from lims_analyses.service import NotFoundError
    with pytest.raises(NotFoundError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=can.id, confirm=False, user_id=2)
    with pytest.raises(NotFoundError):
        mn.remove_parent_native_analysis(db, parent=parent, analysis_id=999999, confirm=False, user_id=2)
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py -k remove
```
Expected: 5 FAIL (AttributeError `remove_parent_native_analysis`).

- [ ] **Step 3: Add `soft_reject_parent_placeholder` to `backend/lims_analyses/service.py`** — right after `record_placeholder_created`:

```python
def soft_reject_parent_placeholder(
    db: Session,
    row: LimsAnalysis,
    *,
    reason: str,
    user_id: Optional[int],
) -> LimsAnalysis:
    """Ruling R1 (manage-analyses slice): a parent PLACEHOLDER (provenance
    'ordered', never worked) is removed by marking it 'rejected' — the row and
    its transitions survive as the trail, and the partial unique index
    (…_parent_service_ordered excludes rejected/retracted) frees the slot for
    a re-add. Written directly rather than through apply_transition: the
    generic tier gate forbids parent-tier 'reject' on purpose (workflow rows),
    and that gate is untouched — this is a placeholder-only primitive.
    Raises BadRequestError on anything that is not a live placeholder.
    Flushes, never commits.
    """
    if row.provenance != "ordered" or row.lims_sub_sample_pk is not None:
        raise BadRequestError(f"analysis id={row.id} is not a parent placeholder")
    if row.review_state in ("rejected", "retracted"):
        raise BadRequestError(f"analysis id={row.id} is already {row.review_state}")
    from_state = row.review_state
    row.review_state = "rejected"
    row.updated_at = datetime.utcnow()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id,
        from_state=from_state,
        to_state="rejected",
        transition_kind="reject",
        user_id=user_id,
        reason=reason,
        details={"changed": {}},
    ))
    db.flush()
    return row
```
(`datetime` is already imported at the top of `service.py`; verify, else add `from datetime import datetime`.)

- [ ] **Step 4: Bump the guard floor** in `backend/tests/test_amendment_audit.py`: `>= 12` → `>= 13`, comment names `soft_reject_parent_placeholder`.

- [ ] **Step 5: Append the removal path to `backend/lims_analyses/manage_native.py`**

```python
# ── write path: remove ───────────────────────────────────────────────────────

class PromotedResultExistsError(ConflictError):
    code = "promoted_result_exists"


class RemovalNeedsConfirm(Exception):
    """Worked vial rows would be rejected — the caller must confirm (412)."""

    def __init__(self, impact: dict):
        super().__init__("removal touches worked vial rows; confirm required")
        self.impact = impact


def _placeholder_row(db: Session, parent: LimsSample, analysis_id: int) -> LimsAnalysis:
    from lims_analyses.service import NotFoundError
    row = db.get(LimsAnalysis, analysis_id)
    if (row is None or row.lims_sample_pk != parent.id or row.lims_sub_sample_pk is not None
            or row.provenance != PROVENANCE_ORDERED or row.review_state in DEAD_STATES):
        raise NotFoundError(f"no live parent placeholder id={analysis_id} on {parent.sample_id}")
    return row


def _classify_vial_rows(db: Session, parent: LimsSample, service_id: int) -> dict:
    """Vial-tier rows for `service_id` on the parent's vials, bucketed like
    service.classify_removal_impact but keyed by SERVICE ID (S3-aligned):
    pristine (unassigned, no result, not retested, no promotion link) /
    worked_unverified (anything else live) / blocked (promoted, i.e. a
    promotion link exists — the parent-tier canonical check upstream already
    409s, this is defence)."""
    from models import LimsAnalysisPromotion
    vials = {v.id: v for v in _vials_of(db, parent)}
    out = {"pristine": [], "worked_unverified": [], "blocked": []}
    if not vials:
        return out
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk.in_(list(vials)),
            LimsAnalysis.analysis_service_id == service_id,
            LimsAnalysis.review_state.notin_(DEAD_STATES),
        )
    ).scalars().all()
    promoted_ids = set(db.execute(
        select(LimsAnalysisPromotion.source_analysis_id).where(
            LimsAnalysisPromotion.source_analysis_id.in_([r.id for r in rows] or [-1]))
    ).scalars().all())
    for r in rows:
        entry = {"sample_id": vials[r.lims_sub_sample_pk].sample_id, "analysis_id": r.id,
                 "review_state": r.review_state, "keyword": r.keyword}
        if r.id in promoted_ids or r.review_state in ("verified", "published", "promoted"):
            out["blocked"].append(entry)
        elif r.review_state == "unassigned" and r.result_value is None and not r.retested:
            out["pristine"].append(entry)
        else:
            out["worked_unverified"].append(entry)
    return out


def _supersede_orphan_edges(db: Session, *, parent: LimsSample, service_id: int) -> int:
    """For every all-native profile containing `service_id`, on every vial of
    the parent that has a current edge for that profile: if NO live vial row
    of ANY member remains on that vial, stamp superseded_at. Returns count."""
    now = datetime.utcnow()
    n = 0
    profiles = [p for p in db.execute(select(AnalysisProfile)).scalars()
                if _is_all_native(p) and any(m.id == service_id for m in p.analysis_services)]
    for prof in profiles:
        member_ids = [m.id for m in prof.analysis_services]
        for vial in _vials_of(db, parent):
            edge = db.execute(select(VialProfileAssignment).where(
                VialProfileAssignment.lims_sub_sample_pk == vial.id,
                VialProfileAssignment.analysis_profile_id == prof.id,
                VialProfileAssignment.superseded_at.is_(None))).scalars().first()
            if edge is None:
                continue
            remaining = db.execute(select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sub_sample_pk == vial.id,
                LimsAnalysis.analysis_service_id.in_(member_ids),
                LimsAnalysis.review_state.notin_(DEAD_STATES))).first()
            if remaining is None:
                edge.superseded_at = now
                n += 1
    db.flush()
    return n


def remove_parent_native_analysis(db: Session, *, parent: LimsSample, analysis_id: int,
                                  confirm: bool, user_id: Optional[int]) -> dict:
    """Ruling P (service-level remove) + R1 (soft remove). Order of operations:
    validate → 409 on a live canonical row → classify vial rows → 412 unless
    confirm when worked rows exist → delete pristine vial rows
    (delete_pristine_analysis, commits per row, writes the vial event first)
    → reject worked rows (apply_transition, commits per row) → supersede
    orphaned custody edges → soft-reject the placeholder → parent event →
    commit. The vial-tier primitives commit as they go (same as the SENAITE
    overlay's path); the placeholder flip is last so a mid-way failure leaves
    the parent row live and the action visibly incomplete, never the reverse."""
    from lims_analyses.service import (
        apply_transition, delete_pristine_analysis, soft_reject_parent_placeholder,
    )
    row = _placeholder_row(db, parent, analysis_id)
    service_id = row.analysis_service_id
    canonical_live = db.execute(select(LimsAnalysis.id).where(
        LimsAnalysis.lims_sample_pk == parent.id, LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.analysis_service_id == service_id, LimsAnalysis.provenance == "canonical",
        LimsAnalysis.review_state.notin_(DEAD_STATES))).first()
    if canonical_live is not None:
        raise PromotedResultExistsError(
            f"{row.keyword} has a promoted result on {parent.sample_id}; use retest/retract")

    impact = _classify_vial_rows(db, parent, service_id)
    if impact["blocked"]:
        raise PromotedResultExistsError(
            f"{row.keyword} has verified/promoted vial rows on {parent.sample_id}")
    if impact["worked_unverified"] and not confirm:
        raise RemovalNeedsConfirm(impact)

    vials = {v.id: v for v in _vials_of(db, parent)}
    deleted = 0
    for e in impact["pristine"]:
        vial = next(v for v in vials.values() if v.sample_id == e["sample_id"])
        delete_pristine_analysis(db, sub_sample_pk=vial.id, keyword=e["keyword"], user_id=user_id)
        deleted += 1
    rejected = 0
    for e in impact["worked_unverified"]:
        apply_transition(db, analysis_id=e["analysis_id"], kind="reject",
                         reason="manage_analyses:remove", user_id=user_id)
        rejected += 1

    superseded = _supersede_orphan_edges(db, parent=parent, service_id=service_id)
    soft_reject_parent_placeholder(db, row, reason="manage_analyses:remove", user_id=user_id)
    db.add(LimsSubSampleEvent(
        lims_sample_pk=parent.id, event="native_analysis_removed",
        details={"keyword": row.keyword, "analysis_service_id": service_id, "analysis_id": row.id,
                 "vial_rows_deleted": deleted, "vial_rows_rejected": rejected,
                 "edges_superseded": superseded},
        user_id=user_id,
    ))
    db.commit()
    log.info("manage_native.analysis_removed parent=%s keyword=%s deleted=%s rejected=%s edges=%s",
             parent.sample_id, row.keyword, deleted, rejected, superseded)
    return {"analysis_id": row.id, "keyword": row.keyword, "analysis_service_id": service_id,
            "vial_rows_deleted": deleted, "vial_rows_rejected": rejected, "edges_superseded": superseded}
```

- [ ] **Step 6: Run the tests**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py tests/test_amendment_audit.py tests/test_native_manage_analyses.py
```
Expected: all pass. If `apply_transition(kind="reject")` from `to_be_verified` is not a legal vial transition in `state_machine._ALLOWED`, set the worked row to `assigned` with a result in the test instead (check `_ALLOWED` for which live states accept `reject`).

- [ ] **Step 7: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/lims_analyses/manage_native.py backend/lims_analyses/service.py backend/tests/test_manage_native.py backend/tests/test_amendment_audit.py && git commit -m "feat(manage-native): remove parent native analysis — cascade to vials, supersede orphan edges, soft-reject placeholder"
```

---

### Task 6: `resync_parent_from_order` + `ensure_parent_placeholder`

**Files:**
- Modify: `backend/lims_analyses/manage_native.py` (append)
- Test: `backend/tests/test_manage_native.py` (append)

**Interfaces:**
- Consumes: `sub_samples.service.fetch_sample_services(sample_id) -> dict | None` (raises on transport error; returns `{"services": {...}, "package": ...}`), `coa.native_sections._ordered_native_profiles(db, services, package, require_archetype=False) -> list[AnalysisProfile]`.
- Produces:
  - `manage_native.OrderServicesUnavailable(Exception)` → 502.
  - `manage_native.resync_parent_from_order(db, *, parent, user_id) -> dict` = `{"placeholders_created","edges_created","vial_rows_created"}`; caller commits.
  - `manage_native.ensure_parent_placeholder(db, *, parent, service, user_id, reason) -> LimsAnalysis | None` (None when a live ordered/canonical row already exists; flushes, no commit).

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_manage_native.py`)

```python
# ── resync_parent_from_order ──────────────────────────────────────────────────

def test_resync_mints_missing_placeholders_edges_and_vial_rows(db, parent, moisture, monkeypatch):
    v = _vial(db, parent, sid="MN-PARENT-S04", seq=4, role="kf")
    monkeypatch.setattr(mn, "fetch_sample_services",
                        lambda sid: {"services": {"moisture": True, "hplcpurity_identity": True}, "package": None})
    res = mn.resync_parent_from_order(db, parent=parent, user_id=3)
    db.commit()
    assert res == {"placeholders_created": 1, "edges_created": 1, "vial_rows_created": 1}
    assert db.query(VialProfileAssignment).filter_by(lims_sub_sample_pk=v.id, superseded_at=None).count() == 1
    ev = [e for e in db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == parent.id)).scalars().all() if e.event == "native_resync"]
    assert len(ev) == 1 and ev[0].details == res
    # second run is a no-op
    res2 = mn.resync_parent_from_order(db, parent=parent, user_id=3)
    db.commit()
    assert res2 == {"placeholders_created": 0, "edges_created": 0, "vial_rows_created": 0}


def test_resync_never_supersedes_lab_added_edges(db, parent, moisture, heavy_metals, monkeypatch):
    v = _vial(db, parent, sid="MN-PARENT-S02", seq=2, role="hm")
    mn.add_profile_to_parent(db, parent=parent, profile=heavy_metals, user_id=1)  # lab-added
    db.commit()
    monkeypatch.setattr(mn, "fetch_sample_services", lambda sid: {"services": {"moisture": True}, "package": None})
    mn.resync_parent_from_order(db, parent=parent, user_id=3)
    db.commit()
    edges = db.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == v.id)).scalars().all()
    assert [(e.analysis_profile_id, e.superseded_at) for e in edges] == [(heavy_metals.id, None)]


def test_resync_is_unavailable_when_is_fails_and_writes_nothing(db, parent, moisture, monkeypatch):
    def boom(sid):
        raise RuntimeError("IS down")
    monkeypatch.setattr(mn, "fetch_sample_services", boom)
    with pytest.raises(mn.OrderServicesUnavailable):
        mn.resync_parent_from_order(db, parent=parent, user_id=3)
    monkeypatch.setattr(mn, "fetch_sample_services", lambda sid: None)
    with pytest.raises(mn.OrderServicesUnavailable):
        mn.resync_parent_from_order(db, parent=parent, user_id=3)
    assert db.query(LimsAnalysis).count() == 0 and db.query(LimsSubSampleEvent).count() == 0


# ── ensure_parent_placeholder ─────────────────────────────────────────────────

def test_ensure_parent_placeholder_mints_once_and_skips_live_rows(db, parent, moisture):
    kf = moisture.analysis_services[0]
    row = mn.ensure_parent_placeholder(db, parent=parent, service=kf, user_id=4, reason="manage_analyses:vial_add")
    db.commit()
    assert row is not None and row.provenance == PROVENANCE_ORDERED and row.review_state == "unassigned"
    tr = db.execute(select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == row.id)).scalars().one()
    assert tr.reason == "manage_analyses:vial_add" and tr.user_id == 4
    assert mn.ensure_parent_placeholder(db, parent=parent, service=kf, user_id=4, reason="x") is None
    # a live canonical also counts as present
    row.review_state = "rejected"; db.commit()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=kf.id, keyword="MOISTURE-KF",
                        title="Residual Moisture", review_state="verified", provenance="canonical")); db.commit()
    assert mn.ensure_parent_placeholder(db, parent=parent, service=kf, user_id=4, reason="x") is None


def test_ensure_parent_placeholder_refuses_non_native(db, parent):
    sen = _svc(db, keyword="ENDO-LAL", title="Endotoxin", origin="senaite")
    with pytest.raises(mn.ProfileNotNativeError):
        mn.ensure_parent_placeholder(db, parent=parent, service=sen, user_id=None, reason="x")
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py -k "resync or ensure"
```
Expected: 5 FAIL.

- [ ] **Step 3: Append to `backend/lims_analyses/manage_native.py`**

```python
# ── write path: re-sync from order (admin) ───────────────────────────────────

class OrderServicesUnavailable(Exception):
    """The IS could not supply the order's services (transport error or 404)."""


def resync_parent_from_order(db: Session, *, parent: LimsSample, user_id: Optional[int]) -> dict:
    """Ruling 2: explicit, additive heal from the WP order. Re-fetches the
    sample's services from the IS, mints missing placeholders for every
    ordered native profile, and on every existing vial whose role hosts such
    a profile adds the missing host edge + seeds the members. Never prunes,
    never supersedes. Raises OrderServicesUnavailable (→ 502) with zero
    writes when the IS fails or knows no order. Caller commits."""
    from coa.native_sections import _ordered_native_profiles
    try:
        raw = fetch_sample_services(parent.sample_id)
    except Exception as exc:  # transport / auth / 5xx — nothing was written
        raise OrderServicesUnavailable(str(exc)) from exc
    if not raw:
        raise OrderServicesUnavailable(f"no order services for {parent.sample_id}")
    services = raw.get("services") or {}
    package = raw.get("package")

    stats = seed_parent_placeholders(
        db, parent=parent, services=services, package=package,
        reason="resync_from_order", created_by_user_id=user_id,
    )
    edges = 0
    vial_rows = 0
    for prof in _ordered_native_profiles(db, services, package, require_archetype=False):
        members = list(prof.analysis_services)
        for vial in _host_vials(db, parent, prof):
            if _ensure_host_edge(db, vial=vial, profile=prof, user_id=user_id):
                edges += 1
            vial_rows += _seed_members_on_vial(db, vial=vial, members=members, user_id=user_id)

    result = {"placeholders_created": stats["created"], "edges_created": edges,
              "vial_rows_created": vial_rows}
    db.add(LimsSubSampleEvent(lims_sample_pk=parent.id, event="native_resync",
                              details=result, user_id=user_id))
    db.flush()
    log.info("manage_native.resync parent=%s %s", parent.sample_id, result)
    return result


# ── vial-page helper: one service, one placeholder ───────────────────────────

def ensure_parent_placeholder(db: Session, *, parent: LimsSample, service: AnalysisService,
                              user_id: Optional[int], reason: str) -> Optional[LimsAnalysis]:
    """Used by the native VIAL add (explorer POST): when the lab puts a single
    mk1 service on a vial, the parent gets a placeholder for it too, so the
    parent card tells the truth before promote. No-op (None) when a live
    'ordered' or 'canonical' row already exists. Refuses non-mk1 services."""
    from lims_analyses.service import record_placeholder_created
    if (getattr(service, "origin", None) or "") != "mk1":
        raise ProfileNotNativeError(f"service {service.keyword!r} is not native")
    if service.id in _live_parent_service_ids(db, parent):
        return None
    row = LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=service.id, keyword=service.keyword, title=service.title,
        result_value=None, review_state="unassigned", provenance=PROVENANCE_ORDERED,
        created_by_user_id=user_id,
    )
    db.add(row)
    db.flush()
    record_placeholder_created(db, row, reason=reason, user_id=user_id)
    return row
```

- [ ] **Step 4: Run the tests**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py
```
Expected: all pass (22 tests).

- [ ] **Step 5: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/lims_analyses/manage_native.py backend/tests/test_manage_native.py && git commit -m "feat(manage-native): resync_parent_from_order (additive, admin) + ensure_parent_placeholder for vial adds"
```

---

### Task 7: Routes, schemas, explorer native branch, `GET /analysis-services` filters, activity labels

**Files:**
- Modify: `backend/lims_analyses/schemas.py` (append)
- Modify: `backend/lims_analyses/routes.py` (append 4 routes after `parent_retest`, ~line 283)
- Modify: `backend/main.py` — explorer POST native branch (~`:9266-9310`, `add_sample_analysis`), `GET /analysis-services` (~`:3215`), activity Section B labels (~`:1436-1447`)
- Test: `backend/tests/test_manage_native_routes.py` (new)

**Interfaces:**
- Consumes: everything from Tasks 3, 5, 6; `auth.require_admin`; `routes._handle_service_error`.
- Produces routes:
  - `GET /api/lims-analyses/parent/{sample_id}/native-profiles` → `list[NativeProfileOut]`
  - `POST /api/lims-analyses/parent/{sample_id}/profiles` body `AddNativeProfileRequest{profile_id:int}` → 201 `AddNativeProfileResponse`
  - `DELETE /api/lims-analyses/parent/{sample_id}/native-analyses/{analysis_id}?confirm=` → 200 `RemoveNativeAnalysisResponse` | 409 `{code:"promoted_result_exists"}` | 412 `{code:"confirm_required", impact:{…}}`
  - `POST /api/lims-analyses/parent/{sample_id}/resync-from-order` (admin) → 200 `ResyncResponse` | 502 `{code:"order_services_unavailable"}`
  - `GET /analysis-services?origin=mk1&active=true` (existing route, two new optional filters)
  - Explorer `POST /explorer/samples/{id}/analyses` native branch reads `body.get("keyword")` and calls `ensure_parent_placeholder`.

- [ ] **Step 1: Write the failing route tests** — create `backend/tests/test_manage_native_routes.py`:

```python
"""Route tests for the native Manage Analyses slice (FastAPI TestClient +
in-memory SQLite, get_db / get_current_user overridden — same idiom as
tests/test_custody_edges.py)."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import models  # noqa: F401
from main import app
from auth import get_current_user, require_admin
from database import get_db, Base
from models import (AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample,
                    LimsSubSampleEvent, VialProfileAssignment)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from lims_analyses import manage_native as mn


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _client(db_session, *, admin: bool):
    app.dependency_overrides[get_db] = lambda: db_session
    user = MagicMock(); user.id = 9; user.role = "admin" if admin else "user"; user.email = "t@x"
    app.dependency_overrides[get_current_user] = lambda: user
    if admin:
        app.dependency_overrides[require_admin] = lambda: user
    else:
        app.dependency_overrides.pop(require_admin, None)
    return TestClient(app)


@pytest.fixture
def client(db_session):
    yield _client(db_session, admin=False)
    app.dependency_overrides.clear()


@pytest.fixture
def admin_client(db_session):
    yield _client(db_session, admin=True)
    app.dependency_overrides.clear()


@pytest.fixture
def world(db_session):
    db = db_session
    parent = LimsSample(sample_id="RT-PARENT", sample_type="x", status="received", external_lims_system="senaite")
    db.add(parent); db.commit(); db.refresh(parent)
    kf = AnalysisService(title="Residual Moisture", keyword="MOISTURE-KF", origin="mk1")
    db.add(kf); db.commit(); db.refresh(kf)
    prof = AnalysisProfile(key="moisture", name="Residual Moisture", is_addon=True, coa_archetype="limit_table",
                           fulfillment_role="kf", fulfillment_dim="role", vials_required=1, active=True)
    prof.analysis_services.append(kf)
    db.add(prof); db.commit(); db.refresh(prof)
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://rt-s04", sample_id="RT-PARENT-S04",
                         vial_sequence=4, assignment_role="kf")
    db.add(vial); db.commit(); db.refresh(vial)
    return {"parent": parent, "kf": kf, "profile": prof, "vial": vial}


def test_native_profiles_lists_moisture_with_host(client, world):
    r = client.get("/api/lims-analyses/parent/RT-PARENT/native-profiles")
    assert r.status_code == 200, r.text
    (p,) = r.json()
    assert p["key"] == "moisture" and p["on_sample"] == "none" and p["host_vials"] == ["RT-PARENT-S04"]
    assert p["members"][0]["keyword"] == "MOISTURE-KF"


def test_add_profile_then_409_then_remove_then_re_add(client, world, db_session):
    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["placeholders_created"] == 1 and body["no_host_vial"] is False
    assert body["hosts"] == [{"vial_id": "RT-PARENT-S04", "edge_created": True, "vial_rows_created": 1}]

    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "profile_already_on_sample"

    ph = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().one()
    r = client.delete(f"/api/lims-analyses/parent/RT-PARENT/native-analyses/{ph.id}")
    assert r.status_code == 200, r.text
    assert r.json()["vial_rows_deleted"] == 1 and r.json()["edges_superseded"] == 1

    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 201 and r.json()["placeholders_created"] == 1


def test_add_profile_422_and_404s(client, world, db_session):
    world["profile"].active = False; db_session.commit()
    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "profile_inactive"
    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": 999})
    assert r.status_code == 404
    r = client.post("/api/lims-analyses/parent/NOPE/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 404


def test_remove_worked_row_412_then_confirm(client, world, db_session):
    client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    vr = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == world["vial"].id)).scalars().one()
    vr.result_value = "1"; vr.review_state = "assigned"; db_session.commit()
    ph = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().one()
    r = client.delete(f"/api/lims-analyses/parent/RT-PARENT/native-analyses/{ph.id}")
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "confirm_required" and d["impact"]["worked_unverified"][0]["sample_id"] == "RT-PARENT-S04"
    r = client.delete(f"/api/lims-analyses/parent/RT-PARENT/native-analyses/{ph.id}?confirm=true")
    assert r.status_code == 200 and r.json()["vial_rows_rejected"] == 1


def test_resync_requires_admin_and_reports_counts(client, admin_client, world, monkeypatch):
    monkeypatch.setattr(mn, "fetch_sample_services", lambda sid: {"services": {"moisture": True}, "package": None})
    r = client.post("/api/lims-analyses/parent/RT-PARENT/resync-from-order")
    assert r.status_code == 403
    r = admin_client.post("/api/lims-analyses/parent/RT-PARENT/resync-from-order")
    assert r.status_code == 200, r.text
    assert r.json() == {"placeholders_created": 1, "edges_created": 1, "vial_rows_created": 1}


def test_resync_502_when_is_unavailable(admin_client, world, monkeypatch):
    def boom(sid): raise RuntimeError("down")
    monkeypatch.setattr(mn, "fetch_sample_services", boom)
    r = admin_client.post("/api/lims-analyses/parent/RT-PARENT/resync-from-order")
    assert r.status_code == 502 and r.json()["detail"]["code"] == "order_services_unavailable"


def test_analysis_services_origin_and_active_filters(client, world, db_session):
    db_session.add(AnalysisService(title="Endo", keyword="ENDO-LAL", origin="senaite"))
    db_session.add(AnalysisService(title="Old", keyword="OLD-KF", origin="mk1", active=False))
    db_session.commit()
    r = client.get("/analysis-services?origin=mk1&active=true")
    assert r.status_code == 200
    assert [s["keyword"] for s in r.json()] == ["MOISTURE-KF"]
    r = client.get("/analysis-services?origin=mk1")
    assert sorted(s["keyword"] for s in r.json()) == ["MOISTURE-KF", "OLD-KF"]


def test_explorer_native_vial_add_by_keyword_ensures_parent_placeholder(client, world, db_session):
    r = client.post("/explorer/samples/RT-PARENT-S04/analyses", json={"keyword": "MOISTURE-KF"})
    assert r.status_code in (200, 201), r.text
    vial_rows = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == world["vial"].id)).scalars().all()
    assert [x.keyword for x in vial_rows] == ["MOISTURE-KF"]
    ph = db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == world["parent"].id, LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().one()
    assert ph.keyword == "MOISTURE-KF"


def test_activity_labels_native_events(client, world, db_session):
    client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    r = client.get("/samples/RT-PARENT/activity")
    assert r.status_code == 200, r.text
    labels = [e["label"] for e in r.json()["events"] if e["event"] == "native_profile_added"]
    assert labels and labels[0].startswith("Residual Moisture added (native)")
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native_routes.py
```
Expected: 404s / failures across the board (routes missing).

- [ ] **Step 3: Append schemas to `backend/lims_analyses/schemas.py`**

```python
# ── Native Manage Analyses (manage_native.py) ─────────────────────────────────

class NativeProfileMemberOut(BaseModel):
    service_id: int
    keyword: str
    title: str


class NativeProfileOut(BaseModel):
    id: int
    key: str
    name: str
    fulfillment_role: Optional[str] = None
    members: List[NativeProfileMemberOut]
    on_sample: Literal["none", "partial", "full"]
    host_vials: List[str]


class AddNativeProfileRequest(BaseModel):
    profile_id: int


class NativeProfileHostOut(BaseModel):
    vial_id: str
    edge_created: bool
    vial_rows_created: int


class AddNativeProfileResponse(BaseModel):
    profile_key: str
    profile_name: str
    placeholders_created: int
    placeholders_existing: int
    hosts: List[NativeProfileHostOut]
    no_host_vial: bool


class RemoveNativeAnalysisResponse(BaseModel):
    analysis_id: int
    keyword: str
    analysis_service_id: int
    vial_rows_deleted: int
    vial_rows_rejected: int
    edges_superseded: int


class ResyncFromOrderResponse(BaseModel):
    placeholders_created: int
    edges_created: int
    vial_rows_created: int
```
(Ensure `Literal`, `List`, `Optional`, `BaseModel` are imported at the top of `schemas.py`; add what is missing.)

- [ ] **Step 4: Append the routes to `backend/lims_analyses/routes.py`** (after `parent_retest`; add `from auth import require_admin`, `from lims_analyses import manage_native`, `from models import AnalysisProfile, LimsSample`, `from sqlalchemy import select` to the imports if absent, and the new schema names to the schemas import):

```python
# ── Native Manage Analyses (spec 2026-08-18) ─────────────────────────────────

def _load_parent_or_404(db: Session, sample_id: str) -> LimsSample:
    parent = db.execute(select(LimsSample).where(LimsSample.sample_id == sample_id)).scalar_one_or_none()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"sample {sample_id!r} not found")
    return parent


def _manage_native_error(e: Exception) -> HTTPException:
    code = getattr(e, "code", None)
    if isinstance(e, manage_native.ProfileAlreadyOnSampleError) or isinstance(e, manage_native.PromotedResultExistsError):
        return HTTPException(status_code=409, detail={"code": code, "message": str(e)})
    if isinstance(e, (manage_native.ProfileNotNativeError, manage_native.ProfileInactiveError,
                      manage_native.ProfileHasNoMembersError)):
        return HTTPException(status_code=422, detail={"code": code, "message": str(e)})
    if isinstance(e, manage_native.RemovalNeedsConfirm):
        return HTTPException(status_code=412, detail={"code": "confirm_required", "impact": e.impact})
    if isinstance(e, manage_native.OrderServicesUnavailable):
        return HTTPException(status_code=502, detail={"code": "order_services_unavailable", "message": str(e)})
    return _handle_service_error(e)


@router.get("/parent/{sample_id}/native-profiles", response_model=List[NativeProfileOut])
def native_profiles(sample_id: str, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Picker for the Manage Analyses overlay: active all-mk1 profiles, whether
    the sample already carries them, and which existing vials would host them."""
    parent = _load_parent_or_404(db, sample_id)
    return manage_native.native_profiles_for_parent(db, parent=parent)


@router.post("/parent/{sample_id}/profiles", response_model=AddNativeProfileResponse,
             status_code=status.HTTP_201_CREATED)
def add_native_profile(sample_id: str, req: AddNativeProfileRequest,
                       db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Ruling A/P: put a native profile on the sample — parent placeholders +
    host custody edge + vial rows on every matching-role vial."""
    parent = _load_parent_or_404(db, sample_id)
    profile = db.get(AnalysisProfile, req.profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"analysis profile id={req.profile_id} not found")
    try:
        result = manage_native.add_profile_to_parent(
            db, parent=parent, profile=profile, user_id=getattr(current_user, "id", None))
        db.commit()
        return result
    except Exception as e:
        db.rollback()
        raise _manage_native_error(e)


@router.delete("/parent/{sample_id}/native-analyses/{analysis_id}", response_model=RemoveNativeAnalysisResponse)
def remove_native_analysis(sample_id: str, analysis_id: int, confirm: bool = Query(False),
                           db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """Ruling P/R1: remove one native parent placeholder; cascades to the vial
    rows (delete pristine / reject worked with ?confirm=true) and soft-rejects
    the placeholder. 409 when a promoted result exists; 412 when confirmation
    is required (body carries the impact for RemovalConfirmModal)."""
    parent = _load_parent_or_404(db, sample_id)
    try:
        return manage_native.remove_parent_native_analysis(
            db, parent=parent, analysis_id=analysis_id, confirm=confirm,
            user_id=getattr(current_user, "id", None))
    except Exception as e:
        db.rollback()
        raise _manage_native_error(e)


@router.post("/parent/{sample_id}/resync-from-order", response_model=ResyncFromOrderResponse)
def resync_from_order(sample_id: str, db: Session = Depends(get_db), current_user=Depends(require_admin)):
    """Ruling 2: admin-only additive heal from the WP order (placeholders,
    host edges, vial rows). 502 with zero writes when the IS is unavailable."""
    parent = _load_parent_or_404(db, sample_id)
    try:
        result = manage_native.resync_parent_from_order(
            db, parent=parent, user_id=getattr(current_user, "id", None))
        db.commit()
        return result
    except Exception as e:
        db.rollback()
        raise _manage_native_error(e)
```

- [ ] **Step 5: `backend/main.py` — three edits**

(a) `GET /analysis-services` (~`:3215`): add two optional query params and filters:
```python
async def get_analysis_services(
    search: Optional[str] = None,
    category: Optional[str] = None,
    origin: Optional[str] = None,
    active: Optional[bool] = None,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """List all analysis services. Optional search by title, keyword, or category. Optional exact category / origin / active filters."""
    query = select(AnalysisService).order_by(AnalysisService.title)
    if category:
        query = query.where(AnalysisService.category == category)
    if origin:
        query = query.where(AnalysisService.origin == origin)
    if active is not None:
        query = query.where(AnalysisService.active.is_(active))
```
(rest unchanged).

(b) Explorer `POST /explorer/samples/{sample_id}/analyses` native branch (~`:9295-9310`): where it does `senaite_service_uid = body.get("service_uid")` and calls `add_analysis_to_native_vial(..., keyword=None, ...)`, change to:
```python
        senaite_service_uid = body.get("service_uid") or None
        keyword = body.get("keyword") or None
        try:
            row = add_analysis_to_native_vial(
                db,
                sub_sample_pk=sub.id,
                senaite_service_uid=senaite_service_uid,
                keyword=keyword,
                user_id=getattr(current_user, "id", None),
            )
            # Manage-analyses slice: the parent tells the truth before promote —
            # a native vial add also ensures the parent placeholder (no-op when
            # a live ordered/canonical row exists).
            from lims_analyses.manage_native import ensure_parent_placeholder
            from models import AnalysisService as _Svc
            parent_row = db.get(LimsSample, sub.parent_sample_pk)
            svc_row = db.get(_Svc, row.analysis_service_id)
            if parent_row is not None and svc_row is not None:
                ensure_parent_placeholder(db, parent=parent_row, service=svc_row,
                                          user_id=getattr(current_user, "id", None),
                                          reason="manage_analyses:vial_add")
                db.commit()
```
Keep the existing exception→HTTP mapping around it exactly as it is (read the block first; `row` may already be the variable name — adapt). If `add_analysis_to_native_vial` commits internally (it does), the extra `db.commit()` after `ensure_parent_placeholder` is required and harmless.

(c) Activity Section B (~`:1436-1447`): after the `parent_analysis_retested` branch add
```python
            elif se.event == "native_profile_added":
                hosts = d.get("hosts") or []
                n = sum(int(h.get("vial_rows_created") or 0) for h in hosts)
                where = ", ".join(h.get("vial_id", "?") for h in hosts) or "no host vial"
                label = (f"{d.get('profile_name', d.get('profile_key', '?'))} added (native) — "
                         f"{n} analys{'is' if n == 1 else 'es'} on {where}")
            elif se.event == "native_analysis_removed":
                label = (f"{d.get('keyword', '?')} removed (native) — "
                         f"{d.get('vial_rows_deleted', 0)} deleted, {d.get('vial_rows_rejected', 0)} rejected")
            elif se.event == "native_resync":
                label = (f"Re-synced from order — {d.get('placeholders_created', 0)} placeholders, "
                         f"{d.get('edges_created', 0)} edges, {d.get('vial_rows_created', 0)} vial analyses")
```

- [ ] **Step 6: Run the route tests + everything touched**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native_routes.py tests/test_manage_native.py tests/test_native_manage_analyses.py tests/test_parent_placeholders.py
```
Expected: all pass. If the explorer POST test returns 404 because the route requires the vial's `external_lims_uid` to be looked up differently, read `add_sample_analysis` and adjust the fixture (uid `mk1://…` + `sample_id` are what it matches on).

- [ ] **Step 7: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/lims_analyses/schemas.py backend/lims_analyses/routes.py backend/main.py backend/tests/test_manage_native_routes.py && git commit -m "feat(manage-native): parent native-profiles/profiles/native-analyses/resync routes; vial add ensures placeholder; analysis-services origin/active filters; activity labels"
```

---

### Task 8: R2 `sample_peptide_id` provenance filter + stale docs

**Files:**
- Modify: `backend/coa/spec_rules.py` (`sample_peptide_id`, the anchor query ~`:108-119` in the composition — locate by `def sample_peptide_id` at base)
- Modify: `backend/main.py` — the comment inside `_native_placeholders_at_registration_bg` claiming "check-in re-seeds via the same function later" (locate by grep)
- Modify: `backend/tests/test_parent_placeholders.py` — the docstring at the "registration hook never raises" test claiming "the next check-in heals the placeholders"
- Test: `backend/tests/test_spec_rules_placeholders.py` (new) — or append to the existing spec_rules test file if one exists (`ls backend/tests | grep spec_rules`)

- [ ] **Step 1: Write the failing test**

```python
"""R2 (manage-analyses spec): an 'ordered' placeholder must never influence
the peptide anchor used for spec resolution."""
from __future__ import annotations
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import models  # noqa: F401
from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample, Peptide
from coa.spec_rules import sample_peptide_id


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_ordered_placeholder_does_not_change_peptide_anchor(db):
    p1 = Peptide(name="BPC-157"); p2 = Peptide(name="TB-500")
    db.add_all([p1, p2]); db.commit()
    parent = LimsSample(sample_id="R2-P", sample_type="x", status="received"); db.add(parent); db.commit()
    s1 = AnalysisService(title="BPC (Purity)", keyword="PUR_BPC157", origin="mk1", peptide_id=p1.id)
    s2 = AnalysisService(title="TB (Purity)", keyword="PUR_TB500", origin="mk1", peptide_id=p2.id)
    db.add_all([s1, s2]); db.commit()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=s1.id, keyword=s1.keyword, title=s1.title,
                        review_state="verified", provenance="canonical"))
    db.commit()
    assert sample_peptide_id(db, parent.id) == p1.id
    # a placeholder for a DIFFERENT peptide's service must not coarsen the anchor to None
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=s2.id, keyword=s2.keyword, title=s2.title,
                        review_state="unassigned", provenance="ordered"))
    db.commit()
    assert sample_peptide_id(db, parent.id) == p1.id
```
(Read `sample_peptide_id`'s real signature first — it may take `(db, parent_pk)` or `(db, sample)`; adapt the two calls. If `AnalysisService.peptide_id` isn't how the anchor is derived at base, read the query and build the fixture the way it joins — the assertion stays: placeholder must not change the result.)

- [ ] **Step 2: Run to verify it fails**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_spec_rules_placeholders.py
```
Expected: FAIL on the second assertion (returns None).

- [ ] **Step 3: Add the filter** — in `sample_peptide_id`'s query add `LimsAnalysis.provenance == "canonical"` alongside the existing `review_state != 'retracted'` filter, with a comment: `# R2 (2026-08-18): 'ordered' placeholders are not results — never anchor on them.`

- [ ] **Step 4: Fix the two stale docs**
  - `backend/main.py`: change the sentence about check-in re-seeding to: `# There is no automatic re-seed after registration; the admin "Re-sync from order" action (lims_analyses.manage_native.resync_parent_from_order) is the heal.`
  - `backend/tests/test_parent_placeholders.py`: same correction in the docstring of the "hook never raises" test.

- [ ] **Step 5: Run**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_spec_rules_placeholders.py tests/test_parent_placeholders.py $(ls tests | grep -E "spec_rules|native_sections|coa_" | sed 's#^#tests/#' | tr '\n' ' ')
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add backend/coa/spec_rules.py backend/main.py backend/tests/test_parent_placeholders.py backend/tests/test_spec_rules_placeholders.py && git commit -m "fix(coa): peptide anchor ignores 'ordered' placeholders (R2); correct stale re-seed comments"
```

---

### Task 9: Frontend — API client + `NativeManageAnalysesBlock` component

**Files:**
- Modify: `src/lib/api.ts` (append near `listNativeParentAnalysesShaped`, ~line 6040; extend `addAnalysisToSample` at ~1680)
- Create: `src/components/senaite/NativeManageAnalysesBlock.tsx`
- Test: `src/test/native-manage-analyses-block.test.tsx` (new)

**Interfaces:**
- Produces (`src/lib/api.ts`):
  - `interface NativeProfile { id:number; key:string; name:string; fulfillment_role:string|null; members:{service_id:number; keyword:string; title:string}[]; on_sample:'none'|'partial'|'full'; host_vials:string[] }`
  - `listNativeProfilesForParent(sampleId): Promise<NativeProfile[]>` → `GET /api/lims-analyses/parent/{id}/native-profiles`
  - `addNativeProfileToParent(sampleId, profileId): Promise<AddNativeProfileResult>` (`{profile_key, profile_name, placeholders_created, placeholders_existing, hosts:{vial_id,edge_created,vial_rows_created}[], no_host_vial}`)
  - `removeNativeParentAnalysis(sampleId, analysisId, confirm=false): Promise<RemoveNativeAnalysisResult>` — on 412 throws `NativeRemovalNeedsConfirm` (class extending `Error` with `.impact: RemovalImpact`); on 409 throws `Error` with the message.
  - `resyncParentFromOrder(sampleId): Promise<{placeholders_created; edges_created; vial_rows_created}>`
  - `listNativeAnalysisServices(): Promise<AnalysisService[]>` → `GET /analysis-services?origin=mk1&active=true` (map `id`→`uid: String(id)` is NOT done; `AnalysisService` type has `uid` — see step 3 for the adapter)
  - `addAnalysisToSample(sampleId, serviceUid, extra?: {keyword?: string; analysis_service_id?: number})` — body merges `extra`.
- Produces (component): `<NativeManageAnalysesBlock sampleId isAdmin onChanged />` — `onChanged: () => void` called after any successful mutation so the page can `refreshSample`.

- [ ] **Step 1: Write the failing component test** — create `src/test/native-manage-analyses-block.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SenaiteAnalysis } from '@/lib/api'

const api = vi.hoisted(() => ({
  listNativeParentAnalysesShaped: vi.fn(),
  listNativeProfilesForParent: vi.fn(),
  addNativeProfileToParent: vi.fn(),
  removeNativeParentAnalysis: vi.fn(),
  resyncParentFromOrder: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, ...api }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { NativeManageAnalysesBlock } from '@/components/senaite/NativeManageAnalysesBlock'

const ordered = (id: number, keyword: string, title: string): SenaiteAnalysis =>
  ({ id, uid: `mk1:${id}`, keyword, title, review_state: 'unassigned', provenance: 'ordered' } as unknown as SenaiteAnalysis)
const canonical = (id: number, keyword: string, title: string): SenaiteAnalysis =>
  ({ id, uid: `mk1:${id}`, keyword, title, review_state: 'verified', provenance: 'canonical' } as unknown as SenaiteAnalysis)

function renderBlock(props: Partial<React.ComponentProps<typeof NativeManageAnalysesBlock>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onChanged = vi.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <NativeManageAnalysesBlock sampleId="PB-0156" isAdmin={false} onChanged={onChanged} {...props} />
    </QueryClientProvider>
  )
  return { ...utils, onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listNativeParentAnalysesShaped.mockResolvedValue([ordered(31, 'MOISTURE-KF', 'Residual Moisture'), canonical(32, 'LEAD-PPM', 'Lead')])
  api.listNativeProfilesForParent.mockResolvedValue([
    { id: 7, key: 'moisture', name: 'Residual Moisture', fulfillment_role: 'kf', on_sample: 'full', host_vials: ['PB-0156-S04'],
      members: [{ service_id: 233, keyword: 'MOISTURE-KF', title: 'Residual Moisture' }] },
    { id: 6, key: 'heavy_metals', name: 'Heavy Metals', fulfillment_role: 'hm', on_sample: 'none', host_vials: [],
      members: [{ service_id: 229, keyword: 'LEAD-PPM', title: 'Lead' }, { service_id: 230, keyword: 'ARSENIC-PPM', title: 'Arsenic' }] },
  ])
})

describe('NativeManageAnalysesBlock', () => {
  it('lists native rows; trash enabled only on ordered rows', async () => {
    renderBlock()
    expect(await screen.findByText('MOISTURE-KF')).toBeInTheDocument()
    const rows = screen.getAllByTestId('native-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole('button', { name: /remove/i })).toBeEnabled()
    expect(within(rows[1]).getByRole('button', { name: /remove/i })).toBeDisabled()
    expect(within(rows[0]).getByText('kf · PB-0156-S04')).toBeInTheDocument()
  })

  it('hides fully-present profiles from the picker and shows the no-host hint', async () => {
    renderBlock()
    await screen.findByText('MOISTURE-KF')
    const picker = screen.getByTestId('native-profile-picker')
    expect(within(picker).queryByText('Residual Moisture')).toBeNull()
    expect(within(picker).getByText('Heavy Metals')).toBeInTheDocument()
    expect(within(picker).getByText(/no hm vial yet — placeholder only/)).toBeInTheDocument()
  })

  it('adds a profile and calls onChanged', async () => {
    api.addNativeProfileToParent.mockResolvedValue({ profile_key: 'heavy_metals', profile_name: 'Heavy Metals',
      placeholders_created: 2, placeholders_existing: 0, hosts: [], no_host_vial: true })
    const { onChanged } = renderBlock()
    await screen.findByText('MOISTURE-KF')
    await userEvent.click(within(screen.getByTestId('native-profile-picker')).getByRole('button', { name: /add heavy metals/i }))
    await waitFor(() => expect(api.addNativeProfileToParent).toHaveBeenCalledWith('PB-0156', 6))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('removes an ordered row straight away when no confirm is needed', async () => {
    api.removeNativeParentAnalysis.mockResolvedValue({ analysis_id: 31, keyword: 'MOISTURE-KF', analysis_service_id: 233,
      vial_rows_deleted: 1, vial_rows_rejected: 0, edges_superseded: 1 })
    const { onChanged } = renderBlock()
    await screen.findByText('MOISTURE-KF')
    await userEvent.click(within(screen.getAllByTestId('native-row')[0]).getByRole('button', { name: /remove/i }))
    await waitFor(() => expect(api.removeNativeParentAnalysis).toHaveBeenCalledWith('PB-0156', 31, false))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('opens the confirm modal on 412 and confirms with confirm=true', async () => {
    const { NativeRemovalNeedsConfirm } = await import('@/lib/api')
    api.removeNativeParentAnalysis
      .mockRejectedValueOnce(new NativeRemovalNeedsConfirm({ pristine: [], blocked: [],
        worked_unverified: [{ sample_id: 'PB-0156-S04', analysis_id: 40, review_state: 'assigned', keyword: 'MOISTURE-KF' }] } as never))
      .mockResolvedValueOnce({ analysis_id: 31, keyword: 'MOISTURE-KF', analysis_service_id: 233,
        vial_rows_deleted: 0, vial_rows_rejected: 1, edges_superseded: 1 })
    renderBlock()
    await screen.findByText('MOISTURE-KF')
    await userEvent.click(within(screen.getAllByTestId('native-row')[0]).getByRole('button', { name: /remove/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /remove|retract/i }))
    await waitFor(() => expect(api.removeNativeParentAnalysis).toHaveBeenLastCalledWith('PB-0156', 31, true))
  })

  it('shows Re-sync only for admins and reports counts', async () => {
    api.resyncParentFromOrder.mockResolvedValue({ placeholders_created: 1, edges_created: 1, vial_rows_created: 1 })
    const { rerender } = renderBlock({ isAdmin: false })
    await screen.findByText('MOISTURE-KF')
    expect(screen.queryByRole('button', { name: /re-sync from order/i })).toBeNull()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(<QueryClientProvider client={qc}><NativeManageAnalysesBlock sampleId="PB-0156" isAdmin onChanged={() => {}} /></QueryClientProvider>)
    await userEvent.click(await screen.findByRole('button', { name: /re-sync from order/i }))
    await waitFor(() => expect(api.resyncParentFromOrder).toHaveBeenCalledWith('PB-0156'))
  })

  it('renders nothing when there are no native rows and no native profiles', async () => {
    api.listNativeParentAnalysesShaped.mockResolvedValue([])
    api.listNativeProfilesForParent.mockResolvedValue([])
    const { container } = renderBlock()
    await waitFor(() => expect(api.listNativeProfilesForParent).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="native-manage-block"]')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && npx vitest run src/test/native-manage-analyses-block.test.tsx
```
Expected: FAIL (module not found).

- [ ] **Step 3: API client additions in `src/lib/api.ts`** — extend `addAnalysisToSample`:

```ts
export async function addAnalysisToSample(
  sampleId: string,
  serviceUid: string,
  extra?: { keyword?: string; analysis_service_id?: number },
): Promise<ManageAnalysisResult> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/samples/${encodeURIComponent(sampleId)}/analyses`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ service_uid: serviceUid || undefined, ...(extra ?? {}) }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Failed to add analysis: ${response.status}`)
  }
  return response.json()
}
```
and append (near `listNativeParentAnalysesShaped`):

```ts
// ── Native Manage Analyses (spec 2026-08-18) ────────────────────────────────

export interface NativeProfileMember { service_id: number; keyword: string; title: string }
export interface NativeProfile {
  id: number
  key: string
  name: string
  fulfillment_role: string | null
  members: NativeProfileMember[]
  on_sample: 'none' | 'partial' | 'full'
  host_vials: string[]
}
export interface AddNativeProfileResult {
  profile_key: string
  profile_name: string
  placeholders_created: number
  placeholders_existing: number
  hosts: { vial_id: string; edge_created: boolean; vial_rows_created: number }[]
  no_host_vial: boolean
}
export interface RemoveNativeAnalysisResult {
  analysis_id: number
  keyword: string
  analysis_service_id: number
  vial_rows_deleted: number
  vial_rows_rejected: number
  edges_superseded: number
}
export interface ResyncFromOrderResult { placeholders_created: number; edges_created: number; vial_rows_created: number }

/** Thrown by removeNativeParentAnalysis on HTTP 412 — carries the impact for RemovalConfirmModal. */
export class NativeRemovalNeedsConfirm extends Error {
  impact: RemovalImpact
  constructor(impact: RemovalImpact) {
    super('confirm_required')
    this.name = 'NativeRemovalNeedsConfirm'
    this.impact = impact
  }
}

async function _detailMessage(response: Response, fallback: string): Promise<string> {
  const err = await response.json().catch(() => null)
  const d = err?.detail
  if (typeof d === 'string') return d
  if (d && typeof d.message === 'string') return d.message
  return `${fallback}: ${response.status}`
}

export async function listNativeProfilesForParent(sampleId: string): Promise<NativeProfile[]> {
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/parent/${encodeURIComponent(sampleId)}/native-profiles`,
    { headers: getAuthHeaders() }
  )
  if (!response.ok) throw new Error(await _detailMessage(response, 'Failed to list native profiles'))
  return response.json()
}

export async function addNativeProfileToParent(sampleId: string, profileId: number): Promise<AddNativeProfileResult> {
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/parent/${encodeURIComponent(sampleId)}/profiles`,
    { method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify({ profile_id: profileId }) }
  )
  if (!response.ok) throw new Error(await _detailMessage(response, 'Failed to add profile'))
  return response.json()
}

export async function removeNativeParentAnalysis(
  sampleId: string, analysisId: number, confirm = false,
): Promise<RemoveNativeAnalysisResult> {
  const qs = confirm ? '?confirm=true' : ''
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/parent/${encodeURIComponent(sampleId)}/native-analyses/${analysisId}${qs}`,
    { method: 'DELETE', headers: getAuthHeaders() }
  )
  if (response.status === 412) {
    const err = await response.json().catch(() => null)
    throw new NativeRemovalNeedsConfirm((err?.detail?.impact ?? { pristine: [], worked_unverified: [], blocked: [] }) as RemovalImpact)
  }
  if (!response.ok) throw new Error(await _detailMessage(response, 'Failed to remove analysis'))
  return response.json()
}

export async function resyncParentFromOrder(sampleId: string): Promise<ResyncFromOrderResult> {
  const response = await fetch(
    `${API_BASE_URL()}/api/lims-analyses/parent/${encodeURIComponent(sampleId)}/resync-from-order`,
    { method: 'POST', headers: getBearerHeaders('application/json') }
  )
  if (!response.ok) throw new Error(await _detailMessage(response, 'Re-sync failed'))
  return response.json()
}

/** Local mk1-origin services (for the native vial picker) shaped like the SENAITE picker rows:
 *  uid = "" (no SENAITE uid), plus `id` for the backend's analysis_service_id resolution. */
export async function listNativeAnalysisServices(): Promise<(AnalysisService & { id: number })[]> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services?origin=mk1&active=true`, { headers: getAuthHeaders() })
  if (!response.ok) throw new Error(`Failed to list native services: ${response.status}`)
  const rows: { id: number; keyword: string | null; title: string; senaite_uid: string | null }[] = await response.json()
  return rows.map(r => ({ uid: r.senaite_uid ?? '', keyword: r.keyword ?? '', title: r.title, id: r.id }) as AnalysisService & { id: number })
}
```
(Check the existing `AnalysisService` interface near `listAnalysisServices` — it has at least `uid`, `keyword`, `title`; add other required fields with sensible defaults if TypeScript complains. `RemovalImpact` is already exported near `getRemovalImpact`.)

- [ ] **Step 4: Create `src/components/senaite/NativeManageAnalysesBlock.tsx`**

```tsx
/**
 * Native (Accu-Mk1) block inside the Manage Analyses overlay — parent pages only.
 * Spec: docs/superpowers/specs/2026-08-18-native-manage-analyses-design.md §5.1
 *
 * Reads the SAME query the native parent card uses (NATIVE_PARENT_ANALYSES_QUERY_KEY,
 * listNativeParentAnalysesShaped) so list and card can never disagree; adds a
 * profile picker (GET native-profiles), per-row remove (trash, ordered rows only)
 * and an admin-only "Re-sync from order".
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { RemovalConfirmModal } from '@/components/senaite/RemovalConfirmModal'
import { NATIVE_PARENT_ANALYSES_QUERY_KEY } from '@/lib/native-parent-analyses'
import {
  addNativeProfileToParent,
  listNativeParentAnalysesShaped,
  listNativeProfilesForParent,
  NativeRemovalNeedsConfirm,
  removeNativeParentAnalysis,
  resyncParentFromOrder,
  type NativeProfile,
  type RemovalImpact,
  type SenaiteAnalysis,
} from '@/lib/api'

const NATIVE_PROFILES_QUERY_KEY = 'native-profiles'

interface Props {
  sampleId: string
  isAdmin: boolean
  /** Called after any successful mutation so the page can refresh its own state. */
  onChanged: () => void
  /** Optional search string shared with the SENAITE picker. */
  search?: string
}

type NativeRow = SenaiteAnalysis & { id?: number; provenance?: string }

export function NativeManageAnalysesBlock({ sampleId, isAdmin, onChanged, search = '' }: Props) {
  const qc = useQueryClient()
  const rowsQ = useQuery<NativeRow[]>({
    queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId],
    queryFn: () => listNativeParentAnalysesShaped(sampleId) as Promise<NativeRow[]>,
  })
  const profilesQ = useQuery<NativeProfile[]>({
    queryKey: [NATIVE_PROFILES_QUERY_KEY, sampleId],
    queryFn: () => listNativeProfilesForParent(sampleId),
  })
  const [addingId, setAddingId] = useState<number | null>(null)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [resyncing, setResyncing] = useState(false)
  const [confirmFor, setConfirmFor] = useState<{ row: NativeRow; impact: RemovalImpact } | null>(null)

  const rows = (rowsQ.data ?? []).filter(r => r.review_state && !['retracted', 'rejected'].includes(r.review_state))
  const profiles = profilesQ.data ?? []
  if (!rowsQ.isLoading && !profilesQ.isLoading && rows.length === 0 && profiles.length === 0) return null

  const roleByServiceKeyword = new Map<string, { role: string | null; hosts: string[] }>()
  for (const p of profiles) for (const m of p.members) roleByServiceKeyword.set(m.keyword, { role: p.fulfillment_role, hosts: p.host_vials })

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId] }),
      qc.invalidateQueries({ queryKey: [NATIVE_PROFILES_QUERY_KEY, sampleId] }),
    ])
    onChanged()
  }

  const handleAdd = async (p: NativeProfile) => {
    setAddingId(p.id)
    try {
      const res = await addNativeProfileToParent(sampleId, p.id)
      const hostText = res.no_host_vial
        ? `placeholder only — seeds when a ${p.fulfillment_role ?? '?'} vial is assigned, or use Re-sync`
        : `on ${res.hosts.map(h => h.vial_id).join(', ')}`
      toast.success(`Added ${res.profile_name}`, { description: hostText })
      await invalidate()
    } catch (e) {
      toast.error('Failed to add profile', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAddingId(null)
    }
  }

  const doRemove = async (row: NativeRow, confirm: boolean) => {
    if (row.id == null) return
    setRemovingId(row.id)
    try {
      const res = await removeNativeParentAnalysis(sampleId, row.id, confirm)
      toast.success(`Removed ${row.title}`, {
        description: `${res.vial_rows_deleted} vial row(s) deleted, ${res.vial_rows_rejected} rejected`,
      })
      setConfirmFor(null)
      await invalidate()
    } catch (e) {
      if (e instanceof NativeRemovalNeedsConfirm) {
        setConfirmFor({ row, impact: e.impact })
      } else {
        toast.error('Failed to remove analysis', { description: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      setRemovingId(null)
    }
  }

  const handleResync = async () => {
    setResyncing(true)
    try {
      const r = await resyncParentFromOrder(sampleId)
      toast.success('Re-synced from order', {
        description: `${r.placeholders_created} placeholders, ${r.edges_created} edges, ${r.vial_rows_created} vial analyses`,
      })
      await invalidate()
    } catch (e) {
      toast.error('Re-sync failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setResyncing(false)
    }
  }

  const q = search.toLowerCase()
  const pickable = profiles
    .filter(p => p.on_sample !== 'full')
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.key.includes(q) || p.members.some(m => m.keyword.toLowerCase().includes(q)))

  return (
    <div className="mb-4 rounded-md border border-border/60 p-2.5" data-testid="native-manage-block">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium">Native (Accu-Mk1)</p>
        {isAdmin && (
          <Button variant="outline" size="sm" className="h-6 gap-1 text-[11px]" disabled={resyncing} onClick={handleResync}>
            {resyncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Re-sync from order
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-1">Current native analyses</p>
      <div className="space-y-1 mb-3">
        {rows.length === 0 && <p className="text-[11px] text-muted-foreground/70 px-2">none</p>}
        {rows.map(r => {
          const isOrdered = r.provenance === 'ordered'
          const host = roleByServiceKeyword.get(r.keyword ?? '')
          const hostChip = host && host.hosts.length > 0 ? `${host.role ?? '?'} · ${host.hosts.join(', ')}` : 'no host vial'
          return (
            <div key={r.id ?? r.keyword} data-testid="native-row" className="flex items-center justify-between py-1 px-2 rounded bg-muted/40">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-mono text-muted-foreground shrink-0">{r.keyword}</span>
                <span className="text-xs truncate">{r.title}</span>
                <span className="text-[10px] rounded px-1 bg-zinc-500/15 text-zinc-500 shrink-0">{isOrdered ? 'Ordered' : r.review_state}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{hostChip}</span>
              </div>
              <Button
                variant="ghost" size="sm" aria-label={`Remove ${r.title}`}
                className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                disabled={!isOrdered || removingId === r.id}
                title={isOrdered ? undefined : 'Promoted result — use retest/retract on the card'}
                onClick={() => doRemove(r, false)}
              >
                {removingId === r.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              </Button>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground mb-1">Add profile</p>
      <div className="max-h-48 overflow-y-auto space-y-0.5" data-testid="native-profile-picker">
        {profilesQ.isLoading && <Loader2 size={14} className="animate-spin text-muted-foreground m-2" />}
        {pickable.map(p => (
          <div key={p.id} className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/60">
            <div className="min-w-0">
              <span className="text-xs block">{p.name}{p.on_sample === 'partial' ? ' — adds missing' : ''}</span>
              <span className="text-[10px] font-mono text-muted-foreground block truncate">{p.members.map(m => m.keyword).join(' · ')}</span>
              <span className="text-[10px] text-muted-foreground block">
                {p.host_vials.length > 0 ? `→ ${p.host_vials.join(', ')}` : `no ${p.fulfillment_role ?? '?'} vial yet — placeholder only`}
              </span>
            </div>
            <Button variant="ghost" size="sm" aria-label={`Add ${p.name}`} className="h-6 w-6 p-0 shrink-0" disabled={addingId === p.id} onClick={() => handleAdd(p)}>
              {addingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            </Button>
          </div>
        ))}
        {!profilesQ.isLoading && pickable.length === 0 && <p className="text-[11px] text-muted-foreground/70 px-2">no native profiles to add</p>}
      </div>

      <RemovalConfirmModal
        open={confirmFor !== null}
        serviceTitle={confirmFor?.row.title ?? ''}
        impact={confirmFor?.impact ?? null}
        pending={confirmFor !== null && removingId === confirmFor.row.id}
        onConfirm={() => confirmFor && doRemove(confirmFor.row, true)}
        onCancel={() => setConfirmFor(null)}
      />
    </div>
  )
}
```
(Verify `SenaiteAnalysis` in `api.ts` exposes `id`/`provenance` for the senaite-shape rows — the serializer returns them; if the TS type lacks them, keep the local `NativeRow` intersection as written. `RemovalConfirmModal`'s confirm button text: read the component to match the regex in the test.)

- [ ] **Step 5: Run the test + typecheck**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && npx vitest run src/test/native-manage-analyses-block.test.tsx && npx tsc --noEmit -p tsconfig.json
```
Expected: 7 pass; tsc clean (pre-existing unrelated errors, if any, must be identical to base — compare with `git stash`-free check: run tsc on base in the composition worktree if unsure).

- [ ] **Step 6: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add src/lib/api.ts src/components/senaite/NativeManageAnalysesBlock.tsx src/test/native-manage-analyses-block.test.tsx && git commit -m "feat(fe): NativeManageAnalysesBlock + api client for native profile add/remove/resync"
```

---

### Task 10: Frontend — wire the block into the overlay; native vial picker

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` — imports (~`:179-213`), `openManageAnalyses` (`:4094`), `handleAddAnalysis` (`:4109`), overlay JSX (insert the block after the SENAITE "Current analyses" `</div>` and before `{/* Add new analysis */}` at `:6529`; extend the cascade help copy at `:6399-6439`)
- Test: `src/test/native-manage-analyses-wiring.test.tsx` (new, unit-level on the extracted helper) — plus rely on Task 9's block tests

**Interfaces:**
- Consumes: `NativeManageAnalysesBlock` (Task 9), `listNativeAnalysisServices`, `addAnalysisToSample(sampleId, uid, extra)`, existing `isAdmin` (`:3586`), `parentSampleId`, `data.sample_uid` (`mk1://…` on native vials — see the comment at `:6297`).
- Produces: `src/lib/manage-analyses-picker.ts` with `export function pickerSourceFor(parentSampleId: string | null, sampleUid: string | null | undefined): 'native' | 'senaite'` — `'native'` iff `parentSampleId !== null && sampleUid?.startsWith('mk1://')`.

- [ ] **Step 1: Write the failing helper test** — create `src/test/manage-analyses-picker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pickerSourceFor } from '@/lib/manage-analyses-picker'

describe('pickerSourceFor', () => {
  it('is native only on mk1 vial pages', () => {
    expect(pickerSourceFor('P-1', 'mk1://abc')).toBe('native')
    expect(pickerSourceFor('P-1', 'senaite-uid')).toBe('senaite')
    expect(pickerSourceFor(null, 'mk1://abc')).toBe('senaite')   // parent pages keep the SENAITE picker
    expect(pickerSourceFor('P-1', undefined)).toBe('senaite')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && npx vitest run src/test/manage-analyses-picker.test.ts
```

- [ ] **Step 3: Create `src/lib/manage-analyses-picker.ts`**

```ts
/** Which service catalog the Manage Analyses "Add analysis" picker reads.
 *  Native (Accu-Mk1) VIAL pages list local mk1-origin services (the SENAITE
 *  proxy never shows services without a senaite_uid); everything else keeps
 *  the SENAITE catalog. Parent pages keep SENAITE here — native PROFILES have
 *  their own block (NativeManageAnalysesBlock). */
export function pickerSourceFor(
  parentSampleId: string | null,
  sampleUid: string | null | undefined,
): 'native' | 'senaite' {
  return parentSampleId !== null && !!sampleUid && sampleUid.startsWith('mk1://') ? 'native' : 'senaite'
}
```

- [ ] **Step 4: Wire `SampleDetails.tsx`**

(a) Imports: add
```ts
import { NativeManageAnalysesBlock } from '@/components/senaite/NativeManageAnalysesBlock'
import { pickerSourceFor } from '@/lib/manage-analyses-picker'
```
and add `listNativeAnalysisServices` to the `@/lib/api` import list.

(b) `openManageAnalyses` (`:4094`): choose the source:
```ts
  const openManageAnalyses = async () => {
    setManageAnalysesOpen(true)
    if (availableServices.length === 0) {
      setServicesLoading(true)
      try {
        const services =
          pickerSourceFor(parentSampleId, data?.sample_uid) === 'native'
            ? await listNativeAnalysisServices()
            : await listAnalysisServices()
        setAvailableServices(services)
      } catch {
        toast.error('Failed to load analysis services')
      } finally {
        setServicesLoading(false)
      }
    }
  }
```

(c) `handleAddAnalysis` (`:4109`): send keyword + id on native vials:
```ts
  const handleAddAnalysis = async (service: AnalysisService & { id?: number }) => {
    if (!data?.sample_id) return
    setAddingService(service.uid || service.keyword)
    try {
      const native = pickerSourceFor(parentSampleId, data.sample_uid) === 'native'
      await addAnalysisToSample(
        data.sample_id,
        service.uid,
        native ? { keyword: service.keyword, analysis_service_id: service.id } : undefined,
      )
      toast.success(`Added ${service.title}`)
      refreshSample(data.sample_id)
    } catch (e) {
      toast.error('Failed to add analysis', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAddingService(null)
    }
  }
```
The picker's row key/`disabled` uses `s.uid` (`:6577-6595`): change `key={s.uid}` → `key={s.uid || s.keyword}` and `addingService === s.uid` → `addingService === (s.uid || s.keyword)` so native rows (uid `''`) don't collide.

(d) Overlay JSX: immediately after the SENAITE "Current analyses" block's closing `</div>` (the one before `{/* Add new analysis */}` at `:6529`), insert:
```tsx
            {/* Native (Accu-Mk1) — parent pages only: native parent rows with
                  remove, native PROFILE picker, admin Re-sync (spec 2026-08-18) */}
            {parentSampleId === null && data?.sample_id && (
              <NativeManageAnalysesBlock
                sampleId={data.sample_id}
                isAdmin={isAdmin}
                search={serviceSearch}
                onChanged={() => refreshSample(data.sample_id)}
              />
            )}
```
(e) Cascade help copy (`:6399-6439`, parent pages with vials): append one sentence inside the existing paragraph: `Native profiles added below are also placed on the matching vial(s); if none exists yet, the analysis seeds when a vial gets that role.`

- [ ] **Step 5: Run the FE checks**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && npx vitest run src/test/manage-analyses-picker.test.ts src/test/native-manage-analyses-block.test.tsx src/test/native-parent-analyses.test.tsx src/test/vials-quicklook.test.tsx && npm run check:all
```
Expected: tests pass; `check:all` green (typecheck + lint + ast:lint + format + rust + tests). Fix formatting with the project's formatter if `format` complains (`npm run format` if that script exists — check `package.json`).

- [ ] **Step 6: Commit**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git add src/components/senaite/SampleDetails.tsx src/lib/manage-analyses-picker.ts src/test/manage-analyses-picker.test.ts && git commit -m "feat(fe): native block in Manage Analyses overlay; native vial picker reads local mk1 services"
```

---

### Task 11: Gates — full backend failure-set diff, FE check:all, composition merge

**Files:**
- Read/compare: `C:\tmp\Accu-Mk1-manage-analyses\.superpowers\sdd\baseline_failed.txt`
- Modify (composition only, never pushed): `C:\tmp\Accu-Mk1-arcitest` (`integration/catalog-arc-itest`) — merge the slice

- [ ] **Step 1: Full backend suite on the slice → failure-set diff**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses/backend"
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^FAILED " | sed 's/ - .*//' | sort -u > "C:/tmp/Accu-Mk1-manage-analyses/.superpowers/sdd/tip_failed.txt"
diff "C:/tmp/Accu-Mk1-manage-analyses/.superpowers/sdd/baseline_failed.txt" "C:/tmp/Accu-Mk1-manage-analyses/.superpowers/sdd/tip_failed.txt" && echo "FAILURE SET IDENTICAL"
```
Expected: `FAILURE SET IDENTICAL`. Any `>` line is a regression to fix before proceeding; any `<` line means the slice fixed a baseline failure — note it.

- [ ] **Step 2: `npm run check:all` on the slice** (already green in Task 10 — re-run once after all commits)

- [ ] **Step 3: Merge into the local test composition and run the touched suites there**

```bash
cd "C:/tmp/Accu-Mk1-arcitest" && git status --short | head && git merge --no-ff feat/native-manage-analyses -m "arcitest: native manage analyses slice into the arc — TEST COMPOSITION, never push"
```
If `backend/main.py` conflicts at the explorer native-branch call site (S3 added `analysis_service_id=body.get("analysis_service_id")`), resolve by keeping BOTH kwargs (`senaite_service_uid`, `keyword`, `analysis_service_id`) and the `ensure_parent_placeholder` call; if `sub_samples/service.py` conflicts around `services_map` (S4 added `snapshot=`), keep the S4 lines and add the union line after `services_map` is resolved. Then:
```bash
cd "C:/tmp/Accu-Mk1-arcitest/backend" && "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider tests/test_manage_native.py tests/test_manage_native_routes.py tests/test_parent_placeholders.py tests/test_native_manage_analyses.py tests/test_amendment_audit.py tests/test_custody_edges.py tests/test_catalog_seeding.py tests/test_spec_rules_placeholders.py
```
Expected: all pass in the composition too (S3's identity indexes and S4's snapshot path coexist with the slice). Record the merge commit hash in the ledger.

- [ ] **Step 4: Ledger the gate results** in `C:\tmp\Accu-Mk1-manage-analyses\.superpowers\sdd\progress.md` (baseline count, tip count, identical y/n, composition merge hash, check:all result). No code commit for this task.

---

### Task 12: Deploy the composition to arcitest and run the acceptance case

**Files:**
- Devbox: `forrestparker@100.73.137.3:~/worktrees/mk1-arcitest` (branch `arcitest/mk1-full`, backend runs `--reload` on the bind mount; frontend is a Vite dev server) — **never `git checkout --`/`stash`/`clean` there; `package-lock.json` is dirty on purpose, leave it**.

- [ ] **Step 1: Ship the slice branch to the devbox and merge into `arcitest/mk1-full`**

```bash
cd "C:/tmp/Accu-Mk1-manage-analyses" && git bundle create /tmp/nma.bundle feat/native-manage-analyses && scp -q /tmp/nma.bundle forrestparker@100.73.137.3:/tmp/nma.bundle
ssh forrestparker@100.73.137.3 'cd ~/worktrees/mk1-arcitest && git fetch /tmp/nma.bundle feat/native-manage-analyses:feat/native-manage-analyses && git merge --no-ff feat/native-manage-analyses -m "arcitest: native manage analyses slice into the arc — TEST COMPOSITION, never push" && git log --oneline -1'
```
Resolve conflicts exactly as in Task 11 step 3 (same two files). Then confirm the backend reloaded and the frontend picked up the new component:
```bash
ssh forrestparker@100.73.137.3 'sleep 5; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5812/health; docker logs --tail 20 accumark-arcitest-accu-mk1-backend 2>&1 | grep -i -E "reload|started|error" | tail -5; cd ~/accumark-stack && ./bin/accumark-stack validate arcitest | tail -1'
```
Expected: `200`, a reload line, `21/21`.

- [ ] **Step 2: Acceptance on `PB-0156` via the API** (login as in the memory idiom: `POST /auth/login` on `http://100.73.137.3:5812`; the stack UAT credentials are in the Handler's hands — if unknown, ask; never guess)

```bash
BASE=http://100.73.137.3:5812
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"email":"<uat-email>","password":"<uat-password>"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
H="Authorization: Bearer $TOKEN"
curl -s -H "$H" "$BASE/api/lims-analyses/parent/PB-0156/native-profiles" | python -m json.tool          # expect moisture on_sample=none, host_vials=[PB-0156-S04]
curl -s -H "$H" -X POST "$BASE/api/lims-analyses/parent/PB-0156/profiles" -H 'Content-Type: application/json' -d '{"profile_id":7}' | python -m json.tool   # 201, hosts=[PB-0156-S04 …]
curl -s -H "$H" "$BASE/api/lims-analyses/parent/PB-0156/native-analyses?as=senaite_shape" | python -c "import sys,json;print([(r['keyword'],r.get('provenance'),r['review_state']) for r in json.load(sys.stdin)])"   # MOISTURE-KF ordered unassigned present
curl -s -H "$H" -X POST "$BASE/api/lims-analyses/parent/PB-0156/resync-from-order" | python -m json.tool     # admin token required; expect all zeros
```
Then in the DB (see the session's `psql` idiom against `accumark-arcitest-postgres` / `accumark_mk1`): `PB-0156-S04` has `MOISTURE-KF:unassigned`; `vial_profile_assignments` has host edge (S04, profile 7, superseded_at NULL); parent activity shows "Residual Moisture added (native) — 1 analysis on PB-0156-S04". Then remove via `DELETE …/native-analyses/{id}` → placeholder `rejected`, S04 row gone, edge superseded; re-add → fresh placeholder (real-Postgres partial-index proof). Leave the sample in the **added** state for the Handler's UI check.

- [ ] **Step 3: UI check on `http://100.73.137.3:5812/` (or the FE port the stack maps — `curl -I` the FE first)**: open `PB-0156` → Manage Analyses → the Native block lists `MOISTURE-KF · Ordered · kf · PB-0156-S04`; the picker no longer offers Residual Moisture; open `PB-0156-S04` → Manage Analyses → picker lists mk1 services (LEAD-PPM … MOISTURE-KF). Screenshot both to `C:\tmp\native-manage-analyses-*.png`.

- [ ] **Step 4: Ledger + handoff note.** Record in `progress.md`: devbox merge hash, acceptance results, screenshots. Do NOT push anything. Update the memory file `project_native_manage_analyses.md` state to BUILT + arcitest live.

---

## Self-review (done at plan-writing time)

- **Spec coverage:** §4.1 (Task 2), §4.2 add/remove/resync/ensure/list (Tasks 3, 5, 6), §4.3 hook (Task 4), §4.4 routes + explorer + `/analysis-services` (Task 7), §4.5 activity (Tasks 3/5/6 write events; Task 7 labels), §4.6 R2 (Task 8), §5.1 block (Tasks 9–10), §5.2 vial picker (Task 10), §5.3 states (Task 9), §6 errors (Task 7 mapping), §7 tests (each task + Task 11), §9.6 stale docs (Task 8). Rollout §8 (Tasks 11–12).
- **Placeholders:** none — every step carries code or an exact command.
- **Type consistency:** `add_profile_to_parent` result keys match `AddNativeProfileResponse` and the FE `AddNativeProfileResult`; `remove_parent_native_analysis` result matches `RemoveNativeAnalysisResponse`/`RemoveNativeAnalysisResult`; `RemovalNeedsConfirm.impact` uses the `RemovalImpact` bucket names (`pristine`/`worked_unverified`/`blocked`) with rows carrying `sample_id` — what `RemovalConfirmModal` reads; `placeholder_profile_keys` name is identical in Tasks 3 and 4; `fetch_sample_services` is imported at module level in `manage_native` so tests monkeypatch `mn.fetch_sample_services`.
