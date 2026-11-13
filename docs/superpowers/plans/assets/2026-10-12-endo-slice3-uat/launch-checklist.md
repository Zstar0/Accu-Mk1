# Endotoxin v2 + slices 3 to 5: launch checklist (one Mk1 release)

Branch `feat/endo-slice3`, which carries v2 and slices 3, 4 and 5. Mk1-only: coabuilder, WordPress and the Integration Service do not change. Deploy after lab hours with the `accumark-deploy` skill. Every production read below is read-only and needs the Handler's approval at the time it runs: `SET TRANSACTION READ ONLY`, through Tailscale `root@100.120.92.93` only.

## A. Before the deploy (production, read-only)

Run these against production first. **Blocking** means any row returned stops the deploy until the Handler rules.

| # | Query | Where drafted | Blocking |
|---|---|---|---|
| 1 | Active specs whose unit differs from the service's catalog unit (slice 3 A.0 item 3) | `gates-backend.md` section 7, query 1 | no, informs |
| 2 | Native results whose unit matches neither a spec nor the catalog unit (they would ship with no spec) | `gates-backend.md` section 7, query 2 | **yes** |
| 3 | Services whose ACTIVE specs span more than one normalized unit, `lower(btrim(coalesce(unit,'')))`. Any service other than 281 needs a ruling. | `preflight-rulings.md` Task 9 | **yes** |
| 4 | Endotoxin vials by normalized sample type, including empty. This decides whether the 350 EU/vial row is Peptide-scoped or a wildcard. | `gates.md` "Still open before deploy" | decision |
| 5 | Profile COA texts that save validation would refuse, or that already hold a macro: `unknown_macros(t)` non-empty, OR `resolve(t, {}) != t`, over the basis note, method, prep and every footnote text | slice 4 spec section 9 | **yes** |

**Results, 2026-10-14 (run with the Handler's approval, read-only, on production v1.48.0).**

All five queries ran in one script. Each ran in its own `SET TRANSACTION READ ONLY` transaction and was rolled back.

| # | Result | Verdict |
|---|---|---|
| 1 | 2 rows: `PH-MEASURE` specs 61 (Bacteriostatic Water) and 62 (wildcard), with no unit, against catalog unit `pH` | No impact. When no spec row is filed in the result's unit and that unit is the catalog unit, `resolve_spec` runs today's lookup (`coa/spec_rules.py:116-124`), so pH results keep these specs |
| 2 | 0 rows | **PASS** |
| 3 | 0 rows | **PASS** |
| 4 | `ENDOTOXIN-USP85LAL` vials: Peptide 323, Peptide Blend 88, Bacteriostatic Water 36, and none with an empty sample type. `ENDO-LAL`, the SENAITE-born service: Peptide 638, Peptide Blend 151, Bacteriostatic Water 54 | **Decision: scope the 350 EU/vial row to Peptide.** Peptide Blend folds into the Peptide matrix (`coa/spec_rules.py:21`), and bac water stays EU/mL, so no wildcard row is needed |
| 5 | 12 profiles, 0 hits | **PASS** |

**How to run query 5.** Production's current image has no `coa.text_macros`. Pipe the module's source in first, then the check script without its import line:
`cat backend/coa/text_macros.py check.py | ssh root@100.120.92.93 'docker exec -i -w /app accu-mk1-backend python -'`
The module must come first because it begins with `from __future__ import annotations`.

## B. The release

1. Merge `origin/master` (v1.48.0 or later) into the branch. Expect one conflict, in `src/store/ui-store.ts`; `database.py` and `main.py` auto-merge (checked against v1.48.0 on 2026-10-14).
2. Re-run the gates as failure-set diffs against master: frontend checks, backend suites in a stack container on a scratch DB, and the Postgres-only tests.
3. Push and open the PR. The PR body includes:
   - this checklist;
   - the slice 3 rollback runbook (slice 3 spec section 9);
   - the slice 4 rollback order (slice 4 spec section 9);
   - the slice 5 rollback note: nothing to undo for a rollback to v1.48.0, and the materialisation SQL (slice 5 plan, Appendix A.0 item 11) is only for an image with v2 but without slice 5;
   - the Handler's final-review rulings: every endo field is final on a promoted row (correct it by retest), and Re-apply moves a row's reading into its history and clears it;
   - the two em dashes kept on purpose in `lims_analyses/promote_flow.py` (moved stored strings, slice 3 A7);
   - the method 26 default gap (v2).
4. Deploy after lab hours with the `accumark-deploy` skill. Boot runs the migrations, all idempotent:
   - three `lims_analyses` columns plus the spec index swap (slice 3);
   - the `endo_prep_rules` table and four `worksheet_items` columns (slice 5).

   Expect one new `migration_skipped` warning on the first boot, for `CREATE TABLE endo_prep_rules`. That boot runs before `consumable_types` exists, and `create_all` then builds the table from the model. After boot, confirm the table exists (`\d endo_prep_rules`).

   Compare the boot's `migration_skipped` lines with the previous boot's, because production may already log others: the prod-shaped stacks log two `lims_analyses_review_state_check` skips on every boot. Any new skip other than `endo_prep_rules` is a stop.

## C. Launch steps (after the new image is healthy)

1. **Cartridges.** Consumables: add the three Endosafe cartridges (0.05, 0.01, 0.005 EU/mL) with their real part numbers.
2. **Reader.** Instruments: set the reader's serial on the reader instrument.
3. **Method.**
   - Before flipping the default, check that method 26's run parameters match Dennis's current method.
   - Make the "Endotoxin" method revision (method 26) the **default** for `ENDOTOXIN-USP85LAL` (281). Without the default, no worksheet resolves a method on production.
   - Link the cartridges, set the run parameters, then activate the revision.
4. **Spec.** In the spec editor for 281, add the 0 to 350 EU/vial row scoped to Peptide (query 4, 2026-10-14), with LOQ left empty. Leave every EU/mL row active, because bac water stays EU/mL.
5. **Profile text.** Only after steps 1-4 and a healthy image: add `[LOD {lod}.]` to the method text of the peptide endotoxin profile and the bac water endotoxin profile.
6. **Prep rules.** The rules table ships empty, so every 2 mL row preps at the standard until Dennis adds lines on the rules page. Nothing to do at launch.
7. **Smoke test.** Run one test sample end to end:
   - a 2 mL worksheet;
   - promote;
   - review on the sample page, which shows LOQ and LOD under the value;
   - a COA preview showing "< LOQ", LOQ 25 and "LOD 0.05 EU/mL." in the footer.

## D. Rollback (in this order)

1. **Slice 5: nothing to undo when rolling back to v1.48.0 or earlier.**
   - Those images have no v2 2 mL worksheet, so they read none of the rule columns.
   - Leave the rule locks in place, so a roll-forward picks them up unchanged.
   - Do NOT run the materialisation SQL in the slice 5 plan (Appendix A.0 item 11). It would turn ruled rows into typed overrides. It applies only to a rollback to an image that has v2 without slice 5, and no such image has shipped.
2. **Then slice 4.** Remove `{lod}` from every profile text. The slice 4 spec section 9 has the query and an API-down fallback. Otherwise the old image prints the macro literally.
3. **Then slice 3.**
   - Deactivate the EU/vial spec row(s).
   - Hold COA generation and regeneration for every sample with an EU/vial endotoxin parent result. The SQL is in slice 3 spec section 9.
   - Redeploy the previous image.
4. **Roll-forward** reverses this: redeploy, reactivate the EU/vial row(s), release the hold, then put the profile text back.
