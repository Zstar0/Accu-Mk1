# Endotoxin v2 + slices 3 and 4: launch checklist (one Mk1 release)

Branch `feat/endo-slice3`, which carries v2, slice 3 and slice 4. Mk1-only: coabuilder, WordPress and the Integration Service do not change. Deploy after lab hours with the `accumark-deploy` skill. Every production read below is read-only and needs the Handler's approval at the time it runs: `SET TRANSACTION READ ONLY`, through Tailscale `root@100.120.92.93` only.

## A. Before the deploy (production, read-only)

Run these against production first. **Blocking** means any row returned stops the deploy until the Handler rules.

| # | Query | Where drafted | Blocking |
|---|---|---|---|
| 1 | Active specs whose unit differs from the service's catalog unit (slice 3 A.0 item 3) | `gates-backend.md` section 7, query 1 | no, informs |
| 2 | Native results whose unit matches neither a spec nor the catalog unit (they would ship with no spec) | `gates-backend.md` section 7, query 2 | **yes** |
| 3 | Services whose ACTIVE specs span more than one normalized unit, `lower(btrim(coalesce(unit,'')))`. Any service other than 281 needs a ruling. | `preflight-rulings.md` Task 9 | **yes** |
| 4 | Endotoxin vials by normalized sample type, including empty. This decides whether the 350 EU/vial row is Peptide-scoped or a wildcard. | `gates.md` "Still open before deploy" | decision |
| 5 | Profile COA texts that save validation would refuse, or that already hold a macro: `unknown_macros(t)` non-empty, OR `resolve(t, {}) != t`, over the basis note, method, prep and every footnote text | slice 4 spec section 9 | **yes** |

**How to run query 5.** Production still runs v1.47.1, which has no `coa.text_macros`. Pipe the module's source in first, then the check script without its import line:
`cat backend/coa/text_macros.py check.py | ssh root@100.120.92.93 'docker exec -i -w /app accu-mk1-backend python -'`
The module must come first because it begins with `from __future__ import annotations`.

## B. The release

1. Merge `origin/master` (v1.47.1 or later) into the branch. Expect one conflict, in `src/store/ui-store.ts`; `database.py` and `main.py` auto-merge.
2. Re-run the gates as failure-set diffs against master: frontend checks, backend suites in a stack container on a scratch DB, and the Postgres-only tests.
3. Push and open the PR. The PR body includes:
   - this checklist;
   - the slice 3 rollback runbook (slice 3 spec section 9);
   - the slice 4 rollback order (slice 4 spec section 9);
   - the two em dashes kept on purpose in `lims_analyses/promote_flow.py` (moved stored strings, slice 3 A7);
   - the method 26 default gap (v2).
4. Deploy after lab hours with the `accumark-deploy` skill. Boot runs the migrations: three `lims_analyses` columns plus the spec index swap, all idempotent.

## C. Launch steps (after the new image is healthy)

1. **Cartridges.** Consumables: add the three Endosafe cartridges (0.05, 0.01, 0.005 EU/mL) with their real part numbers.
2. **Reader.** Instruments: set the reader's serial on the reader instrument.
3. **Method.**
   - Make the "Endotoxin" method revision (method 26) the **default** for `ENDOTOXIN-USP85LAL` (281). Without the default, no worksheet resolves a method on production.
   - Link the cartridges, set the run parameters, then activate the revision.
4. **Spec.** In the spec editor for 281, add the 0 to 350 EU/vial row, scoped to Peptide or as a wildcard per query 4, with LOQ left empty. Leave every EU/mL row active, because bac water stays EU/mL.
5. **Profile text.** Only after steps 1-4 and a healthy image: add `[LOD {lod}.]` to the method text of the peptide endotoxin profile and the bac water endotoxin profile.
6. **Smoke test.** Run one test sample end to end:
   - a 2 mL worksheet;
   - promote;
   - review on the sample page, which shows LOQ and LOD under the value;
   - a COA preview showing "< LOQ", LOQ 25 and "LOD 0.05 EU/mL." in the footer.

## D. Rollback (in this order)

1. **Slice 4 first.** Remove `{lod}` from every profile text. The slice 4 spec section 9 has the query and an API-down fallback. Otherwise the old image prints the macro literally.
2. **Then slice 3.**
   - Deactivate the EU/vial spec row(s).
   - Hold COA generation and regeneration for every sample with an EU/vial endotoxin parent result. The SQL is in slice 3 spec section 9.
   - Redeploy the previous image.
3. **Roll-forward** reverses this: redeploy, reactivate the EU/vial row(s), release the hold, then put the profile text back.
