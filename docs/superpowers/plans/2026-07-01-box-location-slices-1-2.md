# Box Location Tracking — Slices 1+2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Box labels' QR encodes the bare box id (scanner-station contract), and boxes gain an end-of-life close-out (vials return to Unboxed, box stamped stored) surfaced on a new minimal Active Boxes page.

**Architecture:** Additive changes to the existing boxing vertical (`backend/boxes/*`, `lims_boxes`, `BoxStep`/`BoxLabelTemplate`). Two new columns via the repo's idempotent-ALTER migration list, two new endpoints on the existing `/api/boxes` router, one new page wired into the section/subsection navigation switch. Spec: `docs/superpowers/specs/2026-07-01-box-location-tracking-design.md` (slices 1–2 only; location events/bench scanning are deferred and NOT in this plan).

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TanStack Query + shadcn (frontend), pytest / vitest.

## Global Constraints

- Branch: `feat/order-first-checkin-boxing` in worktree `~/worktrees/Accu-Mk1-boxing` (devbox). All work is pre-prod on this branch.
- Additive only. Do not refactor or reformat surrounding code. `delete_box` (the mistake-path trashcan) stays exactly as-is.
- npm only; no new dependencies (frontend or backend).
- NEVER stage `vite.config.ts` or `package-lock.json`. Path-limit every `git add` / `git commit` (`git commit -m "…" -- <paths>`); never `git add -A` / `git add .`.
- Verify in-container (this host has no local toolchain): prefix docker with `DOCKER_CONTEXT=default`. Frontend: `docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx tsc --noEmit"` and `npx vitest run <paths>`. Backend: `docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest 2>/dev/null; python -m pytest <paths> -q"`.
- After ANY backend change: `docker restart accumark-boxing-accu-mk1-backend` (new columns/endpoints are invisible until restart; the ALTER migrations run at startup).
- Ignore the 3 known-stale frontend suites (`wordpress-url`, `App.test`, `peptide-requests-list`) — never open or "fix" them; only task-scoped tests must pass.
- Backend test DB is built from `Base.metadata` (create_all), so model changes alone make tests work; the `database.py` ALTER lines are for live DBs.

---

### Task 1: QR encodes the bare box id (Slice 1)

**Files:**
- Create: `src/components/intake/ReceiveWizard/__tests__/BoxLabelTemplate.test.tsx`
- Modify: `src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx`
- Modify: `src/components/intake/ReceiveWizard/BoxStep.tsx` (the single `<BoxLabelTemplate …/>` usage inside `BoxCard`)

**Interfaces:**
- Consumes: existing `BoxLabelTemplate` props (`labelCode`, `clientName`, `role`, `vialCount`), `LimsBox.id` available on the `box` object in `BoxCard`.
- Produces: `BoxLabelTemplate` now REQUIRES `boxId: number`. Scanner stations will parse the QR payload as the numeric `lims_boxes.id` verbatim (spec: pre-change labels encode the label code, which is non-numeric — stations reject those with a "reprint this label" message; no code here handles that).

- [ ] **Step 1: Write the failing test**

Create `src/components/intake/ReceiveWizard/__tests__/BoxLabelTemplate.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BoxLabelTemplate } from '../BoxLabelTemplate'

// The QR lib renders opaque SVG paths; stub it so the encoded value is assertable.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}))

describe('BoxLabelTemplate', () => {
  it('encodes the bare box id in the QR — the scanner-station contract', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="WP-3267-1" clientName="Acme" role="hplc" vialCount={4} />,
    )
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe('137')
  })

  it('still prints the human label code as text', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="WP-3267-1" clientName={null} role="ster" vialCount={2} />,
    )
    expect(screen.getByText('WP-3267-1')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DOCKER_CONTEXT=default docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx vitest run src/components/intake/ReceiveWizard/__tests__/BoxLabelTemplate.test.tsx 2>&1 | tail -8"`
Expected: FAIL — TS error / `boxId` unknown prop and `data-value` is `"WP-3267-1"` (QR currently encodes the label code).

- [ ] **Step 3: Implement**

In `BoxLabelTemplate.tsx`, add `boxId` to Props and repoint the QR (leave everything else, including `boxLabelLines` if present in the file's siblings, untouched):

```tsx
interface Props {
  boxId: number                // lims_boxes.id — the QR payload (scanner-station contract)
  labelCode: string            // e.g. "WP-20066-3" (verbatim; never prefixed)
  clientName: string | null
  role: 'hplc' | 'endo' | 'ster'
  vialCount: number
}

export function BoxLabelTemplate({ boxId, labelCode, clientName, role, vialCount }: Props) {
  return (
    <div className="label">
      {/* QR carries the bare numeric box id, NOT the label code: it must stay
          sparse enough to scan at 5.5mm on the 2"x1/4" strip, and bench
          stations append their own bench id when they call check-in. */}
      <QRCodeSVG value={String(boxId)} size={64} level="M" marginSize={2} />
```

(The rest of the JSX is unchanged.)

In `BoxStep.tsx`, inside `BoxCard`'s print button `onClick`, add the prop:

```tsx
            onClick={() => { void printBox(box.id); printNode(
              <BoxLabelTemplate boxId={box.id} labelCode={box.label_code} clientName={clientName}
                role={box.role} vialCount={box.vial_count} />,
            ) }}>
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `DOCKER_CONTEXT=default docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx vitest run src/components/intake/ReceiveWizard/__tests__/BoxLabelTemplate.test.tsx src/components/intake/ReceiveWizard/__tests__/BoxStep.test.tsx src/test/box-step.test.tsx 2>&1 | tail -8 && npx tsc --noEmit"`
Expected: all suites PASS, tsc exit 0. (If BoxStep.test.tsx renders the real BoxLabelTemplate anywhere, tsc/tests will flag the missing prop — fix the test's usage by adding `boxId` with the mock box's id, nothing else.)

- [ ] **Step 5: Commit**

```bash
git add -- src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx src/components/intake/ReceiveWizard/BoxStep.tsx src/components/intake/ReceiveWizard/__tests__/BoxLabelTemplate.test.tsx
git commit -m "feat(boxing): box label QR encodes the bare box id (scanner-station contract)" -- src/components/intake/ReceiveWizard/BoxLabelTemplate.tsx src/components/intake/ReceiveWizard/BoxStep.tsx src/components/intake/ReceiveWizard/__tests__/BoxLabelTemplate.test.tsx
```

---

### Task 2: `stored_at` columns + close-out service (Slice 2, backend core)

**Files:**
- Modify: `backend/models.py` (`class LimsBox`, ~line 817)
- Modify: `backend/database.py` (the idempotent `ALTER TABLE … IF NOT EXISTS` migrations list, ~line 133)
- Modify: `backend/boxes/service.py`
- Test: `backend/tests/test_boxes_service.py`

**Interfaces:**
- Consumes: existing `service.next_box / assign_vials / list_for_order`, `LimsSubSample.box_id`, the `_vial(db, parent, n, role)` helper already defined in `test_boxes_service.py` (READ the file first and reuse its exact helpers/fixtures).
- Produces: `LimsBox.stored_at: Optional[datetime]`, `LimsBox.stored_by_user_id: Optional[int]`; `service.close_box(db, box_id: int, user_id: int) -> LimsBox` (LookupError if missing; idempotent); `service.list_active(db) -> List[LimsBox]`; `service.list_for_order` now returns only non-stored boxes. Task 3 depends on these exact names.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_boxes_service.py`, mirroring its existing style)

```python
def test_close_box_unassigns_vials_and_stamps_stored(db):
    p = LimsSample(sample_id="P-0603", external_lims_uid="u-603")
    db.add(p); db.flush()
    v = _vial(db, p, 1, "hplc")
    box = service.next_box(db, "WP-20067", "hplc", user_id=1)
    service.assign_vials(db, box.id, [v.sample_id])
    closed = service.close_box(db, box.id, user_id=7)
    assert closed.stored_at is not None
    assert closed.stored_by_user_id == 7
    db.refresh(v)
    assert v.box_id is None
    # Closed boxes drop off both active surfaces.
    assert service.list_for_order(db, "WP-20067") == []
    assert box.id not in [b.id for b in service.list_active(db)]


def test_close_box_is_idempotent(db):
    box = service.next_box(db, "WP-20068", "hplc", user_id=1)
    first = service.close_box(db, box.id, user_id=1)
    stamp = first.stored_at
    again = service.close_box(db, box.id, user_id=2)
    # Re-close is a no-op: first closer's stamp wins, nothing re-stamps.
    assert again.stored_at == stamp
    assert again.stored_by_user_id == 1


def test_close_missing_box_raises_lookup(db):
    with pytest.raises(LookupError):
        service.close_box(db, 9999, user_id=1)


def test_list_active_excludes_stored(db):
    a = service.next_box(db, "WP-20069", "hplc", user_id=1)
    b = service.next_box(db, "WP-20069", "endo", user_id=1)
    service.close_box(db, a.id, user_id=1)
    ids = [x.id for x in service.list_active(db)]
    assert a.id not in ids
    assert b.id in ids
```

- [ ] **Step 2: Run to verify they fail**

Run: `DOCKER_CONTEXT=default docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest 2>/dev/null; python -m pytest tests/test_boxes_service.py -q 2>&1 | tail -5"`
Expected: FAIL — `AttributeError: module … has no attribute 'close_box'` (existing tests still pass).

- [ ] **Step 3: Implement**

`backend/models.py` — add to `class LimsBox` after `printed_by_user_id`:

```python
    # Close-out ("stored"): set when the box's testing life ends and it goes to
    # storage; its vials were returned to Unboxed. Active box = stored_at IS NULL.
    stored_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    stored_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
```

`backend/database.py` — append to the idempotent migrations list (exact style of its neighbors):

```python
        "ALTER TABLE lims_boxes ADD COLUMN IF NOT EXISTS stored_at TIMESTAMP",
        "ALTER TABLE lims_boxes ADD COLUMN IF NOT EXISTS stored_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL",
```

`backend/boxes/service.py` — add after `delete_box` (both `update` and `datetime` are already imported in this file):

```python
def close_box(db: Session, box_id: int, user_id: int) -> LimsBox:
    """Close out a box: return all its vials to Unboxed and stamp stored_at.

    The normal end-of-life path — unlike delete_box (the mistake path) it keeps
    the box row as a record. Idempotent: closing an already-stored box is a
    no-op (first closer's stamp wins). Raises LookupError if the box is missing.
    """
    box = db.get(LimsBox, box_id)
    if box is None:
        raise LookupError(f"box {box_id} not found")
    if box.stored_at is None:
        db.execute(
            update(LimsSubSample).where(LimsSubSample.box_id == box_id).values(box_id=None)
        )
        box.stored_at = datetime.utcnow()
        box.stored_by_user_id = user_id
        db.commit()
    db.refresh(box)
    return box


def list_active(db: Session) -> List[LimsBox]:
    """All boxes not yet closed out to storage, oldest first (Active Boxes page)."""
    return list(
        db.scalars(
            select(LimsBox).where(LimsBox.stored_at.is_(None)).order_by(LimsBox.created_at, LimsBox.id)
        )
    )
```

`backend/boxes/service.py` — in `list_for_order`, add the active filter so closed boxes leave the check-in Boxing tab:

```python
            select(LimsBox)
            .where(LimsBox.order_key == order_key, LimsBox.stored_at.is_(None))
            .order_by(LimsBox.box_number)
```

- [ ] **Step 4: Run to verify green**

Run: same pytest command as Step 2.
Expected: ALL tests in `tests/test_boxes_service.py` pass (new + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add -- backend/models.py backend/database.py backend/boxes/service.py backend/tests/test_boxes_service.py
git commit -m "feat(boxing): stored_at close-out columns + close_box/list_active service" -- backend/models.py backend/database.py backend/boxes/service.py backend/tests/test_boxes_service.py
```

---

### Task 3: close + active-list endpoints (Slice 2, backend API)

**Files:**
- Modify: `backend/boxes/schemas.py` (`BoxResponse`)
- Modify: `backend/boxes/routes.py`
- Test: `backend/tests/test_boxes_routes.py`

**Interfaces:**
- Consumes: `service.close_box(db, box_id, user_id)` and `service.list_active(db)` from Task 2; existing `_serialize`, router, and the test file's client/patch fixtures (READ `test_boxes_routes.py` first and mirror its exact patch targets and any box-stub helper it uses).
- Produces: `GET /api/boxes/active -> list[BoxResponse]`; `POST /api/boxes/{box_id}/close -> BoxResponse` (404 on unknown box); `BoxResponse` gains `created_at: datetime | None` and `stored_at: datetime | None`. Task 4's frontend calls these exact paths/shapes.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_boxes_routes.py` — it uses a module-level `client = TestClient(app)`, an autouse `override_auth` fixture (`get_current_user -> MagicMock(id=1)`), and `MagicMock` fake boxes with `patch("boxes.routes.service.…")`)

```python
def test_list_active_boxes_returns_200():
    with patch("boxes.routes.service.list_active", return_value=[]):
        resp = client.get("/api/boxes/active")
    assert resp.status_code == 200
    assert resp.json() == []


def test_close_box_returns_stored_box():
    fake = MagicMock(id=13, order_key="WP-3267", box_number=1, role="hplc",
                     printed_at=None, created_at=None, stored_at="2026-07-01T13:00:00")
    with patch("boxes.routes.service.close_box", return_value=fake) as m, \
         patch("boxes.routes.service.box_label_code", return_value="WP-3267-1"), \
         patch("boxes.routes.service.vial_count", return_value=0):
        resp = client.post("/api/boxes/13/close")
    assert resp.status_code == 200
    assert resp.json()["stored_at"] is not None
    m.assert_called_once()
    assert m.call_args.args[1] == 13 or m.call_args.kwargs.get("box_id") == 13


def test_close_missing_box_returns_404():
    with patch("boxes.routes.service.close_box", side_effect=LookupError("box 99 not found")):
        resp = client.post("/api/boxes/99/close")
    assert resp.status_code == 404
```

**Cross-impact you MUST also fix in this task:** `BoxResponse` gaining `created_at`/`stored_at` makes `_serialize` read those attributes off the fake boxes in EXISTING tests (e.g. `test_create_box_returns_label_code` builds `MagicMock(id=3, order_key="WP-20066", box_number=2, role="hplc", printed_at=None)`). A bare MagicMock attribute is a MagicMock — pydantic's `Optional[datetime]` rejects it. Add `created_at=None, stored_at=None` to every existing MagicMock fake box that flows through `_serialize` in this file.

- [ ] **Step 2: Run to verify they fail**

Run: `DOCKER_CONTEXT=default docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest 2>/dev/null; python -m pytest tests/test_boxes_routes.py -q 2>&1 | tail -5"`
Expected: FAIL — 404s/AttributeError for the missing routes.

- [ ] **Step 3: Implement**

`backend/boxes/schemas.py` — add to `BoxResponse` (import `datetime`/`Optional` if not present; mirror how `printed_at` is typed):

```python
    created_at: Optional[datetime] = None
    stored_at: Optional[datetime] = None
```

`backend/boxes/routes.py` — extend `_serialize`'s constructor call:

```python
        created_at=box.created_at,
        stored_at=box.stored_at,
```

and add the two routes. Put `GET /active` directly after the existing `GET ""` list route (no dynamic GET exists, but keep static-before-dynamic ordering as a convention); put `close` next to `delete_box`:

```python
@router.get("/active", response_model=list[BoxResponse])
def list_active_boxes(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Every box not yet closed out to storage, across all orders."""
    return [_serialize(db, b) for b in service.list_active(db)]
```

```python
@router.post("/{box_id}/close", response_model=BoxResponse)
def close_box(box_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Close out a box: vials return to Unboxed, the box is stamped stored.
    Idempotent — re-closing a stored box is a no-op."""
    try:
        box = service.close_box(db, box_id, user_id=user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _serialize(db, box)
```

- [ ] **Step 4: Run to verify green, then restart the backend**

Run: same pytest command as Step 2 — all `tests/test_boxes_routes.py` pass.
Then: `DOCKER_CONTEXT=default docker restart accumark-boxing-accu-mk1-backend` and wait for healthy (`docker inspect -f '{{.State.Health.Status}}' accumark-boxing-accu-mk1-backend` → `healthy`). This runs the new ALTERs and exposes the routes for Task 4's live page.

- [ ] **Step 5: Commit**

```bash
git add -- backend/boxes/schemas.py backend/boxes/routes.py backend/tests/test_boxes_routes.py
git commit -m "feat(boxing): GET /api/boxes/active + POST /api/boxes/{id}/close endpoints" -- backend/boxes/schemas.py backend/boxes/routes.py backend/tests/test_boxes_routes.py
```

---

### Task 4: Active Boxes page + navigation (Slice 2, frontend)

**Files:**
- Modify: `src/lib/api.ts` (extend `LimsBox`, add `listActiveBoxes`/`closeBox`, fix one stale comment)
- Modify: `src/store/ui-store.ts` (`SenaiteSubSection` union, ~line 18)
- Modify: `src/components/layout/AppSidebar.tsx` (senaite group subItems, ~line 76)
- Modify: `src/components/layout/MainWindowContent.tsx` (senaite case)
- Create: `src/components/intake/ActiveBoxesPage.tsx`
- Test: `src/components/intake/__tests__/ActiveBoxesPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/boxes/active` and `POST /api/boxes/{box_id}/close` from Task 3; `apiFetch` from `src/lib/api.ts`; `roleBadgeClass`/`roleTextClass` from `@/lib/assignment-colors`; shadcn `Table`? — READ how a simple existing page (e.g. `src/components/hplc/InstrumentsPage.tsx`) lays out a list and mirror its idiom; use `@/components/ui/alert-dialog` for the Close confirm.
- Produces: `<ActiveBoxesPage />` reachable via sidebar Analysis → Boxes (`navigateTo('senaite', 'boxes')`).

- [ ] **Step 1: Write the failing test**

Create `src/components/intake/__tests__/ActiveBoxesPage.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveBoxesPage } from '../ActiveBoxesPage'
import { listActiveBoxes, closeBox } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  listActiveBoxes: vi.fn(),
  closeBox: vi.fn(),
}))
const mockList = vi.mocked(listActiveBoxes)
const mockClose = vi.mocked(closeBox)

const box = {
  id: 13,
  order_key: 'WP-3267',
  box_number: 1,
  role: 'hplc' as const,
  label_code: 'WP-3267-1',
  vial_count: 2,
  printed_at: null,
  created_at: '2026-07-01T12:00:00',
  stored_at: null,
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ActiveBoxesPage />
    </QueryClientProvider>,
  )
}

describe('ActiveBoxesPage', () => {
  beforeEach(() => {
    mockList.mockReset()
    mockClose.mockReset()
  })

  it('renders active boxes with label, order, and vial count', async () => {
    mockList.mockResolvedValue([box])
    renderPage()
    expect(await screen.findByText('WP-3267-1')).toBeInTheDocument()
    expect(screen.getByText('WP-3267')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('Close asks for confirmation, then calls closeBox with the box id', async () => {
    mockList.mockResolvedValue([box])
    mockClose.mockResolvedValue({ ...box, vial_count: 0, stored_at: '2026-07-01T13:00:00' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /close/i }))
    // Confirm dialog: closeBox NOT called yet.
    expect(mockClose).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /return vials|confirm/i }))
    await waitFor(() => expect(mockClose).toHaveBeenCalledWith(13))
  })

  it('shows the empty state when no boxes are active', async () => {
    mockList.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/no active boxes/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DOCKER_CONTEXT=default docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx vitest run src/components/intake/__tests__/ActiveBoxesPage.test.tsx 2>&1 | tail -8"`
Expected: FAIL — module `../ActiveBoxesPage` not found.

- [ ] **Step 3: Implement**

`src/lib/api.ts` — extend the `LimsBox` interface:

```ts
export interface LimsBox {
  id: number
  order_key: string
  box_number: number
  role: 'hplc' | 'endo' | 'ster'
  label_code: string
  vial_count: number
  printed_at: string | null
  created_at: string | null
  stored_at: string | null
}
```

add below `deleteBox` (and while in the file, fix `deleteBox`'s stale doc comment — it still says "Backend rejects with 409 if the box still holds vials"; since `62ebb50` delete force-returns vials. New comment: `/** Delete a box outright (mistake path): its vials return to Unboxed. */`):

```ts
/** All boxes not yet closed out to storage, across all orders. */
export async function listActiveBoxes(): Promise<LimsBox[]> {
  return apiFetch<LimsBox[]>('/api/boxes/active')
}

/** Close out a box (end-of-life): vials return to Unboxed, box is stamped
 *  stored and drops off active surfaces. Idempotent on the backend. */
export async function closeBox(boxId: number): Promise<LimsBox> {
  return apiFetch<LimsBox>(`/api/boxes/${boxId}/close`, { method: 'POST' })
}
```

`src/store/ui-store.ts` — extend the union:

```ts
export type SenaiteSubSection =
  | 'samples'
  | 'event-log'
  | 'sample-details'
  | 'receive-sample'
  | 'boxes'
```

`src/components/layout/AppSidebar.tsx` — in the `senaite` group's `subItems`, after `receive-sample`:

```ts
      { id: 'boxes', label: 'Boxes' },
```

`src/components/layout/MainWindowContent.tsx` — import `{ ActiveBoxesPage } from '@/components/intake/ActiveBoxesPage'` and add to the `senaite` case before the default return:

```tsx
        if (activeSubSection === 'boxes') return <ActiveBoxesPage />
```

Create `src/components/intake/ActiveBoxesPage.tsx`:

```tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { closeBox, listActiveBoxes, type LimsBox } from '@/lib/api'
import { roleBadgeClass, roleTextClass } from '@/lib/assignment-colors'

const ROLE_LABEL: Record<string, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility' }

/** All not-yet-stored boxes across orders. Minimal slice-2 surface: list +
 *  Close action. Location / last-scan / history columns arrive with the
 *  deferred bench-scan slices (see the box-location-tracking spec). */
export function ActiveBoxesPage() {
  const qc = useQueryClient()
  const [closing, setClosing] = useState<LimsBox | null>(null)

  const boxesQ = useQuery({ queryKey: ['active-boxes'], queryFn: listActiveBoxes })
  const closeM = useMutation({
    mutationFn: (boxId: number) => closeBox(boxId),
    onSuccess: async () => {
      setClosing(null)
      await qc.invalidateQueries({ queryKey: ['active-boxes'] })
    },
  })

  const boxes = boxesQ.data ?? []

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <Archive className="h-5 w-5" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Active Boxes</h2>
      </div>

      {boxesQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!boxesQ.isLoading && boxes.length === 0 && (
        <div className="text-sm text-muted-foreground">No active boxes.</div>
      )}

      {boxes.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4">Label</th>
              <th className="py-2 pr-4">Order</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Vials</th>
              <th className="py-2 pr-4">Created</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {boxes.map(b => (
              <tr key={b.id} className="border-b">
                <td className={`py-2 pr-4 font-mono font-semibold ${roleTextClass(b.role)}`}>{b.label_code}</td>
                <td className="py-2 pr-4">{b.order_key}</td>
                <td className="py-2 pr-4">
                  <span className={`rounded px-2 py-0.5 text-xs ${roleBadgeClass(b.role)}`}>
                    {ROLE_LABEL[b.role] ?? b.role}
                  </span>
                </td>
                <td className="py-2 pr-4">{b.vial_count}</td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}
                </td>
                <td className="py-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => setClosing(b)}>
                    Close
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AlertDialog open={closing !== null} onOpenChange={open => { if (!open) setClosing(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {closing?.label_code}?</AlertDialogTitle>
            <AlertDialogDescription>
              {closing?.vial_count ?? 0} vial(s) will be returned to Unboxed and the box
              marked stored. The physical box goes back to the check-in desk for reuse.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={closeM.isPending}
              onClick={() => { if (closing) closeM.mutate(closing.id) }}
            >
              Return vials &amp; close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

(If `@/components/ui/alert-dialog` exports differ, READ the file and adjust import names only — the repo has `src/components/ui/alert-dialog.tsx`.)

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `DOCKER_CONTEXT=default docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx vitest run src/components/intake/__tests__/ActiveBoxesPage.test.tsx 2>&1 | tail -8 && npx tsc --noEmit"`
Expected: 3 tests PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add -- src/lib/api.ts src/store/ui-store.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/components/intake/ActiveBoxesPage.tsx src/components/intake/__tests__/ActiveBoxesPage.test.tsx
git commit -m "feat(boxing): Active Boxes page with close-out action (Analysis > Boxes)" -- src/lib/api.ts src/store/ui-store.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/components/intake/ActiveBoxesPage.tsx src/components/intake/__tests__/ActiveBoxesPage.test.tsx
```

---

## Out of scope (deferred slices — do NOT build)

- `lims_box_location_events` table, `POST /api/boxes/{id}/location`, bench/storage scan handling, location/history columns on the Active Boxes page — all blocked on the Department/Bench hierarchy (`bench_id` interface).
- Scanner-station software and the non-numeric-QR "reprint this label" rejection message (station-side behavior).
