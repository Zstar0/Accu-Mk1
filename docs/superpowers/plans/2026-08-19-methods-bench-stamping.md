# Methods Bench Stamping Implementation Plan (slice 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the bench stamp method + instrument onto native analysis rows — worksheet-level apply, per-row override, optional stamping at result submission — with reported states protected and mixed worksheets never mis-stamped.

**Architecture:** One new FK on `worksheet_items`, a state guard + no-commit core extracted inside `set_method_instrument`, a bulk worksheet verb that fans the core out coverage-scoped, and optional `method_id`/`instrument_id` on the existing transitions submit. FE: apply controls in the worksheet drawer, stamped-value display, and a per-row override dialog.

**Tech Stack:** as slice 1. Worksheet drawer FE **does** use react-query (`['worksheets-list']`); AnalysisTable/SampleDetails surfaces use load-callback props.

**Spec:** `docs/superpowers/specs/2026-08-19-methods-bench-stamping-design.md` (R0, R5–R8 binding).

## Recon corrections to the spec (cite these, don't re-derive)

1. **The native submit path is `POST /api/lims-analyses/{analysis_id}/transitions`** with `TransitionRequest {kind:'submit', result_value, reason}` (`routes.py:428`, `schemas.py:85`) — the spec's "SubmitResultRequest" maps to `TransitionRequest`. There are THREE FE callers of `setAnalysisResult` (inline cell editor via `use-analysis-editing.ts`, `VialsQuickLookDialog` reusing `AnalysisTable`, and `SenaiteResultsView.handleAutoFill` bypassing the hook) — all send only `{kind, result_value, reason}` and stay untouched; the new fields are optional.
2. **There is no result-entry form.** Native result entry is an inline cell editor. The spec §4.4's FE half ("method/instrument fields on the result form") is implemented instead as the per-row override affordance (Task 6) — the BE half (optional fields on the transition) is kept verbatim for API-level parity and future UI.
3. **`prep_bridge.py:328` CALLS `set_method_instrument`** — the state guard must keep `unassigned`/`assigned`/`to_be_verified` stampable or the HPLC prep flow breaks (its rows are early-state at stamp time; Task 2 pins this with a test).
4. **`set_method_instrument` commits internally** (`service.py:594` ends with `db.commit()`); the bulk verb and the transition path need a **no-commit core** — Task 2 extracts it.
5. `updateWorksheetItem`'s payload type exists in **three places** (component prop `WorksheetDrawerItems.tsx:68` + `:207`, hook `use-worksheet-drawer.ts:106`, api fn `api.ts:5411`) and the hook's copy is already drifted (missing `prep_status`). Task 5 widens all three.

## Global Constraints

- **R0: zero new SENAITE coupling.** New code reads/writes `worksheet_items.instrument_id` (INT FK) and `lims_analyses.method_id`/`instrument_id` only; `instrument_uid` is frozen legacy for the HPLC lane.
- **Branch:** `feat/methods-bench-stamping` cut from the slice-1 tip, same worktree `C:\tmp\Accu-Mk1-methods` (`git checkout -b feat/methods-bench-stamping`).
- Interpreter, baseline-diff gating, npm-only, JSX typographic quotes, no `backend/.env`: as slice 1's Global Constraints.
- Slice-1 interfaces consumed here: `method_services` Table, `AnalysisServiceResponse.default_method_id` (fail-open), `getMethodServices`, `Instrument.department_id`.

---

### Task 1: `worksheet_items.instrument_id` + payload keys

**Files:**
- Modify: `backend/models.py` (WorksheetItem ~957-983), `backend/database.py` (append before `]` ~1723), `backend/main.py` items payload (~19334-19383) and `PATCH /worksheets/{id}/items/{item_id}` (19923)
- Test: `backend/tests/test_methods_stamping.py` (new; same SQLite+TestClient harness as `tests/test_manage_native_routes.py` — copy its `db_session` fixture and `_client` helper)

**Interfaces:**
- Produces: `WorksheetItem.instrument_id: Optional[int]` FK; items payload gains `"instrument_id": it.instrument_id`; the item PATCH accepts `{"instrument_id": <int|null>}` alongside the existing keys.

- [ ] **Step 1: Failing test**

```python
def test_worksheet_item_instrument_id_roundtrip(client, db_session):
    from models import Worksheet, WorksheetItem, Instrument
    inst = Instrument(name="Agilent 7900 ICP-MS", origin="mk1", active=True)
    ws = Worksheet(title="hm#1", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-1", sample_id="PB-1-S01")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": inst.id})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** — model column:

```python
    # Slice 2 (bench stamping): local-instrument leg. instrument_uid above is
    # the frozen SENAITE-uid leg for the HPLC lane (R0) — both may coexist.
    instrument_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("instruments.id", ondelete="SET NULL"), nullable=True)
```

migration: `"ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS instrument_id INTEGER REFERENCES instruments(id) ON DELETE SET NULL",` — payload: add `"instrument_id": it.instrument_id,` next to the existing `"instrument_uid"` key; item PATCH: read the body's `instrument_id` (validate instrument exists when not null → 400) and set it, mirroring how `instrument_uid` is handled in that route.

- [ ] **Step 4: PASS.** **Step 5: Commit** — `feat(worksheets): local instrument FK on items`.

---

### Task 2: State guard + no-commit core in `set_method_instrument`

**Files:**
- Modify: `backend/lims_analyses/service.py:594-630`
- Test: `backend/tests/test_methods_stamping.py` (extend)

**Interfaces:**
- Produces: `stamp_method_instrument(db, row, *, method_id, instrument_id, user_id) -> bool` — the no-commit core: state-guards, writes the audit transition, returns False on no-op; raises `StateLockedError` (new exception class in `lims_analyses/service.py`, mapped to 409 by `_handle_service_error` — add the mapping in `routes.py`'s handler with body `{"detail": {"code": "state_locked", "review_state": ...}}`). `set_method_instrument` becomes a thin wrapper: load row → core → `db.commit()`.
- STAMPABLE_STATES = `("unassigned", "assigned", "to_be_verified")` (module constant).

- [ ] **Step 1: Failing tests**

```python
_SEQ = iter(range(9100, 9999))


def _mk_vial_row(db, *, state="assigned", keyword="LEAD-PPM"):
    from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample
    n = next(_SEQ)  # unique sample ids per call — LimsSample.sample_id is UNIQUE
    parent = LimsSample(sample_id=f"P-{n}"); db.add(parent); db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-{n}-S01")
    db.add(vial); db.flush()
    svc = AnalysisService(title="Lead", keyword=keyword, origin="mk1", active=True,
                          variance_capable=False)
    db.add(svc); db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                       keyword=keyword, title="Lead", review_state=state,
                       provenance="canonical")
    db.add(row); db.commit()
    return row


def test_stamp_guard_blocks_verified(db_session):
    from lims_analyses import service as svc_mod
    row = _mk_vial_row(db_session, state="verified")
    with pytest.raises(svc_mod.StateLockedError):
        svc_mod.set_method_instrument(db_session, analysis_id=row.id,
                                      method_id=None, instrument_id=None, user_id=None)


def test_stamp_allows_prep_bridge_states(db_session):
    """prep_bridge stamps rows in early states — the guard must not break it."""
    from lims_analyses import service as svc_mod
    for state in ("unassigned", "assigned", "to_be_verified"):
        row = _mk_vial_row(db_session, state=state, keyword=f"K-{state.upper()}")
        got = svc_mod.set_method_instrument(db_session, analysis_id=row.id,
                                            method_id=None, instrument_id=1, user_id=None)
        assert got.instrument_id == 1


def test_patch_method_instrument_409_on_published(client, db_session):
    row = _mk_vial_row(db_session, state="published")
    r = client.patch(f"/api/lims-analyses/{row.id}/method-instrument",
                     json={"method_id": None, "instrument_id": 1})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "state_locked"
```

(Note: `LimsSubSample.parent_sample_pk` / field names — copy the exact constructor kwargs from `tests/test_manage_native_routes.py`'s `world` fixture rather than guessing.)

- [ ] **Step 2: FAIL** (no `StateLockedError`; verified rows currently stamp fine — this test documents the tightening). **Step 3: Implement** in `service.py`:

```python
STAMPABLE_STATES = ("unassigned", "assigned", "to_be_verified")


class StateLockedError(Exception):
    """Method/instrument restamp attempted on a reported or dead row (R7)."""
    def __init__(self, review_state: str):
        super().__init__(f"row is {review_state}; method/instrument locked")
        self.review_state = review_state


def stamp_method_instrument(db, row, *, method_id, instrument_id, user_id) -> bool:
    """No-commit core of set_method_instrument. Guards state (R7), applies the
    pair, writes the audit transition. Returns False on no-op. Callers commit."""
    if row.review_state not in STAMPABLE_STATES:
        raise StateLockedError(row.review_state)
    if row.method_id == method_id and row.instrument_id == instrument_id:
        return False
    before = _snapshot(row)
    row.method_id = method_id
    row.instrument_id = instrument_id
    row.updated_at = datetime.utcnow()
    db.add(LimsAnalysisTransition(
        analysis_id=row.id, from_state=row.review_state, to_state=row.review_state,
        transition_kind="auto", user_id=user_id,
        reason=f"method_id={method_id},instrument_id={instrument_id}",
        details=_deltas(before, row),
    ))
    return True
```

`set_method_instrument` body becomes: `row = get_analysis(db, analysis_id)` → `if stamp_method_instrument(...): db.commit(); db.refresh(row)` → `return row`. In `routes.py:_handle_service_error` add: `if isinstance(e, service.StateLockedError): raise HTTPException(409, {"code": "state_locked", "review_state": e.review_state})` (match the handler's existing raise style exactly).

- [ ] **Step 4: PASS + run the amendment-audit + prep suites** (guard floor: `tests/test_amendment_audit.py` calls `set_method_instrument` at :179/:181/:345 — if those fixtures use non-stampable states, adjust THE TESTS' fixture states only with reviewer sign-off, never the guard; also `tests/test_lims_analyses_service.py`, `tests/test_prep_assignment_stamp.py`): result must match baseline. **Step 5: Commit** — `feat(lims-analyses): state guard + no-commit core for method/instrument stamping`.

---

### Task 3: Optional stamping on the submit transition

**Files:**
- Modify: `backend/lims_analyses/schemas.py:85` (TransitionRequest), `backend/lims_analyses/routes.py:428` (transition route), `backend/lims_analyses/service.py` (`apply_transition` — add optional passthrough)
- Test: extend `test_methods_stamping.py`

**Interfaces:**
- Produces: `TransitionRequest` gains `method_id: Optional[int] = None`, `instrument_id: Optional[int] = None`. `apply_transition(..., method_id=None, instrument_id=None)`: when `kind == "submit"` AND at least one is not None, calls `stamp_method_instrument` on the row BEFORE the state transition, same transaction. Other kinds ignore the fields (400 if provided on a non-submit kind — explicit beats silent).

- [ ] **Step 1: Failing test**

```python
def test_submit_with_method_instrument_stamps_atomically(client, db_session):
    row = _mk_vial_row(db_session, state="assigned")
    mid = client.post("/hplc/methods", json={"name": "ICP-MS E"}).json()["id"]
    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "submit", "result_value": "1.2",
                          "method_id": mid, "instrument_id": None,
                          "reason": "bench-tech result entry"})
    assert r.status_code == 200
    b = r.json()
    assert b["review_state"] == "to_be_verified" and b["method_id"] == mid


def test_non_submit_kind_rejects_stamp_fields(client, db_session):
    row = _mk_vial_row(db_session, state="to_be_verified")
    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "verify", "method_id": 1})
    assert r.status_code == 400
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** — schemas: add the two optional fields with a comment `# slice 2: optional stamping at submit; ignored-forbidden on other kinds`. Route: pass `method_id=req.method_id, instrument_id=req.instrument_id` into `service.apply_transition`. Service: at the top of `apply_transition`, after loading the row:

```python
    if (method_id is not None or instrument_id is not None):
        if kind != "submit":
            raise BadRequestError("method_id/instrument_id only apply to kind='submit'")
        stamp_method_instrument(db, row,
                                method_id=method_id if method_id is not None else row.method_id,
                                instrument_id=instrument_id if instrument_id is not None else row.instrument_id,
                                user_id=user_id)
```

(Partial semantics: a provided field overwrites, an omitted one preserves — matches the prep bridge's existing-value-wins shape. `apply_transition` already commits at its end; the stamp rides that commit.)

- [ ] **Step 4: PASS.** **Step 5: Commit** — `feat(lims-analyses): optional method/instrument stamping on submit`.

---

### Task 4: Bulk worksheet apply — service fn + route

**Files:**
- Create: `backend/lims_analyses/worksheet_stamping.py`
- Modify: `backend/main.py` (new route near the other worksheet verbs, after 19923's PATCH)
- Test: extend `test_methods_stamping.py`

**Interfaces:**
- Produces: `POST /worksheets/{worksheet_id}/apply-method-instrument` body `{"method_id": int, "instrument_id": int, "item_ids": [int] | null}` → 200 `{"stamped": int, "items_updated": int, "skipped_state": [{"analysis_id", "review_state"}], "skipped_uncovered": [{"analysis_id", "keyword"}]}`. 400 when method inactive / instrument inactive / instrument not linked to method via `instrument_methods`. 404 unknown worksheet.
- `apply_method_instrument_to_worksheet(db, *, worksheet, method_id, instrument_id, item_ids, user_id) -> dict` in the new module (route stays thin).

- [ ] **Step 1: Failing test**

```python
def _hm_world(client, db):
    """Worksheet with one HM vial carrying 2 covered analyses + 1 uncovered."""
    from models import (AnalysisService, Instrument, LimsAnalysis, LimsSample,
                        LimsSubSample, Worksheet, WorksheetItem, instrument_methods)
    mid = client.post("/hplc/methods", json={"name": "ICP-MS F", "technique": "ICP-MS"}).json()["id"]
    inst = Instrument(name="7900F", origin="mk1", active=True)
    db.add(inst); db.flush()
    db.execute(instrument_methods.insert().values(instrument_id=inst.id, method_id=mid))
    parent = LimsSample(sample_id="P-9200"); db.add(parent); db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-9200-S01")
    db.add(vial); db.flush()
    rows = {}
    for kw in ("LEAD-PPM", "ARSENIC-PPM", "MOISTURE-KF"):
        s = AnalysisService(title=kw, keyword=kw, origin="mk1", active=True,
                            variance_capable=False)
        db.add(s); db.flush()
        r = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=s.id,
                         keyword=kw, title=kw, review_state="assigned",
                         provenance="canonical")
        db.add(r); db.flush()
        rows[kw] = (s, r)
    client.put(f"/hplc/methods/{mid}/services", json=[
        {"analysis_service_id": rows["LEAD-PPM"][0].id, "is_default": True},
        {"analysis_service_id": rows["ARSENIC-PPM"][0].id, "is_default": True},
    ])
    ws = Worksheet(title="hm#1", status="open"); db.add(ws); db.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-2", sample_id="P-9200-S01")
    db.add(it); db.commit()
    # lims_sub_sample_pk resolution in the payload joins on sample_id — the
    # bulk verb resolves the vial the same way (sub_sample_pk_map idiom).
    return ws, it, inst, mid, rows


def test_bulk_apply_coverage_and_skips(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    # one covered row already verified -> skipped_state
    rows["ARSENIC-PPM"][1].review_state = "verified"; db_session.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": inst.id})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["stamped"] == 1                       # LEAD only
    assert b["items_updated"] == 1
    assert b["skipped_state"][0]["review_state"] == "verified"
    assert b["skipped_uncovered"][0]["keyword"] == "MOISTURE-KF"
    db_session.expire_all()
    assert rows["LEAD-PPM"][1].method_id == mid and rows["LEAD-PPM"][1].instrument_id == inst.id
    assert rows["MOISTURE-KF"][1].method_id is None    # never mis-stamped (R8)
    assert it.instrument_id == inst.id


def test_bulk_apply_unlinked_instrument_400(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    from models import Instrument
    other = Instrument(name="KF-V20", origin="mk1", active=True)
    db_session.add(other); db_session.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": other.id})
    assert r.status_code == 400
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** `worksheet_stamping.py`:

```python
"""Slice 2: worksheet-level method/instrument apply (R6/R7/R8).

Coverage-scoped: only analyses whose service the method covers are stamped;
only STAMPABLE_STATES rows are touched; everything else is reported, never
silent. One transaction — the caller's route commits once.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from lims_analyses.service import (STAMPABLE_STATES, StateLockedError,
                                   stamp_method_instrument)
from models import (LimsAnalysis, LimsSubSample, WorksheetItem, method_services)


def apply_method_instrument_to_worksheet(db: Session, *, worksheet, method_id: int,
                                         instrument_id: int, item_ids, user_id) -> dict:
    covered = {r[0] for r in db.execute(
        select(method_services.c.analysis_service_id)
        .where(method_services.c.method_id == method_id)).all()}
    items = [it for it in db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet.id)
    ).scalars().all() if item_ids is None or it.id in set(item_ids)]

    stamped, items_updated = 0, 0
    skipped_state, skipped_uncovered = [], []
    for it in items:
        vial = db.execute(select(LimsSubSample).where(
            LimsSubSample.sample_id == it.sample_id)).scalar_one_or_none()
        if vial is None:
            continue  # parent-sample item (no vial) — nothing to stamp
        rows = db.execute(select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == vial.id)).scalars().all()
        for row in rows:
            if row.analysis_service_id not in covered:
                skipped_uncovered.append({"analysis_id": row.id, "keyword": row.keyword})
                continue
            if row.review_state not in STAMPABLE_STATES:
                skipped_state.append({"analysis_id": row.id, "review_state": row.review_state})
                continue
            if stamp_method_instrument(db, row, method_id=method_id,
                                       instrument_id=instrument_id, user_id=user_id):
                stamped += 1
        it.instrument_id = instrument_id
        items_updated += 1
    return {"stamped": stamped, "items_updated": items_updated,
            "skipped_state": skipped_state, "skipped_uncovered": skipped_uncovered}
```

Route in main.py (validations first — method exists+active 400, instrument exists+active 400, `instrument_methods` link exists 400 naming both, worksheet 404 — then call, then `db.commit()`, return the dict). Request model `WorksheetApplyMethodInstrument(BaseModel): method_id: int; instrument_id: int; item_ids: Optional[list[int]] = None`.

- [ ] **Step 4: PASS.** **Step 5: Commit** — `feat(worksheets): bulk method/instrument apply, coverage-scoped with skip reports`.

---

### Task 5: Stamped values on the worksheet payload + FE plumbing

**Files:**
- Modify: `backend/main.py` items payload (19334-19383): add `stamped_method_name`, `stamped_instrument_name` per item
- Modify: `src/lib/api.ts` — `updateWorksheetItem` payload type (5411) + new `applyWorksheetMethodInstrument`; the worksheet item TS type (find `method_name` in api.ts types)
- Modify: `src/hooks/use-worksheet-drawer.ts:106` (widen the drifted type; add the apply mutation)
- Modify: `src/components/hplc/WorksheetDrawerItems.tsx:66-68/:207` (prop types) — display only in this task
- Test: extend `backend/tests/test_methods_stamping.py`; FE compile gate

**Interfaces:**
- Produces (payload, per item): `"stamped_method_name": str|None` and `"stamped_instrument_name": str|None` — the DISTINCT stamped values across the item's vial analyses: one distinct non-null value → that name; >1 distinct → the literal `"mixed"`; none → `None`. Display precedence downstream: `stamped_method_name ?? method_name ?? '—'`.
- `applyWorksheetMethodInstrument(worksheetId, body: {method_id: number; instrument_id: number; item_ids?: number[]}): Promise<{stamped: number; items_updated: number; skipped_state: {analysis_id: number; review_state: string}[]; skipped_uncovered: {analysis_id: number; keyword: string}[]}>`
- `updateWorksheetItem` data type widened to `{ instrument_uid?: string; prep_status?: string; instrument_id?: number | null }` in ALL THREE declaration sites (recon correction 5).

- [ ] **Step 1: Failing backend test**

```python
def test_payload_carries_stamped_names(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                json={"method_id": mid, "instrument_id": inst.id})
    item = client.get("/worksheets").json()[0]["items"][0]
    assert item["stamped_method_name"] == "ICP-MS F"
    assert item["stamped_instrument_name"] == "7900F"
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** — in the payload builder, alongside the existing per-worksheet maps, build one grouped query keyed by `lims_sub_sample_pk` over that worksheet's vials: `select(LimsAnalysis.lims_sub_sample_pk, HplcMethod.name, Instrument.name) ... outerjoin` collecting distinct non-null names per vial pk into two dicts; resolve each to name/`"mixed"`/`None`; emit both keys in the item dict. (Same eager-map idiom as `sub_sample_pk_map` directly above — never per-item queries in the loop.) FE: widen the three type sites, add the api fn (copy `updateWorksheetItem`'s fetch shape, POST), add `stamped_method_name`/`stamped_instrument_name` to the item type.

- [ ] **Step 4: backend PASS; `npx tsc --noEmit` clean.** **Step 5: Commit** — `feat(worksheets): stamped method/instrument names on the drawer payload`.

---

### Task 6: FE — drawer apply controls, stamped display, native instrument select

**Files:**
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (apply bar), `src/components/hplc/WorksheetDrawerItems.tsx` (display + native select), `src/hooks/use-worksheet-drawer.ts` (apply mutation)
- Test: `src/test/worksheet-apply-method.test.tsx` (new)

**Interfaces:** Consumes Task 5's api fn + payload keys; slice 1's `getMethods` (active + `services` for coverage display) and `getInstruments`.

- [ ] **Step 1: Failing test** (mock `@/lib/api` + `sonner`; the drawer needs a `QueryClientProvider` wrapper — copy the `wrapper` helper from `src/test/analysis-profiles-coa-display.test.tsx`; seed the worksheets query by mocking the api fn the `['worksheets-list']` query calls — find it in `use-worksheet-drawer.ts` and mock it to return one worksheet with the two items below):

```tsx
const ITEM_STAMPED = { id: 1, sample_id: 'P-9200-S01', lims_sub_sample_pk: 7, peptide_id: null,
  stamped_method_name: 'ICP-MS F', stamped_instrument_name: '7900F',
  method_name: null, instrument_uid: null, instrument_id: 3, prep_status: 'ready' }
const ITEM_HPLC = { id: 2, sample_id: 'P-9300-S01', lims_sub_sample_pk: 8, peptide_id: 44,
  stamped_method_name: null, stamped_instrument_name: null,
  method_name: 'Method 2', instrument_uid: 'uid-a', instrument_id: null, prep_status: 'ready' }

it('renders stamped method over the derived one, keeps HPLC derivation', async () => {
  render(<WorksheetDrawer />, { wrapper })   // adjust to the drawer's real mount props
  expect(await screen.findByText('ICP-MS F')).toBeInTheDocument()
  expect(screen.getByText('Method 2')).toBeInTheDocument()
})

it('applies a run context to the worksheet', async () => {
  vi.mocked(applyWorksheetMethodInstrument).mockResolvedValue(
    { stamped: 3, items_updated: 2, skipped_state: [], skipped_uncovered: [] })
  const user = userEvent.setup()
  render(<WorksheetDrawer />, { wrapper })
  await user.click(await screen.findByRole('combobox', { name: /method/i }))
  await user.click(screen.getByRole('option', { name: /icp-ms f/i }))
  await user.click(screen.getByRole('combobox', { name: /instrument/i }))
  await user.click(screen.getByRole('option', { name: /7900f/i }))
  await user.click(screen.getByRole('button', { name: /apply to all/i }))
  await waitFor(() => expect(applyWorksheetMethodInstrument).toHaveBeenCalledWith(
    expect.any(Number), expect.objectContaining({ instrument_id: expect.any(Number) })))
  expect(vi.mocked(toast.success).mock.calls[0][0]).toContain('3')
})
```

- [ ] **Step 2: FAIL.** **Step 3: Implement.**
  - **Apply bar** (WorksheetDrawer, above the items list): a compact row — method `Select` (options: active methods; label `code ?? name`), instrument `Select` (options: chosen method's linked instruments via `instrument_ids` ∩ active; disabled until a method is chosen), `Apply to all` Button. *Declared deviation from spec §4.6: the "same-department instruments sort first" nicety is dropped — the list is already method-scoped (typically 1–3 rows), so department sorting adds a worksheet-department resolution for near-zero value; revisit if instrument fleets grow.* On click → `applyMutation.mutate(...)`; onSuccess → `toast.success(\`Stamped ${res.stamped} analyses on ${res.items_updated} items\` + (res.skipped_state.length ? ` — ${res.skipped_state.length} locked` : '') + (res.skipped_uncovered.length ? `, ${res.skipped_uncovered.length} not covered by this method` : ''))` + `queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })`.
  - **Items row**: Method cell renders `item.stamped_method_name ?? item.method_name ?? '—'`; instrument cell for items with `lims_sub_sample_pk` and no `peptide_id` (native lane) switches the Select to local instruments keyed by **id** writing `onUpdateItem(item.id, { instrument_id: Number(value) })`; the HPLC lane (has `peptide_id`) keeps the existing `senaite_uid` select untouched.
  - Mutation in the hook: mirror `updateItemMutation`'s shape for `applyMutation` (`mutationFn: ({worksheetId, body}) => applyWorksheetMethodInstrument(worksheetId, body)`), same invalidation + error toast idiom.

- [ ] **Step 4: vitest PASS.** **Step 5: Commit** — `feat(worksheets-ui): run-context apply + stamped display + native instrument select`.

---

### Task 7: FE — per-row method/instrument override

**Files:**
- Create: `src/components/senaite/SetMethodInstrumentDialog.tsx`
- Modify: `src/components/senaite/AnalysisTable.tsx` (row actions for `mk1:` rows), `src/lib/api.ts` (PATCH fn)
- Test: `src/test/set-method-instrument-dialog.test.tsx` (new)

**Interfaces:**
- Produces: `setAnalysisMethodInstrument(analysisId: number, body: {method_id: number | null; instrument_id: number | null}): Promise<unknown>` → `PATCH /api/lims-analyses/{id}/method-instrument` (endpoint pre-exists; slice 2's guard makes it 409 on locked states — surface `detail.code === 'state_locked'` as a toast error "Result is already reported — corrections go through retract/amend").
- Dialog: props `{analysisId: number; serviceId: number; currentMethodId: number | null; currentInstrumentId: number | null; open; onOpenChange; onSaved: () => void}` — method Select (active methods covering `serviceId` via each method's `services`, default first), instrument Select (chosen method's instruments), Save. Trigger: a `Wrench`-icon action on `mk1:` rows in states unassigned/assigned/to_be_verified (reuse the row-verb affordance pattern already present in AnalysisTable for promote).

- [ ] **Step 1: Failing test**

```tsx
const METHOD = { id: 11, name: 'ICP-MS G', code: 'AM-G-1', active: true,
  instrument_ids: [3], instruments: [{ id: 3, name: '7900G', model: null }],
  services: [{ analysis_service_id: 5, keyword: 'LEAD-PPM', title: 'Lead', is_default: true }] }

it('preselects the default method and saves', async () => {
  vi.mocked(getMethods).mockResolvedValue([METHOD] as never)
  vi.mocked(setAnalysisMethodInstrument).mockResolvedValue({} as never)
  const user = userEvent.setup()
  render(<SetMethodInstrumentDialog analysisId={99} serviceId={5}
    currentMethodId={null} currentInstrumentId={null}
    open onOpenChange={() => {}} onSaved={vi.fn()} />)
  expect(await screen.findByText(/am-g-1|icp-ms g/i)).toBeInTheDocument() // default preselected
  await user.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(setAnalysisMethodInstrument).toHaveBeenCalledWith(99,
    expect.objectContaining({ method_id: 11 })))
})

it('surfaces state_locked as a friendly error', async () => {
  vi.mocked(getMethods).mockResolvedValue([METHOD] as never)
  vi.mocked(setAnalysisMethodInstrument).mockRejectedValue(
    Object.assign(new Error('409'), { detail: { code: 'state_locked' } }))
  const user = userEvent.setup()
  render(<SetMethodInstrumentDialog analysisId={99} serviceId={5}
    currentMethodId={null} currentInstrumentId={null}
    open onOpenChange={() => {}} onSaved={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: /save/i }))
  await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled())
})
```

(The api fn should attach the parsed error body onto the thrown Error so the dialog can read `detail.code` — mirror however `createMethod` surfaces `err?.detail`, extending it to keep the object when it isn't a string.)
- [ ] **Step 2: FAIL. Step 3: Implement.** (Dialog: shadcn Dialog, two Selects + Save/Cancel; on save `await setAnalysisMethodInstrument(...)`, `toast.success('Method/instrument updated')`, `onSaved()`.) In AnalysisTable, the action only renders when `uid.startsWith('mk1:')` and the row's state is stampable; `onSaved` → the table's existing `onTransitionComplete`/reload callback prop.
- [ ] **Step 4: vitest PASS + run the existing AnalysisTable suites** (`npx vitest run src/test/ --silent` filtered to analysis-table tests if named; at minimum `npx tsc --noEmit`). **Step 5: Commit** — `feat(analyses-ui): per-row method/instrument override`.

---

### Task 8: Gates

- [ ] Backend: full suite → failure-set diff vs `../.baseline_ids.txt` (captured in slice 1) → empty.
- [ ] FE: `npx vitest run src/test/worksheet-apply-method.test.tsx src/test/set-method-instrument-dialog.test.tsx` + the worksheet suites (`src/components/hplc/__tests__/worksheet-sample-filter.test.ts`, `src/test/worksheets-inbox-lanes.test.tsx`) → pass/baseline; `npx tsc --noEmit`; eslint+prettier on touched files.
- [ ] Commit stragglers. No push.
