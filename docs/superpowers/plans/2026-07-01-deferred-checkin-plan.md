# Deferred Check-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox steps. Executed by devbox `claude -p` workers in `~/worktrees/Accu-Mk1-boxing` on `feat/order-first-checkin-boxing`; read the code for exact signatures where this says "read/mirror".

**Goal:** Stop auto-receiving on first vial; add an explicit "Complete Check-In" that transitions vialed samples `sample_due → sample_received` — at order level (OrderReceiveSession) and for single-sample check-in (ReceiveWizard).

**Architecture:** Frontend-only, no backend change. Remove the container-branch `receiveSenaiteSample` from vial saving; add a `completeCheckIn` helper + a header button in the order session + a Finish→Complete-Check-In in the standalone wizard. `receiveSenaiteSample` is idempotent; container photos live on vials (bare receive). Spec: `docs/superpowers/specs/2026-07-01-deferred-checkin-design.md`.

**Tech Stack:** React 19 + TS + TanStack Query + shadcn/ui + Vitest.

## Global Constraints

- **npm only.** Frontend gates: `docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx tsc --noEmit"` (0 errors) + `... npx vitest run <scoped>`.
- **Production-behavior change (signed off).** Keep it tightly scoped to the deferral; change no other behavior.
- **Path-limit every commit** (`git commit -- <files>`); never `git add -A`/`.`. **Never stage `vite.config.ts` / `package-lock.json`.**
- The **4 known-failing frontend tests are stale** (`wordpress-url` ×2, `App.test`, `peptide-requests-list`) — ignore.
- No backend change (reuse `receiveSenaiteSample`).

---

## Task 1: Remove the auto-receive from vial saving

**Files:** Modify `src/components/intake/ReceiveWizard/useReceiveWizard.ts`; Test `src/components/intake/ReceiveWizard/__tests__/useReceiveWizard.test.ts` (create if absent; if the hook is hard to test in isolation, add a focused test that mocks `@/lib/api`).

**Interfaces:** `saveNewVial` (and the bulk saver) keep their signatures; they simply no longer call `receiveSenaiteSample`.

- [ ] **Step 1: Read** `useReceiveWizard.ts` — find the `isFirstVialEver` block (~lines 119-157) with the `if (isContainer) { await receiveSenaiteSample(parent.uid, parent.sample_id, null, null); setParentReceivedThisSession(true) }` container branch and the legacy `else` branch. Find the bulk saver's equivalent.
- [ ] **Step 2: Write the failing test** — mock `@/lib/api` (`receiveSenaiteSample`, `createSubSample`, `ensureParentSampleRow`). Drive `saveNewVial` for a `sample_due` container parent's first vial; assert **`receiveSenaiteSample` is NOT called** and **`createSubSample` IS called** (S01 still created). (If a hook harness doesn't exist, render a tiny test component using the hook, or test the extracted save logic.)
- [ ] **Step 3: Run → FAIL** (`... npx vitest run <test>`) — currently `receiveSenaiteSample` IS called.
- [ ] **Step 4: Implement** — in the container branch of the `isFirstVialEver` block, DELETE `await receiveSenaiteSample(parent.uid, parent.sample_id, null, null)` and its `setParentReceivedThisSession(true)`, so the branch falls straight through to `createSubSample`. Do the same in the bulk saver if it has a matching first-vial receive. **Leave the legacy `else` branch (first-vial-becomes-parent) untouched.** If `receiveSenaiteSample` becomes an unused import, remove it.
- [ ] **Step 5: Run → PASS.** Also `npx tsc --noEmit` → 0 errors (watch for now-unused vars). Run `... npx vitest run src/components/intake/ReceiveWizard` to confirm no wizard regressions.
- [ ] **Step 6: Commit:** `git commit -- src/components/intake/ReceiveWizard/useReceiveWizard.ts <test> -m "feat(checkin): stop auto-receiving on first vial (defer to Complete Check-In)"`

## Task 2: `completeCheckIn` helper

**Files:** Create `src/lib/complete-checkin.ts`; Test `src/lib/__tests__/complete-checkin.test.ts` (or repo convention `src/test/`).

**Interfaces:**
```ts
import { receiveSenaiteSample } from '@/lib/api'
export interface CompleteCheckInSample { uid: string; sampleId: string; vialCount: number }
// Receives each sample with vialCount > 0 (bare receive; photos are on vials). Idempotent per sample.
export async function completeCheckIn(samples: CompleteCheckInSample[]): Promise<void>
```

- [ ] **Step 1: Write failing tests** (mock `@/lib/api`):
  ```ts
  it('receives only samples with >=1 vial', async () => {
    await completeCheckIn([
      { uid: 'u1', sampleId: 'PB-0075', vialCount: 2 },
      { uid: 'u2', sampleId: 'BW-0014', vialCount: 0 },
    ])
    expect(receiveSenaiteSample).toHaveBeenCalledWith('u1', 'PB-0075', null, null)
    expect(receiveSenaiteSample).not.toHaveBeenCalledWith('u2', 'BW-0014', null, null)
    expect(receiveSenaiteSample).toHaveBeenCalledTimes(1)
  })
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** per the Interfaces (a simple loop; `for` with `await` so calls are sequential — SENAITE's single Zope core dislikes parallel bursts).
- [ ] **Step 4: Run → PASS; `tsc` 0 errors.**
- [ ] **Step 5: Commit:** `git commit -- src/lib/complete-checkin.ts <test> -m "feat(checkin): completeCheckIn helper (receive vialed samples, idempotent)"`

## Task 3: Standalone wizard — Finish → "Complete Check-In"

**Files:** Modify `src/components/intake/ReceiveWizard/ReceiveWizard.tsx`; Test `src/components/intake/ReceiveWizard/__tests__/ReceiveWizard.test.tsx`.

**Interfaces:** add prop `orderManaged?: boolean` (default `false`). Consumes `completeCheckIn` (or `receiveSenaiteSample` directly for the single parent) + `parent` (uid, sample_id) + `wiz.vials`.

- [ ] **Step 1: Read** the Finish button (~lines 140-145: `finishButton = <Button onClick={onClose}>Finish</Button>`, gated by `showFinish`) and how `parent`/`wiz.vials` are available.
- [ ] **Step 2: Write failing tests** (mock `@/lib/api`):
  - `orderManaged` false + `wiz.vials.length > 0`: clicking the finish button calls `receiveSenaiteSample(parent.uid, parent.sample_id, null, null)` then `onClose`; label is "Complete Check-In".
  - `orderManaged` false + 0 vials: clicking just calls `onClose`, no `receiveSenaiteSample`; label "Finish".
  - `orderManaged` true: clicking calls `onClose`, never `receiveSenaiteSample`.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** — add `orderManaged` prop. Replace the finish handler: if `!orderManaged && wiz.vials.length > 0` → an async handler that sets a local `completing` spinner, `await receiveSenaiteSample(parent.uid, parent.sample_id, null, null)`, then `onClose()`; label "Complete Check-In". Else (`orderManaged` or 0 vials) → `onClose`, label "Finish". Disable while `completing`.
- [ ] **Step 5: Run → PASS; `tsc` 0 errors; `... npx vitest run src/components/intake/ReceiveWizard`.**
- [ ] **Step 6: Commit:** `git commit -- src/components/intake/ReceiveWizard/ReceiveWizard.tsx <test> -m "feat(checkin): single-sample Finish becomes Complete Check-In (receives when vialed)"`

## Task 4: Order flow — header "Complete Check-In" button

**Files:** Modify `src/components/intake/OrderReceiveSession.tsx`; Test `src/components/intake/__tests__/OrderReceiveSession.test.tsx`.

**Interfaces:** pass `orderManaged` to the embedded `<ReceiveWizard>`; add a header button calling `completeCheckIn`.

- [ ] **Step 1: Read** OrderReceiveSession — the header, the embedded `<ReceiveWizard parent=… hideSampleInfo boxing=… />`, and the per-sample vial-count source (the rail's `listSubSamples(sample.id)` → `parent.sub_sample_count`; the rail computes `received = sub_sample_count > 0`).
- [ ] **Step 2: Write failing test** (mock `@/lib/api` + `completeCheckIn`, or mock `receiveSenaiteSample`): render with an order whose samples have known vial counts (mock `listSubSamples`); clicking the header **"Complete Check-In"** calls `completeCheckIn` with the order's samples (uid/sampleId/vialCount) and then `onClose`; assert the embedded `ReceiveWizard` receives `orderManaged` (mock it to capture props).
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement:**
  - Pass `orderManaged` (true) to the embedded `<ReceiveWizard>`.
  - Gather per-sample vial counts for the order's samples (reuse/lift the rail's `listSubSamples` queries — e.g. a `useQueries` over `order.samples` keyed `['order-rail-sub-count', id]` matching the rail — or read `parent.sub_sample_count`). Build `CompleteCheckInSample[]` = `{ uid: s.uid, sampleId: s.id, vialCount }`.
  - Add a header **"Complete Check-In"** button showing `N of M samples` (N = vialCount>0, M = total). On click: `completing` spinner → `await completeCheckIn(samples)` → `onClose()`. Disable while running; disable entirely if N === 0.
- [ ] **Step 5: Run → PASS; `tsc` 0 errors; `... npx vitest run src/components/intake`.**
- [ ] **Step 6: Commit:** `git commit -- src/components/intake/OrderReceiveSession.tsx <test> -m "feat(checkin): order-level Complete Check-In button (receives vialed samples)"`
- [ ] **Step 7: e2e (HMR):** add vials to an order's samples (parent stays Due), sort boxes, hit Complete Check-In → the vialed samples transition to received and drop off the due list; a 0-vial sample stays Due. Report for UAT.

---

## Self-review (plan author)

- **Spec coverage:** remove auto-receive (T1) · completeCheckIn only-vialed (T2) · single-sample Finish→Complete (T3) · order header button + orderManaged (T4). Decisions (only-vialed, unified, stays-due) all mapped. No backend change (per spec).
- **Type consistency:** `CompleteCheckInSample`/`completeCheckIn` (T2) consumed by T3(optionally)/T4; `orderManaged` prop (T3) passed by T4; `receiveSenaiteSample(uid, sampleId, null, null)` signature consistent across T1-removal, T3, T4.
- **Open reads for the worker:** the exact `isFirstVialEver` block + bulk saver in `useReceiveWizard.ts`; the Finish button + `wiz.vials` in `ReceiveWizard.tsx`; the rail's vial-count query keys in `OrderReceiveSession.tsx`.
- **Risk watch:** don't touch the legacy branch; ensure removing the receive doesn't leave `parentReceivedThisSession` consumers broken (it just stays false — correct, parent is still due).
