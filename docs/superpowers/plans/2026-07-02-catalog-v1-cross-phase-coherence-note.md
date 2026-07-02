# Test-Catalog v1 — Cross-Phase Coherence Note (authoritative; owned by orchestrator, NOT delegated)

This is the shared spine for the 1D/1E/1F plans. Every drafting agent MUST obey it. It encodes the sequencing + risk reasoning that spans phases and therefore cannot be decided inside a single-phase draft.

## Phase state (ground truth, 2026-07-02)
- **1A** foundation — DONE, PR #31 (`feat/test-catalog-v1`).
- **1B** safety-coupling (Dept-keyed mirror/inbox/stale-cleanup, fail-closed) — DONE, PR #31.
- **1C** sterility tenant seed + COA-gate→Department + parity harness — DONE on `feat/catalog-departments-admin` (Mk1-only, additive, legacy literals still live).
- **1E-a** coabuilder native sterility READ endpoint + value shadow-diff — DONE on same branch (additive, nothing cut; SENAITE still authoritative).
- **REMAINING:** 1D, 1E (rest), 1F.

## THE SEAM-CUT ORDER (mandatory; spec §199-206, §245). Reversing it silently drops sterility results from customer COAs.
1. **Seam 1 — coabuilder can READ native sterility** (Accu-Mk1). ✅ 1E-a.
2. **Seam 4 — coabuilder anchors on a native sample** (sterility-only orders have no SENAITE AR). MUST land before seam 2. → 1E.
3. **Seam 3 — order→AR: route sterility natively; sterility-only → no SENAITE AR.** → 1D (IS). Independent of the COA-source flip, but the native-analysis it creates is what seam 2 later relies on.
4. **Seam 2 — CUT the promote SENAITE write-back; native Mk1 parent-tier row becomes canonical.** LAST. Gated on: (a) seams 1+4 done, (b) the **rendered-COA both-ways diff** (top control) passing on real samples, (c) Handler sign-off. → 1E.

**Top control (spec §206, §244):** before cutting seam 2, render the sterility COA section BOTH ways (SENAITE-sourced vs Accu-Mk1-sourced) on real samples and diff; cut only on match, retain the diff as ISO-17025 7.11.2 evidence. NOTE (from 1E-a): the value-level shadow-diff is NOT this control — native/SENAITE share write-provenance on promoted samples, so a value match is near-tautological. The real control is the **rendered-COA** diff produced once the COA is actually built from the native source (the flip). This is a 1E deliverable.

## Demand-parity scope (spans 1C/1D/1F; spec §247). Do not let any plan flag new behavior as a regression.
- Parity is asserted ONLY against the **legacy `sterility_pcr` order flag → 2 vials** (`derive_base_demand`). Every in-flight/existing sample was ordered "always both."
- **New per-product single-product orders legitimately demand 1 vial** (PCR-only → 1, USP71-only → 1, both → 2). This is NEW behavior that arrives with 1D (per-product flags) + 1F (WP products), and is EXPLICITLY OUTSIDE the parity set.
- Catalog demand = Σ(`vials_required` of each ordered assignable unit), THEN variance composes on top (never fold variance into base).

## Additive-cutover discipline (spec locked #7)
- New paths live ALONGSIDE old maps; cut per-path behind a parity gate; keep old maps as fallback until proven, retire in Phase 2 (NOT in this phase).
- 1C left `derive_base_demand`/`ROLE_TO_KEYWORDS` LIVE. 1D adds the catalog-driven path and shadow-reads it against the legacy path before flipping.

## Non-negotiables every plan must carry
- **Additive only; production-behavior changes need Handler sign-off.** The seam-2 cut, order→AR change, COA-source flip, and WP product publish are production-behavior → each is a **Handler-gated checkpoint**, not an autonomous step.
- **JWT_SECRET identical across IS + coabuilder + WP** — unchanged by this work (the native S2S read uses a SEPARATE `X-Service-Token`, not JWT). Any COA-verification-code path must keep JWT parity.
- **LIMS tables use `lims_` prefix.** Cross-repo edits obey each repo's CLAUDE.md (coabuilder: gitnexus impact-analysis before editing existing symbols; IS: ruff+mypy gate).
- Stage EXPLICIT paths; never `git add -A` (worktrees carry unrelated dirty files, e.g. `package-lock.json`).

## Open decisions = Handler/lab GATES (mark inline in plans; do NOT invent answers)
- **G1 — USP<71> `result_options` terminology.** 1C seeded a placeholder (`No Growth`/`Growth` in the tenant migration; the 1E-a normalizer used `Pass`/`Fail` mapping). LAB must confirm the reported wording before the split ships. Refinable via `PATCH /analysis-services/{id}/result-type` (no migration).
- **G2 — USP<71> preliminary→amend COA flow (spec #8, RESOLVED as practice, UNBUILT).** Issue PCR as a preliminary certificate, then re-publish (amend) when USP<71> completes. MUST be a traceable amendment (7.5.2), not a silent overwrite. Native amendment mechanics are a 1E design item + Handler confirm.
- **G3 — PCR rendered-COA shadow-diff sign-off.** PCR has an existing SENAITE-sourced render → diff Accu-Mk1 vs SENAITE on real samples, Handler signs the match. USP<71> has NO prior render → validate against expected output + lab sign-off (net-new COA content).
- **G4 — WP product pricing** (1F) — lab/accounting, not an engineering blocker; product scaffolding can proceed with placeholder price gated on real price before publish.
- **G5 — prod `Endotoxin` group existence** (spec #5) — seed must be derived from LIVE group rows, not hardcoded; verify against prod before any prod deploy. (Robustness: ENDO-LAL → Microbiology dept regardless.)

## What is SAFE to execute autonomously tonight (isolation test: verifiable end-to-end, alone, no cross-repo contract change)
- **1D Task 1 — the catalog-driven demand shadow-resolver + parity harness** (Mk1-internal, additive, dead-until-wired): a new `catalog`-reading demand function + a test asserting it reproduces `derive_base_demand` for the legacy `sterility_pcr` flag (→2) and yields per-product 1-vial for single-product (new, outside parity set). Verifiable on the devbox `catalog` stack. This is the spec's mandated shadow-read (safe-cutover step 3), built ahead of the cut.
- Everything past it (IS order→AR, coabuilder flip, seam-2 cut, WP publish) = PLAN ONLY tonight, Handler-gated.

## Execution environment
- Test bed = devbox `catalog` stack (already mounts `feat/catalog-departments-admin`). Loop: edit laptop `C:/tmp/Accu-Mk1-departments` → push → `ssh devbox git -C ~/worktrees/Accu-Mk1-departments pull` → pytest in `accumark-catalog-accu-mk1-backend` (`pip install -q pytest` first). Migration changes need `docker restart`.
- Cross-repo 1D/1E execution (when sign-off'd) uses a FRESH isolated stack per the 1E-a plan (mount Mk1 + IS + coabuilder worktrees).

## Cross-phase reconciliation (post-draft, 2026-07-02) — orchestrator-owned
The three plans (1D/1E/1F) were drafted in parallel and reconciled here. They are mutually consistent; the seams that span phases and MUST be co-designed (not decided inside one plan):

1. **Native-sample contract spans 1D ↔ 1E (JOINT design — do not build either half alone).** 1D Task 4 *creates* the native sterility sample at order time (new Mk1 `POST /samples/native-sterility` ingest; parent-id scheme + analyte source + mixed-anchor semantics = 1D gates **DG-1..3**). 1E Task C's coabuilder anchor *reads* that sample and needs sample **metadata** (client, name, matrix, dates), which the 1E-a results endpoint does NOT expose (1E flags this as an unlocked cross-repo interface). → The parent-id/`mk1://` identity scheme and the sample-metadata read must be designed as ONE contract when either 1D-Task-4 or 1E-Task-C is executed. Whichever runs first pins it; the other consumes it. Neither is autonomous (both Handler-gated).

2. **Per-product flag contract spans 1D ↔ 1F.** 1D owns the canonical key strings (`sterility_pcr` kept + `sterility_usp71` added, tri-state `bool|None` for back-compat). 1F emits them but must NOT invent them — 1F treats them as `<1D:...>` placeholders until 1D lands, and breaks the WP binary `endotoxin|sterility` addon model to carry explicit per-product keys (the `sterility(pcr)`≠`sterility_pcr` name-strip mismatch is the load-bearing WP fix). 1F is HARD-blocked on 1D deploying.

3. **Seam ordering across phases (already in §12-18) confirmed consistent:** seam1 read (1E-a ✅) → seam3 order→AR native (1D, independent of the flip but produces the AR-less samples seam4 anchors + the native analysis seam2 relies on) → seam4 anchor (1E Task C) → seam2 write-back cut (1E Task D, LAST, gated on the signed rendered-COA diff G3).

4. **Full gate register (owners):** G1 USP<71> result_options wording (LAB) · G2 USP<71> preliminary→amend mechanics (HANDLER+LAB) · G3 rendered-COA both-ways diff sign-off (HANDLER+LAB) · G4 WP pricing (HANDLER/accounting) · G5 prod Endotoxin group existence (HANDLER, verify vs prod) · G6 in-flight mixed samples' legacy SENAITE STER-PCR line at the cut (HANDLER) · plus 1D's DG-1..3 (native-ingest design), G-WP-USP71 (WooCommerce cart key), G-ORD (are sterility-only orders orderable today), G-BASE (IS 1D branch base — currently `subsample-features`, confirm vs master before branching).
