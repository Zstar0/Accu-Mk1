# Rider Vial Assignment + Native Analyses Vial Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rider profiles (e.g. Fentanyl Screening riding `hplc`) get their analyses seeded on the host vial, lab-added riders provision correctly, the UI shows where a rider landed, and the native "Accu-Mk1 Analyses" card shows clickable assigned-vial chips pre-promotion.

**Architecture:** Four additive slices on the existing custody-edge machinery: (S1) the seeder's `hplc` branch additionally seeds rider-edge members + a rider-aware stale-row cleanup in `set_assignment_role`; (S2) `manage_native._host_vials` becomes ride-list-aware and `_ensure_host_edge` gains a relation param; (S3) vial-plan sections carry the rider's landing vials, rendered by `RiderChips`; (S4) the native parent card feeds its own rows through the existing `buildVialAssignmentMap` chip join.

**Tech Stack:** FastAPI + SQLAlchemy (backend/), React + TypeScript + react-query + vitest (src/), pytest with in-memory SQLite StaticPool fixtures.

**Spec:** `docs/superpowers/specs/2026-08-20-rider-vial-visibility-design.md` (same repo/branch as this plan). Read it first.

## Global Constraints

- **Worktree:** `C:\tmp\Accu-Mk1-riders`, branch `feat/rider-vial-visibility`, cut from arcitest composition commit `37955381`. All file paths below are relative to that worktree.
- **Additive only.** Never change existing seeding/edge behavior for host profiles, endo/ster whitelists, or the SENAITE mirror. A failing pre-existing test defaults to "test is stale" — but check the baseline first.
- **Test gate = failure-SET diff** against `C:\tmp\Accu-Mk1-riders\.rider_baseline_ids.txt` (captured at Task 0), never zero-failures. The composition has ≥1 documented pre-existing failure (`test_catalog_change_log.py::test_create_service_group_writes_create_log_row`).
- **`.rider_baseline_ids.txt` must stay UNTRACKED.** Check `git status` before every commit; never `git add -A`.
- **Backend test command:** `cd C:\tmp\Accu-Mk1-riders\backend && C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <targets>`. Do NOT create a `backend/.env` (an empty-token .env fakes +23 failures).
- **FE:** npm only (never pnpm). `node_modules` is a junction to `C:\tmp\Accu-Mk1-amendment-audit\node_modules`; if npx errors about missing packages, the junction target got emptied — re-point per Task 0.
- **R0: zero new SENAITE coupling.** No new calls to any SENAITE surface.
- **No new keyword-join tiers** in `src/lib/vial-assignment.ts` (ast-grep rule `no-new-keyword-join-tiers` enforces this).
- Python: match surrounding style (function-local imports for cross-package imports inside `sub_samples`/`lims_analyses` to avoid cycles — see existing `set_assignment_role`).

---

### Task 0: Worktree + baseline setup (orchestrator does this inline, not a subagent)

**Files:** none (environment).

- [ ] **Step 1: Create the worktree**

```bash
git -C "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" worktree add C:/tmp/Accu-Mk1-riders -b feat/rider-vial-visibility 37955381
```

- [ ] **Step 2: node_modules junction (verify target non-empty first)**

```bash
ls "C:/tmp/Accu-Mk1-amendment-audit/node_modules" | head -3   # must list packages
cmd //c "cd /d C:\tmp\Accu-Mk1-riders && mklink /J node_modules C:\tmp\Accu-Mk1-amendment-audit\node_modules"
```

- [ ] **Step 3: Capture backend baseline**

```bash
cd C:/tmp/Accu-Mk1-riders/backend
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > ../.rider_baseline_ids.txt
wc -l ../.rider_baseline_ids.txt
```

- [ ] **Step 4: FE sanity** — `cd C:/tmp/Accu-Mk1-riders && npx tsc --noEmit` (expect clean; if it errors on missing packages, fix the junction).

---

### Task 1: S1a — seed rider members on hplc host vials

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (hplc branch at ~`:627-640`; new helper next to `_members_from_edges`)
- Test: `backend/tests/test_rider_seeding.py` (new file)

**Interfaces:**
- Consumes: `_members_from_edges(db, edges, snapshot=...)`, `_seed_rows_from_services(db, sub_sample=, services=, existing_kw=, existing_service_ids=, created_by_user_id=, commit=, log_event=)`, `sub_samples.custody.current_custody(db, sub_pk)` (returns current `VialProfileAssignment` rows).
- Produces: `_seed_rider_members(db, *, sub_sample, existing_kw, existing_service_ids, created_by_user_id, commit) -> List[LimsAnalysis]` — Task 2's tests and the live heal depend on the hplc branch calling it.

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_rider_seeding.py`. Fixture idiom copied from `backend/tests/test_custody_edges.py` (StaticPool SQLite, `seed_vial_roles`); NO autouse seeder stub in this file (Task 1 exercises the real seeder). Full file:

```python
"""Rider seeding on legacy-host (hplc) vials — spec 2026-08-20-rider-vial-visibility.

The hplc branch of seed_analyses_for_vial historically returned the SENAITE
mirror's rows and never consulted custody edges, so a rider profile riding
`hplc` (the only legal legacy host) never got its member analyses on the host
vial (P-0158 evidence in the spec). The acceptance suite missed it by using an
hplc-ANALOG catalog role (test_catalog_bench_acceptance.py t13hplc).

SENAITE read is monkeypatched at "sub_samples.senaite.fetch_parent_analysis_keywords"
(same target as test_seeder_mirror.py).
"""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import (
    AnalysisProfile,
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    VialProfileAssignment,
    VialRole,
    profile_ride_hosts,
)
from lims_analyses.seeder import seed_analyses_for_vial


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    from catalog.vial_roles_seed import seed_vial_roles
    seed_vial_roles(session)
    yield session
    session.close()


def _svc(db, keyword, origin="mk1", department_id=None):
    s = AnalysisService(title=keyword, keyword=keyword, origin=origin, unit="ppm",
                        department_id=department_id)
    db.add(s)
    db.flush()
    return s


def _profile(db, key, role, members, vials=0, rides=None):
    existing_role = db.query(VialRole).filter_by(code=role).one_or_none()
    if existing_role is None:
        max_sort = db.query(func.coalesce(func.max(VialRole.sort_order), 0)).scalar() or 0
        db.add(VialRole(code=role, label=role, department_id=None, boxable=False,
                        variance_eligible=False, sort_order=max_sort + 1,
                        frozen=False, is_system=False))
        db.flush()
    p = AnalysisProfile(key=key, name=key, is_addon=True, vials_required=vials,
                        fulfillment_role=role, fulfillment_dim="role", active=True)
    p.analysis_services = list(members)
    db.add(p)
    db.flush()
    for i, host in enumerate(rides or []):
        db.execute(profile_ride_hosts.insert().values(
            analysis_profile_id=p.id, host_role_code=host, priority=i))
    db.commit()
    return p


def _vial(db, order_key, role="hplc", kind="core", seq=1):
    parent = LimsSample(sample_id=order_key, external_lims_uid=f"{order_key}-uid")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(sample_id=f"{order_key}-S{seq:02d}", vial_sequence=seq,
                        parent_sample_pk=parent.id, assignment_role=role,
                        assignment_kind=kind,
                        external_lims_uid=f"{order_key}-S{seq:02d}-uid")
    db.add(sub)
    db.commit()
    return parent, sub


def _rider_edge(db, sub, profile, relation="rider"):
    db.add(VialProfileAssignment(lims_sub_sample_pk=sub.id,
                                 analysis_profile_id=profile.id,
                                 relation=relation, assigned_at=datetime.utcnow()))
    db.commit()


def _seed_hplc(db, sub, parent, monkeypatch, keywords=()):
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords",
                        lambda sid: list(keywords))
    return seed_analyses_for_vial(
        db, sub_sample=sub, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id=parent.sample_id, created_by_user_id=1, commit=True,
    )


def test_rider_edge_member_seeds_on_hplc_vial(db, monkeypatch):
    """A live rider custody edge on an hplc vial seeds the rider profile's
    member service alongside the (empty here) mirror."""
    fent_svc = _svc(db, "ZZR-FENT")
    fent = _profile(db, "zzr_fent", "zzrfent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR-0001")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert [r.keyword for r in rows] == ["ZZR-FENT"]
    persisted = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()
    assert [r.keyword for r in persisted] == ["ZZR-FENT"]
    assert persisted[0].review_state == "unassigned"
    assert persisted[0].analysis_service_id == fent_svc.id


def test_rider_seeding_composes_with_mirror(db, monkeypatch):
    """Mirror rows first (Analytical-department keyword), rider member after —
    both on the vial, no interference."""
    analytical = Department(name="Analytical")
    db.add(analytical)
    db.flush()
    _svc(db, "HPLC-PUR", department_id=analytical.id)
    fent_svc = _svc(db, "ZZR2-FENT")
    fent = _profile(db, "zzr2_fent", "zzr2fent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR2-0001")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch, keywords=["HPLC-PUR"])

    assert [r.keyword for r in rows] == ["HPLC-PUR", "ZZR2-FENT"]


def test_variance_vial_gets_no_rider_rows(db, monkeypatch):
    fent_svc = _svc(db, "ZZR3-FENT")
    fent = _profile(db, "zzr3_fent", "zzr3fent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR3-0001", kind="variance")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert rows == []
    assert db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).count() == 0


def test_rider_seeding_is_idempotent(db, monkeypatch):
    fent_svc = _svc(db, "ZZR4-FENT")
    fent = _profile(db, "zzr4_fent", "zzr4fent", [fent_svc], rides=["hplc"])
    parent, sub = _vial(db, "ZZR4-0001")
    _rider_edge(db, sub, fent)

    first = _seed_hplc(db, sub, parent, monkeypatch)
    second = _seed_hplc(db, sub, parent, monkeypatch)

    assert len(first) == 1 and second == []
    assert db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).count() == 1


def test_rider_origin_gate_fails_closed(db, monkeypatch):
    """A rider profile with any non-mk1 member seeds nothing (per-profile
    origin gate, same as the catalog path)."""
    ok = _svc(db, "ZZR5-OK")
    foreign = _svc(db, "ZZR5-BAD", origin="senaite")
    fent = _profile(db, "zzr5_fent", "zzr5fent", [ok, foreign], rides=["hplc"])
    parent, sub = _vial(db, "ZZR5-0001")
    _rider_edge(db, sub, fent)

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert rows == []


def test_host_edge_alone_adds_nothing_on_hplc(db, monkeypatch):
    """A host edge (the hplc anchor's own edge) must NOT trigger member
    seeding on the hplc branch — the mirror owns hplc host content."""
    host_svc = _svc(db, "ZZR6-HOST")
    anchor = _profile(db, "zzr6_anchor", "hplc", [host_svc], vials=1)
    parent, sub = _vial(db, "ZZR6-0001")
    _rider_edge(db, sub, anchor, relation="host")

    rows = _seed_hplc(db, sub, parent, monkeypatch)

    assert rows == []
```

- [ ] **Step 2: Run to verify failure**

Run: `...python.exe -m pytest -q -p no:cacheprovider tests/test_rider_seeding.py -v`
Expected: the 4 rider-positive tests FAIL (no rider rows seeded); `test_variance_vial_gets_no_rider_rows` and `test_host_edge_alone_adds_nothing_on_hplc` may pass vacuously — that's fine, they pin the boundary.

- [ ] **Step 3: Implement.** In `backend/lims_analyses/seeder.py`, add the helper directly after `_members_from_edges` and call it from the hplc branch:

```python
def _seed_rider_members(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    existing_kw: set,
    existing_service_ids: set,
    created_by_user_id: Optional[int],
    commit: bool,
) -> List[LimsAnalysis]:
    """Seed member services of this vial's live RIDER custody edges (spec
    2026-08-20-rider-vial-visibility). The hplc mirror reads the parent's
    SENAITE keywords, which know nothing about catalog riders — so a rider
    riding a legacy host would otherwise never get its analyses on the host
    vial. Host edges are deliberately excluded here: on the hplc branch the
    mirror owns host content. Variance replicates never carry rider work."""
    if sub_sample.assignment_kind == "variance":
        return []
    from sub_samples.custody import current_custody

    rider_edges = [e for e in current_custody(db, sub_sample.id) if e.relation == "rider"]
    if not rider_edges:
        return []
    snapshot = sub_sample.parent_sample.catalog_snapshot
    services = _members_from_edges(db, rider_edges, snapshot=snapshot)
    if not services:
        return []
    return _seed_rows_from_services(
        db,
        sub_sample=sub_sample,
        services=services,
        existing_kw=existing_kw,
        existing_service_ids=existing_service_ids,
        created_by_user_id=created_by_user_id,
        commit=commit,
        log_event="rider_seeded",
    )
```

Change the hplc branch in `seed_analyses_for_vial` from `return mirror_parent_hplc_analyses(...)` to:

```python
    if role == "hplc":
        if not parent_sample_id:
            raise ValueError(
                "seed_analyses_for_vial(role='hplc') requires parent_sample_id"
            )
        inserted = mirror_parent_hplc_analyses(
            db,
            sub_sample=sub_sample,
            parent_sample_id=parent_sample_id,
            existing_kw=existing_kw,
            existing_service_ids=existing_service_ids,
            created_by_user_id=created_by_user_id,
            commit=commit,
        )
        # Rider custody edges seed too (mirror mutates existing_kw/ids as it
        # inserts, so the dedupe composes).
        inserted.extend(_seed_rider_members(
            db,
            sub_sample=sub_sample,
            existing_kw=existing_kw,
            existing_service_ids=existing_service_ids,
            created_by_user_id=created_by_user_id,
            commit=commit,
        ))
        return inserted
```

Leave the endo/ster branch untouched (forbidden ride hosts — `_RIDE_HOST_FORBIDDEN`).

- [ ] **Step 4: Run the new file + neighbors**

Run: `...python.exe -m pytest -q -p no:cacheprovider tests/test_rider_seeding.py tests/test_seeder_mirror.py tests/test_catalog_seeding.py tests/test_lims_analyses_seeder.py tests/test_catalog_bench_acceptance.py -v`
Expected: all PASS (neighbors unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/seeder.py backend/tests/test_rider_seeding.py
git commit -m "feat(seeder): seed rider custody-edge members on hplc host vials"
```

---

### Task 2: S1b — rider-aware stale-row cleanup on role flip

**Files:**
- Modify: `backend/sub_samples/service.py` (new helper near `_drop_stale_role_rows` ~`:1736`; two insertions in `set_assignment_role` around `:1952-1971`)
- Test: `backend/tests/test_rider_seeding.py` (append)

**Interfaces:**
- Consumes: `current_custody`, `set_assignment_role` internals (edge rewrite at `write_custody_edges` + `db.flush()` + `_drop_stale_role_rows`).
- Produces: `_drop_stale_rider_rows(db, *, sub, prev_rider_pids) -> int`, called inside `set_assignment_role` right after `_drop_stale_role_rows`.

- [ ] **Step 1: Append failing tests** to `backend/tests/test_rider_seeding.py`. These go through `set_assignment_role` with the real seeder stubbed per-test (the pattern `test_custody_edges.py` uses file-wide):

```python
# ─── rider-aware stale-row cleanup on role flip (S1b) ────────────────────────

def _stub_seeder(monkeypatch):
    monkeypatch.setattr("lims_analyses.seeder.seed_analyses_for_vial",
                        lambda *a, **k: [])


def _manual_row(db, sub, svc, result_value=None):
    row = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title,
                       review_state="unassigned", result_value=result_value)
    db.add(row)
    db.commit()
    return row


def test_flip_away_from_host_role_drops_pristine_rider_row(db, monkeypatch):
    """zzchost -> zzcother: the rider edge disappears (rider rides zzchost
    only), so its pristine row drops even though the department-keyed
    cleanup can't see it (test roles carry department_id=None)."""
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    host_svc = _svc(db, "ZZC-HOST")
    other_svc = _svc(db, "ZZC-OTHER")
    rider_svc = _svc(db, "ZZC-RIDER")
    _profile(db, "zzc_host", "zzchost", [host_svc], vials=1)
    _profile(db, "zzc_other", "zzcother", [other_svc], vials=1)
    rider = _profile(db, "zzc_rider", "zzcrider", [rider_svc], rides=["zzchost"])
    parent, sub = _vial(db, "ZZC-0001", role=None, kind=None)
    wp = {"zzc_host": True, "zzc_other": True, "zzc_rider": True}

    sub_service.set_assignment_role(db, sub.sample_id, "zzchost", wp_services=wp, user_id=1)
    assert {e.relation for e in _edges(db, sub)} == {"host", "rider"}
    _manual_row(db, sub, rider_svc)  # what Task 1 would have seeded

    sub_service.set_assignment_role(db, sub.sample_id, "zzcother", wp_services=wp, user_id=1)

    kws = [r.keyword for r in db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()]
    assert "ZZC-RIDER" not in kws


def test_same_role_reassign_keeps_rider_row(db, monkeypatch):
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    host_svc = _svc(db, "ZZC2-HOST")
    rider_svc = _svc(db, "ZZC2-RIDER")
    _profile(db, "zzc2_host", "zzc2host", [host_svc], vials=1)
    _profile(db, "zzc2_rider", "zzc2rider", [rider_svc], rides=["zzc2host"])
    parent, sub = _vial(db, "ZZC2-0001", role=None, kind=None)
    wp = {"zzc2_host": True, "zzc2_rider": True}

    sub_service.set_assignment_role(db, sub.sample_id, "zzc2host", wp_services=wp, user_id=1)
    _manual_row(db, sub, rider_svc)
    sub_service.set_assignment_role(db, sub.sample_id, "zzc2host", wp_services=wp, user_id=1)

    kws = [r.keyword for r in db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()]
    assert "ZZC2-RIDER" in kws


def test_worked_rider_row_is_never_dropped(db, monkeypatch):
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    host_svc = _svc(db, "ZZC3-HOST")
    other_svc = _svc(db, "ZZC3-OTHER")
    rider_svc = _svc(db, "ZZC3-RIDER")
    _profile(db, "zzc3_host", "zzc3host", [host_svc], vials=1)
    _profile(db, "zzc3_other", "zzc3other", [other_svc], vials=1)
    _profile(db, "zzc3_rider", "zzc3rider", [rider_svc], rides=["zzc3host"])
    parent, sub = _vial(db, "ZZC3-0001", role=None, kind=None)
    wp = {"zzc3_host": True, "zzc3_other": True, "zzc3_rider": True}

    sub_service.set_assignment_role(db, sub.sample_id, "zzc3host", wp_services=wp, user_id=1)
    _manual_row(db, sub, rider_svc, result_value="0.5")  # worked

    sub_service.set_assignment_role(db, sub.sample_id, "zzc3other", wp_services=wp, user_id=1)

    kws = [r.keyword for r in db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=sub.id).all()]
    assert "ZZC3-RIDER" in kws


def _edges(db, sub):
    from sub_samples.custody import current_custody
    return current_custody(db, sub.id)
```

Note: `_vial(...)` gains `role=None, kind=None` support — adjust the Task 1 helper signature to `def _vial(db, order_key, role="hplc", kind="core", seq=1)` and pass the values straight through (already written that way above).

- [ ] **Step 2: Run to verify failure** — `tests/test_rider_seeding.py -v`: `test_flip_away...` FAILS (rider row survives), the other two pass (pinning current behavior stays).

- [ ] **Step 3: Implement.** In `backend/sub_samples/service.py` add after `_drop_stale_role_rows`:

```python
def _drop_stale_rider_rows(db: Session, *, sub: LimsSubSample,
                           prev_rider_pids: set) -> int:
    """Rider companion to _drop_stale_role_rows (spec
    2026-08-20-rider-vial-visibility): that cleanup is DEPARTMENT-keyed, so a
    rider row whose service shares the new role's department survives a flip
    even though its rider edge is gone. Drop this vial's pristine rows whose
    service belongs to a profile that just LOST its rider edge and holds no
    current edge of any relation. Same pristine predicate as
    _drop_stale_role_rows — worked rows are never touched."""
    if not prev_rider_pids:
        return 0
    from sub_samples.custody import current_custody

    current_pids = {e.analysis_profile_id for e in current_custody(db, sub.id)}
    stale_pids = prev_rider_pids - current_pids
    if not stale_pids:
        return 0
    from models import AnalysisProfile, LimsAnalysis, LimsAnalysisTransition

    svc_ids: set = set()
    for pid in stale_pids:
        prof = db.get(AnalysisProfile, pid)
        if prof is not None:
            svc_ids.update(s.id for s in prof.analysis_services)
    if not svc_ids:
        return 0
    stale = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub.id,
            LimsAnalysis.analysis_service_id.in_(svc_ids),
            LimsAnalysis.review_state == "unassigned",
            LimsAnalysis.result_value.is_(None),
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalars().all()
    n = 0
    for row in stale:
        db.execute(delete(LimsAnalysisTransition).where(
            LimsAnalysisTransition.analysis_id == row.id))
        db.delete(row)
        n += 1
    if n:
        db.flush()
        log.info("sub_samples.rider_cleanup sub=%s dropped=%s", sub.sample_id, n)
    return n
```

In `set_assignment_role`, capture the outgoing rider edges immediately BEFORE the `write_custody_edges(...)` call (the write supersedes them):

```python
        from sub_samples.custody import current_custody, write_custody_edges
        prev_rider_pids = {
            e.analysis_profile_id
            for e in current_custody(db, sub.id)
            if e.relation == "rider"
        }
```

(replace the existing `from sub_samples.custody import write_custody_edges` line), and add directly AFTER the existing `_drop_stale_role_rows(...)` call:

```python
        _drop_stale_rider_rows(db, sub=sub, prev_rider_pids=prev_rider_pids)
```

- [ ] **Step 4: Run** — `tests/test_rider_seeding.py tests/test_custody_edges.py tests/test_assignment_kind.py tests/test_catalog_bench_acceptance.py -v` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/service.py backend/tests/test_rider_seeding.py
git commit -m "feat(sub-samples): drop pristine rider rows when a role flip loses the rider edge"
```

---

### Task 3: S2a — ride-aware `_host_vials` + rider relation on lab-add/resync edges

**Files:**
- Modify: `backend/lims_analyses/manage_native.py` (`_host_vials` `:107-114`, `_ensure_host_edge` `:170-188`, `add_profile_to_parent` host loop `:237-241`, `resync_parent_from_order` host loop `:487-492`)
- Test: `backend/tests/test_manage_native.py` (append; reuse its `_svc`/`_profile` helpers — read the file's fixture section first)

**Interfaces:**
- Consumes: `profile_ride_hosts` table (models), `_vials_of(db, parent)`.
- Produces: `_host_vials` returns ride-host vials for rider profiles; `_ensure_host_edge(db, *, vial, profile, user_id, relation="host")`. Task 5's chip rendering and the resync heal path depend on these.

- [ ] **Step 1: Append failing tests** to `backend/tests/test_manage_native.py`, following that file's existing fixture idiom (it has `_svc(db, *, keyword, title, origin=...)` and `_profile(db, *, key, name, members, role, ...)` helpers and an existing parent/vial construction pattern — imitate the test around its `host_vials` assertions at ~`:92`). Add `profile_ride_hosts` to the models import. Test bodies:

```python
def _ride(db, profile, hosts):
    from models import profile_ride_hosts
    for i, code in enumerate(hosts):
        db.execute(profile_ride_hosts.insert().values(
            analysis_profile_id=profile.id, host_role_code=code, priority=i))
    db.commit()


def _mk_vial_for(db, parent, seq, role, kind="core"):
    from models import LimsSubSample
    sub = LimsSubSample(
        sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
        parent_sample_pk=parent.id, assignment_role=role, assignment_kind=kind,
        external_lims_uid=f"{parent.sample_id}-S{seq:02d}-uid")
    db.add(sub)
    db.commit()
    return sub


def test_host_vials_resolves_ride_hosts_in_priority_order(db):
    from lims_analyses.manage_native import _host_vials
    svc = _svc(db, keyword="ZMN-RIDER", title="ZMN Rider")
    rider = _profile(db, key="zmn_rider", name="ZMN Rider", members=[svc], role="zmnrider")
    _ride(db, rider, ["zmnfirst", "zmnsecond"])
    parent = _mk_parent(db, "ZMN-P1")          # use this file's existing parent factory name
    second = _mk_vial_for(db, parent, 1, "zmnsecond")
    first = _mk_vial_for(db, parent, 2, "zmnfirst")

    hosts = _host_vials(db, parent, rider)
    assert [v.sample_id for v in hosts] == [first.sample_id]  # priority 0 wins


def test_host_vials_skips_variance_vials_and_falls_back_to_own_role(db):
    from lims_analyses.manage_native import _host_vials
    svc = _svc(db, keyword="ZMN2-RIDER", title="ZMN2 Rider")
    rider = _profile(db, key="zmn2_rider", name="ZMN2 Rider", members=[svc], role="zmn2rider")
    _ride(db, rider, ["zmn2host"])
    parent = _mk_parent(db, "ZMN2-P1")
    _mk_vial_for(db, parent, 1, "zmn2host", kind="variance")   # only a variance host
    own = _mk_vial_for(db, parent, 2, "zmn2rider")             # standalone self-mint vial

    hosts = _host_vials(db, parent, rider)
    assert [v.sample_id for v in hosts] == [own.sample_id]


def test_add_rider_profile_writes_rider_edge_and_seeds_host_vial(db):
    from lims_analyses.manage_native import add_profile_to_parent
    from sub_samples.custody import current_custody
    svc = _svc(db, keyword="ZMN3-RIDER", title="ZMN3 Rider")
    rider = _profile(db, key="zmn3_rider", name="ZMN3 Rider", members=[svc], role="zmn3rider")
    _ride(db, rider, ["zmn3host"])
    parent = _mk_parent(db, "ZMN3-P1")
    host_vial = _mk_vial_for(db, parent, 1, "zmn3host")

    out = add_profile_to_parent(db, parent=parent, profile=rider, user_id=1)
    db.commit()

    assert out["no_host_vial"] is False
    assert [h["vial_id"] for h in out["hosts"]] == [host_vial.sample_id]
    edges = current_custody(db, host_vial.id)
    assert [(e.analysis_profile_id, e.relation) for e in edges] == [(rider.id, "rider")]
    from models import LimsAnalysis
    kws = [r.keyword for r in db.query(LimsAnalysis)
           .filter_by(lims_sub_sample_pk=host_vial.id).all()]
    assert "ZMN3-RIDER" in kws


def test_add_host_profile_still_writes_host_edge(db):
    """Regression pin: the default relation stays 'host' for a profile
    landing on its OWN role's vial."""
    from lims_analyses.manage_native import add_profile_to_parent
    from sub_samples.custody import current_custody
    svc = _svc(db, keyword="ZMN4-OWN", title="ZMN4 Own")
    prof = _profile(db, key="zmn4_own", name="ZMN4 Own", members=[svc], role="zmn4own")
    parent = _mk_parent(db, "ZMN4-P1")
    vial = _mk_vial_for(db, parent, 1, "zmn4own")

    add_profile_to_parent(db, parent=parent, profile=prof, user_id=1)
    db.commit()

    edges = current_custody(db, vial.id)
    assert [(e.analysis_profile_id, e.relation) for e in edges] == [(prof.id, "host")]
```

If this file's parent factory has a different name than `_mk_parent`, use the actual one (read the file; do NOT invent a second parent factory if one exists). If none exists, define `_mk_parent(db, sid)` creating a committed `LimsSample(sample_id=sid, external_lims_uid=f"{sid}-uid")`.

- [ ] **Step 2: Run to verify failure** — `tests/test_manage_native.py -v -k "ride or rider or zmn"`: the two `_host_vials` tests and the rider-add test FAIL; the host-pin test passes.

- [ ] **Step 3: Implement** in `backend/lims_analyses/manage_native.py`:

Replace `_host_vials`:

```python
def _host_vials(db: Session, parent: LimsSample, profile: AnalysisProfile) -> list[LimsSubSample]:
    """Existing vials that would host this profile's work.

    Role-dimension profiles host on their own fulfillment_role. A profile
    with a ride list (profile_ride_hosts) hosts on the FIRST listed role
    (priority order) that has ≥1 existing non-variance vial — mirroring
    resolve_catalog_fulfillment's hosts-before-riders walk; with no live
    ride-host vial it falls back to its own role's vials (the standalone
    self-mint case). Variance replicates never host rider work."""
    if profile.fulfillment_dim != "role" or not profile.fulfillment_role:
        return []
    vials = _vials_of(db, parent)
    ride_codes = db.execute(
        select(profile_ride_hosts.c.host_role_code)
        .where(profile_ride_hosts.c.analysis_profile_id == profile.id)
        .order_by(profile_ride_hosts.c.priority)
    ).scalars().all()
    for host_role in ride_codes:
        hosts = [v for v in vials
                 if v.assignment_role == host_role and v.assignment_kind != "variance"]
        if hosts:
            return hosts
    return [v for v in vials if v.assignment_role == profile.fulfillment_role]
```

(add `profile_ride_hosts` to this module's `models` import).

`_ensure_host_edge` — add the parameter and use it in the `db.add`:

```python
def _ensure_host_edge(db: Session, *, vial: LimsSubSample, profile: AnalysisProfile,
                      user_id: Optional[int], relation: str = "host") -> bool:
```
…and `relation=relation` in the `VialProfileAssignment(...)` constructor. The existing-edge pre-check stays relation-agnostic (never write a second current edge for the same vial+profile pair).

Both call sites (`add_profile_to_parent` and `resync_parent_from_order`) compute the relation from the landing vial:

```python
        relation = "rider" if vial.assignment_role != profile.fulfillment_role else "host"
        edge_created = _ensure_host_edge(db, vial=vial, profile=profile,
                                         user_id=user_id, relation=relation)
```

(in `resync_parent_from_order` the loop variables are `prof`/`vial` — same expression with `prof`).

- [ ] **Step 4: Run** — `tests/test_manage_native.py tests/test_manage_native_routes.py tests/test_native_manage_analyses.py -v` → failure-set unchanged vs baseline (these files may have pre-existing composition failures — diff, don't eyeball).

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/manage_native.py backend/tests/test_manage_native.py
git commit -m "feat(manage-native): ride-aware host vials; lab-added riders get rider edges"
```

---

### Task 4: S2b — vial-plan sections resolve against services ∪ placeholders

**Files:**
- Modify: `backend/sub_samples/service.py` (`compute_vial_plan`, around the `_build_vial_plan_sections` call sites — grep for `_build_vial_plan_sections(` inside `compute_vial_plan`; there may be one in the variance-locked early return AND one at the end — patch every call site inside `compute_vial_plan`)
- Test: `backend/tests/test_rider_seeding.py` (append)

**Interfaces:**
- Consumes: `placeholder_profile_keys(db, parent)` (manage_native, `{profile.key: True}` for live ordered placeholders).
- Produces: sections rider chips include lab-added rider profiles. No schema change.

- [ ] **Step 1: Append failing test** to `backend/tests/test_rider_seeding.py`:

```python
# ─── sections resolve against services ∪ placeholders (S2b) ──────────────────

def test_sections_include_lab_added_rider_via_placeholder_union(db, monkeypatch):
    """A rider profile that exists only as a live 'ordered' parent placeholder
    (lab-added, not in the WP order) renders as a rider chip in the vial-plan
    sections — parity with set_assignment_role's union hook."""
    import sub_samples.service as sub_service
    _stub_seeder(monkeypatch)
    dept = Department(name="ZZ Sec Dept")
    db.add(dept)
    db.flush()
    role = VialRole(code="zzsechost", label="zzsechost", department_id=dept.id,
                    boxable=False, variance_eligible=False, sort_order=900,
                    frozen=False, is_system=False)
    db.add(role)
    db.flush()
    host_svc = _svc(db, "ZZS-HOST")
    rider_svc = _svc(db, "ZZS-RIDER")
    host = AnalysisProfile(key="zzs_host", name="zzs_host", is_addon=True,
                           vials_required=1, fulfillment_role="zzsechost",
                           fulfillment_dim="role", active=True)
    host.analysis_services = [host_svc]
    rider = AnalysisProfile(key="zzs_rider", name="ZZS Rider", is_addon=True,
                            vials_required=0, fulfillment_role="zzsrider",
                            fulfillment_dim="role", active=True)
    rider.analysis_services = [rider_svc]
    db.add_all([host, rider])
    db.flush()
    db.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider.id, host_role_code="zzsechost", priority=0))
    parent = LimsSample(sample_id="ZZS-0001", external_lims_uid="ZZS-0001-uid")
    db.add(parent)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, lims_sub_sample_pk=None,
                        analysis_service_id=rider_svc.id, keyword=rider_svc.keyword,
                        title=rider_svc.title, review_state="unassigned",
                        provenance="ordered"))
    db.commit()
    monkeypatch.setattr("sub_samples.service.fetch_sample_services",
                        lambda sid: {"services": {"zzs_host": True}, "package": None})

    plan = sub_service.compute_vial_plan(db, "ZZS-0001")

    section = next(s for s in plan["sections"] if s["department_name"] == "ZZ Sec Dept")
    spot = next(r for r in section["roles"] if r["code"] == "zzsechost")
    riders = [p for p in spot["profiles"] if p["relation"] == "rider"]
    assert [p["key"] for p in riders] == ["zzs_rider"]
```

Adjust to `compute_vial_plan`'s real return access if it returns a pydantic object rather than a dict (check the function's return statement; if it returns `VialPlanResponse`, use `plan.sections`). Also note `zzsrider` role code for the rider's own role needs a VialRole row only if `resolve_catalog_fulfillment` requires it — it does not (ride resolution attaches the rider to the host role before its own role matters); if the test errors on a missing role row, mint one the same way as `zzsechost` with `department_id=None`.

- [ ] **Step 2: Run to verify failure** — rider chip absent (raw services dict has no `zzs_rider` key).

- [ ] **Step 3: Implement.** In `compute_vial_plan`, after the parent row is loaded (it already reads `parent.catalog_snapshot`), build once:

```python
        # Sections/display parity with set_assignment_role's union hook (spec
        # 2026-08-20-rider-vial-visibility): a lab-added profile living only
        # as a live 'ordered' placeholder must render its chip. Display-only —
        # demand/auto-assign inputs deliberately stay on the raw order dict.
        from lims_analyses.manage_native import placeholder_profile_keys
        services_for_sections = {**(services or {}), **placeholder_profile_keys(db, parent)}
```

and pass `services_for_sections` (instead of `services`) as the `services` argument at every `_build_vial_plan_sections(...)` call inside `compute_vial_plan`. Do NOT touch `derive_base_demand`/`auto_assign`/`set_assignment_role` inputs.

- [ ] **Step 4: Run** — `tests/test_rider_seeding.py tests/test_assignment_kind.py tests/test_container_mode.py tests/test_catalog_snapshot.py tests/test_catalog_bench_acceptance.py -v` → failure-set unchanged vs baseline.

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/service.py backend/tests/test_rider_seeding.py
git commit -m "feat(vial-plan): sections resolve riders against services union placeholders"
```

---

### Task 5: S3 — rider landing in sections payload + RiderChips "→ S01"

**Files:**
- Modify: `backend/sub_samples/service.py` (`_build_vial_plan_sections`)
- Modify: `src/lib/api.ts` (`VialPlanRoleProfile` ~`:6138`)
- Modify: `src/components/intake/ReceiveWizard/AssignStep.tsx` (`RiderChips` ~`:618-638`)
- Test: `backend/tests/test_rider_seeding.py` (append), `src/test/assign-step.test.tsx` (extend)

**Interfaces:**
- Consumes: sections profile dicts from Task 4; live rider edges.
- Produces: rider profile dicts carry `host_vials: list[str]` (vial sample_ids, vial_sequence order); TS `VialPlanRoleProfile.host_vials?: string[]`.

- [ ] **Step 1: Append failing backend test**:

```python
def test_sections_rider_profile_carries_host_vials(db, monkeypatch):
    """The rider chip's landing: sections rider entries name the vial(s)
    holding a live rider edge, in vial_sequence order."""
    from sub_samples.service import _build_vial_plan_sections
    dept = Department(name="ZZ Land Dept")
    db.add(dept)
    db.flush()
    db.add(VialRole(code="zzlhost", label="zzlhost", department_id=dept.id,
                    boxable=False, variance_eligible=False, sort_order=901,
                    frozen=False, is_system=False))
    db.flush()
    host_svc = _svc(db, "ZZL-HOST")
    rider_svc = _svc(db, "ZZL-RIDER")
    host = _profile(db, "zzl_host", "zzlhost", [host_svc], vials=1)
    rider = _profile(db, "zzl_rider", "zzlrider", [rider_svc], rides=["zzlhost"])
    parent, sub = _vial(db, "ZZL-0001", role="zzlhost")
    _rider_edge(db, sub, rider)

    sections = _build_vial_plan_sections(
        db,
        {"zzlhost": 1},
        [{"sample_id": sub.sample_id, "is_parent": False, "vial_sequence": 1,
          "assignment_role": "zzlhost", "assignment_kind": "core"}],
        {"zzl_host": True, "zzl_rider": True},
    )

    section = next(s for s in sections if s["department_name"] == "ZZ Land Dept")
    spot = next(r for r in section["roles"] if r["code"] == "zzlhost")
    rider_entry = next(p for p in spot["profiles"] if p["relation"] == "rider")
    assert rider_entry["host_vials"] == [sub.sample_id]
    host_entry = next(p for p in spot["profiles"] if p["relation"] == "host")
    assert "host_vials" not in host_entry
```

NOTE: `_profile`'s helper (Task 1) creates the VialRole row only when missing — the explicit `zzlhost` row with a department is created first here on purpose, so the section resolves to "ZZ Land Dept".

- [ ] **Step 2: Run to verify failure** — KeyError `host_vials`.

- [ ] **Step 3: Implement backend.** In `_build_vial_plan_sections`, after `profile_by_id` is built, add one batched query:

```python
    # Rider landing (spec 2026-08-20-rider-vial-visibility): which of THIS
    # plan's vials hold a live rider edge, per profile — one query, keyed by
    # profile id. Display metadata only; failures here must never 500 the
    # vial plan, so the shape stays a plain default-empty lookup.
    rider_vials_by_pid: dict = {}
    vial_sample_ids = [v["sample_id"] for v in vials if not v.get("is_parent")]
    if all_ids and vial_sample_ids:
        from models import VialProfileAssignment
        edge_rows = db.execute(
            select(VialProfileAssignment.analysis_profile_id,
                   LimsSubSample.sample_id)
            .join(LimsSubSample,
                  LimsSubSample.id == VialProfileAssignment.lims_sub_sample_pk)
            .where(
                VialProfileAssignment.relation == "rider",
                VialProfileAssignment.superseded_at.is_(None),
                VialProfileAssignment.analysis_profile_id.in_(all_ids),
                LimsSubSample.sample_id.in_(vial_sample_ids),
            )
            .order_by(LimsSubSample.vial_sequence)
        ).all()
        for pid, sid in edge_rows:
            rider_vials_by_pid.setdefault(pid, []).append(sid)
```

and in the rider projection loop change the appended dict to:

```python
            for pid in rf.rider_profile_ids:
                p = profile_by_id.get(pid)
                if p is not None:
                    profiles.append({
                        "id": p.id, "key": p.key, "name": p.name,
                        "relation": "rider",
                        "host_vials": rider_vials_by_pid.get(pid, []),
                    })
```

Host entries stay untouched (no `host_vials` key).

- [ ] **Step 4: Run backend test** → PASS.

- [ ] **Step 5: FE type + failing FE test.** In `src/lib/api.ts`, extend `VialPlanRoleProfile`:

```ts
export interface VialPlanRoleProfile {
  id: number
  key: string
  name: string
  relation: 'host' | 'rider'
  /** rider entries only: vial sample_ids holding a live rider edge (vial_sequence order) */
  host_vials?: string[]
}
```

In `src/test/assign-step.test.tsx`, find the existing rider-chip contract test (fixture `ZZTEST Rider`, `relation: 'rider'`, asserted around `:509-514`) and add a sibling test in the same describe block: clone the fixture's plan response, set `host_vials: ['P-0001-S01']` on the rider profile entry, render, and assert:

```ts
expect(await screen.findByText(/· rider → S01/)).toBeInTheDocument()
```

plus keep the original no-`host_vials` test asserting the plain `· rider` marker still renders unchanged.

- [ ] **Step 6: Run FE test to verify failure** — `npx vitest run src/test/assign-step.test.tsx` → new test FAILS.

- [ ] **Step 7: Implement `RiderChips`** in `AssignStep.tsx` (keep the existing comment block; body becomes):

```tsx
function RiderChips({ profiles }: { profiles: VialPlanRoleProfile[] }) {
  const riders = profiles.filter(p => p.relation === 'rider')
  if (riders.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] uppercase tracking-wide text-muted-foreground mt-1 pl-3">
      {riders.map(r => {
        const landing = (r.host_vials ?? [])
          .map(v => v.split('-').pop())
          .filter(Boolean)
          .join(', ')
        return (
          <span key={r.id} title={(r.host_vials ?? []).join(', ') || undefined}>
            {r.name}
            <span className="ml-1 normal-case">
              · rider{landing ? ` → ${landing}` : ''}
            </span>
          </span>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 8: Run** — `npx vitest run src/test/assign-step.test.tsx src/test/assign-step-acceptance.test.tsx && npx tsc --noEmit` → PASS/clean.

- [ ] **Step 9: Commit**

```bash
git add backend/sub_samples/service.py backend/tests/test_rider_seeding.py src/lib/api.ts src/components/intake/ReceiveWizard/AssignStep.tsx src/test/assign-step.test.tsx
git commit -m "feat(assign): rider chips show their landing vial(s)"
```

---

### Task 6: S4 — vial chips on the native "Accu-Mk1 Analyses" card

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (map construction block ~`:3826-3846`; `NativeParentAnalysesCard` mount — search `<NativeParentAnalysesCard`)
- Test: `src/test/native-parent-analyses.test.tsx` (extend)

**Interfaces:**
- Consumes: `buildVialAssignmentMap(parentAnalyses, vials, analyteNames?)` from `src/lib/vial-assignment.ts` (tier 0 joins on `analysis_service_id`, tier 1 exact keyword — native rows match on both); `listNativeParentAnalysesShaped` + `NATIVE_PARENT_ANALYSES_QUERY_KEY` (both already in `SampleDetails.tsx` scope — the card lives in this file).
- Produces: the card's `vialAssignmentByKeyword` prop gets a map keyed by NATIVE row keywords.

- [ ] **Step 1: Write the failing test.** In `src/test/native-parent-analyses.test.tsx`, find how the existing tests render `NativeParentAnalysesCard` (they mock the shaped-rows query). Add a test that passes a `vialAssignmentByKeyword` prop containing an entry for a native keyword present in the mocked rows:

```tsx
it('renders a clickable assigned-vial chip for a native row', async () => {
  // fixture: shaped rows include keyword 'FENTANYL' (reuse/extend this
  // file's existing row fixture builder)
  const vialMap = new Map([
    ['FENTANYL', {
      editable: true,
      matches: [{
        vialSampleId: 'P-0158-S01',
        vialLabel: 'Vial 1',
        mk1Analysis: { uid: 'mk1:1', keyword: 'FENTANYL', title: 'Fentanyl', review_state: 'unassigned' },
        assignmentRole: 'hplc',
        assignmentKind: 'core',
      }],
    }],
  ])
  renderCard({ vialAssignmentByKeyword: vialMap })   // this file's render helper, prop threaded through
  expect(await screen.findByRole('button', { name: /Vial 1 — P-0158-S01/ })).toBeInTheDocument()
})
```

Adapt fixture/mock/render-helper names to what the file actually uses — read it first; the assertion contract (`button` named `<vialLabel> — <vialSampleId>`) comes from `AnalysisTable.tsx:1514-1533`. Cast the `mk1Analysis` stub through the file's existing analysis-fixture builder if it has one (the chip only reads identity fields). If the file's render helper doesn't accept a `vialAssignmentByKeyword` prop yet, thread it through (default undefined).

- [ ] **Step 2: Run to verify failure** — if the card already forwards the prop to `AnalysisTable` (it does, `SampleDetails.tsx:3483`), this test may PASS immediately. If it passes: good — it pins the card-level contract; note it in the commit message and move on (the real gap is the map construction in SampleDetails, Step 3).

- [ ] **Step 3: Implement the map wiring** in `SampleDetails.tsx`:

3a. Hoist the vial-inputs array that's currently inline in the `buildVialAssignmentMap` call (`:3831-3843`) into a const ABOVE it, and use it in both maps:

```tsx
  const overlayVialInputs = overlayVials.map((v, i) => ({
    sampleId: v.sample_id,
    label: vialLabel(v.vial_sequence, subData?.parent.container_mode ?? false),
    analyses: overlayAnalysesQueries[i]?.data ?? [],
    assignmentRole: v.assignment_role,
    assignmentKind: v.assignment_kind,
    varianceLocked: lockedVialIds.has(v.sample_id),
  }))
```

(the existing SENAITE map call then takes `overlayVialInputs` — behavior identical; keep its surrounding comments.)

3b. Below the existing map, add the native map (react-query dedupes with the card's own identical query):

```tsx
  // Native card chips (spec 2026-08-20-rider-vial-visibility): the SENAITE
  // map above is keyed by SENAITE parent keywords, which never contain
  // native rows — build the native card its own map from ITS rows. Tier 0
  // (analysis_service_id) joins exactly; no analyte bridge needed.
  const { data: nativeShapedRows } = useQuery({
    queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId, 'senaite_shape'],
    queryFn: () => listNativeParentAnalysesShaped(sampleId!),
    enabled: parentSampleId === null && !!sampleId,
    staleTime: 30_000,
  })
  const nativeVialAssignmentByKeyword =
    parentSampleId !== null || !nativeShapedRows?.length
      ? undefined
      : buildVialAssignmentMap(nativeShapedRows, overlayVialInputs)
```

3c. At the `<NativeParentAnalysesCard` mount, change the `vialAssignmentByKeyword` prop value to `{nativeVialAssignmentByKeyword}` (it currently receives the SENAITE-keyed map, which is dead weight for native rows).

- [ ] **Step 4: Run** — `npx vitest run src/test/native-parent-analyses.test.tsx src/test/vial-assignment-service-id.test.ts src/test/vial-assignment-bridge.test.ts && npx tsc --noEmit` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/SampleDetails.tsx src/test/native-parent-analyses.test.tsx
git commit -m "feat(sample-details): native analyses card shows assigned-vial chips pre-promotion"
```

---

### Task 7: Full gates

**Files:** none (verification only).

- [ ] **Step 1: Backend full suite, failure-set diff**

```bash
cd C:/tmp/Accu-Mk1-riders/backend
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > /tmp/rider_after.txt
diff ../.rider_baseline_ids.txt /tmp/rider_after.txt
```
Expected: empty diff.

- [ ] **Step 2: FE battery**

```bash
cd C:/tmp/Accu-Mk1-riders
npx vitest run src/test/assign-step.test.tsx src/test/assign-step-acceptance.test.tsx src/test/native-parent-analyses.test.tsx src/test/native-manage-analyses-block.test.tsx src/test/vial-assignment-service-id.test.ts src/test/vial-assignment-bridge.test.ts src/test/vials-quicklook.test.tsx
npx tsc --noEmit
```
Expected: all green, tsc clean.

- [ ] **Step 3:** `git status` — confirm `.rider_baseline_ids.txt` untracked and tree otherwise clean.

---

### Post-plan (orchestrator, not subagent tasks)

1. Final whole-branch review (fresh reviewer subagent, no pre-judged findings).
2. Merge `feat/rider-vial-visibility` into the arcitest composition at `C:\tmp\Accu-Mk1-arcimerge` (branch `arcitest/methods-merge`), re-run the merged battery, push to the DEVBOX clone only, ff `~/worktrees/mk1-arcitest`, `docker restart accumark-arcitest-accu-mk1-backend`, health check via `:5812`.
3. Live heal + E2E on P-0158: re-PATCH S01's assignment (`PATCH /api/sub-samples/P-0158-S01/assignment` body `{"role":"hplc","kind":"core"}`) → verify a FENTANYL row on vial 1325; native card shows S01/S02 chips; AssignStep shows `Fentanyl Screening · rider → S01`.
4. NEVER push anything to origin — Handler-gated.
