# Catalog 1E — coabuilder SENAITE-Source Flip + Seam-2/Seam-4 Cut + USP<71> Amend Flow (STRUCTURED SKELETON, Handler-gated) Implementation Plan

> **For agentic workers:** This is the **highest-risk phase in the catalog effort.** Its failure mode (spec §281) is *"a wrong sterility result on a customer certificate — the single worst failure in this effort, above the HPLC-leak."* This document is a **structured skeleton, NOT an executable plan.** It fixes the mandatory task order, states known interfaces, and marks **every unresolved decision inline as a `⛔ HANDLER/LAB GATE`**. Do **NOT** execute it autonomously. Do **NOT** invent answers to the gates. Steps that depend on an open gate describe the *shape* of the work and stop at the gate — they do not ship speculative code. Execution of any task here requires an explicit Handler go/no-go per task.

**Goal:** Flip coabuilder's sterility COA section from the SENAITE source to the native Accu-Mk1 source (behind a flag), prove it with a **rendered-COA both-ways diff** on real samples, add a **native-sample anchor** so sterility-only orders (no SENAITE AR) can be built, then — and only then — **cut the promote SENAITE write-back** so the native Mk1 parent-tier row becomes canonical. Add the **USP<71> preliminary→amend** COA flow as a traceable amendment.

**Architecture:** Cross-repo (coabuilder + Accu-Mk1), building directly on **1E-a** (seam 1 — coabuilder can already *read* native sterility via `AccumkClient`/`normalize_native_sterility` + a value shadow-diff). 1E converts that read capability into a *rendering source*, adds the AR-less anchor, and severs the write-back. The seam-cut order is load-bearing and mandatory (see below). HPLC stays SENAITE-sourced throughout; the two sources continue to merge in coabuilder into one certificate.

**Tech Stack:** Python 3 — coabuilder (`requests` + existing `senaite_client`/`addon_parsing` render path, pytest) and Accu-Mk1 backend (FastAPI + SQLAlchemy, pytest). No frontend, no WordPress in 1E.

---

## ⛔ THE MANDATORY SEAM-CUT ORDER (read first — reversing it silently drops sterility results from customer COAs)

Per coherence note §12-18 and spec §199-206/§245, the seams must be cut in this exact order:

1. **Seam 1 — coabuilder can READ native sterility.** ✅ **DONE in 1E-a** (`AccumkClient`, `normalize_native_sterility`, value shadow-diff; SENAITE still authoritative).
2. **Seam 4 — coabuilder anchors on a native Accu-Mk1 sample** (sterility-only orders have no SENAITE AR). **→ 1E Task C. MUST land before seam 2.**
3. **Seam 3 — order→AR: IS routes sterility natively; sterility-only → no SENAITE AR. → 1D (integration-service), separate plan.** Independent of the COA-source flip, but the native analysis it creates is what seam 2 relies on, and the AR-less samples it produces are what seam 4 exists to anchor.
4. **Seam 2 — CUT the promote SENAITE write-back; the native Mk1 parent-tier row becomes canonical. → 1E Task D. LAST.** Gated on: (a) seams 1+4 done, (b) the **rendered-COA both-ways diff** (top control) passing + signed on real samples, (c) explicit Handler sign-off.

**Why the order is load-bearing:** if seam 2 (write-back cut) is done *before* coabuilder can source and render sterility natively (Task A) and anchor AR-less samples (Task C), the value stops flowing to SENAITE while the COA still reads from SENAITE → **the sterility line silently disappears from the certificate.** No error is raised. This is the exact top-risk failure. The tasks below are ordered to make that inversion structurally impossible.

**Within 1E, Task A (flip) and Task B (rendered diff) run on SENAITE-anchored samples** (mixed orders + legacy promoted samples still have their SENAITE AR), so they do **not** need seam 4 first. Seam 4 (Task C) is only required for AR-less sterility-only samples, which arrive with 1D. The only hard constraints are: seam 1 before everything (done), seam 4 (C) before seam 2 (D), and the signed rendered-COA diff (B) before seam 2 (D).

---

## Global Constraints

- **This entire phase is Handler-gated for execution. It is NOT autonomously executable.** Each of Tasks A–D is a production-behavior change (COA-source flip, native anchor, write-back cut) and therefore a **Handler-gated checkpoint** per the non-negotiables (coherence §29-30, spec locked #7, CLAUDE.md "production-behavior changes need sign-off"). Task E depends on an unresolved lab-practice gate (G2). Nothing here rides to prod without an explicit per-task go.
- **Additive-cutover discipline (spec locked #7; coherence §25-27).** The native render path lives **alongside** the SENAITE path behind a flag; the write-back cut is **flag-gated and reversible** (a keyword-scoped write-back toggle), NOT a hard delete. The SENAITE path stays as fallback until proven; hard retirement is **Phase 2, not 1E**.
- **The flip redirects sterility keywords ONLY.** `STER-PCR`, `STER-USP71`, `PCR-FUNGI`, `PCR-BACTERIA` move to the native source. **`ENDO-LAL` (endotoxin) and all HPLC analytes stay SENAITE-sourced** and merge unchanged. "Source-flip" must never be read as "flip endotoxin/HPLC too."
- **coabuilder stays the single COA merge point** (spec locked #10). One certificate, one builder, two sources. No parallel native-COA render surface.
- **`JWT_SECRET` unchanged.** The native read/anchor uses the separate `X-Service-Token` S2S secret introduced in 1E-a (`ACCUMK1_SERVICE_TOKEN` ↔ Mk1 `ACCUMK1_INTERNAL_SERVICE_TOKEN`), NOT JWT. Any COA-verification-code path must keep JWT parity across IS + coabuilder + WP.
- **coabuilder edit discipline (coabuilder/CLAUDE.md — MANDATORY).** Every task here edits **existing** coabuilder symbols (`fetch_sample_data`, `parse_addon_results`, `parse_sterility`, `ADDON_KEYWORDS`, `generic_assay_engine`'s `addon_kw_set`). Before editing any of them run `gitnexus_impact({target, direction:"upstream"})` and report blast radius; warn on HIGH/CRITICAL; run `gitnexus_detect_changes()` before committing. `fetch_sample_data` and `parse_addon_results` are on the COA hot path — expect HIGH usage.
- **LIMS tables use `lims_` prefix**; each repo obeys its own CLAUDE.md gate (coabuilder: gitnexus; Accu-Mk1: the write-back cut is a behavior change with a regression test).
- **Stage EXPLICIT paths; never `git add -A`** (worktrees carry unrelated dirty files, e.g. `package-lock.json`).
- **ISO 17025:** the rendered-COA both-ways diff (Task B) is the **7.11.2 validation evidence** for the COA-source change and MUST be retained as a durable artifact. The USP<71> amend flow (Task E) MUST produce a **traceable amendment (7.5.2)**, not a silent overwrite.

## Execution environment (READ FIRST)

Cross-repo, touching the customer-COA pipeline → runs in a **fresh isolated `accumark-stack`** with production-shaped data (real promoted-sterility samples for the diff), NOT the shared `catalog` stack. At any sanctioned execution start, invoke the **`accumark-stack-platform`** skill, then mount worktrees for **Accu-Mk1** (off the 1C/1E-a branch `feat/catalog-departments-admin`), **coabuilder** (off the 1E-a branch `feat/1e-a-native-sterility` — the branch that carries `accumk1_client.py`/`sterility_shadow.py`; note these are NOT in the workspace `coabuilder` checkout, which is detached HEAD), and — once 1D exists — **integration-service**.

- coabuilder pytest: `docker exec <stack>-coabuilder sh -c "cd /app && python -m pytest scripts/test_*.py -q"`.
- Accu-Mk1 backend pytest: `docker exec <stack>-accu-mk1-backend sh -c "cd /app && python -m pytest tests/<file> -q"` (`pip install -q pytest` after any mount/recreate).
- Set `ACCUMK1_URL` + `ACCUMK1_SERVICE_TOKEN` in the coabuilder container (matching the backend's `ACCUMK1_INTERNAL_SERVICE_TOKEN`) for any live render/diff.
- Confirm exact container names with `docker ps` at execution start.

Commit convention (both repos): conventional-commit subject + footer
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQSWZ3crh9dMhKwU2YHeq7
```

---

## Gate register (all must be resolved by the named owner before the dependent task ships)

| Gate | What is unresolved | Who decides | What unblocks it | Blocks |
|---|---|---|---|---|
| **⛔ G1** | USP<71> `result_options` reported terminology. 1C seeded a placeholder (`No Growth`/`Growth`); the 1E-a normalizer mapped `Pass`/`Fail`. The COA render string + normalization depend on the confirmed wording. | **LAB** | Lab confirms reported wording. Refinable via `PATCH /analysis-services/{id}/result-type` (no migration). | Task A (USP<71> render), Task B (USP<71> validation) |
| **⛔ G2** | USP<71> preliminary→amend COA mechanics. RESOLVED as *practice* (issue PCR preliminary, re-publish/amend on USP<71> completion — spec OQ#8) but **UNBUILT**. Must be a **traceable amendment (7.5.2)**, not a silent overwrite. Native amendment mechanics undesigned. | **HANDLER + LAB** | Handler confirms amendment mechanics (versioned re-publish, amendment marker, prior-version retention) + lab confirms the preliminary/final labelling. | Task E (entirely skeleton until resolved) |
| **⛔ G3** | Rendered-COA both-ways diff sign-off. **PCR:** native-vs-SENAITE diff on real (STER-PCR-provenance) samples must **match** and be **Handler-signed**. **USP<71> + the new two-row Fungi/Bacteria PCR render:** no prior SENAITE render exists → validate against **expected output + lab sign-off** (net-new COA content). | **HANDLER (PCR match) + LAB (net-new content)** | Signed diff artifact retained as 7.11.2 evidence. | Task D (seam-2 cut) — hard precondition |
| **⛔ G6 (new)** | In-flight **mixed** samples ordered *before* 1D carry a legacy SENAITE AR with a `STER-PCR` line. Once the write-back is cut, that line never receives a result. Undecided: does the dangling line block SENAITE-side HPLC publish? reconcile the legacy line, or ignore it? | **HANDLER** | 1D's final order→AR shape (does the legacy sterility line survive on mixed ARs?) + a Handler call on legacy in-flight ARs. | Task D (seam-2 cut) scope/rollout |
| **Seam-2 Cut checkpoint** | The cut itself is the top-risk, production-behavior step. | **HANDLER** | Tasks A+B+C complete, G3 signed, G6 answered. | Task D flip in any real environment |

> Context gates carried from the coherence note but **not owned by 1E**: **G4** (WP pricing — 1F), **G5** (prod `Endotoxin` group existence — ENDO-LAL stays SENAITE-sourced here so it does not block 1E; relevant only if endotoxin is ever pulled native).

---

## File Structure (indicative — exact shapes for gate-dependent files are deferred to their gate)

| Repo | File | Responsibility | Change |
|---|---|---|---|
| coabuilder | `src/coabuilder_core/addon_parsing.py` | `ADDON_KEYWORDS` (`:15`), `parse_sterility` (`:104`), `parse_addon_results` (`:154`) | **Modify** — teach the new sterility keywords; keyword-titled `parse_sterility`; native-source-aware `parse_addon_results`. gitnexus impact required. |
| coabuilder | `src/coabuilder_core/senaite_client.py` | `fetch_sample_data` (`:244`) — source-flip merge + native anchor | **Modify** — inject native sterility rows into `coa.addon_results` (before `:598-612`) behind the flip flag; add native anchor when the SENAITE-AR search (`:261-291`) returns no match. gitnexus impact (HIGH). |
| coabuilder | `src/coabuilder_core/generic_assay_engine.py` | `addon_kw_set = set(ADDON_KEYWORDS)` (`:103`) | **Verify/adjust** — new keywords flow through the skip-set correctly. |
| coabuilder | `scripts/test_native_sterility_render.py` | flip renders native sterility rows into `addon_results` | **Create** |
| coabuilder | `scripts/test_native_anchor.py` | AR-less anchor path returns a `CoAData` | **Create** |
| coabuilder | `scripts/render_both_ways_diff.py` | Task B harness — render SENAITE-sourced vs native-sourced, diff, emit retained artifact | **Create** |
| Accu-Mk1 | `backend/lims_analyses/routes.py` | `promote` (`:273`), native write (`:305`), SENAITE write-back (`:345-357`) | **Modify (Task D)** — flag-gate the write-back off for sterility keywords. Behavior change + regression test. |
| Accu-Mk1 | `backend/tests/test_promote_writeback_sterility_gate.py` | write-back is skipped for sterility keywords, still fires for non-sterility | **Create (Task D)** |
| coabuilder | *(Task E — USP<71> amend)* | preliminary→amend mechanics | **Deferred — skeleton only, G2** |

---

## Task A — Source-flip: coabuilder builds the sterility COA section from the native Accu-Mk1 source (flagged, additive)

**Status: Handler-gated. Additive (SENAITE path stays as fallback behind the flag). Depends on 1E-a interfaces. USP<71> render blocked by G1.**

**Goal:** With a flag on (e.g. `COA_STERILITY_NATIVE_SOURCE`, off by default), coabuilder assembles the sterility rows of `coa.addon_results` from the **native** Accu-Mk1 source (via 1E-a's `AccumkClient` + `normalize_native_sterility`) instead of from the SENAITE `_Analyses_Detailed`. HPLC and endotoxin are untouched. This is the prerequisite that makes a native render — and therefore the Task B diff — possible. **The promote write-back stays ON during Task A**, so both sources remain populated and the both-ways diff is meaningful.

**Interfaces (known from 1E-a — `docs/superpowers/plans/2026-07-01-catalog-1e-a-...`):**
- Consumes: `accumk1_client.AccumkClient().fetch_sterility_results(sample_id) -> list[{keyword,result_value,promoted_at}]`; `accumk1_client.normalize_native_sterility(rows) -> {keyword: parse_sterility-row}`; `accumk1_client.is_configured()`; `accumk1_client.STERILITY_KEYWORDS`, `KEYWORD_TITLES`.
- Reuses the existing render shape: `parse_sterility` (`addon_parsing.py:104`) row keys (`test_name`, `analyte_name`, `test_type`, `specification`, `result`, `status`, `conforms`, `unit`, `status_color`) — the exact shape `coa.addon_results` is built from at `senaite_client.py:598-612`.
- Produces: sterility rows in `coa.addon_results` sourced from Mk1 when the flag is on and `is_configured()`; SENAITE-sourced otherwise.

**Shape of the change (concrete where known; do not over-specify the gate-dependent USP<71> pieces):**

- [ ] **A1 — gitnexus impact on the existing symbols to be edited.** Run `gitnexus_impact` (upstream) on `fetch_sample_data`, `parse_addon_results`, `parse_sterility`, and the `ADDON_KEYWORDS` consumers. Report blast radius; warn if HIGH/CRITICAL. Expected: `fetch_sample_data`/`parse_addon_results` are HIGH (COA hot path) — the change is additive and flag-gated, so it does not alter default behavior, but record the radius.

- [ ] **A2 — Teach coabuilder the new sterility keywords.** Extend `ADDON_KEYWORDS` (`addon_parsing.py:15`, today `("ENDO-LAL", "STER-PCR")`) to include `PCR-FUNGI`, `PCR-BACTERIA`, `STER-USP71` so the engine skip-set (`generic_assay_engine.py:103`) and addon detection recognise them. Verify `addon_kw_set` still excludes these from the main results table.

- [ ] **A3 — Keyword-titled `parse_sterility`.** Today `parse_sterility` (`:104-151`) defaults the title to `"Rapid Sterility Screening (PCR)"` and maps `0→Pass / 1→Fail`. Generalise it to title from `KEYWORD_TITLES` (Fungi, Bacteria, USP<71>). **The `STER-USP71` result mapping + `specification` string is `⛔ G1`-blocked** — do NOT hardcode `No Growth`/`Growth` vs `Pass`/`Fail` until the lab confirms. Ship PCR-family titling now; leave USP<71> wording behind G1.

- [ ] **A4 — Native-source injection in `fetch_sample_data`.** Behind the flip flag + `is_configured()`, after the engine produces `processed_data` and before `coa.addon_results` is assembled (`senaite_client.py:598-612`): fetch native sterility (`AccumkClient().fetch_sterility_results(sample_id)`), normalize it, and **replace the sterility subset of the addon rows** with the native rows — leaving `ENDO-LAL` and every HPLC/main-table row untouched. `parse_addon_results` (`:154-172`, currently Endo-first/STER-PCR-second) becomes native-source-aware for the sterility keywords only. **Flag off = byte-identical to today.** Wrap the native fetch best-effort (never raise into the COA pipeline), consistent with 1E-a.
  - **Render-shape note (spec locked #2, resolved OQ#2):** the PCR product renders **two rows** (`PCR-FUNGI`, `PCR-BACTERIA`) natively, whereas legacy SENAITE renders **one** `STER-PCR` row. This is a decided design point, NOT an open gate. But the two-row render is **net-new content** with no prior SENAITE render to byte-diff against — it is validated under G3's "expected output + lab sign-off" path, same as USP<71>. Under current seeding (all promotions are `STER-PCR`), the native source emits one `STER-PCR` row and 1E's own diff run is a clean **one-row-vs-one-row** comparison; the two-row path is only exercised once **1D** seeds `PCR-FUNGI`/`PCR-BACTERIA` onto vials.

- [ ] **A5 — Unit tests (`scripts/test_native_sterility_render.py`).** Flag-off → SENAITE-sourced rows unchanged (regression). Flag-on + configured → `coa.addon_results` sterility rows come from the mocked native client; ENDO-LAL row unchanged; HPLC/main results untouched. Mock `AccumkClient`; no live services. USP<71>-wording assertions are **stubbed pending G1**.

- [ ] **A6 — `gitnexus_detect_changes()` + commit** (explicit paths only). Confirm only the expected symbols/flows changed.

---

## Task B — Rendered-COA both-ways diff (THE TOP CONTROL)

**Status: Handler-gated. This is the spec's top safety control (§206, §244) and the hard precondition for Task D. `⛔ G3`.**

**Goal:** Render the sterility COA section **both ways** on real samples — SENAITE-sourced (flag off) vs native Accu-Mk1-sourced (flag on) — diff them, and **retain the diff as ISO-17025 7.11.2 validation evidence.** Cut seam 2 (Task D) **only on a signed match.**

**Why this is the real control (not the 1E-a value-diff):** 1E-a's value-level shadow-diff compares two values that share write-provenance on promoted samples (the promote path writes the native row and the SENAITE write-back from the same value in one operation), so a value match is **near-tautological** — it proves the read/normalize plumbing, not that the native source renders a correct certificate. The rendered-COA diff is meaningful precisely because it exercises the **new render path** built in Task A end-to-end (fetch → normalize → `parse_sterility` → `addon_results` → PDF section).

**Shape of the change:**

- [ ] **B1 — Diff harness (`scripts/render_both_ways_diff.py`).** For a list of real promoted-sterility sample IDs: render the COA (or at minimum the `addon_results` sterility section + the rendered PDF section) with the flip flag **off**, then **on**, and diff the sterility rows (`test_name`, `result`, `status`, `specification`, `conforms`) and the rendered section. Emit a durable artifact (JSON + the two rendered PDFs/sections) to a retained path — this is the 7.11.2 evidence, unlike 1E-a's log-only diff.

- [ ] **B2 — Confirm real promoted-sterility samples exist on the stack** (else the run is vacuous). Query as in 1E-a Task 3 Step 8.1 (`lims_analysis_promotions` join on the sterility keywords). If none, promote one or record that live exercise was skipped for lack of data — the harness is still unit-proven.

- [ ] **B3 — Run the diff on real samples.**
  - **PCR (existing STER-PCR-provenance samples):** expected **exact match** — same single row, same value, both sources. A mismatch here is a genuine plumbing/mapping defect (values share provenance) → investigate, do not sign.
  - **USP<71> + the new two-row Fungi/Bacteria PCR render:** **no prior SENAITE render exists** → there is nothing to byte-diff. Validate the native render against **expected output + lab sign-off**. `⛔ G1` blocks finalising the USP<71> render wording.

- [ ] **B4 — `⛔ HANDLER/LAB GATE G3` — sign-off.** Handler signs the PCR match; lab signs the net-new USP<71>/two-row content against expected output. Retain the signed artifact. **Without this signature, Task D does not proceed.**

---

## Task C — Seam 4: native-sample anchor (coabuilder anchors on a native Accu-Mk1 sample when no SENAITE AR exists)

**Status: Handler-gated. MUST land before Task D (seam 2). Fully exercisable only once 1D produces AR-less sterility-only samples.**

**Goal:** Today `fetch_sample_data` finds a sample by **searching for its SENAITE AR** (`senaite_client.py:261-291`: exact-ID then Title search on `portal_type=AnalysisRequest`), and returns `None` when no AR matches (`:289-291`). A fully-native sterility-only sample has **no SENAITE AR** → today it cannot be built. Add a fallback: when the SENAITE-AR search yields no match, anchor on the **native Accu-Mk1 sample** (fetched via the S2S client) and build a `CoAData` whose sterility section is native-sourced and whose HPLC section is empty (sterility-only). This is the one-time entry-level change every future SENAITE-free family reuses.

**Interfaces (partly known, partly to-be-defined against the 1E-a Mk1 endpoint):**
- Consumes: the 1E-a Mk1 read (`GET /samples/{sample_id}/sterility-results`) plus — **to confirm** — a native sample-metadata read for the certificate header (client, sample name, matrix, dates). 1E-a exposed only sterility *results*; the anchor needs sample *metadata*. **Design item:** either extend the 1E-a endpoint to return sample meta, or add a sibling S2S endpoint. This is a coabuilder↔Mk1 contract addition (not a gate, but a cross-repo interface to lock at execution time).
- Produces: `fetch_sample_data` returns a valid `CoAData` for an AR-less native sample (sterility rows populated, HPLC/main empty, no SENAITE calls beyond the failed search).

**Shape of the change:**

- [ ] **C1 — gitnexus impact on `fetch_sample_data`** (again — this is a second edit to the same HIGH-usage symbol). Report radius.
- [ ] **C2 — Insert the native-anchor fallback** at the `if not match: return None` point (`senaite_client.py:289-291`): when `is_configured()` and the native sample exists, build the `CoAData` header from native sample metadata and the sterility rows from the native source; skip all SENAITE analysis/attachment fetches. When native is unconfigured or the sample is unknown natively, preserve today's `return None`.
- [ ] **C3 — Lock the native sample-metadata contract** (see interfaces) — extend or add the Mk1 S2S endpoint; keep `X-Service-Token` auth, JWT unchanged.
- [ ] **C4 — Tests (`scripts/test_native_anchor.py`).** AR-less native sample → non-None `CoAData` with native sterility rows and empty HPLC. Mixed/legacy sample (AR present) → unchanged SENAITE anchor. Unknown-everywhere → `None`. Mock both the SENAITE search (no match) and the native client.
- [ ] **C5 — `gitnexus_detect_changes()` + commit.**

> **Dependency note:** the AR-less case only *occurs* once **1D/seam 3** makes IS create sterility-only orders with no SENAITE AR. Task C can be **built and unit-proven** ahead of 1D, but its live exercise waits on 1D. That is acceptable — seam 4 must merely *exist* before seam 2 cuts.

---

## Task D — Seam 2: CUT the promote SENAITE write-back for sterility (native Mk1 parent-tier row becomes canonical)

**Status: TOP-RISK. Handler-gated hard checkpoint. Proceeds ONLY after Tasks A+B+C complete, `⛔ G3` signed, and `⛔ G6` answered. Flag-gated and reversible (not a hard delete).**

**Goal:** Stop writing promoted sterility results back to the parent SENAITE AR line; let the **native Mk1 parent-tier row** (already written at `routes.py:305`) be canonical for sterility. This is the last seam; doing it before Tasks A/C makes the certificate silently lose sterility.

**Exact cut target (verified in `C:\tmp\Accu-Mk1-departments`):**
- `backend/lims_analyses/routes.py:273` — `@router.post("/promote")` endpoint.
- `:305` — `service.promote_to_parent(..., commit=False)` writes the native parent-tier row (this **stays**, unconditional).
- `:345-357` — the **fail-closed SENAITE write-back**: `senaite_writeback.writeback_promotion(parent_sample_id, parent_row.keyword, req.result_value, remark)`; on `SenaiteWritebackError` → `db.rollback()` + `raise HTTPException(502, "SENAITE write-back failed — promote aborted")`. **This block is what gets flag-gated off for sterility keywords.**
- `senaite_writeback.py:241-278` — `writeback_promotion`, docstring `"All failures raise SenaiteWritebackError (fail-closed)"`; this function stays intact (still used by non-sterility promotes) — the cut is at the **call site**, keyword-scoped.

**Shape of the change (additive/reversible):**

- [ ] **D1 — Handler go/no-go checkpoint.** Confirm A+B+C done, G3 signed artifact on file, G6 answered. No go → stop.
- [ ] **D2 — gitnexus impact is not applicable (Accu-Mk1, no gitnexus)** — instead, this is a **production-behavior change with a mandatory regression test** and Handler sign-off.
- [ ] **D3 — Flag-gate the write-back off for sterility keywords.** At `routes.py:345`, skip `writeback_promotion` when the promoted `parent_row.keyword` (and/or `req.keyword`) is a sterility keyword **and** a keyword-scoped flag (e.g. `STERILITY_SENAITE_WRITEBACK=off`) is set. Native row at `:305` already persisted; `db.commit()` proceeds. **Non-sterility promotes keep the fail-closed write-back unchanged.** Reversible by flipping the flag (additive discipline; hard-remove is Phase 2).
- [ ] **D4 — `⛔ G6` handling.** For in-flight **mixed** samples with a legacy SENAITE STER-PCR line: apply the Handler's decision from G6 (reconcile / ignore / block-check). Do NOT invent this — it is a design item pending G6 + 1D's AR shape.
- [ ] **D5 — Regression test (`test_promote_writeback_sterility_gate.py`).** With the flag on: a sterility-keyword promote persists the native parent row and does **NOT** call `writeback_promotion` (mock/spy asserts zero calls), returns 201. A non-sterility promote still calls it (fail-closed preserved). With the flag off: sterility promote still writes back (default/rollback behavior intact).
- [ ] **D6 — Live verification on the isolated stack** (post-1D, with real samples): promote a sterility result, confirm the native parent row is canonical, the COA renders sterility from native (flip flag on), and no SENAITE write occurred. Retain evidence.
- [ ] **D7 — Commit (explicit paths). Do NOT deploy to prod without the Handler sign-off from D1 and a deploy window.**

---

## Task E — USP<71> preliminary→amend COA flow (SKELETON ONLY — `⛔ G2`)

**Status: Handler+lab-gated. Mechanics UNRESOLVED. This task is a skeleton; no code shape is finalised until G2 is decided.**

**Goal (from spec OQ#8, resolved as practice, unbuilt):** issue the **PCR** result first as a **preliminary** certificate, then **re-publish (amend)** when **USP<71>** completes (~14-day turnaround). The amendment MUST be **traceable (ISO 17025 7.5.2)** — a versioned re-publish with an amendment marker and prior-version retention — **not a silent overwrite**.

**⛔ HANDLER/LAB GATE G2 — what must be decided before this task has a code shape:**
- **Amendment mechanics (HANDLER):** how does a native (SENAITE-free) COA get re-published as an amendment? Versioned artifact + amendment reason + retained prior version? Where is the amendment recorded (Mk1 parent-tier? coabuilder? WP order?)? This is the "native amendment flow" the spec defers to this plan.
- **Preliminary/final labelling (LAB):** how is a preliminary certificate labelled vs the final amended one on the customer-facing PDF?
- **G1 dependency:** the USP<71> result wording (G1) must be settled before its render can be finalised on either the preliminary or amended certificate.

**Skeleton (do not build until G2 resolves):**
- [ ] **E1 — Design the native amendment record** (per G2 Handler decision): amendment marker + reason + prior-version pointer, traceable per 7.5.2.
- [ ] **E2 — Preliminary render:** COA with PCR complete, USP<71> marked pending/preliminary (render wording per G1).
- [ ] **E3 — Amend render:** re-publish with USP<71> filled, amendment marker + retained prior version.
- [ ] **E4 — Traceability test:** the amended certificate is distinguishable from the preliminary and the prior version is retained (7.5.2 evidence).

---

## Self-Review (completed against the spec + coherence note)

**Spec coverage (of the 1E cross-repo slice):**
- Source-flip — coabuilder renders sterility from Accu-Mk1 (spec §183, §256; seam 1 → render) → **Task A** (flag-gated, sterility-only redirect, HPLC/endo stay SENAITE).
- Rendered-COA both-ways diff, the **top control** (spec §206, §244; ISO 7.11.2) → **Task B**, retained artifact, `⛔ G3`.
- Seam 4 native-sample anchor (spec §186) → **Task C**, before seam 2.
- Seam 2 write-back cut (spec §184, §192, locked #11) → **Task D**, LAST, flag-gated/reversible, verified `routes.py:345-357` cut target + `senaite_writeback.py:241-278` fail-closed guard.
- USP<71> preliminary→amend (spec §263, OQ#8) → **Task E**, skeleton, `⛔ G2`.
- Mandatory seam-cut order + "reversing it silently drops results from COAs" stated at the top and enforced by task ordering.

**Which parts are skeleton-pending-gate (honesty over polish):**
- **Task E is skeleton-only** (`⛔ G2` — amendment mechanics + preliminary/final labelling undesigned).
- **USP<71> render wording** in Tasks A/B is `⛔ G1`-blocked (PCR-family titling can proceed; USP<71> mapping/spec string cannot).
- **Task B PCR sign-off** and the **net-new two-row/USP<71> validation** are `⛔ G3` (Handler + lab signatures required; hard precondition for Task D).
- **Task D scope for in-flight mixed samples** is `⛔ G6`-blocked (depends on 1D's AR shape + Handler call).
- **Task C native sample-metadata contract** is an unlocked cross-repo interface (extend the 1E-a endpoint or add a sibling) — to be pinned at execution, not invented here.

**Gates marked:** **G1** (USP<71> `result_options` wording — LAB), **G2** (USP<71> amend mechanics — HANDLER+LAB), **G3** (rendered-COA sign-off — HANDLER+LAB), **G6 (new)** (in-flight mixed legacy SENAITE sterility line — HANDLER), plus the explicit **Seam-2 Cut Handler checkpoint**. Context gates **G4**/**G5** noted as not owned by 1E.

**Deferred items (out of 1E):** seam 3 / IS order→AR native routing (1D); WP products + pricing (1F, G4); prod `Endotoxin` group verification (G5 — moot here, endotoxin stays SENAITE); hard-removal of the SENAITE write-back and the SENAITE-sourced fallback (Phase 2 retirement); native COA sourcing for non-sterility families (Phase 4).

**Type/name consistency:** the render row shape (`test_name`/`result`/`status`/`specification`/`conforms`/…) is consistent across `parse_sterility` (`addon_parsing.py:104`), the `addon_results` assembly (`senaite_client.py:598-612`), and the 1E-a `normalize_native_sterility` output. Sterility keyword set (`STER-PCR`, `STER-USP71`, `PCR-FUNGI`, `PCR-BACTERIA`) is used identically in `ADDON_KEYWORDS`, the flip redirect, the diff scope, and the write-back gate. `X-Service-Token` (not JWT) is the native-read auth throughout.

**Placeholder scan:** intentional. Every gate-dependent step describes the *shape* and stops at its `⛔` marker rather than shipping speculative code — an authoritative-looking plan on unresolved lab/Handler decisions would be worse than this honest skeleton. Concrete code shapes are given only where the interface is already known (1E-a client, the verified cut target, the verified render merge point).

**Execution posture:** **1E is Handler-gated end-to-end. It is NOT autonomously executable.** Each of Tasks A–D is a per-task Handler checkpoint; Task E is blocked on G2. Nothing here ships to prod without explicit sign-off and a deploy window.
