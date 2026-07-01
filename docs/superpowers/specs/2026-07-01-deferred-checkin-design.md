# Deferred Check-In (Complete Check-In) · Design

*Created 2026-07-01. Branch: `feat/order-first-checkin-boxing`. Status: approved, ready for implementation plan.*
*Production-behavior change (the SENAITE receive transition) — signed off by the Handler.*

## Context

Today, checking in the **first vial** of a not-yet-received sample immediately transitions that sample
`sample_due → sample_received` in SENAITE (inside `useReceiveWizard.saveNewVial`). Techs want to work through
**all** of an order's samples — add vials, sort boxes — and only then hit a single **"Complete Check-In"**
button that transitions the samples to received. The same deferral should apply to single-sample check-in.

### What the investigation established (so the deferral is safe)

- **The receive fires only in `saveNewVial`, on the first vial of a pre-received parent.** For **container-mode**
  samples — which is *every* order-first sample (born before check-in) — it is a **bare** receive
  (`receiveSenaiteSample(uid, sample_id, null, null)`; photos live on the vials), after which S01 is created
  normally via `createSubSample`.
- **Vial creation does NOT depend on the receive.** `createSubSample` succeeds on a `sample_due` parent — the
  native path never touches SENAITE; the legacy secondary-AR path checks contact/UID, not received-state. So
  removing the auto-receive does not block vial saving.
- **`receiveSenaiteSample` is idempotent** — re-called on an already-received sample it skips the transition and
  returns success. A batch "receive all" is safe to re-run.
- **Container-mode determination is independent of the receive** — decided at mount by `ensure_sample_row`
  from `review_state`, before any vial/receive. Deferring doesn't change it.
- **The legacy "first-vial-becomes-parent" branch is dead code for this flow** — it only fires for samples
  already received before the cutover, which never appear in the `sample_due` list. Leave it untouched.

## Confirmed decisions

- **Complete Check-In receives only samples with ≥1 vial** (`sub_sample_count > 0`); 0-vial samples stay `due`.
- **Unified:** single-sample check-in also defers — its Finish becomes "Complete Check-In".
- **Vialed-but-not-completed samples stay `sample_due`** (visible as due to SENAITE/other consumers) until
  Complete Check-In — intended.

---

## Design

### 1. Remove the auto-receive from vial saving
In `src/components/intake/ReceiveWizard/useReceiveWizard.ts`, in the `isFirstVialEver` block of `saveNewVial`
(and the equivalent in the bulk saver if present), **delete the container-branch receive**:
```ts
// REMOVE these two lines from the `if (isContainer)` branch:
await receiveSenaiteSample(parent.uid, parent.sample_id, null, null)
setParentReceivedThisSession(true)
// The branch then just falls through to `createSubSample(...)`, so S01 is still created.
```
Leave the **legacy `else` branch untouched** (unreachable in the order-first flow). Confirm nothing else in the
hook breaks from `parentReceivedThisSession` no longer being set on first vial (it stays `false`; the parent is
genuinely still `sample_due` until Complete Check-In — that is correct).

### 2. `completeCheckIn` — receive the vialed samples
A small frontend helper that receives a set of samples, skipping any with no vials:
```ts
// receives each sample that has >=1 vial; bare receive (photos are on vials); idempotent.
async function completeCheckIn(
  samples: { uid: string; sampleId: string; vialCount: number }[]
): Promise<void> {
  for (const s of samples) {
    if (s.vialCount > 0) {
      await receiveSenaiteSample(s.uid, s.sampleId, null, null)
    }
  }
}
```
(Location: a small module e.g. `src/lib/complete-checkin.ts`, or colocated — the plan decides. The vial count
per sample comes from `listSubSamples(sampleId).parent.sub_sample_count`, already queried by the rail /
available via the wizard's loaded vials.)

### 3. Order flow — `OrderReceiveSession`
- Pass a new `orderManaged` flag to the embedded `ReceiveWizard` (so its Finish does **not** receive — the
  order session owns the receive; prevents double-receive).
- Add a prominent **"Complete Check-In"** button in the session **header**. On click it runs `completeCheckIn`
  over the order's samples (using each sample's `uid`, `sample_id`, and its vial count — the rail already
  queries `sub_sample_count` per sample; reuse those), then calls `onClose` (which refreshes the due list, so
  received samples drop off). Show a spinner + disable while running.
- Show a count so it's clear which samples get received, e.g. **"Complete Check-In · N of M samples"**
  (M = order samples, N = those with ≥1 vial). 0-vial samples stay due.

### 4. Single-sample — `ReceiveWizard` standalone / Manage Sub-Samples
- Add prop `orderManaged?: boolean` (default `false`).
- When **not** `orderManaged`: the footer **Finish** button becomes **"Complete Check-In"** — on click, if the
  parent has ≥1 vial (`wiz.vials.length > 0`), call `receiveSenaiteSample(parent.uid, parent.sample_id, null,
  null)` (spinner while running), then `onClose`. If 0 vials, it just closes (no receive), labeled "Finish".
- When `orderManaged`: keep today's behavior — Finish just navigates/closes (no receive).

---

## Files

| File | Change |
|---|---|
| `src/components/intake/ReceiveWizard/useReceiveWizard.ts` | Remove the container-branch `receiveSenaiteSample` + `setParentReceivedThisSession(true)` from the first-vial block (in `saveNewVial` and the bulk saver). Legacy branch untouched. |
| `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` | `orderManaged?: boolean` prop; Finish → "Complete Check-In" (receive parent when ≥1 vial + close) unless `orderManaged`. |
| `src/components/intake/OrderReceiveSession.tsx` | Pass `orderManaged` to the wizard; add a header "Complete Check-In" button running `completeCheckIn` over vialed order samples, then close+refresh. |
| `src/lib/complete-checkin.ts` (new, or colocated) | `completeCheckIn(samples)` helper. |
| Reused | `receiveSenaiteSample` (`@/lib/api`), the rail's per-sample `listSubSamples` vial counts. No backend change. |

## Testing

- `useReceiveWizard`: saving the first vial **does not** call `receiveSenaiteSample` (mock it → assert not
  called); S01 is still created (`createSubSample` called). Subsequent vials unaffected.
- `completeCheckIn`: receives samples with `vialCount > 0`, **skips** 0-vial samples (mock `receiveSenaiteSample`
  → assert called only for vialed samples).
- `OrderReceiveSession`: the header "Complete Check-In" button calls `completeCheckIn` over the order's vialed
  samples then closes; the embedded wizard is passed `orderManaged` so its Finish does not receive.
- `ReceiveWizard`: with `orderManaged` false + ≥1 vial, Finish/"Complete Check-In" calls `receiveSenaiteSample`
  for the parent then closes; with 0 vials it just closes; with `orderManaged` true it never receives.

## ISO 17025 alignment

The receive transition (and its SENAITE audit-trail entry) still occurs — just batched at Complete Check-In,
attributed and timestamped there. Traceability/identity of samples and vials is unchanged. Known knock-on:
turnaround analytics will read the `receive` transition time as the batch completion moment rather than
first-vial time (accepted).

## Out of scope (YAGNI)

- Backfilling a per-sample receive photo onto the parent AR (photos live on vials; container receive is bare).
- Changing the legacy "first-vial-becomes-parent" path (dead for order-first).
- A partial/undo "un-complete" (receive is one-way; idempotent re-run covers retries).
- Auto-completing when all samples have vials (explicit button only).
