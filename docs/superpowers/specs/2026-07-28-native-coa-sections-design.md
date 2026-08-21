---
title: "Native COA Sections — catalog-driven certificate sections from Accu-Mk1 results"
date: 2026-07-28
status: draft
authors: [ZeroSignal, forrestp]
depends_on: "docs/superpowers/specs/2026-07-28-analysis-catalog-foundation-design.md (spec 1)"
part_of: "New-test-families program, spec 2 of 3 (foundation → COA sections → order routing)"
---

# Native COA Sections

## Summary

Give Accu-Mk1 a way to put results it owns onto a customer certificate, in sections defined by the
catalog rather than by code. Today no result has ever reached a COA from Mk1 — COABuilder pulls the
Analysis Request from SENAITE, and Mk1's payload is a display overlay carrying no results at all.

This spec builds the pipeline and proves it with **one family, Heavy Metals**, end to end:

1. **Mk1 emits a section payload** derived from Analysis Profiles (spec 1) — one section per ordered
   native profile, with its rows.
2. **The payload is pushed to COABuilder** by whichever service invokes it, alongside the existing
   variance overlay.
3. **COABuilder renders sections generically** using a single `limit_table` archetype, on a new
   blank-background page, generalizing the mechanism the variance page already proves.
4. **Spec limits stay baked in COABuilder**, keyed by keyword, filling fields Mk1 deliberately leaves
   empty — so the wire format survives the later conformance-engine migration unchanged.

Unlike the variance path this copies, **every step is fail-closed**. Variance is an enhancement, so
its fetch failure degrades silently. A heavy-metals result is a paid, reportable test: if it cannot
be rendered completely and correctly, no certificate is produced at all.

## Prerequisite: native results cannot currently reach the parent tier

This is the blocker that makes spec 2 more than a rendering change, and it must be fixed here.

`POST /api/lims-analyses/promote` writes the promoted result back to SENAITE **fail-closed**
(`backend/lims_analyses/routes.py:376`). `writeback_promotion` begins with
`find_parent_analysis_line(parent_sample_id, keyword)` — it locates the analysis line *in SENAITE*
(`backend/lims_analyses/senaite_writeback.py:241+`). A Mk1-native service such as `HM-PB` has no
SENAITE service and no line on the parent AR, so the lookup fails, `SenaiteWritebackError` is raised,
the transaction is rolled back, and the promote returns 502.

**A Mk1-native result therefore cannot be promoted to the parent tier at all today.**

**Fix: gate the write-back on the parent service's `origin`.** A service with `origin = 'mk1'` has no
SENAITE representation, so there is nothing to synchronise — skip the write-back entirely. Services
with `origin = 'senaite'` keep the fail-closed write-back exactly as it is.

This is **not** the SENAITE write-back cut (phase-out seam 2). No existing behavior changes; a code
path is added for rows that would otherwise be impossible.

**Read the origin from the service backing the *parent* row, not the vial row.** The write-back is
called with `parent_row.keyword`, not `req.keyword`, because `resolve_parent_analyte_target` can
translate a vial keyword to a different parent keyword. That function's docstring says "native
keywords pass through unchanged," but "native" there means "not a per-substance `PUR_`/`QTY_`
keyword" — a different predicate from `origin = 'mk1'`. Conflating them would gate the wrong rows.

## Which results are eligible

**Only parent-tier `lims_analyses` rows whose `review_state` is `verified` or `published`.**

This deliberately diverges from `_LIVE_RESULT_STATES` in `backend/coa/source_resolver.py:41`
(`submitted`, `to_be_verified`, `verified`, `published`) and from the 1E-a sterility-results endpoint
on the parked branch, which filtered only `retest_of_id IS NULL` and
`review_state NOT IN (retracted, rejected)`.

Both of those are correct for what they do — SENAITE-sourced analyses get a human verify step *in
SENAITE*, and 1E-a fed a shadow-diff, not a renderer. **Native services have no SENAITE verify step,
so the Mk1 `review_state` is the only gate that exists.** Reusing either filter would print an
unverified result on a customer certificate.

Rows must also be current: `retest_of_id IS NULL`, and the row must not be retested. A row in any
other state is not "missing" — it makes the section **incomplete**, which aborts (see Fail-closed).

## Scope boundary: all-native profiles only

A section is emitted only for a profile whose members are **all** `origin = 'mk1'`.

A mixed profile — say a future BacWater panel containing SENAITE-born `ENDO-LAL` alongside native
services — would have its SENAITE members rendered twice: once by the existing add-on block, once in
the native section. Mixed profiles are deferred until the COABuilder re-wire gives one source of
truth per keyword.

Spec 1's cross-origin keyword collision check is the second half of this guarantee: it prevents a
native service from *claiming* a SENAITE keyword and reintroducing the double-render by the back
door.

## Transport: push, not pull

**Mk1 and Integration Service attach the section payload to the COABuilder request. COABuilder does
not call Mk1.**

COABuilder has **no Mk1 connectivity whatsoever** today — no client, no base URL, no service token
(verified: nothing matching `accumk1|mk1_url|X-Service-Token` anywhere in its `src/` or `scripts/`).
Building that path would put a new fail-closed network dependency in front of **every** certificate,
including plain peptide COAs with no native sections, because COABuilder cannot know whether any were
ordered without asking. A Mk1 outage or a stale token would then break all COA generation, where
today COABuilder depends only on SENAITE.

Push is also strictly safer for fail-closed. **Mk1 is already the caller** for the primary COA
(`backend/main.py:9901` posts to `{COA_BUILDER_URL}/process/{sample_id}`) and already knows what was
ordered, so it can refuse to invoke COABuilder at all when it cannot assemble a complete payload.
Failing at the caller means the certificate is never requested — better than refusing at render time.

Two call sites carry the payload, exactly as variance does today:

| Path | Caller | Existing variance precedent |
|---|---|---|
| Primary COA | Accu-Mk1 → `POST /process/{sample_id}` | `backend/main.py:9868-9871` |
| Additional COA | Integration Service → `POST /process-additional/{senaite_id}` | `integration-service/app/api/webhook.py:752-782` |

**Integration Service's fetch must change from fail-soft to fail-closed** on this payload. Today it
wraps `get_variance_payload` in `except Exception` and proceeds without variance — correct for
variance, wrong here. It must fetch native sections from Mk1, and abort COA generation on failure
rather than building a certificate that silently omits a paid test.

## The wire contract

One builder function, two entry points. Mk1 calls it **in-process** when it invokes COABuilder for the
primary COA — it must not HTTP-call itself. The same function is exposed as
`GET /samples/{sample_id}/coa-sections` (service token, mirroring the existing
`/samples/{sample_id}/variance-payload` at `backend/main.py:17752`) for Integration Service to fetch
on the additional-COA path. Either way the identical document is passed through verbatim as
`native_sections` in the COABuilder request body.

```jsonc
{
  "sample_id": "P-1234",
  "ordered_profiles": ["heavy_metals"],      // see definition below — REPORTABLE native profiles only
  "sections": [
    {
      "profile_key": "heavy_metals",
      "title": "Heavy Metals",                // from analysis_profiles.coa_section_title ?? name
      "archetype": "limit_table",
      "sort_order": 10,
      "rows": [
        {
          "keyword": "HM-PB",                 // the cross-repo join key
          "name": "Lead (Pb)",
          "result": "0.12",
          "unit": "ppm",
          "method": "ICP-MS",
          "specification": null,              // COABuilder fills from baked specs
          "conforms": null                    // COABuilder fills from baked specs
        }
      ]
    }
  ]
}
```

**`ordered_profiles` means "ordered **and** reportable."** A profile is listed only if the order
bought it, **all** its members are `origin = 'mk1'`, and its `coa_archetype` is non-NULL. A profile
that is deliberately not reported (`coa_archetype` NULL) is a legitimate internal-only test and must
be excluded, or fail-closed rule 2 would abort every certificate that includes one. The list is the
contract for "these sections must be present and complete" — nothing else belongs in it.

`specification` and `conforms` are **deliberately null**. COABuilder fills them from its baked table.
When the conformance engine moves into Mk1, Mk1 populates the same two fields and COABuilder's lookup
is deleted — **the wire format does not change, and the renderer is never touched.** That is the whole
point of leaving them in the contract now.

### New columns on `analysis_profiles` (deferred from spec 1)

| Column | Type | Notes |
|---|---|---|
| `coa_section_title` | String(200), nullable | Section heading. Falls back to `name`. |
| `coa_archetype` | String(50), nullable | `'limit_table'` today. NULL = profile is not reported on the COA. |
| `coa_sort_order` | int, NOT NULL, default 0 | Section order among native sections |

Row order within a section comes from `analysis_profile_members.sort_order` (spec 1).

## One archetype

`limit_table` renders **Test | Result | Unit | Specification | Verdict** — the same shape as the
existing add-on rows, without the two-row ceiling.

It covers every family in the pipeline:

| Family | Test | Result | Unit | Specification | Verdict |
|---|---|---|---|---|---|
| Heavy Metals | Lead (Pb) | 0.12 | ppm | ≤ 0.5 ppm | Conforms |
| Moisture | Water Content | 4.2 | % | ≤ 5.0 % | Conforms |
| pH (à la carte) | pH | 5.8 | — | 4.5 – 7.0 | Conforms |
| Sterility USP<71> | Sterility (USP<71>) | No Growth | — | No Growth | Conforms |

A single-row section is a degenerate limit table, not a separate archetype. **Do not add archetypes
speculatively** — add one when a family genuinely does not fit this shape.

`archetype` stays in the wire format as a forward-compatible field with exactly one legal value, and
**COABuilder aborts on an unknown archetype** rather than skipping the section.

## Spec limits in COABuilder

Extend the existing `BAKED_SPECS` mechanism (`coabuilder/src/coabuilder_core/baked_specs.py`), keyed
by `(SampleTypeTitle, Keyword)` with `min` / `max` / `unit` / `display`, plus `TEST_TECHNIQUES` for
the technique label.

**Unknown is not the same as informational.** `baked_specs.py` already distinguishes these —
`FILL-NET-CONTENT` carries a technique label and deliberately no spec. Make it a rule rather than an
example:

- A keyword **explicitly marked informational** renders with an empty Specification and Verdict.
- A keyword **absent from the table entirely** is an error and **aborts** the COA. A result printed
  without a verdict because nobody remembered to add its limit is exactly the failure this rule
  exists to prevent.

## Fail-closed rules

Every one of these aborts COA generation with a specific error, at the caller where possible:

1. The Mk1 section fetch fails (network, 5xx, timeout, auth).
2. A profile in `ordered_profiles` has no matching section.
3. A section has zero rows, or any row has a null/empty `result`.
4. A member service has no eligible result row (not `verified`/`published`).
5. A row's keyword is absent from the baked spec table and not marked informational.
6. A section declares an unrecognised `archetype`.

Rule 2 is what makes the rest work: `ordered_profiles` is the cross-check that lets a caller tell
"nothing was ordered" apart from "something broke." Without it, an empty `sections` array is
ambiguous and fail-closed is unachievable.

## Rendering

Follow the variance recipe — the only mechanism in COABuilder that renders an unbounded number of
rows.

1. **Blank background.** Reuse `Templates/UnifiedCOA_v1/Single & Blend Blank Page.pdf`.
2. **New template** `Templates/Additional Analyses/layout.json` — the standard header and footer
   frames copied verbatim, plus one magic-named empty frame (`NativeSections`) whose geometry is the
   table's bounding box.
3. **Frame-loop intercept** in `generator.py` (~`:296`), beside the existing `VarianceList` branch.
4. **`_draw_native_sections`** — programmatic ReportLab, matching `_draw_variance_table`
   (`generator.py:619`): section heading band, then rows, with row height computed from available
   frame height.
5. **`resolve_templates` appends the page** when `native_sections` is present.

### Pagination

Row capacity is derived from the frame height, not hardcoded. `resolve_templates` computes how many
pages the sections need and appends `"Additional Analyses"` that many times; `_draw_native_sections`
receives the page ordinal and renders its slice. Sections are never split silently — **truncation is
not an acceptable outcome**, and a section that cannot be laid out aborts.

### Two structural traps in the existing renderer

Both were found by reading `logic.py` and `generator.py` directly, and both are silent failures:

- **`resolve_templates` returns early for non-peptide matrices.** If `matrix_type` is not in
  `{"Peptide", "Peptide Blend"}` it returns `["Generic Page 1"]` or
  `["Generic Page 1", "Generic Page 2 - Addons"]` and **never reaches the variance append below**
  (`coabuilder/src/coabuilder_core/logic.py:34-40`). The native-sections append must be added to
  **both** branches, or heavy metals would silently vanish from every Bacteriostatic Water
  certificate.
- **The dynamic-background block is a name-compare deny-list.** `generator.py:246` reads
  `if i == 1 and template_name != "Generic Page 2 - Variance List"`, then may override that page's
  background with a pre-rendered peptide page-2 PDF chosen by analyte count. Any new page that can
  land at index 1 has to be added to that condition. **Convert it to an allow-list** — apply the
  dynamic override only for the two `Blend Page 2 - *` templates — so a programmatic-background page
  is excluded by default. Same fail-closed principle as spec 1's HPLC allow-list, and it removes the
  trap for every future page instead of adding one more name to a growing exception.

## Overall verdict and remarks

Native sections bypass both `ConformanceEngine` and `GenericAssayEngine`, so a non-conforming native
row would render a red cell while the certificate headline still reads Conforms. That is
unacceptable, and it is not satisfied by rendering alone.

**Integration point:** `overall_status_badge` is computed inside the engines
(`conformance.py:811`, `generic_assay_engine.py:217`) and assigned to `CoAData` at
`senaite_client.py:576`. **Apply the native-section downgrade immediately after that assignment** —
one join point covering both engines. Any non-conforming native row forces the badge to FAILED,
matching the existing rule that `overall_status` fails on any non-conforming reported test
(commit `d36da74`).

The **non-conforming lab-remarks gate** (commit `21192e7`) currently forces remarks on identity and
purity non-conformance. Whether native non-conformance also trips it is a **lab decision** (open
question 1) — consistency argues yes, but it changes what the lab must fill in before publishing.

## Digital COA parity

`_build_coa_data_json` (`coabuilder/scripts/server.py:87`) produces the JSONB stored in
`coa_generations.coa_data` and sent to Integration Service — it is what the customer portal and the
verification panel render.

**Native sections must appear there too.** Otherwise the PDF shows Heavy Metals and the digital
certificate does not, which is a discrepancy on a citable document.

`published_coa_result` keeps its per-family columns unchanged (Handler ruling): heavy metals does not
get `has_heavy_metals` / `heavy_metals_conforms` columns in this slice. The consequence is explicit —
**that table's roll-up will not reflect native families** until it is reworked, and the certificate
itself, not that table, is authoritative.

## Deliberately deferred

- **Order routing and vial provisioning** (spec 3). This slice assumes the heavy-metals vial exists
  and its analyses were added and promoted. During execution, verify the manual path end to end
  before automating it.
- **Native sample anchor.** Heavy Metals rides on a peptide sample that already has a SENAITE AR, so
  COABuilder anchors normally. Fully native, AR-less samples (sterility-only orders) still need the
  anchor work and are out of scope.
- **Mixed-origin profiles**, spec limits in Mk1, `published_coa_result` rework, and additional
  archetypes.

## Risks

| Risk | Mitigation |
|---|---|
| **ENDO-LAL unit divergence starts printing.** The Mk1 catalog carries `EU/mg` on service id=77 while COABuilder hardcodes `EU/mL`; no COA has ever printed `EU/mg`. Inert today — but this slice is the first time catalog units reach the renderer | ENDO-LAL is SENAITE-origin and cannot appear in a native section under the all-native rule, so it is not exposed *by this slice*. **Fix the catalog unit before any profile containing it becomes reportable.** Do not let this ride into spec 3 unresolved |
| An unverified result reaching a certificate | Eligibility restricted to `verified`/`published`, deliberately narrower than `_LIVE_RESULT_STATES`; anything else aborts rather than being skipped |
| A paid test silently missing from a COA | `ordered_profiles` cross-check plus six abort rules; IS fail-soft converted to fail-closed |
| A keyword rendering twice | All-native profiles only, plus spec 1's cross-origin collision check |
| Origin gate wired to the vial row instead of the parent row | Stated explicitly; test asserts a `PUR_<X>` → `ANALYTE-{slot}` translation still writes back |
| New page silently absent on BacWater certificates | `resolve_templates` early-return trap named; test renders a non-peptide matrix with a native section |
| Dynamic background stomping the blank page | Deny-list converted to allow-list; test asserts the section page keeps its blank background at every page index |

## Testing

- **Native promote:** succeeds for an `origin='mk1'` parent service with SENAITE unreachable;
  a SENAITE-origin promote still 502s and rolls back when write-back fails (behavior unchanged).
- **Eligibility:** a `to_be_verified` native row aborts rather than rendering or being skipped.
- **Each of the six fail-closed rules** aborts with its own distinct error.
- **Renderer:** a section with more rows than one page fits paginates without truncation; a
  non-peptide matrix still gets the section page; the page keeps its blank background at index 1.
- **Golden render:** a frozen expected PDF/section for a known heavy-metals sample.
- **Overall verdict:** one non-conforming native row flips `overall_status_badge` to FAILED under
  both engines.
- **Digital parity:** `coa_data` JSONB contains the same sections as the rendered PDF.
- **Regression:** an existing peptide COA with no native sections renders byte-identically to master.
- **Additive proof:** failure-set diff against master in the same virtualenv, never zero-failures
  (`architecture_mk1_test_baseline_failures`).

## Execution environment

Cross-repo (Accu-Mk1 + Integration Service + COABuilder), so rehearse on a **fresh isolated devbox
stack** mounting all three worktrees — never the live host. Invoke the `accumark-stack-platform`
skill at execution time. Note COABuilder's container topology trap: the wave-1 backend serves a baked
image on :5000, **not** the bind-mounted checkout
(`architecture_coabuilder_container_topology`).

Cross-repo gates apply: COABuilder requires gitnexus impact analysis before editing existing symbols;
Integration Service must pass `ruff check . && mypy app`.

## Handler / lab gates

Production-behavior changes; none is autonomously executable:

- **G-A — heavy-metals limits.** The actual numeric limits, units, and technique labels per element.
  Lab-owned; nothing renders until they exist.
- **G-B — remarks gate.** Does native non-conformance force lab remarks (open question 1)?
- **G-C — rendered-COA sign-off.** Heavy Metals has no prior render to diff against, so validation is
  against expected output plus lab sign-off — the same discipline the prior program applied to
  USP<71>.
- **G-D — eligibility confirmation.** Confirm `verified`/`published` matches the lab's intended
  release point for a test with no SENAITE verify step.

## Open questions

1. **Does native non-conformance trip the lab-remarks gate?** (G-B.) Consistency with identity and
   purity argues yes.
2. **Section placement relative to existing pages.** Native sections currently append last, after any
   analyte and add-on pages. Confirm that reads correctly on a real certificate.
3. **Retest of a native analysis after publish.** The published-COA immutable snapshot
   (`architecture_published_coa_snapshot_retest`) is a hard prerequisite for the COABuilder re-wire
   and is not solved here. Native families inherit whatever that slice decides.

## Cross-references

- Spec 1 — `docs/superpowers/specs/2026-07-28-analysis-catalog-foundation-design.md`
- `coabuilder/src/coabuilder_core/logic.py`, `generator.py`, `baked_specs.py` — the renderer
- `backend/main.py:17752` — the `variance-payload` S2S endpoint this mirrors
- `integration-service/app/api/webhook.py:752-782` — the fail-soft fetch converted here
- SENAITE phase-out program — COABuilder re-wire is the last section; this slice deliberately pulls a
  narrow, native-only piece of it forward
