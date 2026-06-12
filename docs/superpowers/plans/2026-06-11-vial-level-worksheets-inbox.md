# Vial-Level Worksheets Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Container-mode parents stop appearing as worksheet-addable inbox rows; their Mk1-native vials become first-class rows (uid = the vial's existing `mk1://…` `external_lims_uid`), with family-grouped rendering and whole-family drag.

**Architecture:** Additive changes inside `GET /worksheets/inbox` (a new emission helper + a suppress-parent branch in the step-7 loop), a parent-id resolver in front of `_notify_worksheet_assigned`, and an FE family-grouping layer (pure helpers + one new component) over the existing dnd-kit drag pipeline. No schema changes.

**Tech Stack:** FastAPI + SQLAlchemy (backend/main.py), psycopg (mk1_db sample_preps), React + dnd-kit + TanStack Query (FE), pytest (sqlite in-memory), vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-vial-level-worksheets-inbox-design.md`

**Plan-time corrections to the spec** (verified in code):
- Native vials already have a NOT NULL UNIQUE `external_lims_uid` of the form `mk1://{uuid4.hex}` (`backend/sub_samples/native.py`). Use it as the inbox/worksheet uid — do NOT synthesize `mk1-sub-{pk}`.
- `stamp_for_item` already resolves by exact `external_lims_uid` match (`backend/lims_analyses/worksheet_analyst.py:38`) — **no change needed**.
- `POST /worksheets` (bulk + SENAITE stale guard) has **no FE callers** (`CreateWorksheetDialog`/`useCreateWorksheetMutation` are dead code). Leave its guard untouched (fails closed for `mk1://` uids); only its notify call gets the parent-id resolver.
- IS `/explorer/worksheet-assigned` (`integration-service/app/api/desktop.py:2240`) matches `sample_status_events.sample_id` or `sample_results[*].senaite_id` — **parent IDs only**. Vial IDs return `no_order_found` today; resolver fixes this for all vial-shaped items.

**Worktree:** `C:/tmp/Accu-Mk1-subvial`, branch `subvial/continue`.
**Backend venv python:** `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe` (worktree has no venv).
**Do NOT run bare `pytest tests/`** — untracked `tests/test_coa_gate.py` has a syntax error; always name test files explicitly.

---

### Task 1: Backend — native-vial inbox emission helper (TDD)

**Files:**
- Modify: `backend/main.py` (near `_fetch_mk1_inbox_analyses_for_sub_sample`, ~line 13736)
- Test: `backend/tests/test_inbox_native_vials.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_inbox_native_vials.py`:

```python
"""Unit tests for the native-vial inbox emission helper.

Container-mode parents are suppressed from /worksheets/inbox in favor of
their Mk1-native vials (spec 2026-06-11-vial-level-worksheets-inbox-design).
_build_native_vial_inbox_items mirrors the SENAITE loop's per-vial filters:
role, open-worksheet claims, prepped, no-analyses-left. Pure service-level
tests on in-memory sqlite — no SENAITE, no TestClient.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from main import _build_native_vial_inbox_items
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    SamplePriority,
    ServiceGroup,
    service_group_members,
)


PARENT_ITEM = {
    "title": "BPC-157 10mg",
    "getClientTitle": "Acme Peptides",
    "getClientOrderNumber": "WP-555",
    "getDateReceived": "2026-06-10T15:00:00+00:00",
    "review_state": "sample_received",
}


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
def family(db):
    """Container parent + 3 native vials (2 hplc, 1 endo), each with one
    live analysis. Returns (parent, [sub1, sub2, sub3])."""
    grp = ServiceGroup(name="Analytics", color="sky")
    db.add(grp)
    svc = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR")
    db.add(svc)
    db.flush()
    db.execute(service_group_members.insert().values(
        analysis_service_id=svc.id, service_group_id=grp.id,
    ))
    parent = LimsSample(
        sample_id="P-0300",
        external_lims_uid="senaite-uid-p0300",
        container_mode=True,
    )
    db.add(parent)
    db.flush()
    subs = []
    for seq, role in ((1, "hplc"), (2, "hplc"), (3, "endo")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=f"mk1://nat-{seq:03d}",
            sample_id=f"P-0300-S{seq:02d}",
            vial_sequence=seq,
            assignment_role=role,
        )
        db.add(sub)
        db.flush()
        db.add(LimsAnalysis(
            lims_sub_sample_pk=sub.id,
            analysis_service_id=svc.id,
            keyword="HPLC-PUR",
            title="Peptide Purity (HPLC)",
            review_state="unassigned",
        ))
        subs.append(sub)
    db.commit()
    return parent, subs


def _call(db, subs, **overrides):
    kwargs = dict(
        parent_item=PARENT_ITEM,
        parent_sample_id="P-0300",
        native_subs=subs,
        family_size=3,
        allowed_vial_roles={"hplc"},
        assigned_pairs=set(),
        assigned_uids_for_null_group=set(),
        hide_prepped=True,
        prepped_sub_pks=set(),
        prepped_senaite_ids=set(),
        priority_map={},
        order_priority=None,
        assignment_map={},
        keyword_to_peptide={},
    )
    kwargs.update(overrides)
    return _build_native_vial_inbox_items(db, **kwargs)


def test_emits_one_row_per_role_matching_native_vial(db, family):
    _parent, subs = family
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S01", "P-0300-S02"]
    first = items[0]
    assert first.uid == "mk1://nat-001"          # the vial's external_lims_uid
    assert first.is_parent is False
    assert first.parent_sample_id == "P-0300"
    assert first.container_mode is True
    assert first.vial_total == 3
    assert first.client_id == "Acme Peptides"
    assert first.analyses and first.analyses[0].keyword == "HPLC-PUR"


def test_role_filter_micro(db, family):
    _parent, subs = family
    items = _call(db, subs, allowed_vial_roles={"ster", "endo"})
    assert [i.sample_id for i in items] == ["P-0300-S03"]


def test_claimed_vial_group_drops_analysis_and_row(db, family):
    """A vial whose only analysis-group is already on an open worksheet
    disappears (mirrors the SENAITE loop's assigned_pairs filter)."""
    _parent, subs = family
    grp_id = db.execute(select(ServiceGroup.id)).scalar_one()
    items = _call(db, subs, assigned_pairs={("mk1://nat-001", grp_id)})
    assert [i.sample_id for i in items] == ["P-0300-S02"]


def test_fully_claimed_uid_skipped(db, family):
    _parent, subs = family
    items = _call(db, subs, assigned_uids_for_null_group={"mk1://nat-002"})
    assert [i.sample_id for i in items] == ["P-0300-S01"]


def test_prepped_vial_hidden_by_pk_and_by_sample_id(db, family):
    _parent, subs = family
    items = _call(db, subs, prepped_sub_pks={subs[0].id})
    assert [i.sample_id for i in items] == ["P-0300-S02"]
    items = _call(db, subs, prepped_senaite_ids={"P-0300-S02"})
    assert [i.sample_id for i in items] == ["P-0300-S01"]
    # hide_prepped=False shows both
    items = _call(db, subs, prepped_sub_pks={subs[0].id}, hide_prepped=False)
    assert len(items) == 2


def test_vial_without_live_analyses_hidden(db, family):
    _parent, subs = family
    db.execute(
        LimsAnalysis.__table__.update()
        .where(LimsAnalysis.lims_sub_sample_pk == subs[0].id)
        .values(review_state="retracted")
    )
    db.commit()
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S02"]


def test_order_priority_inherited_and_persisted(db, family):
    """Order-level priority (WP payload) flows onto native vials exactly like
    step 4b does for parents: persisted to sample_priorities so it survives
    reloads and is read by the worksheet add endpoints."""
    _parent, subs = family
    items = _call(db, subs, order_priority="expedited")
    assert all(i.priority == "expedited" for i in items)
    persisted = db.execute(
        select(SamplePriority).where(SamplePriority.sample_uid == "mk1://nat-001")
    ).scalar_one()
    assert persisted.priority == "expedited"
    # Manual override wins over order priority
    items = _call(db, subs, order_priority="expedited",
                  priority_map={"mk1://nat-001": "normal"})
    assert items[0].priority == "normal"


def test_date_received_prefers_vial_own_timestamp(db, family):
    _parent, subs = family
    items = _call(db, subs)
    # received_at default=utcnow was set on insert — vial's own date wins
    assert items[0].date_received is not None
    assert items[0].date_received != PARENT_ITEM["getDateReceived"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_inbox_native_vials.py -q
```

Expected: ImportError — `_build_native_vial_inbox_items` not defined.

- [ ] **Step 3: Implement the helper**

In `backend/main.py`, immediately after `_fetch_mk1_inbox_analyses_for_sub_sample` (ends ~line 13735), add:

```python
def _build_native_vial_inbox_items(
    db: Session,
    *,
    parent_item: dict,
    parent_sample_id: str,
    native_subs: list,
    family_size: int,
    allowed_vial_roles: set,
    assigned_pairs: set,
    assigned_uids_for_null_group: set,
    hide_prepped: bool,
    prepped_sub_pks: set,
    prepped_senaite_ids: set,
    priority_map: dict,
    order_priority: Optional[str],
    assignment_map: dict,
    keyword_to_peptide: dict,
) -> "list[InboxVialItem]":
    """Inbox rows for the Mk1-native vials of one container-mode family.

    Called when a container parent is suppressed in favor of its vials
    (spec 2026-06-11-vial-level-worksheets-inbox-design.md). Mirrors the
    per-vial filters of the SENAITE loop in get_worksheets_inbox: role,
    open-worksheet claims, prepped, and no-analyses-left. Row identity is
    the vial's own external_lims_uid (mk1://…) — already what
    worksheet_analyst.stamp_for_item resolves and unique per vial.

    Order-level priority persists to sample_priorities exactly like step 4b
    does for parents, so the worksheet add endpoints (which read
    SamplePriority by uid) see it too.
    """
    out: list[InboxVialItem] = []
    priorities_dirty = False
    for sub in native_subs:
        uid = sub.external_lims_uid
        role = sub.assignment_role
        if role not in allowed_vial_roles:
            continue
        if uid in assigned_uids_for_null_group:
            continue
        if hide_prepped and (
            sub.id in prepped_sub_pks or sub.sample_id in prepped_senaite_ids
        ):
            continue

        analyses = _fetch_mk1_inbox_analyses_for_sub_sample(
            db, sub.id, role, keyword_to_peptide,
        )
        analyses = [a for a in analyses if (uid, a.group_id) not in assigned_pairs]
        if not analyses:
            continue
        analyses.sort(key=lambda a: (a.group_name.lower(), a.title.lower()))

        prio = priority_map.get(uid)
        if prio is None and order_priority in ("high", "expedited"):
            existing = db.execute(
                select(SamplePriority).where(SamplePriority.sample_uid == uid)
            ).scalar_one_or_none()
            if existing is None:
                db.add(SamplePriority(sample_uid=uid, priority=order_priority))
                priorities_dirty = True
            elif existing.priority == "normal":
                existing.priority = order_priority
                priorities_dirty = True
            prio = order_priority

        unique_groups = {a.group_id for a in analyses}
        assigned_count = 0
        for gid in unique_groups:
            assignment = assignment_map.get((uid, gid))
            if assignment and assignment.assigned_analyst_id:
                assigned_count += 1
        summary = (
            f"{assigned_count}/{len(unique_groups)} assigned"
            if (unique_groups and assigned_count > 0)
            else ""
        )

        received_at = getattr(sub, "received_at", None)
        date_received = (
            received_at.isoformat()
            if received_at
            else (parent_item.get("getDateReceived") or parent_item.get("DateReceived") or None)
        )

        out.append(InboxVialItem(
            uid=uid,
            sample_id=sub.sample_id,
            is_parent=False,
            parent_sample_id=parent_sample_id,
            assignment_role=role,
            vial_sequence=sub.vial_sequence,
            vial_total=family_size,
            container_mode=True,
            title=str(parent_item.get("title", "")),
            client_id=parent_item.get("getClientTitle") or parent_item.get("ClientID") or None,
            client_order_number=parent_item.get("getClientOrderNumber") or parent_item.get("ClientOrderNumber") or None,
            date_received=date_received,
            review_state=str(parent_item.get("review_state", "sample_received")),
            priority=prio or "normal",
            assignment_summary=summary,
            analyses=analyses,
        ))
    if priorities_dirty:
        db.commit()
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_inbox_native_vials.py -q
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/main.py backend/tests/test_inbox_native_vials.py && git commit -m "feat(worksheets): native-vial inbox emission helper"
```

---

### Task 2: Backend — wire emission into the inbox route

**Files:**
- Modify: `backend/main.py` — step 2b (~13912), step 4c sub select (~14042), step 7 loop (~14180)

- [ ] **Step 1: Step 2b — also load prepped sub pks**

Inside the existing `if hide_prepped:` block (the `with conn.cursor() as cur:` body at ~13919), declare `prepped_sub_pks: set[int] = set()` next to `prepped_senaite_ids` (before the `if hide_prepped:`) and add a second query after the existing one:

```python
    # Step 2b: Load SENAITE sample IDs that already have a sample prep
    prepped_senaite_ids: set[str] = set()
    prepped_sub_pks: set[int] = set()
    if hide_prepped:
        try:
            from mk1_db import ensure_sample_preps_table, get_mk1_db
            ensure_sample_preps_table()
            with get_mk1_db() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT DISTINCT senaite_sample_id FROM sample_preps WHERE senaite_sample_id IS NOT NULL")
                    prepped_senaite_ids = {row[0] for row in cur.fetchall()}
                    # Vial-scoped preps (post prep-cutover) tag the vial pk —
                    # the native-vial rows filter on this, not the senaite id.
                    cur.execute("SELECT DISTINCT lims_sub_sample_pk FROM sample_preps WHERE lims_sub_sample_pk IS NOT NULL")
                    prepped_sub_pks = {row[0] for row in cur.fetchall()}
        except Exception:
            pass  # If mk1 DB is unavailable, show all samples
```

- [ ] **Step 2: Step 4c — add `received_at` to the sub select and collect native subs**

Extend the existing `sub_rows` select (~14042) with `LimsSubSample.received_at`:

```python
    sub_rows = db.execute(
        select(
            LimsSubSample.parent_sample_pk,
            LimsSubSample.external_lims_uid,
            LimsSubSample.sample_id,
            LimsSubSample.assignment_role,
            LimsSubSample.vial_sequence,
            LimsSubSample.id,             # Phase 3.5: needed for Mk1 inbox source
            LimsSubSample.received_at,    # native-vial rows: own check-in date
        ).where(
            (LimsSubSample.external_lims_uid.in_(uids))
            | (LimsSubSample.parent_sample_pk.in_(parent_ids) if parent_ids else False)
        )
    ).all()
```

After the `family_sizes = _inbox_family_sizes(...)` line (~14075), add:

```python
    # Native vials (mk1:// uid — no SENAITE AR) per parent pk, for the
    # container-parent suppression branch in step 7. AR-backed subs are NOT
    # collected here; they arrive through their own SENAITE loop items.
    native_subs_by_parent: dict[int, list] = {}
    for r in sub_rows:
        if r.external_lims_uid and r.external_lims_uid.startswith("mk1://"):
            native_subs_by_parent.setdefault(r.parent_sample_pk, []).append(r)
    for subs in native_subs_by_parent.values():
        subs.sort(key=lambda r: r.vial_sequence)
```

- [ ] **Step 3: Step 7 — suppress container parents with vials**

In the step-7 loop, right after the `vial_meta` legacy-fallback block closes (after `"vial_sequence": 0,` / `}` at ~14179) and BEFORE `vial_role = vial_meta["assignment_role"]`, add:

```python
        # Vial-only mode: a container parent is a depository, not a work
        # unit. When its family has any vials, suppress the parent row and
        # emit its native vials instead (AR-backed vials arrive via their
        # own loop items). A zero-vial container family keeps the parent
        # row — it is the family's only inbox handle until the Receive
        # Wizard registers vials. Spec:
        # docs/superpowers/specs/2026-06-11-vial-level-worksheets-inbox-design.md
        if (
            vial_meta.get("is_parent")
            and vial_meta.get("container_mode")
            and family_sizes.get(vial_meta.get("parent_lims_id"), 0) > 0
        ):
            result_items.extend(_build_native_vial_inbox_items(
                db,
                parent_item=it,
                parent_sample_id=vial_meta["parent_sample_id"],
                native_subs=native_subs_by_parent.get(vial_meta["parent_lims_id"], []),
                family_size=family_sizes.get(vial_meta["parent_lims_id"], 1),
                allowed_vial_roles=allowed_vial_roles,
                assigned_pairs=assigned_pairs,
                assigned_uids_for_null_group=assigned_uids_for_null_group,
                hide_prepped=hide_prepped,
                prepped_sub_pks=prepped_sub_pks,
                prepped_senaite_ids=prepped_senaite_ids,
                priority_map=priority_map,
                order_priority=order_priority_map.get(sample_id),
                assignment_map=assignment_map,
                keyword_to_peptide=keyword_to_peptide,
            ))
            continue
```

Note: the legacy-fallback `vial_meta` dict has no `container_mode` key → `.get()` returns None → branch skipped, fallback behavior unchanged. Non-container parents have `container_mode=False` → skipped. Result sorting (~14348) already orders by `(parent_sample_id, not is_parent, vial_sequence)` — native rows slot in correctly.

- [ ] **Step 4: Syntax check + existing suites still pass**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_inbox_native_vials.py tests/test_worksheets_inbox.py tests/test_worksheet_analyst_stamp.py -q
```

Expected: all passed (integration-marked tests in test_worksheets_inbox auto-skip without `-m integration`).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/main.py && git commit -m "feat(worksheets): suppress container parents in inbox — emit native vials"
```

---

### Task 3: Backend — order-status notify uses parent sample id (TDD)

**Files:**
- Modify: `backend/main.py` — near `_notify_worksheet_assigned` (~8073) + 3 call sites (~14619, ~14954, ~15055)
- Test: `backend/tests/test_worksheet_notify_target.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_worksheet_notify_target.py`:

```python
"""_worksheet_notify_target: order-status notifications must carry the PARENT
sample id. The IS /explorer/worksheet-assigned endpoint maps sample_id → order
via receive-webhook events / order payload sample_results — both keyed by
parent AR ids. Vial ids (…-SNN) would no-op there (no_order_found)."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from main import _worksheet_notify_target
from models import LimsSample, LimsSubSample


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
def vial(db):
    parent = LimsSample(sample_id="BW-0014", external_lims_uid="uid-bw14")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="mk1://notify-001",
        sample_id="BW-0014-S03",
        vial_sequence=3,
        assignment_role="hplc",
    )
    db.add(sub)
    db.commit()
    return sub


def test_parent_id_passes_through(db):
    assert _worksheet_notify_target(db, "P-0144") == "P-0144"


def test_vial_id_resolves_to_parent_via_db(db, vial):
    assert _worksheet_notify_target(db, "BW-0014-S03") == "BW-0014"


def test_unknown_vial_shaped_id_falls_back_to_regex_strip(db):
    assert _worksheet_notify_target(db, "P-9999-S01") == "P-9999"


def test_empty_and_non_sample_strings_unchanged(db):
    assert _worksheet_notify_target(db, "") == ""
    assert _worksheet_notify_target(db, "WS-2026-001") == "WS-2026-001"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_worksheet_notify_target.py -q
```

Expected: ImportError — `_worksheet_notify_target` not defined.

- [ ] **Step 3: Implement the resolver and switch the call sites**

In `backend/main.py`, directly above `_notify_worksheet_assigned` (~8073), add:

```python
_VIAL_SHAPED_ID_RE = re.compile(r"^(?P<parent>.+)-S\d{2,}$")


def _worksheet_notify_target(db: Session, sample_id: str) -> str:
    """Resolve the sample id to notify the IS with when a worksheet item is
    added. Order-status mapping on the IS side (/explorer/worksheet-assigned)
    is keyed by PARENT AR ids — receive-webhook sample_status_events and
    order payload sample_results — so vial ids (…-SNN) must be translated or
    the notification no-ops (no_order_found). DB linkage wins; regex strip is
    the fallback for vial-shaped ids with no lims_sub_samples row."""
    if not sample_id:
        return sample_id
    m = _VIAL_SHAPED_ID_RE.match(sample_id)
    if not m:
        return sample_id
    parent_sid = db.execute(
        select(LimsSample.sample_id)
        .join(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
        .where(LimsSubSample.sample_id == sample_id)
    ).scalar_one_or_none()
    return parent_sid or m.group("parent")
```

Change the three call sites:

At ~14619 (`POST /worksheets` notify loop):
```python
    for sid in items:
        if sid:
            await _notify_worksheet_assigned(_worksheet_notify_target(db, sid))
```

At ~14954 (`add-group-to-worksheet`):
```python
    # Notify integration service — order status → analyzing. Vial items
    # notify with the PARENT id (the IS can only map parent ARs to orders).
    await _notify_worksheet_assigned(_worksheet_notify_target(db, data.sample_id))
```

At ~15055 (`create-from-drop`): same replacement as above.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/tmp/Accu-Mk1-subvial/backend && C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/test_worksheet_notify_target.py tests/test_inbox_native_vials.py -q
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add backend/main.py backend/tests/test_worksheet_notify_target.py && git commit -m "fix(worksheets): order-status notify resolves vial ids to parent sample id"
```

---

### Task 4: FE — family-grouping pure helpers (TDD)

**Files:**
- Create: `src/lib/inbox-families.ts`
- Test: `src/test/inbox-families.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/test/inbox-families.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  groupInboxFamilies,
  familyDragItems,
  familyDateReceived,
} from '@/lib/inbox-families'
import type { InboxVialItem } from '@/lib/api'

function vial(over: Partial<InboxVialItem>): InboxVialItem {
  return {
    uid: 'u1',
    sample_id: 'P-0001-S01',
    is_parent: false,
    parent_sample_id: 'P-0001',
    assignment_role: 'hplc',
    vial_sequence: 1,
    vial_total: 2,
    container_mode: true,
    title: '',
    client_id: null,
    client_order_number: null,
    date_received: '2026-06-10T12:00:00+00:00',
    review_state: 'sample_received',
    priority: 'normal',
    assignment_summary: '',
    analyses: [
      {
        uid: 'a1', title: 'Peptide Purity (HPLC)', keyword: 'HPLC-PUR',
        peptide_name: 'BPC-157', method: null, review_state: 'unassigned',
        group_id: 1, group_name: 'Analytics', group_color: 'sky',
      },
    ],
    ...over,
  } as InboxVialItem
}

describe('groupInboxFamilies', () => {
  it('groups vials by parent and orders vials by sequence (parent row first)', () => {
    const fams = groupInboxFamilies([
      vial({ uid: 'b2', parent_sample_id: 'P-02', sample_id: 'P-02-S02', vial_sequence: 2 }),
      vial({ uid: 'b1', parent_sample_id: 'P-02', sample_id: 'P-02-S01', vial_sequence: 1 }),
      vial({ uid: 'p3', parent_sample_id: 'P-03', sample_id: 'P-03', is_parent: true, vial_sequence: 0 }),
    ])
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-02', 'P-03'])
    expect(fams[0]!.vials.map(v => v.sample_id)).toEqual(['P-02-S01', 'P-02-S02'])
  })

  it('a mixed-priority family stays together, ranked by its most urgent vial', () => {
    const fams = groupInboxFamilies([
      vial({ uid: 'a1', parent_sample_id: 'P-0A', sample_id: 'P-0A-S01', priority: 'normal' }),
      vial({ uid: 'b1', parent_sample_id: 'P-0B', sample_id: 'P-0B-S01', priority: 'high' }),
      vial({ uid: 'a2', parent_sample_id: 'P-0A', sample_id: 'P-0A-S02', vial_sequence: 2, priority: 'expedited' }),
    ])
    // P-0A ranks expedited (its best vial) and so sorts before P-0B (high)
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-0A', 'P-0B'])
    expect(fams[0]!.vials).toHaveLength(2)
  })

  it('equal-priority families sort by parent id', () => {
    const fams = groupInboxFamilies([
      vial({ uid: 'z', parent_sample_id: 'P-09' }),
      vial({ uid: 'a', parent_sample_id: 'P-01' }),
    ])
    expect(fams.map(f => f.parentSampleId)).toEqual(['P-01', 'P-09'])
  })
})

describe('familyDragItems', () => {
  it('builds one DragData per vial, identical to the single-vial drag shape', () => {
    const items = familyDragItems([vial({ uid: 'u9', sample_id: 'P-09-S01' })])
    expect(items).toEqual([
      {
        sampleUid: 'u9',
        sampleId: 'P-09-S01',
        groupId: 1,
        groupName: 'Analytics',
        dateReceived: '2026-06-10T12:00:00+00:00',
        analyses: [
          { title: 'Peptide Purity (HPLC)', keyword: 'HPLC-PUR', peptide_name: 'BPC-157', method: null },
        ],
      },
    ])
  })
})

describe('familyDateReceived', () => {
  it('returns the earliest date in the family', () => {
    const d = familyDateReceived([
      vial({ date_received: '2026-06-11T09:00:00+00:00' }),
      vial({ uid: 'u2', date_received: '2026-06-09T08:00:00+00:00' }),
      vial({ uid: 'u3', date_received: null }),
    ])
    expect(d).toBe('2026-06-09T08:00:00+00:00')
  })

  it('returns null when no vial has a date', () => {
    expect(familyDateReceived([vial({ date_received: null })])).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/tmp/Accu-Mk1-subvial && npx vitest run src/test/inbox-families.test.ts
```

Expected: FAIL — cannot resolve `@/lib/inbox-families`.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/inbox-families.ts`:

```typescript
// Pure, framework-free helpers for family-grouped rendering of the
// Worksheet Inbox. A "family" = all visible vials sharing a
// parent_sample_id. See
// docs/superpowers/specs/2026-06-11-vial-level-worksheets-inbox-design.md.
import type { InboxVialItem } from '@/lib/api'
import type { DragData } from '@/components/hplc/InboxVialCard'

export interface VialFamily {
  parentSampleId: string
  vials: InboxVialItem[]
}

/** Drag payload for a whole-family drop. Discriminated from single-vial
 *  DragData by the `family` flag. */
export interface FamilyDragData {
  family: true
  parentSampleId: string
  items: DragData[]
}

const PRIORITY_ORDER: Record<string, number> = { expedited: 0, high: 1, normal: 2 }

function familyPriorityRank(vials: InboxVialItem[]): number {
  return Math.min(...vials.map(v => PRIORITY_ORDER[v.priority] ?? 2))
}

/** Group vials by parent_sample_id and sort for rendering: families ordered
 *  by their MOST URGENT vial's priority, then parent id; vials within a
 *  family by (parent row first, vial_sequence). Keeping a mixed-priority
 *  family intact is deliberate — techs grab all of a sample's vials at
 *  once, so a family must never split across the list. */
export function groupInboxFamilies(vials: InboxVialItem[]): VialFamily[] {
  const byParent = new Map<string, InboxVialItem[]>()
  for (const v of vials) {
    const list = byParent.get(v.parent_sample_id)
    if (list) list.push(v)
    else byParent.set(v.parent_sample_id, [v])
  }
  const families: VialFamily[] = Array.from(byParent.entries()).map(
    ([parentSampleId, fam]) => ({
      parentSampleId,
      vials: fam.slice().sort((a, b) => {
        if (a.is_parent !== b.is_parent) return a.is_parent ? -1 : 1
        return a.vial_sequence - b.vial_sequence
      }),
    }),
  )
  families.sort((a, b) => {
    const ra = familyPriorityRank(a.vials)
    const rb = familyPriorityRank(b.vials)
    if (ra !== rb) return ra - rb
    return a.parentSampleId.localeCompare(b.parentSampleId)
  })
  return families
}

/** Per-vial drag payloads for a whole-family drop — one entry per vial,
 *  byte-identical to what the vial's own drag handle would carry
 *  (InboxVialCard's useDraggable data). */
export function familyDragItems(vials: InboxVialItem[]): DragData[] {
  return vials.map(v => ({
    sampleUid: v.uid,
    sampleId: v.sample_id,
    groupId: v.analyses[0]?.group_id ?? 0,
    groupName: v.analyses[0]?.group_name ?? '',
    dateReceived: v.date_received,
    analyses: v.analyses.map(a => ({
      title: a.title,
      keyword: a.keyword,
      peptide_name: a.peptide_name,
      method: a.method,
    })),
  }))
}

/** Earliest date_received in the family — drives the header aging timer. */
export function familyDateReceived(vials: InboxVialItem[]): string | null {
  const dates = vials
    .map(v => v.date_received)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
  if (dates.length === 0) return null
  return dates.slice().sort()[0] ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/tmp/Accu-mk1-subvial && npx vitest run src/test/inbox-families.test.ts
```

(Use the correct casing: `C:/tmp/Accu-Mk1-subvial`.) Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add src/lib/inbox-families.ts src/test/inbox-families.test.ts && git commit -m "feat(worksheets): family-grouping helpers for the vial inbox"
```

---

### Task 5: FE — family group component + whole-family drag

**Files:**
- Create: `src/components/hplc/InboxFamilyGroup.tsx`
- Modify: `src/components/hplc/WorksheetsInboxPage.tsx` (sort block ~164-184, drag handlers ~202-254, cards render ~429-445, overlay ~499-507)

- [ ] **Step 1: Create the family group component**

Create `src/components/hplc/InboxFamilyGroup.tsx`:

```tsx
import { useDraggable } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import { InboxVialCard } from '@/components/hplc/InboxVialCard'
import {
  familyDateReceived,
  familyDragItems,
  type FamilyDragData,
  type VialFamily,
} from '@/lib/inbox-families'
import { cn } from '@/lib/utils'
import type { InboxPriority } from '@/lib/api'

interface InboxFamilyGroupProps {
  family: VialFamily
  onPriorityChange: (sampleUid: string, priority: InboxPriority) => void
}

/** Bordered section wrapping all of one sample's vial cards, with a header
 *  drag handle that assigns the WHOLE family at once (one worksheet item
 *  per vial). Rendered only for vial-only families (no parent row) with
 *  2+ visible vials — legacy parent-led families keep the flat card list. */
export function InboxFamilyGroup({ family, onPriorityChange }: InboxFamilyGroupProps) {
  const dragData: FamilyDragData = {
    family: true,
    parentSampleId: family.parentSampleId,
    items: familyDragItems(family.vials),
  }
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `family-${family.parentSampleId}`,
    data: dragData,
  })

  const client = family.vials[0]?.client_id
  const title = family.vials[0]?.title

  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-border/80 bg-muted/20',
        isDragging && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-dashed border-border/60">
        <button
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          className="h-6 w-10 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none text-muted-foreground/40 hover:text-muted-foreground rounded hover:bg-muted/50"
          aria-label={`Drag all ${family.vials.length} vials of ${family.parentSampleId}`}
          title="Drag to assign all vials at once"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="font-mono text-sm font-semibold hover:underline hover:text-primary transition-colors"
          onClick={() => useUIStore.getState().navigateToSample(family.parentSampleId)}
        >
          {family.parentSampleId}
        </button>
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {family.vials.length} vials
        </span>
        {title && (
          <span className="text-xs text-muted-foreground truncate max-w-48">{title}</span>
        )}
        {client && (
          <span className="text-xs text-muted-foreground/70 truncate max-w-40">{client}</span>
        )}
        <div className="flex-1" />
        <AgingTimer dateReceived={familyDateReceived(family.vials)} />
      </div>
      <div className="space-y-2 p-2">
        {family.vials.map(v => (
          <InboxVialCard
            key={v.uid}
            vial={v}
            groupedWithPrevious={false}
            onPriorityChange={onPriorityChange}
          />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Rewire WorksheetsInboxPage**

In `src/components/hplc/WorksheetsInboxPage.tsx`:

(a) Add imports:
```tsx
import { InboxFamilyGroup } from '@/components/hplc/InboxFamilyGroup'
import { groupInboxFamilies, type FamilyDragData } from '@/lib/inbox-families'
```

(b) Replace the `.sort(...)` chain on `visibleVials` (lines ~169-184, from `// Priority pass…` through the closing `})`) with nothing (delete it — sorting moves to `groupInboxFamilies`), then add below:

```tsx
  // Family-grouped rendering: groupInboxFamilies owns ALL ordering (family
  // rank = most urgent vial; vials by sequence). A family never splits
  // across the list — techs grab all of a sample's vials at once.
  const families = groupInboxFamilies(visibleVials)
```

(c) Widen `activeDrag` state and `handleDragStart`:

```tsx
  const [activeDrag, setActiveDrag] = useState<DragData | FamilyDragData | null>(null)
```

```tsx
  function handleDragStart(event: DragStartEvent) {
    setActiveDrag(event.active.data.current as DragData | FamilyDragData)
    // Prevent body scroll during drag
    document.body.style.overflow = 'hidden'
  }
```

(d) Branch `handleDragEnd` and add `handleFamilyDrop`:

```tsx
  async function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
    document.body.style.overflow = ''
    const { over, active } = event
    if (!over) return

    const payload = active.data.current as DragData | FamilyDragData
    const dropId = String(over.id)

    if (payload && 'family' in payload) {
      await handleFamilyDrop(dropId, payload)
      return
    }
    const dragData = payload
    // …existing single-vial body unchanged from here (cardKey, optimistic
    // hide, createWorksheetFromDrop / addGroupToWorksheet, invalidate)…
  }

  async function handleFamilyDrop(dropId: string, fam: FamilyDragData) {
    const keys = fam.items.map(i => `${i.sampleUid}::${i.groupId}`)
    setPendingDropKeys(prev => new Set([...prev, ...keys]))
    const failed: { sampleUid: string; sampleId: string; groupId: number }[] = []
    let added = 0
    try {
      let worksheetId: number
      let createdTitle: string | null = null
      let queue = fam.items
      if (dropId === 'new-worksheet') {
        const [first, ...rest] = fam.items
        if (!first) return
        const result = await createWorksheetFromDrop({
          sample_uid: first.sampleUid,
          sample_id: first.sampleId,
          service_group_id: first.groupId,
          date_received: first.dateReceived,
          analyses: first.analyses,
        })
        worksheetId = result.id
        createdTitle = result.title
        added += 1
        queue = rest
      } else if (dropId.startsWith('worksheet-')) {
        worksheetId = Number(dropId.replace('worksheet-', ''))
      } else {
        return
      }
      for (const item of queue) {
        try {
          await addGroupToWorksheet(worksheetId, {
            sample_uid: item.sampleUid,
            sample_id: item.sampleId,
            service_group_id: item.groupId,
            date_received: item.dateReceived,
            analyses: item.analyses,
          })
          added += 1
        } catch {
          failed.push(item)
        }
      }
      if (added > 0) {
        toast.success(
          createdTitle
            ? `Created "${createdTitle}" with ${added} vial${added === 1 ? '' : 's'}`
            : `Added ${added} vial${added === 1 ? '' : 's'} to worksheet`,
        )
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} vial(s) not added: ${failed.map(f => f.sampleId).join(', ')}`)
      }
    } catch (err) {
      // Worksheet creation itself failed — restore every card
      failed.push(...fam.items)
      toast.error(err instanceof Error ? err.message : 'Failed to assign family to worksheet')
    } finally {
      setPendingDropKeys(prev => {
        const next = new Set(prev)
        for (const f of failed) next.delete(`${f.sampleUid}::${f.groupId}`)
        return next
      })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
    }
  }
```

(e) Replace the cards render block (`{!isLoading && !isError && visibleVials.length > 0 && (…)}`, ~429-445) with:

```tsx
            {/* Cards — family-grouped. Vial-only families (container mode,
                no parent row) of 2+ get a draggable group section; legacy
                parent-led families keep the flat indent treatment. */}
            {!isLoading && !isError && visibleVials.length > 0 && (
              <div className="space-y-2">
                {families.map(fam => {
                  const hasParentRow = fam.vials.some(v => v.is_parent)
                  if (fam.vials.length >= 2 && !hasParentRow) {
                    return (
                      <InboxFamilyGroup
                        key={fam.parentSampleId}
                        family={fam}
                        onPriorityChange={handlePriorityChange}
                      />
                    )
                  }
                  return fam.vials.map((vial, idx) => (
                    <InboxVialCard
                      key={vial.uid}
                      vial={vial}
                      groupedWithPrevious={idx > 0}
                      onPriorityChange={handlePriorityChange}
                    />
                  ))
                })}
              </div>
            )}
```

(f) Update the DragOverlay ghost (~499-507):

```tsx
      <DragOverlay dropAnimation={null}>
        {activeDrag && ('family' in activeDrag ? (
          <div className="rounded-lg border bg-card shadow-xl px-3 py-2 opacity-90 w-56 pointer-events-none">
            <span className="font-mono text-xs font-semibold">{activeDrag.parentSampleId}</span>
            <span className="mx-1.5 text-muted-foreground/50">·</span>
            <span className="text-xs">{activeDrag.items.length} vials</span>
          </div>
        ) : (
          <div className="rounded-lg border bg-card shadow-xl px-3 py-2 opacity-90 w-48 pointer-events-none">
            <span className="font-mono text-xs font-medium">{activeDrag.sampleId}</span>
            <span className="mx-1.5 text-muted-foreground/50">·</span>
            <span className="text-xs">{activeDrag.groupName}</span>
          </div>
        ))}
      </DragOverlay>
```

- [ ] **Step 3: Typecheck + lint + tests**

```bash
cd C:/tmp/Accu-Mk1-subvial && npm run typecheck
```
Expected: ONLY the pre-existing `WorksheetsInboxPage.tsx` error (baseline; line may shift) — no new errors. If the baseline error's code region got touched, fix it incidentally and note it in the commit.

```bash
cd C:/tmp/Accu-Mk1-subvial && npx eslint src/components/hplc/WorksheetsInboxPage.tsx src/components/hplc/InboxFamilyGroup.tsx src/lib/inbox-families.ts
```
Expected: 0 problems in the new files; page file no worse than baseline.

```bash
cd C:/tmp/Accu-Mk1-subvial && npx vitest run src/test/inbox-families.test.ts src/test/native-sub-sample.test.ts src/test/vials-quicklook.test.tsx
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial && git add src/components/hplc/InboxFamilyGroup.tsx src/components/hplc/WorksheetsInboxPage.tsx && git commit -m "feat(worksheets): family-grouped inbox with whole-family drag"
```

---

### Task 6: Live verification + UAT handoff

- [ ] **Step 1: Backend reload check** — the stack backend bind-mounts the worktree with `--reload`; confirm it picked up:

```bash
docker logs accumark-subvial-accu-mk1-backend --since 3m 2>&1 | tail -20
```
Expected: a reload line, no tracebacks. If no reload: `docker restart accumark-subvial-accu-mk1-backend`.

- [ ] **Step 2: Smoke the inbox endpoint** (login first):

```bash
curl -s -X POST http://localhost:5530/auth/login -H "Content-Type: application/json" -d '{"email":"forrest@valenceanalytical.com","password":"test123"}'
# then with the token:
curl -s "http://localhost:5530/worksheets/inbox?role=hplc" -H "Authorization: Bearer <token>" | head -c 2000
```
Expected: 200; container families appear as vial rows (`"is_parent":false`, uids starting `mk1://`); no container-parent rows when the family has vials.

- [ ] **Step 3: Hand UAT to the Handler** — exact steps:
1. Hard-refresh (Ctrl+Shift+R) `http://localhost:5532`, go to Worksheets → Inbox (HPLC bench).
2. A container-mode family shows a dashed group box: header = parent ID + "N vials" + aging; vial cards inside.
3. Drag the header grip onto "New worksheet" → toast "Created … with N vials"; every vial is its own worksheet item; container parent is nowhere in the inbox.
4. Drag a single vial from another family onto the same worksheet → still works.
5. Delete the worksheet → vials return to inbox on refresh.
6. Order status (MailHog / WP order page): adding a native vial flips the order to "analyzing" (parent-id notify).

---

## Self-review notes

- Spec coverage: inbox emission (T1+T2), zero-vial parent retention (T2 branch condition), legacy parents untouched (branch guards), stale-guard skip — **dropped deliberately** (no FE caller; documented in header), stamping — no change needed (verified), parent-id notify (T3), family grouping + family drag (T4+T5), AddSamplesModal free-rider (same endpoint).
- Types: `FamilyDragData.items: DragData[]` matches `familyDragItems` return; helper kwargs match call site; `received_at` added to the select feeds `getattr(sub, "received_at", None)`.
- Known accepted behaviors: native vials ride the PARENT AR's `sample_received` presence in the SENAITE feed (parent published ⇒ family leaves inbox); N family adds fire N parent-id notifications (status flip idempotent).
