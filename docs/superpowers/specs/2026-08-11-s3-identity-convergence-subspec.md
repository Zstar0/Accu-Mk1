# S3 Sub-Spec — Native Identity Convergence (the centerpiece)

*Sub-spec under the 2026-08-10 Catalog Foundation Hardening umbrella (Slice 3). Drafted
2026-08-11 from a full-code dossier (scratchpad s3-dossier.md); verified against
`C:/tmp/Accu-Mk1-amendment-audit` @ b30d9fc0. ALL rulings LANDED 2026-08-12; everything
recommendation-final. Depends on PRs #97/#98 merging (provenance `'ordered'` + audit idioms).*

## Premise corrections to the umbrella spec (verified)

1. **`lims_analyses.analysis_service_id` is `NOT NULL` since table inception** (database.py:564,
   models.py:1655). There is no NULL case: the new indexes need no NULL predicate, and the
   umbrella's "keyword fallback when service_id absent" FE language is moot on the wire — every
   row has a service id; the FE just isn't given it yet.
2. **`origin` lives on `analysis_services`, not `lims_analyses`** — a partial-index predicate
   cannot reference it. "Senaite rows grandfathered" is therefore a CODE-level rule, not an
   index predicate. The new indexes are origin-agnostic, which is safe on structural grounds:
   the existing keyword indexes already force at-most-one row per (host, keyword), so the ONLY
   possible violation of (host, service_id) uniqueness is same-service/different-keyword drift —
   origin-blind by nature. No `service_origin` column is denormalized onto `lims_analyses`.
3. **The pattern already ships.** `uq_lims_analyses_parent_service_shadow` and
   `uq_lims_analyses_parent_service_ordered` are service-id-keyed partial unique indexes in
   production code today (database.py:1124-1135, :1613-1625). S3 extends the established pattern
   to the two remaining keyword-keyed root indexes — it does not introduce a new idea.
4. **Placeholder coexistence must be asserted.** The new parent index's `provenance='canonical'`
   term is mutually exclusive with the `'ordered'` placeholder index — promote landing a
   canonical row beside a placeholder still succeeds. A test pins this (it protects the shipped,
   unpushed placeholder slice, P-0145's verified ordered-3661 + canonical-3663 coexistence).

## D1. The two new indexes (raw SQL, appended at the end of `_run_migrations`)

Mirror each source index's predicate EXACTLY (no normalization of the known asymmetry —
vial root has no provenance term, shadow uses `retested=FALSE`; recorded, not fixed here):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_id_root
    ON lims_analyses (lims_sub_sample_pk, analysis_service_id)
    WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
      AND review_state NOT IN ('retracted', 'rejected');

CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_id_root
    ON lims_analyses (lims_sample_pk, analysis_service_id)
    WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
      AND review_state NOT IN ('retracted', 'rejected')
      AND provenance = 'canonical';
```

Bare `CREATE … IF NOT EXISTS`, **no DROP pair** (last-boot-wins hazard with mixed-vintage
images). Keyword indexes are NOT retired in this slice — coexistence is deliberate (see R1).

## D2. 🔴 The pre-check is the only failure surface — treat it as a gate, not hardening

`_run_migrations` swallows a failing CREATE into a `migration_skipped` warning that operators
are trained to ignore (the stale review_state CHECK produces it routinely). Therefore:

- A fail-loud script `backend/scripts/s3_identity_precheck.py` runs the dossier's four queries
  (§6.1-6.4: vial-tier violations, parent-tier violations, origin-segmented diagnostic, and the
  keyword-index-integrity canary) plus the drift sizer (§6.5). **Run against BOTH s3rehe and
  prod before deploy, naming the environment.** Any violation row is reported, never
  auto-healed. Non-zero on the canary (6.4) means the EXISTING keyword index is missing —
  a migration-mechanism integrity failure to investigate before anything else.
- Post-create verification lands in the same slice: after boot, a check queries `pg_indexes`
  for both names and logs at ERROR if absent (today NO index existence is verified anywhere).

## D3. Code convergence — the MOVE list

The `_ident_clause` ternary from promote (service.py:850-857) is the idiom, propagated with a
per-site `db.get(AnalysisService, …)` origin resolve (accepted cost; rows are singular):

`service_id if is_native else keyword`

**MOVE (mk1 rows key on service id; senaite rows keep keyword):**
- `cascade_parent_retest_to_sources` active-parent lookup (service.py:1585-1596)
- `parent_retest` active-row lookup (service.py:1700-1712)
- seeder already-seeded skip set (seeder.py:501-512, multi-branch)
- `add_analysis_to_native_vial` duplicate guard (service.py:2658-2671) — resolves a service
  then guards on keyword; the exact defect class
- `coa/source_resolver.py:381` pin-staleness check (native path)
- FE parent↔vial join (vial-assignment.ts) — service-id equality becomes **tier 0**, exact
  keyword demoted to tier 1, identity/analyte bridge tiers survive untouched (they are
  translations, not identity)

**KEEP (permanent, documented at the site):**
- cross-provenance keyword collapse (service.py:1342-1357) — converting regresses the P-0143
  double-render; the mirror legitimately holds different service ids per provenance
- `resolve_shadow_target`, `observer._live_shadow`, `resolve_parent_analyte_target`,
  `_build_analysis_debug_rows` (SENAITE boundary translators/diff surfaces)
- `_category(keyword)` / `isIdentityAnalysis` keyword-SHAPE classifiers (S9 owns their fate)
- `_candidate_vial_keywords` (SENAITE slot translation; degradation contract preserved)

**DONE already (cite as precedent, do not touch):** promote native-identity override,
`_eligible_parent_row`, `_existing_shadow`, `list_native_parent_analyses` dedupe,
placeholder collapse, `vial_source_retest`.

**Stale comment to rewrite in the same commit:** `main.py:19511-19515` asserts the keyword
index is THE uniqueness rule.

## D4. FE wire change

`_serialize_senaite_shape_rows` (service.py:2874-2897) additively emits
`analysis_service_id`; `SenaiteAnalysis` (api.ts) gains the optional field. This unblocks the
join tier-0 and lets `sla-resolution.ts`'s out-of-band `keywordToServiceId` maps retire later
(not in this slice). `service_origin` is already on the wire — the FE knows which rows are mk1.

## D5. Enforcement guard

Backend: AST-based test (the amendment-audit idiom — ast.parse/walk, Name+Attribute shapes,
floor assertion) sweeping the file list (`lims_analyses/{service,seeder,parent_mirror}.py`,
`workflow/observer.py`, `coa/{source_resolver,native_sections}.py`, `main.py`) for
`.keyword ==`/`keyword.in_` comparison shapes against **two lists with different assertions**:
a SHRINKING list (each entry is debt; test fails if an entry no longer matches — no stale
green) and a PERMANENT list (the D3 KEEPs; each carries its reason). FE: an ast-grep rule
(`.ast-grep/rules/`, wired into `npm run check:all`) guarding `src/lib/vial-assignment.ts`
against new keyword-equality tiers outside the sanctioned ladder.

## D6. Catalog edit safety (the payoff)

Once mk1 rows compare by service id, `AnalysisServicesPage`'s keyword edit
(AnalysisServicesPage.tsx:506) stops orphaning rows — the re-label incident class (P-1611,
Replace-leaves-wrong-analysis) closes for native rows. Senaite rows remain frozen legacy until
the phase-out decommissions the mirror.

## ✅ Rulings — ALL LANDED 2026-08-12 (spec is build-ready)

1. **Keyword-index retirement wave — RULED: deferred out of this slice.** Precondition to
   schedule later: shrinking allow-list empty + pre-check clean N days + SENAITE mirror
   decommissioned. Keyword indexes stay load-bearing-but-shrinking meanwhile.
2. **Route signatures — RULED: additive.** `analysis_service_id` param added with keyword kept
   as a compatibility alias (resolution order service_id → senaite_uid → keyword); no breaking
   change to `delete_pristine_analysis` / `add_analysis_to_native_vial`.
3. **COA-side keyword constraints — RULED: out of S3.** The pin-staleness READ still moves in
   D3; the stored `CoaResultPin`/`CoaGenerationSource` keyword constraints become a program
   backlog entry (pull in only if COA pin durability across renames becomes pressing).

## Sequencing within the slice

1. Pre-check script + run on s3rehe & prod (report results before anything ships)
2. Indexes + pg_indexes post-verification + placeholder-coexistence test
3. Backend MOVE conversions (each with its `_ident_clause` test twin)
4. Wire field + FE tier-0 join + ast-grep rule
5. AST guard test with both lists
6. Full-suite failure-set diff vs base

## Non-goals

No service renames/merges, no historical data healing (pre-check reports, humans decide),
no keyword-index retirement, no senaite-path conversions, no SLA-map re-key, no COA pin
constraint changes.
