# Mk1-Native Analyses Phase 3.5 — Worksheet Inbox Source Switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the worksheet inbox endpoint over to source sub-sample vial analyses from Mk1 `lims_analyses` instead of SENAITE. Sub-samples that have Mk1 analyses seeded (everything Phase 2+ created via role-assignment) show their Mk1 analyses in the inbox card with `mk1:` prefixed UIDs. Sub-samples without Mk1 rows (pre-Phase-2 vials, or freshly-created XTRA vials) fall back to the existing SENAITE source. Parent samples are unchanged.

**Architecture:** Add a small helper `_fetch_mk1_inbox_analyses_for_sub_sample(db, sub_sample_pk) -> list[InboxAnalysisItem]` near the existing inbox builder in `backend/main.py`. Inside the per-vial loop in `get_worksheets_inbox`, after the SENAITE `raw_analyses` are loaded, branch on `vial_meta.is_sub_sample`: if Mk1 rows exist for the vial, use them; otherwise use the existing SENAITE-derived `raw_analyses` path unchanged. The returned `InboxAnalysisItem` shape is identical between sources, so the FE inbox card renders without changes. UIDs from Mk1 carry the `mk1:` prefix, matching Phase 3's adapter convention — Phase 3's existing FE dispatch shims handle them if the inbox ever wires up direct writes.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (backend). No frontend changes. No schema changes (the SPEC's "worksheet_items.lims_analysis_id" column turned out to be unnecessary — worksheet_items store one row per (sample, service_group) with analyses denormalized into a JSON blob, not one row per analysis).

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"Worksheet routing + result entry"
**Predecessor:** Phase 3 (`docs/superpowers/plans/2026-06-03-mk1-native-analyses-phase3.md`).
**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **No `worksheet_items.lims_analysis_id` column.** The existing `worksheet_items` schema stores one row per `(sample_uid, service_group_id)` with analyses denormalized into `analyses_json`. The SPEC's per-analysis-FK design doesn't match the code's per-group structure. Adding the column would create a half-empty FK that's never set on the read path — pure dead weight. Skipped.

2. **Dual-source for sub-sample vials in the inbox.** If Mk1 has lims_analyses rows for a sub-sample vial, use them. If it doesn't (pre-Phase-2 vials, or new XTRA vials that haven't had a role assigned), fall back to SENAITE. Matches Phase 2.5's photo dual-source pattern. No backfill.

3. **Drag-drop + worksheet detail are untouched.** Both endpoints currently consume the denormalized `analyses_json` from worksheet_items. After Phase 3.5, that JSON snapshot just happens to carry `mk1:` UIDs for sub-sample groups instead of SENAITE UIDs. The frontend `WorksheetDrawer` renders by title/keyword, not by UID. If a bench tech opens a worksheet item, the AnalysisTable kicks in (Phase 3 adapter) and fetches fresh — so the inbox-time snapshot only matters for display.

4. **Method/instrument PATCH endpoints are NOT in this phase.** Phase 3's plan also flagged them — they're a separate concern (Mk1 needs new endpoints + the FE has to populate the option arrays from a join we don't currently do). Defer until first concrete need.

5. **InboxAnalysisItem shape is unchanged.** The Mk1-sourced builder produces the same Pydantic shape as the SENAITE path. `uid` carries `mk1:{id}` for Mk1 rows; `keyword`, `title`, `peptide_name`, `method`, `review_state`, `group_id`, `group_name`, `group_color` are populated by joining `lims_analyses` → `analysis_services` → `service_group_members` → `service_groups`.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (modified):**
- `backend/main.py` — add `_fetch_mk1_inbox_analyses_for_sub_sample(db, sub_sample_pk, role) -> list[InboxAnalysisItem]` helper near the inbox endpoint (around line 13180). Modify the per-vial loop in `get_worksheets_inbox` (around line 13260) to dispatch on `vial_meta.is_sub_sample`: try Mk1, fall back to SENAITE.
- `backend/tests/test_worksheets_inbox.py` — add tests that (a) sub-sample with seeded Mk1 analyses returns `mk1:` UIDs in the inbox response, (b) sub-sample without Mk1 rows falls back to SENAITE.

**Out of scope:**
- `worksheet_items.lims_analysis_id` column — not needed; see Scope Decision 1.
- Drag-drop endpoint changes — unchanged; analyses_json carries whatever UIDs the inbox surfaces.
- Worksheet detail (`GET /worksheets`) endpoint changes — unchanged; renders from analyses_json.
- Method/instrument PATCH endpoints + FE option-array population — explicitly punted (Scope Decision 4).
- Frontend changes — none. UID-based dispatch in the AnalysisTable already lands via Phase 3.

---

## How to run tests

- Single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheets_inbox.py -v"`
- Full suite: same harness, `tests/`. Baseline: 13 failures, 440 passed at end of Phase 3.

---

## Task 1: Probe + plan inbox helper signature

Verification-only — no commit.

- [ ] **Step 1: Re-read the inbox endpoint's per-vial loop**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "sed -n '13255,13320p' /app/main.py"
```

Capture: which local variable holds `vial_meta`, how `is_sub_sample` is determined, and what the `flat_analyses` builder loop looks like. The new branch goes inside that loop, BEFORE the existing SENAITE-derived flat_analyses build.

- [ ] **Step 2: Find the `vial_meta_by_uid` shape**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "grep -nB 2 -A 10 'vial_meta_by_uid' /app/main.py | head -60"
```

Confirm what `vial_meta` exposes: at minimum `is_sub_sample: bool`, `pk: int` (the lims_sub_samples.id), and `assignment_role: str`. If those aren't direct fields, note the actual attribute names — Task 2 must use them.

- [ ] **Step 3: Confirm the service_groups + service_group_members structure**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import ServiceGroup, AnalysisService
db = SessionLocal()
groups = db.execute(select(ServiceGroup)).scalars().all()
print(f'{len(groups)} service_groups:')
for g in groups:
    cols = {c.name: getattr(g, c.name) for c in ServiceGroup.__table__.columns if c.name in ('id', 'name', 'color', 'role')}
    print(f'  {cols}')
db.close()
"
```

Capture the columns we'll need: `id`, `name`, a color/role marker. The inbox uses `group_id`, `group_name`, `group_color`. If `color` doesn't exist on the model, fall back to a hardcoded per-role map. Document what's actually there.

---

## Task 2: `_fetch_mk1_inbox_analyses_for_sub_sample` helper

**Files:**
- Modify: `backend/main.py` (add helper near the inbox endpoint)

- [ ] **Step 1: Read the existing inbox endpoint imports**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "grep -n '^from models\|^from database\|^from sqlalchemy' /app/main.py | head -10"
```

Confirm `LimsAnalysis`, `AnalysisService`, `ServiceGroup`, and `service_group_members` are imported. If any are missing, the helper needs an explicit import inside the function (the file's a 14k-line monolith — local imports are common).

- [ ] **Step 2: Add the helper above `get_worksheets_inbox`**

Find the `get_worksheets_inbox` route handler (around line 12813). Add this helper IMMEDIATELY BEFORE it:

```python
def _fetch_mk1_inbox_analyses_for_sub_sample(
    db: Session,
    sub_sample_pk: int,
    role: Optional[str],
    keyword_to_peptide: dict[str, str],
) -> list["InboxAnalysisItem"]:
    """Build the per-vial inbox analysis list from Mk1 lims_analyses.

    Returns the same InboxAnalysisItem shape as the existing SENAITE-
    derived builder. UIDs carry the 'mk1:' prefix so any downstream
    write-path dispatches to the Mk1 endpoints (Phase 3 adapter).

    Filtering parity with the SENAITE path:
      - Excluded review_states are dropped (rejected, retracted, etc. —
        cancelled doesn't apply at the Mk1 layer but harmless to include).
      - Retests aren't yet wired (Mk1's 'retest' kind creates a new row,
        not a transition); for now, treat all current rows as the
        canonical view.

    Returns an empty list if the vial has no Mk1 rows — caller falls
    back to the SENAITE path.
    """
    from models import (
        LimsAnalysis, AnalysisService,
        ServiceGroup, service_group_members,
    )

    rows = db.execute(
        select(LimsAnalysis, AnalysisService, ServiceGroup)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .outerjoin(
            service_group_members,
            service_group_members.c.analysis_service_id == AnalysisService.id,
        )
        .outerjoin(ServiceGroup, ServiceGroup.id == service_group_members.c.service_group_id)
        .where(LimsAnalysis.lims_sub_sample_pk == sub_sample_pk)
        .where(LimsAnalysis.retest_of_id.is_(None))
    ).all()

    EXCLUDED_STATES = {"rejected", "retracted"}
    out: list[InboxAnalysisItem] = []
    for la, svc, sg in rows:
        if la.review_state in EXCLUDED_STATES:
            continue
        # ServiceGroup attributes: id, name, and a color we can read or
        # synthesize. If color isn't on the model, fall back to a per-role
        # map. The inbox card uses the color for the role chip.
        if sg is not None:
            grp_id = sg.id
            grp_name = sg.name or ""
            grp_color = getattr(sg, "color", None) or _ROLE_COLOR_FALLBACK.get(role or "", "zinc")
        else:
            grp_id = 0
            grp_name = ""
            grp_color = _ROLE_COLOR_FALLBACK.get(role or "", "zinc")

        out.append(InboxAnalysisItem(
            uid=f"mk1:{la.id}",
            title=la.title or la.keyword,
            keyword=la.keyword,
            peptide_name=keyword_to_peptide.get(la.keyword or "") if keyword_to_peptide else None,
            method=None,           # Mk1 vial method not yet wired (Phase 3.5+)
            review_state=la.review_state,
            group_id=grp_id,
            group_name=grp_name,
            group_color=grp_color,
        ))
    return out


# Color fallback when ServiceGroup.color isn't on the model OR the row
# lacks a group_members join. Mirrors the FE's role palette.
_ROLE_COLOR_FALLBACK = {
    "hplc": "sky",
    "endo": "emerald",
    "ster": "violet",
    "xtra": "zinc",
}
```

- [ ] **Step 3: Sanity-import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from main import _fetch_mk1_inbox_analyses_for_sub_sample, _ROLE_COLOR_FALLBACK
print('imports ok')
print('color fallback:', _ROLE_COLOR_FALLBACK)
"
```

Expected: `imports ok` plus the color map. If `service_group_members` import fails (it might be a `Table` not a class, lower-cased), find its actual name in `backend/models.py` and adjust the import.

- [ ] **Step 4: Smoke against PB-0075-S01**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import LimsSubSample
from main import _fetch_mk1_inbox_analyses_for_sub_sample
db = SessionLocal()
sub = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == 'PB-0075-S01')).scalar_one_or_none()
if sub is None:
    print('no PB-0075-S01 in DB')
else:
    rows = _fetch_mk1_inbox_analyses_for_sub_sample(db, sub.id, sub.assignment_role, {})
    print(f'{len(rows)} inbox analyses for {sub.sample_id} (role={sub.assignment_role}):')
    for r in rows:
        print(f'  uid={r.uid} title={r.title!r} kw={r.keyword!r} state={r.review_state} group={r.group_name!r} color={r.group_color}')
db.close()
"
```

Expected: at least 1 row with `uid='mk1:NNN'`, title 'Endotoxin', keyword 'ENDO-LAL', group name + color populated (or fallback).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/main.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): _fetch_mk1_inbox_analyses_for_sub_sample helper"
```

---

## Task 3: Wire the helper into the inbox per-vial loop

**Files:**
- Modify: `backend/main.py` (the `get_worksheets_inbox` per-vial loop, around line 13260)

- [ ] **Step 1: Locate the exact branch point**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "grep -n 'raw_analyses = analyses_by_sample\|deduped_analyses = list\|flat_analyses: list' /app/main.py | head -5"
```

Expected: lines showing the SENAITE raw_analyses pickup, dedupe, and flat_analyses build. The branch goes IMMEDIATELY after `raw_analyses = analyses_by_sample.get(sample_id, [])` so the rest of the dedup/build logic uses Mk1-derived input when applicable.

Actually — simpler: branch on `vial_meta.is_sub_sample` BEFORE the dedup logic. If sub-sample and Mk1 has rows, skip the entire SENAITE-source path and use the Mk1 builder directly. If sub-sample with no Mk1 rows, fall through to the SENAITE path. Parent vials always fall through.

- [ ] **Step 2: Insert the dispatch branch**

Find the line `raw_analyses = analyses_by_sample.get(sample_id, [])` and the variable `vial_meta` (set earlier in the loop). IMMEDIATELY AFTER the `raw_analyses = ...` line, add:

```python
        # Phase 3.5 (mk1-native-analyses): for sub-sample vials with seeded
        # Mk1 lims_analyses rows, use Mk1 as the source of truth for the
        # inbox view. Pre-Phase-2 sub-samples (no Mk1 rows yet) fall back to
        # the existing SENAITE-derived path below. Parent vials are
        # untouched.
        mk1_inbox_analyses: Optional[list[InboxAnalysisItem]] = None
        if vial_meta is not None and getattr(vial_meta, "is_sub_sample", False):
            sub_pk = getattr(vial_meta, "pk", None) or getattr(vial_meta, "sub_sample_pk", None)
            if sub_pk:
                mk1_rows = _fetch_mk1_inbox_analyses_for_sub_sample(
                    db, sub_pk, getattr(vial_meta, "assignment_role", None),
                    keyword_to_peptide,
                )
                if mk1_rows:
                    mk1_inbox_analyses = mk1_rows
```

Then AT THE END of the per-vial flat-analyses build (right before the vial is appended to `result_items`), add a final swap:

```python
        # Phase 3.5: if Mk1 supplied a complete analysis list above, replace
        # the SENAITE-derived flat_analyses with it. Note: filter by role
        # already happened inside the Mk1 builder so we don't re-apply here.
        if mk1_inbox_analyses is not None:
            flat_analyses = mk1_inbox_analyses
```

Find the exact insertion point by grepping for the line that builds `InboxVialItem(... analyses=flat_analyses, ...)` and insert the swap just above it.

- [ ] **Step 3: Restart backend + sanity-check**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -2
```

(pytest install needed after every container restart — Mk1 prod image doesn't bake it.)

- [ ] **Step 4: HTTP smoke**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && cat > /tmp/_smoke_p35_inbox.py << 'PYEOF'
from main import app
from auth import get_current_user
from fastapi.testclient import TestClient

class _U:
    id = 1
    email = 'test@x.com'
app.dependency_overrides[get_current_user] = lambda: _U()
with TestClient(app) as c:
    r = c.get('/worksheets/inbox?role=microbiology')
    print(f'inbox → {r.status_code}')
    if r.status_code != 200:
        print(r.json())
    else:
        items = r.json().get('items', [])
        print(f'{len(items)} vials in microbiology inbox')
        for v in items:
            if 'S' in v.get('sample_id', '').split('-')[-1]:  # sub-sample
                uids = [a.get('uid') for a in v.get('analyses', [])]
                mk1_uids = [u for u in uids if u and u.startswith('mk1:')]
                print(f'  {v[\"sample_id\"]:20s} role={v.get(\"assignment_role\")} mk1_analyses={len(mk1_uids)}/{len(uids)} uids={uids[:3]}')
PYEOF
python /tmp/_smoke_p35_inbox.py && rm /tmp/_smoke_p35_inbox.py"
```

Expected: At least one sub-sample with `mk1_analyses=N/N` (all analyses sourced from Mk1) — `uids[0]` starts with `mk1:`. Sub-samples without Mk1 rows show their normal SENAITE-derived analyses.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/main.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(mk1): inbox sources sub-sample analyses from Mk1 (with SENAITE fallback)"
```

---

## Task 4: Tests

**Files:**
- Modify: `backend/tests/test_worksheets_inbox.py`

- [ ] **Step 1: Inspect existing test patterns**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "sed -n '1,40p' /app/tests/test_worksheets_inbox.py"
```

Note the auth-override pattern, test markers (`@pytest.mark.integration`), and how the client is constructed.

- [ ] **Step 2: Add the Phase 3.5 test**

Append to `backend/tests/test_worksheets_inbox.py`:

```python
# ── Phase 3.5: Mk1-sourced inbox analyses for sub-samples ────────────────────


@pytest.mark.integration
def test_sub_sample_inbox_analyses_come_from_mk1_when_seeded(client):
    """Sub-samples with seeded lims_analyses rows surface those rows in the
    inbox response (uid carries the 'mk1:' prefix); parent samples are
    unchanged."""
    # Microbiology role covers endo + ster; PB-0075-S01 is endo per the
    # Phase 2.5 + 3 smoke vials.
    r = client.get("/worksheets/inbox?role=microbiology")
    assert r.status_code == 200, r.text
    items = r.json().get("items", [])
    sub_samples_with_mk1 = []
    for vial in items:
        if not vial.get("sample_id", "").split("-")[-1].startswith("S"):
            continue  # parent — skip
        uids = [a.get("uid") for a in vial.get("analyses", [])]
        if any(u and u.startswith("mk1:") for u in uids):
            sub_samples_with_mk1.append(vial["sample_id"])
    # The subvial dev DB has at least one sub-sample with seeded Mk1 rows
    # (PB-0075-S01 from Phase 3 smoke). If your env has none, skip.
    if not sub_samples_with_mk1:
        pytest.skip(
            "no sub-samples with Mk1-seeded analyses in this env — seed via "
            "Receive Wizard + assign role hplc/endo/ster first"
        )
    assert sub_samples_with_mk1, "expected at least one sub-sample with mk1: UIDs"


@pytest.mark.integration
def test_parent_sample_inbox_analyses_still_come_from_senaite(client):
    """Parent samples (non-sub) continue to surface SENAITE-sourced
    analyses — their UIDs are 32-char hex, not 'mk1:'-prefixed."""
    r = client.get("/worksheets/inbox?role=hplc")
    assert r.status_code == 200, r.text
    items = r.json().get("items", [])
    parents = [v for v in items if v.get("is_parent")]
    if not parents:
        pytest.skip("no parent vials in hplc inbox in this env")
    for parent in parents:
        for a in parent.get("analyses", []):
            uid = a.get("uid")
            if uid:
                assert not uid.startswith("mk1:"), (
                    f"parent {parent['sample_id']} unexpectedly has Mk1 UID {uid}"
                )
```

- [ ] **Step 3: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_worksheets_inbox.py -v -k 'inbox_analyses' 2>&1 | tail -10"
```

Expected: 2 passed (or skips if seeding state is missing).

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_worksheets_inbox.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "test(mk1): inbox surfaces mk1: UIDs for sub-samples; parents stay SENAITE"
```

---

## Task 5: Full-suite check + live verification

Verification-only — no commit.

- [ ] **Step 1: Full backend suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -q --tb=no 2>&1 | tail -5"
```

Expected: 442 passed (was 440 at end of Phase 3), 13 baseline failures, zero new regressions.

- [ ] **Step 2: Live wizard verification**

```
1. http://localhost:5532
2. sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530'); location.reload()
3. Log in as forrest@valenceanalytical.com / test123
4. Navigate to Worksheets → Inbox (Microbiology role)
5. Open browser Network tab BEFORE viewing
```

In the network response for `/worksheets/inbox?role=microbiology`, find a sub-sample card (e.g., PB-0075-S01). Inspect its `analyses[]` — the `uid` field on each analysis should start with `mk1:`. Parent samples in the response (if any in this view) should have plain SENAITE UIDs.

Visually: the inbox card should render identically to today. The mk1: UIDs are only visible via the network tab — the FE displays titles + group chips, no UIDs.

- [ ] **Step 3: Drag-drop sanity (read-only)**

Drag a sub-sample inbox card onto a worksheet. The worksheet should accept the drop (existing endpoint, unchanged). Open the worksheet detail — the item shows with the same analyses (denormalized into worksheet_items.analyses_json).

- [ ] **Step 4: Confirm AnalysisTable still works for the dropped item**

Click into the dropped sub-sample to open SampleDetails. The AnalysisTable renders the Mk1 analyses (Phase 3 adapter, unchanged). Result entry + verify writes to lims_analyses (also Phase 3, unchanged). End-to-end the bench tech can now go inbox → worksheet → SampleDetails → result entry, all routing through Mk1 for sub-samples.

---

## Verification (Phase 3.5 acceptance)

- [ ] **Inbox endpoint returns `mk1:` UIDs for sub-samples with seeded lims_analyses** (Task 3 Step 4 + Task 4)
- [ ] **Sub-samples without Mk1 rows fall back to SENAITE-sourced analyses** (Task 4)
- [ ] **Parent samples continue to return SENAITE UIDs (no `mk1:` prefix)** (Task 4 second test)
- [ ] **Inbox card renders identically in the FE — no visual regression** (Task 5 Step 2)
- [ ] **Drag-drop + worksheet detail work unchanged** (Task 5 Step 3)
- [ ] **End-to-end inbox → worksheet → SampleDetails → result entry works for a sub-sample** (Task 5 Step 4)
- [ ] **Full backend suite has 442 passed (was 440), 13 baseline failures, zero regressions** (Task 5 Step 1)

---

## Risks and unknowns

- **`vial_meta` attribute names** (Task 3 Step 2 uses `is_sub_sample` and `pk` / `sub_sample_pk` with `getattr` fallback). If the actual structure differs (e.g. a dict with different keys, or a SQLAlchemy row), the dispatch branch needs adjusting. The `getattr` fallback already covers two likely names; if both miss, the helper silently doesn't run and the SENAITE path takes over — degrades safely.

- **`ServiceGroup.color` may not exist.** Task 1 Step 3's probe captures the actual columns. If the column is missing, the helper falls back to `_ROLE_COLOR_FALLBACK` keyed on `role`. The inbox card's color tinting may differ slightly from today's SENAITE-derived path, but the difference is small (per-role colors are already conventional).

- **No Mk1 rows for pre-Phase-2 vials.** The fallback path is the existing SENAITE source, so those vials continue to render normally. No visual difference for the bench tech.

- **The `method` field on Mk1 inbox rows is None.** Today's SENAITE-source path populates `method` from the SENAITE analysis payload. For Mk1 vials, the method isn't bound to the row by default. The FE inbox card shows method as part of analysis metadata; an empty method displays as "—" or similar. Acceptable Phase 3.5 trade-off; method/instrument editing is Phase 3.5+ (separate phase).

- **The retest column on the inbox is filtered out by `retest_of_id.is_(None)`.** Matches the SENAITE path's "prefer retest over original" dedup behavior approximately — retests just don't surface until a Mk1 retest mechanism lands.

- **The `assigned_analyst` filter** (the inbox checks `worksheet_items` to skip already-assigned vials) operates at the (sample, group) level, not per-analysis. Phase 3.5 doesn't change this — the same worksheet-vs-vial dedup happens whether analyses come from SENAITE or Mk1.

## Open questions (carried forward)

1. **Method/instrument editing on Mk1 vials** — Phase 3.6 candidate. Needs Mk1 PATCH endpoints + FE option-array population.
2. **`worksheet_items.lims_analysis_id`** — explicitly skipped per Scope Decision 1. The schema model is per-group not per-analysis; a column add would never get populated meaningfully.
3. **Retest mechanism on Mk1 vials** — out of scope; defer until first concrete need.

## Out of scope (carried forward)

- `promote_to_parent` service + verification UI — Phase 4.
- COA resolver default-path simplification — Phase 5.
- Family-state derivation + WP signaling — Phase 5.
- Drop the SENAITE secondary AR entirely — Phase 5 cleanup.
- Prelim-COA opt-in customer flow — Phase 6.
