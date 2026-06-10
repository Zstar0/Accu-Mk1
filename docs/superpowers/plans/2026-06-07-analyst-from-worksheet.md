# Analyst from Worksheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp `lims_analyses.analyst_user_id` from worksheet membership (add / analyst-change / remove / reassign), log it in vial activity, and surface the analyst (email) in the senaite-shape serializer so the Analyst column goes live.

**Architecture:** New `backend/lims_analyses/worksheet_analyst.py` service module resolves a `WorksheetItem.sample_uid` → `lims_sub_samples.external_lims_uid` (exact string; parent-AR uids no-op) → that vial's live analyses in the item's service group (via `service_group_members`), and stamps/clears `analyst_user_id`. Four 1-3-line hooks in main.py's worksheet endpoints call it. Spec: `docs/superpowers/specs/2026-06-07-analyst-from-worksheet-design.md`.

**Tech Stack:** FastAPI + SQLAlchemy (backend), pytest in the backend container; one small React change (activity icon/level cases) + vitest/tsc.

**Spec deviation (locked here):** `User` has no display-name column (models.py:16-32) — the analyst is surfaced as the user's **email**, matching the activity log's existing `by <UserTag email>` convention.

**Environment:**
- Repo: `C:/tmp/Accu-Mk1-subvial`, branch `subvial/continue` (push to PR #9 freely).
- Backend tests: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q --tb=short"`.
  If pytest is missing (container was recreated): `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio`.
- Backend TRUE baseline (full suite, flag-off): **13 known failures** — filter with
  `grep -vE 'checkin_times|sample_priorities|clickup_webhook_dispatch|completion_side_effects|test_e2e_peptide_request|test_list_sub_samples_with_children'`; the clickup_task_retry trio bounces 13↔16. Don't chase those.
- FE tests: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/"` (1 known peptide-requests-list flake). FE typecheck baseline: 1 known error (`WorksheetsInboxPage.tsx(356,38)`).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Any new TestClient fixture MUST snapshot/restore `app.dependency_overrides` (the test_api_business_hours lesson).

---

### Task 1: Stamping service module (`worksheet_analyst.py`) — TDD

**Files:**
- Create: `backend/lims_analyses/worksheet_analyst.py`
- Test: `backend/tests/test_worksheet_analyst_stamp.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_worksheet_analyst_stamp.py`. Copy the import/fixture style from `backend/tests/test_subsample_activity.py` (it has `db_session` plus `_make_parent`/`_make_sub` builders — reuse its conftest fixture, don't invent a new harness). IMPORTANT: before finalizing the helpers below, read `backend/models.py` for `AnalysisService`, `ServiceGroup`, and `service_group_members` required columns and adjust the constructor kwargs to satisfy NOT NULLs — the shapes below are the expected minimum.

```python
"""Service-level tests for worksheet→analyst stamping (spec 2026-06-07)."""
from sqlalchemy import insert, select

from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    ServiceGroup,
    User,
    service_group_members,
)
from lims_analyses.worksheet_analyst import (
    clear_for_item,
    restamp_for_worksheet,
    stamp_for_item,
)


def _mk_parent(db, sample_id="P-T-001"):
    p = LimsSample(sample_id=sample_id, external_lims_uid=f"SEN-{sample_id}")
    db.add(p)
    db.flush()
    return p


def _mk_sub(db, parent, sample_id="P-T-001-S01", uid="mk1://sub-1", role="ster"):
    s = LimsSubSample(
        sample_id=sample_id,
        parent_sample_pk=parent.id,
        vial_sequence=1,
        external_lims_uid=uid,
        assignment_role=role,
    )
    db.add(s)
    db.flush()
    return s


def _mk_group(db, name):
    g = ServiceGroup(name=name)
    db.add(g)
    db.flush()
    return g


def _mk_service(db, keyword, title, group=None):
    svc = AnalysisService(keyword=keyword, title=title)
    db.add(svc)
    db.flush()
    if group is not None:
        db.execute(insert(service_group_members).values(
            analysis_service_id=svc.id, service_group_id=group.id,
        ))
    return svc


def _mk_analysis(db, sub, svc, state="unassigned"):
    a = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        review_state=state,
    )
    db.add(a)
    db.flush()
    return a


def _mk_user(db, email):
    u = User(email=email, hashed_password="x")
    db.add(u)
    db.flush()
    return u


def _events(db, sub):
    return db.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).all()


def test_stamp_matching_group_only(db_session):
    """HPLC analyses on a ster vial (the P-0142-S02 shape): an Analytics-group
    item stamps only Analytics analyses; Microbiology rows untouched."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    analytics = _mk_group(db_session, "Analytics")
    micro = _mk_group(db_session, "Microbiology")
    svc_hplc = _mk_service(db_session, "HPLC-PUR", "Peptide Purity (HPLC)", analytics)
    svc_ster = _mk_service(db_session, "STER-PCR", "Rapid Sterility (PCR)", micro)
    a_hplc = _mk_analysis(db_session, sub, svc_hplc)
    a_ster = _mk_analysis(db_session, sub, svc_ster)
    tech = _mk_user(db_session, "tech@lab.test")
    actor = _mk_user(db_session, "lead@lab.test")

    n = stamp_for_item(
        db_session,
        sample_uid="mk1://sub-1",
        service_group_id=analytics.id,
        analyst_user_id=tech.id,
        acting_user_id=actor.id,
        worksheet_id=7,
        worksheet_title="HPLC Bench A",
    )

    assert n == 1
    db_session.refresh(a_hplc); db_session.refresh(a_ster)
    assert a_hplc.analyst_user_id == tech.id
    assert a_ster.analyst_user_id is None
    evs = _events(db_session, sub)
    assert len(evs) == 1
    ev = evs[0]
    assert ev.event == "worksheet_assigned"
    assert ev.user_id == actor.id
    assert ev.details["worksheet_id"] == 7
    assert ev.details["analyst_email"] == "tech@lab.test"
    assert ev.details["keywords"] == ["HPLC-PUR"]


def test_stamp_null_group_stamps_all_live(db_session):
    """Item with service_group_id None stamps all live analyses on the vial."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a1 = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    a2 = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2", None))
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session, sample_uid="mk1://sub-1", service_group_id=None,
        analyst_user_id=tech.id, acting_user_id=None, worksheet_id=1,
    )
    assert n == 2
    db_session.refresh(a1); db_session.refresh(a2)
    assert a1.analyst_user_id == tech.id and a2.analyst_user_id == tech.id


def test_dead_states_never_stamped(db_session):
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    svc = _mk_service(db_session, "K1", "T1", g)
    dead = _mk_analysis(db_session, sub, svc, state="retracted")
    tech = _mk_user(db_session, "tech@lab.test")

    n = stamp_for_item(
        db_session, sample_uid="mk1://sub-1", service_group_id=g.id,
        analyst_user_id=tech.id, acting_user_id=None, worksheet_id=1,
    )
    assert n == 0
    db_session.refresh(dead)
    assert dead.analyst_user_id is None
    # the add still happened — event recorded with empty keywords
    assert _events(db_session, sub)[0].details["keywords"] == []


def test_parent_ar_uid_noops(db_session):
    """A SENAITE parent-AR uid matches no lims_sub_samples row → no-op, no event."""
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    n = stamp_for_item(
        db_session, sample_uid="SEN-P-T-001", service_group_id=None,
        analyst_user_id=None, acting_user_id=None, worksheet_id=1,
    )
    assert n == 0
    assert _events(db_session, sub) == []


def test_clear_for_item(db_session):
    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    tech = _mk_user(db_session, "tech@lab.test")
    a.analyst_user_id = tech.id
    db_session.flush()

    n = clear_for_item(
        db_session, sample_uid="mk1://sub-1", service_group_id=g.id,
        acting_user_id=tech.id, worksheet_id=3,
    )
    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id is None
    evs = _events(db_session, sub)
    assert evs[-1].event == "worksheet_removed"
    assert evs[-1].details["worksheet_id"] == 3


def test_restamp_emits_changed_only_when_values_change(db_session):
    """restamp updates rows + emits worksheet_analyst_changed per affected vial;
    re-running with the same analyst is a no-op (no duplicate events)."""
    from models import Worksheet, WorksheetItem

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    old = _mk_user(db_session, "old@lab.test")
    new = _mk_user(db_session, "new@lab.test")
    a.analyst_user_id = old.id

    ws = Worksheet(title="Bench", assigned_analyst_id=new.id)
    db_session.add(ws); db_session.flush()
    db_session.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid="mk1://sub-1", sample_id=sub.sample_id,
        service_group_id=g.id,
    ))
    db_session.flush()

    n = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=new.id)
    assert n == 1
    db_session.refresh(a)
    assert a.analyst_user_id == new.id
    evs = [e for e in _events(db_session, sub) if e.event == "worksheet_analyst_changed"]
    assert len(evs) == 1
    assert evs[0].details["from_email"] == "old@lab.test"
    assert evs[0].details["to_email"] == "new@lab.test"

    # idempotent re-run: values unchanged → no new event
    n2 = restamp_for_worksheet(db_session, worksheet=ws, acting_user_id=new.id)
    assert n2 == 0
    evs2 = [e for e in _events(db_session, sub) if e.event == "worksheet_analyst_changed"]
    assert len(evs2) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py -q --tb=short"`
Expected: FAIL — `ModuleNotFoundError: lims_analyses.worksheet_analyst` (collection error counts). If instead constructors fail on NOT NULL columns, fix the helper kwargs against models.py and re-run until the only failure is the missing module.

- [ ] **Step 3: Implement the module**

Create `backend/lims_analyses/worksheet_analyst.py`:

```python
"""Worksheet → analyst stamping for vial-tier lims_analyses rows.

Spec: docs/superpowers/specs/2026-06-07-analyst-from-worksheet-design.md
The analyst column FOLLOWS worksheet membership: stamp on add, re-stamp when the
worksheet's effective analyst changes, clear on removal. Resolution is by exact
string match WorksheetItem.sample_uid == lims_sub_samples.external_lims_uid —
covers mk1:// native vials and legacy SENAITE-uid vials; a parent AR uid matches
nothing and the call no-ops (parent-tier attribution stays in SENAITE).
"""
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSubSample,
    LimsSubSampleEvent,
    User,
    Worksheet,
    WorksheetItem,
    service_group_members,
)

_DEAD_STATES = ("retracted", "rejected")


def _resolve(
    db: Session, *, sample_uid: str, service_group_id: Optional[int]
) -> Tuple[Optional[LimsSubSample], List[LimsAnalysis]]:
    """Vial + its live analyses in the given group (all live when group is None)."""
    sub = db.execute(
        select(LimsSubSample).where(LimsSubSample.external_lims_uid == sample_uid)
    ).scalar_one_or_none()
    if sub is None:
        return None, []
    q = (
        select(LimsAnalysis)
        .where(LimsAnalysis.lims_sub_sample_pk == sub.id)
        .where(LimsAnalysis.review_state.not_in(_DEAD_STATES))
    )
    if service_group_id is not None:
        q = (
            q.join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
            .join(
                service_group_members,
                service_group_members.c.analysis_service_id == AnalysisService.id,
            )
            .where(service_group_members.c.service_group_id == service_group_id)
        )
    return sub, list(db.execute(q).scalars().all())


def _email(db: Session, user_id: Optional[int]) -> Optional[str]:
    if not user_id:
        return None
    u = db.get(User, user_id)
    return u.email if u else None


def _emit(db, sub_pk: int, event: str, details: dict, user_id: Optional[int]) -> None:
    db.add(LimsSubSampleEvent(
        sub_sample_pk=sub_pk, event=event, details=details, user_id=user_id,
    ))


def stamp_for_item(
    db: Session,
    *,
    sample_uid: str,
    service_group_id: Optional[int],
    analyst_user_id: Optional[int],
    acting_user_id: Optional[int],
    worksheet_id: int,
    worksheet_title: Optional[str] = None,
) -> int:
    """Stamp on add-to-worksheet. Always emits worksheet_assigned when the uid
    resolves to a vial (the add itself is the event), even if no analysis row
    changed value (e.g. analyst unassigned, or no live analyses in the group).
    Returns the number of analysis rows whose analyst changed."""
    sub, rows = _resolve(db, sample_uid=sample_uid, service_group_id=service_group_id)
    if sub is None:
        return 0
    changed = [r for r in rows if r.analyst_user_id != analyst_user_id]
    for r in changed:
        r.analyst_user_id = analyst_user_id
    _emit(db, sub.id, "worksheet_assigned", {
        "worksheet_id": worksheet_id,
        "worksheet_title": worksheet_title,
        "analyst_email": _email(db, analyst_user_id),
        "keywords": sorted(r.keyword for r in changed),
    }, acting_user_id)
    return len(changed)


def clear_for_item(
    db: Session,
    *,
    sample_uid: str,
    service_group_id: Optional[int],
    acting_user_id: Optional[int],
    worksheet_id: int,
    worksheet_title: Optional[str] = None,
) -> int:
    """Clear on removal from a worksheet. Emits worksheet_removed when the uid
    resolves to a vial. Returns the number of rows cleared."""
    sub, rows = _resolve(db, sample_uid=sample_uid, service_group_id=service_group_id)
    if sub is None:
        return 0
    changed = [r for r in rows if r.analyst_user_id is not None]
    for r in changed:
        r.analyst_user_id = None
    _emit(db, sub.id, "worksheet_removed", {
        "worksheet_id": worksheet_id,
        "worksheet_title": worksheet_title,
        "keywords": sorted(r.keyword for r in changed),
    }, acting_user_id)
    return len(changed)


def restamp_for_worksheet(
    db: Session, *, worksheet: Worksheet, acting_user_id: Optional[int]
) -> int:
    """Re-stamp every vial item on a worksheet with its current effective
    analyst (worksheet-level wins, else the item's). Emits ONE
    worksheet_analyst_changed event per vial whose rows actually changed —
    idempotent: re-running with the same analyst emits nothing.
    Returns total analysis rows changed."""
    items = db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet.id)
    ).scalars().all()
    total = 0
    for item in items:
        effective = worksheet.assigned_analyst_id or item.assigned_analyst_id
        sub, rows = _resolve(
            db, sample_uid=item.sample_uid, service_group_id=item.service_group_id
        )
        if sub is None:
            continue
        changed = [r for r in rows if r.analyst_user_id != effective]
        if not changed:
            continue
        # from_email: attribution before this restamp (rows agree in practice;
        # take the first changed row's prior analyst as the representative).
        from_email = _email(db, changed[0].analyst_user_id)
        for r in changed:
            r.analyst_user_id = effective
        _emit(db, sub.id, "worksheet_analyst_changed", {
            "worksheet_id": worksheet.id,
            "worksheet_title": worksheet.title,
            "from_email": from_email,
            "to_email": _email(db, effective),
            "keywords": sorted(r.keyword for r in changed),
        }, acting_user_id)
        total += len(changed)
    return total
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py -q --tb=short"`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/worksheet_analyst.py backend/tests/test_worksheet_analyst_stamp.py
git commit -m "feat(be): worksheet->analyst stamping service for vial analyses

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Serializer surfaces analyst email — TDD

**Files:**
- Modify: `backend/lims_analyses/service.py` (`list_analyses_in_senaite_shape`, ~line 893; the hardcoded `analyst=None` at ~line 1000)
- Test: `backend/tests/test_worksheet_analyst_stamp.py` (append)

- [ ] **Step 1: Write the failing test (append to the Task 1 file)**

```python
def test_senaite_shape_surfaces_analyst_email(db_session):
    """Serializer returns the analyst's email for stamped rows, None otherwise."""
    from lims_analyses.service import list_analyses_in_senaite_shape

    parent = _mk_parent(db_session)
    sub = _mk_sub(db_session, parent)
    g = _mk_group(db_session, "Analytics")
    a1 = _mk_analysis(db_session, sub, _mk_service(db_session, "K1", "T1", g))
    a2 = _mk_analysis(db_session, sub, _mk_service(db_session, "K2", "T2", g))
    tech = _mk_user(db_session, "tech@lab.test")
    a1.analyst_user_id = tech.id
    db_session.flush()

    shaped = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id
    )
    by_kw = {s.keyword: s for s in shaped}
    assert by_kw["K1"].analyst == "tech@lab.test"
    assert by_kw["K2"].analyst is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py::test_senaite_shape_surfaces_analyst_email -q --tb=short"`
Expected: FAIL — `assert None == 'tech@lab.test'`.

- [ ] **Step 3: Implement**

In `backend/lims_analyses/service.py`, inside `list_analyses_in_senaite_shape`:

1. Extend the bulk-load section (after the instruments load, ~line 959) with:

```python
    # Analyst display: User has no name column — surface the email (matches
    # the activity log's by-<email> convention).
    from models import User
    analyst_ids = {r.analyst_user_id for r in rows if r.analyst_user_id}
    analyst_email_by_id = {}
    if analyst_ids:
        analyst_email_by_id = {
            u.id: u.email
            for u in db.execute(select(User).where(User.id.in_(analyst_ids))).scalars()
        }
```

2. Replace the hardcoded line `analyst=None,` (~line 1000) with:

```python
            analyst=analyst_email_by_id.get(r.analyst_user_id),
```

Also update the function docstring's stale sentence if it still claims analyst is unsupported.

- [ ] **Step 4: Run the file's tests + the adjacent senaite-shape suite**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py tests/test_senaite_shape_result_type.py -q --tb=short"`
Expected: all pass (7 in the new file + the existing senaite-shape suite green).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/lims_analyses/service.py backend/tests/test_worksheet_analyst_stamp.py
git commit -m "feat(be): senaite-shape serializer surfaces analyst email

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Hook the four worksheet endpoints

**Files:**
- Modify: `backend/main.py` — four handlers: `add_group_to_worksheet` (~14378), `update_worksheet` (~14327), `remove_worksheet_item` (~14565), `reassign_worksheet_item` (~14614). Line numbers drift — search by handler name.

All hooks run in the host endpoint's existing transaction (before its `db.commit()`).

- [ ] **Step 1: add_group_to_worksheet — stamp after the item is created**

Locate the end of the handler where `item = WorksheetItem(...)` then `db.add(item)`. Immediately AFTER `db.add(item)` (and before the handler's commit), insert:

```python
    # Analyst-from-worksheet (spec 2026-06-07): stamp vial-tier analyses.
    # No-ops for parent-AR uids (resolver matches lims_sub_samples only).
    from lims_analyses.worksheet_analyst import stamp_for_item
    stamp_for_item(
        db,
        sample_uid=data.sample_uid,
        service_group_id=data.service_group_id,
        analyst_user_id=analyst_id,
        acting_user_id=getattr(_current_user, "id", None),
        worksheet_id=worksheet_id,
        worksheet_title=ws.title,
    )
```

(`analyst_id` and `ws` are already in scope — the handler computes effective analyst as `ws.assigned_analyst_id`, else the staging item's.)

- [ ] **Step 2: update_worksheet — restamp on analyst change**

Inside the `if data.assigned_analyst is not None:` block (which already cascades the analyst onto every `WorksheetItem`), AFTER the existing `for item in items:` loop, insert:

```python
        # Analyst-from-worksheet: re-stamp vial-tier analyses to the new analyst.
        from lims_analyses.worksheet_analyst import restamp_for_worksheet
        restamp_for_worksheet(
            db, worksheet=ws, acting_user_id=getattr(_current_user, "id", None)
        )
```

- [ ] **Step 3: remove_worksheet_item — clear before delete**

After the `if not item: raise HTTPException(404, ...)` guard and BEFORE `db.delete(item)`, insert:

```python
    # Analyst-from-worksheet: clear vial-tier stamps; analysis returns to inbox.
    from lims_analyses.worksheet_analyst import clear_for_item
    clear_for_item(
        db,
        sample_uid=sample_uid,
        service_group_id=gid,
        acting_user_id=getattr(_current_user, "id", None),
        worksheet_id=worksheet_id,
    )
```

- [ ] **Step 4: reassign_worksheet_item — remove+add semantics**

After the `target` 404 guard and around the existing `item.worksheet_id = data.target_worksheet_id`, replace that single line with:

```python
    # Analyst-from-worksheet: reassign = remove from source + add to target.
    from lims_analyses.worksheet_analyst import clear_for_item, stamp_for_item
    acting_id = getattr(_current_user, "id", None)
    clear_for_item(
        db, sample_uid=sample_uid, service_group_id=gid,
        acting_user_id=acting_id, worksheet_id=worksheet_id,
    )
    item.worksheet_id = data.target_worksheet_id
    # Target's worksheet-level analyst wins; else keep the item's own.
    if target.assigned_analyst_id:
        item.assigned_analyst_id = target.assigned_analyst_id
    stamp_for_item(
        db, sample_uid=sample_uid, service_group_id=gid,
        analyst_user_id=target.assigned_analyst_id or item.assigned_analyst_id,
        acting_user_id=acting_id,
        worksheet_id=target.id, worksheet_title=target.title,
    )
```

- [ ] **Step 4b: delete_worksheet — clear all items' stamps**

`delete_worksheet` (`main.py:~14543`) bulk-deletes items ("analyses return to inbox") — mirror remove semantics. BEFORE the bulk `WorksheetItem.__table__.delete()`, insert:

```python
    # Analyst-from-worksheet: deleting a worksheet returns analyses to the
    # inbox — clear their stamps, like per-item removal.
    from lims_analyses.worksheet_analyst import clear_for_item
    acting_id = getattr(_current_user, "id", None)
    ws_items = db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet_id)
    ).scalars().all()
    for ws_item in ws_items:
        clear_for_item(
            db, sample_uid=ws_item.sample_uid,
            service_group_id=ws_item.service_group_id,
            acting_user_id=acting_id, worksheet_id=worksheet_id,
            worksheet_title=ws.title,
        )
```

**`complete_worksheet` (~14596) intentionally does NOT clear** — a completed worksheet is finished work; the analyst stays as the person who did it (lock this rationale in a one-line comment at the complete handler ONLY if you touch it; otherwise leave the handler alone).

- [ ] **Step 5: Endpoint smoke test (append to the test file)**

The four hooks are thin; one endpoint-level test proves the wiring imports/executes. Check `backend/tests/` for an existing worksheet TestClient pattern first (`grep -rl "worksheets" backend/tests/`); if one exists, copy its client/auth fixture (snapshot/restore `app.dependency_overrides`!). If none exists, test the wiring at the function level instead — call the handler's stamping path by invoking `stamp_for_item` with the exact arguments the hook passes (already covered by Task 1) and add ONLY this regression lock:

```python
def test_hooks_import(db_session):
    """The main.py hooks import the module lazily — lock the import path."""
    from lims_analyses.worksheet_analyst import (  # noqa: F401
        clear_for_item,
        restamp_for_worksheet,
        stamp_for_item,
    )
```

(If a TestClient pattern exists, replace this with a real POST → assert `lims_analyses.analyst_user_id` updated and one `worksheet_assigned` event row.)

- [ ] **Step 6: Run the new file + backend baseline**

Run: `MSYS_NO_PATHCONV=1 docker exec -e SUBSAMPLE_NATIVE_CREATE=0 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheet_analyst_stamp.py -q --tb=short"` → all pass.
Run the FULL backend suite and compare against the 13-known-failure baseline (filter list in the Environment section). No NEW failures.

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/main.py backend/tests/test_worksheet_analyst_stamp.py
git commit -m "feat(be): worksheet endpoints stamp/clear/restamp vial analyst (incl. delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Activity rendering — backend labels + FE icon/level cases

**Files:**
- Modify: `backend/main.py` — the vial activity aggregation `elif` chain (~line 1075, inside the `lims_sub_sample_events` Section B loop)
- Modify: `src/components/senaite/SampleActivityLog.tsx` — `eventToLevel` (~line 35) and `eventIcon` (~line 60) switches

- [ ] **Step 1: Backend labels**

In the Section B event loop in `backend/main.py`, the chain currently ends:

```python
            elif se.event == "analysis_removed":
                d = se.details or {}
                label = f"Analysis removed: {d.get('keyword', '?')}"
            else:
                label = se.event
```

Insert BEFORE the `else`:

```python
            elif se.event == "worksheet_assigned":
                d = se.details or {}
                ws_label = d.get("worksheet_title") or f"#{d.get('worksheet_id')}"
                analyst = d.get("analyst_email") or "unassigned"
                label = f"Added to worksheet {ws_label} — analyst {analyst}"
            elif se.event == "worksheet_removed":
                d = se.details or {}
                ws_label = d.get("worksheet_title") or f"#{d.get('worksheet_id')}"
                label = f"Removed from worksheet {ws_label}"
            elif se.event == "worksheet_analyst_changed":
                d = se.details or {}
                label = (
                    f"Worksheet analyst: {d.get('from_email') or '—'} → "
                    f"{d.get('to_email') or '—'}"
                )
```

- [ ] **Step 2: FE cases**

In `src/components/senaite/SampleActivityLog.tsx`:

`eventToLevel` — add alongside the existing vial-event cases:

```typescript
    case 'worksheet_assigned':        return 'info'
    case 'worksheet_removed':         return 'warn'
    case 'worksheet_analyst_changed': return 'accent'
```

`eventIcon` — add:

```typescript
    case 'worksheet_assigned':        return '+'
    case 'worksheet_removed':         return '−' // −
    case 'worksheet_analyst_changed': return '◈' // ◈
```

(The detail renderer's `default` branch already prints `by <UserTag>` from `details.by` — no further FE change.)

- [ ] **Step 3: Backend label test (append to the test file)**

The aggregation runs inside the big activity endpoint — test the label branch via the event rows directly is impractical without TestClient; instead lock the LABELS in a focused unit if the activity endpoint has an existing test (check `tests/test_subsample_activity.py` — it tests the endpoint with a client or service?). If `test_subsample_activity.py` exercises the activity ENDPOINT, append one test there following its pattern: create a `worksheet_assigned` event row via `stamp_for_item`, hit the activity endpoint, assert an event with `event == "worksheet_assigned"` and a label starting with `"Added to worksheet"`. If it only tests writers, add the writer-side assertions only (already covered in Task 1) and note the label branch is exercised in UAT.

- [ ] **Step 4: Run FE checks**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/"` → known flake only.
Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"` → only `WorksheetsInboxPage.tsx(356,38)`.
Run backend: `... python -m pytest tests/test_worksheet_analyst_stamp.py tests/test_subsample_activity.py -q --tb=short` → all pass.

- [ ] **Step 5: Commit and push**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/main.py src/components/senaite/SampleActivityLog.tsx backend/tests/
git commit -m "feat: worksheet analyst events in vial activity (labels + icons)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

### Task 5: Live UAT on the subvial stack (user-driven)

No code. Backend hooks need a backend restart to pick up main.py changes (uvicorn `--reload` should hot-reload; if not: `docker restart accumark-subvial-accu-mk1-backend`, then re-`pip install pytest` if testing again).

1. Worksheets Inbox (`http://localhost:5532` → HPLC Automation → Inbox): untick **hide test orders** → P-0142 family appears (parent + S01/S02/S03).
2. Drag/add `P-0142-S02` (the ster vial carrying HPLC analyses) to an HPLC worksheet with an assigned analyst → open P-0142-S02's sample page → Analyst column shows the analyst's email on `HPLC-ID`/`HPLC-PUR` only (STER-PCR stays —). Quick-look dialog shows the same.
3. Activity log on the vial: "Added to worksheet … — analyst …" with `by @user`.
4. Change the worksheet's analyst → vial page Analyst column updates; activity shows "Worksheet analyst: old → new".
5. Remove the item from the worksheet → Analyst back to "—"; activity shows "Removed from worksheet …".
6. Add the PARENT (P-0142) to a worksheet → no errors, no analyst change on vial rows (parent no-op path).
