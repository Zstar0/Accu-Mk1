# Endotoxin slice 3: gate results and launch rehearsal

Branch `feat/endo-slice3`. Base `feat/endo-worksheet-v2` @ 4efbd083. The gates ran on 2026-10-13.

## Gates

| Gate | Result | Record |
|---|---|---|
| Frontend typecheck, lint, ast-lint | PASS. Identical to base: tsc exits 0; 941 lint problems and 3 ast errors on both sides | `gates-frontend.md` |
| Frontend format | PASS. The only extra flagged files are the slice 3 plan and spec docs, the same `docs/superpowers` class base already flags (317 files); no `src/` file is flagged | `gates-frontend.md` |
| Frontend vitest | PASS. The branch has 9 failing tests, base has 13. The one extra is a 5 s timeout cascade in `analysis-profiles-coa-display.test.tsx`, an untouched file that runs at 4.1 to 5.0 s on both trees, so it is flaky | `gates-frontend.md` |
| Backend suites (stack container, scratch DB) | PASS. The branch and base fail the same 163 ids; the branch passes 4956 tests to base's 4840; every slice 3 file passes | `gates-backend.md` |
| Postgres-only tests | PASS. Index swap 3/3 and v2 migration 1/1. `test_hplc_native_schema` is 15/16; the one failure (its live INSERT omits `received_at`) also fails on base | `gates-backend.md` |

## Launch rehearsal (stack `endos3`, staged at da5bfc77)

This was a fresh stack from the 2026-09-11 golden, so v2 and slice 3 migrated together, as production will.

The golden has no native `ENDOTOXIN-USP85LAL` service. `seed_native_endo.py` builds a production-shaped one through the app's own API. It creates the EU/mL specs as on production, the "Endotoxin" method revision as the service's default, three cartridges and native vials on a 2 mL worksheet. It is re-runnable: a second run changes nothing.

1. **Boot.** PASS. The three `lims_analyses` columns are added, and the three unit-aware spec indexes replace the old names.
2. **Specs.** PASS. The Peptide 0 to 350 EU/vial row is accepted beside the EU/mL rows, and a duplicate in the same scope and unit gets 409.
3. **Promote.** PASS. The peptide and bac water rows are promoted to `parent_to_verify` with LOQ/LOD. The Invalid, inconclusive, SENAITE-born and parent-holds rows are refused with the exact reason texts, and the provenance audit rows are written.
4. **Repeat.** PASS. Every row is refused, with no new parent rows and no 500.
5. **Concurrency.** PASS. Two simultaneous requests for one row leave exactly one parent; the loser hit the unique index and was refused.
6. **Verify and COA.** PASS.
   - The peptide row shows "< LOQ" with LOQ 25 and is judged against 0 to 350 EU/vial.
   - The bac water row (0.005 cartridge, "<0.1") shows "< LOQ" with its own LOQ 0.1, not the spec's 0.2, and is judged against 0 to 0.25 EU/mL.
7. **Unchanged path.** PASS. An EU/mL result promoted the old way is judged against 0 to 5 EU/mL with the spec's LOQ 2.5.

The stack's `coa_generation` key was removed for steps 6 and 7, so it runs in `senaite` mode, which is production's effective mode (production has no key). The mk1-mode 502 is recorded in `gates-backend.md`. It comes from the existing legacy-rows preflight, not from slice 3.

## Still open before deploy

- **Read-only production queries.** These need the Handler's approval at the time; the drafts are in `gates-backend.md`.
  1. A.0 item 3's first query.
  2. A.0 item 3's second query. It is blocking.
  3. Services whose active specs span more than one unit. It is blocking: any service other than `ENDOTOXIN-USP85LAL` needs a ruling.
  4. Endotoxin vials by normalized sample type, including an empty one. The Peptide-scoped 350 EU/vial row matches only `Peptide` (and `Peptide Blend`). Any other or empty sample type is refused promote with "No active ... spec in EU/vial".
- **UAT with the Handler and Dennis (Step 6).**
  - Box 3 shows checkboxes only on eligible rows, with the reasons on hover.
  - The confirm dialog shows exactly what is sent.
  - Each row gets its own result.
  - The Promoted chip appears after a refresh.
  - Stock worksheets show nothing.
  - The sample page shows LOQ and LOD under the value, and the result's LOQ in the Spec column.
  - A regenerated COA preview prints "< LOQ".
  - Dark mode works.
