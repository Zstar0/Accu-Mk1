# Endotoxin slice 3: frontend gate (Task 9 Step 1), failure-set diff

Run 2026-10-13. Read-only against both trees (no edit, format, commit or checkout; both trees' `git status` unchanged afterwards).

- BRANCH: `C:/tmp/Accu-Mk1-endo-s3`, `feat/endo-slice3`, HEAD `1b5317ed`
- BASE: `C:/tmp/Accu-Mk1-endo-v2`, `feat/endo-worksheet-v2`, HEAD `4efbd083` (the branch's merge-base). Used in place of a throwaway worktree; its one untracked docs folder (`uat-screens/`) was left alone.
- Each check ran on its own, base first, then branch, one after the other. Logs: `/c/tmp/endo-s3-gates/fe-<base|branch>-<check>.log`.
- Comparison: `(file, severity, rule, message)` tuples for eslint, `(severity, rule, file)` for ast-grep, flagged file paths for prettier, failing `file > suite > test` names for vitest. No line numbers anywhere. The parser is `fe_compare.py` in the session scratchpad. It extends the `gatediff.py` eslint reader to handle the rule-less "Parsing error" entries (11 of them, identical on both trees), which the original regex skips.

## Verdicts

| Check | BASE exit | BRANCH exit | Verdict |
|---|---|---|---|
| typecheck | 0 | 0 | PASS (branch exits 0 as expected) |
| lint (eslint) | 1 | 1 | PASS, subset (identical set) |
| ast:lint | 1 | 1 | PASS, subset (identical set) |
| format:check | 1 | 1 | NOT a strict subset: 2 extra files, both new markdown docs (see below) |
| vitest | 1 | 1 | NOT a strict subset: 1 extra test name, classified flaky (see below) |
| rust steps | skipped | skipped | `git diff --stat 4efbd083 HEAD -- src-tauri` is empty (0 files), confirmed |

No real new failure on the branch. Two items need the Handler's eye: the two unformatted docs (cosmetic, same class as 317 docs already flagged on base) and one marginal-timeout test (flaky, not touched by the branch).

## Counts

| Check | BASE | BRANCH |
|---|---|---|
| typecheck | clean (empty log) | clean (empty log) |
| eslint | 941 problems (839 errors, 102 warnings), 254 distinct tuples | 941 problems (839 errors, 102 warnings), 254 distinct tuples |
| ast-grep | 3 errors | 3 errors |
| prettier | 868 files flagged | 869 files flagged |
| vitest files | 9 failed, 340 passed, 1 skipped (350) | 6 failed, 345 passed, 1 skipped (352) |
| vitest tests | 13 failed, 2680 passed, 11 todo (2704) | 9 failed, 2714 passed, 11 todo (2734) |

The branch adds 2 test files and 30 tests (`endo-promote.test.ts`, `analysis-result-limits.test.tsx`, plus additions in `EndoResultsBox.test.tsx`); all of them pass.

## Subset verdict per check

### typecheck
`tsc --noEmit` exits 0 on both trees. PASS.

### eslint
Branch tuples minus base tuples (with multiplicity): 0 extra. Base minus branch: 0. The two sets are identical, so the new files (`EndoPromoteDialog.tsx`, `endo-promote.ts`, the `api.ts`, `AnalysisTable.tsx`, `AnalysisSpecCell.tsx` and `EndoResultsBox.tsx` edits, and the new tests) add no lint problem. Extra items: none.

### ast-grep
Both trees report the same 3 errors, all rule `hooks-in-hooks-dir`: `src/lib/read-source.ts` (2) and `src/lib/hash-navigation.ts` (1). Extra items: none.

### prettier
Branch files minus base files = 2 extra:

1. `docs/superpowers/plans/2026-10-12-endo-slice3.md`
2. `docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md`

Both are markdown docs this branch added (the plan and the design spec). They are the same class as the 317 `docs/superpowers/*` files already flagged on base, including the v2 predecessors (`docs/superpowers/plans/2026-10-10-endo-worksheet-v2.md`, `docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md`). No source file (`src/`) is flagged that was not flagged on base. Not formatted here because this gate is read-only. If the gate must be a strict subset, `npx prettier --write` on those two files fixes it (a docs-only change, the Handler's call).

One file is flagged on base but not on branch: `backend/.pytest_cache/README.md`. That is an ignored pytest cache directory that exists only in the base tree (`backend/.pytest_cache` does not exist in the branch tree). It is an environment artifact, not a fix by the branch.

### vitest
Branch failing names minus base failing names = 1 extra:

- `src/test/analysis-profiles-coa-display.test.tsx` > AnalysisProfilesPage, COA display fields > `clearing basis/method/prep and removing all footnotes sends nulls`

(The describe title uses an em dash in the source; shown here as a comma.)

Eight failing names are shared by both runs: `src/App.test.tsx` renders main window layout; `analysis-profiles-coa-display` fills basis note (the sibling of the extra one); `peptide-requests-list` Closed tab re-query; `worksheets-inbox-lanes` rider-work sub-chip; three `FlagsFlyout.test.tsx` tests; `PackagingPanel.test.tsx` file-path Save. Five names failed on base only and passed on the branch: two `RaiseFlagButton.test.tsx` tests, two `FlagsPane.addtype.test.tsx` tests and `FlagsPane.scopechips.test.tsx` (all untouched by the branch; consistent with load-sensitive tests moving in and out of the failure set between runs).

## Flaky analysis of the one extra vitest failure

Not in this branch's diff: `git diff --name-only 4efbd083 HEAD` has no path for the test file, `AnalysisProfilesPage`, or any vitest config or setup file. The test file mocks `@/lib/api` with `importOriginal`, and the branch's `api.ts` change (+64 lines) is load-time only.

Evidence it is a marginal-timeout flake, not a regression:

1. **The same test file failed on base in the full run.** On BASE the sibling `fills basis note, method, prep, and two footnotes, and PATCH carries all four` timed out at 5000 ms. On BRANCH both that test and `clearing basis/...` failed. The first is the timeout, the second is its cascade: the timed-out test's body keeps running and leaves state behind, so the next test's `toHaveBeenCalledWith` assertion fails (in the isolated branch run it failed at 419 ms right after the 5015 ms timeout).
2. **That test runs at 4.1 to 5.0 s against a 5 s limit on both trees.** Isolated runs of the file, per-test duration of `fills basis note...`:
   - BASE (8 verbose runs): 4742, 4135, 4406, 4218, 4858, 4130, 4957, 4207 ms. Plus 3 earlier dot-reporter runs, all green.
   - BRANCH (8 verbose runs): 4419, 4252, 4628, 4691, 4205, 5015 (timeout), 4221, 4898 ms. Plus 3 earlier dot-reporter runs, one failed.
   The ranges overlap; the branch median (about 4.5 s) is at most a few hundred ms above base (about 4.3 s), inside the noise of a machine that has many other node processes running.
3. **Load matters.** The full-suite run had 6 timeouts on BASE and 3 on BRANCH under the same conditions.

Isolated re-run tally for `src/test/analysis-profiles-coa-display.test.tsx`:

| Tree | Runs | Pass | Fail |
|---|---|---|---|
| BASE | 11 (3 dot + 8 verbose) | 11 | 0 |
| BRANCH | 11 (3 dot + 8 verbose) | 9 | 2 (both: the 5 s timeout on `fills basis note...` plus the cascade) |

Honest caveat: this is not the clean "3 of 3 pass alone on both trees" the brief sets as the bar. The branch failed 2 of 11 in isolation versus 0 of 11 on base (not statistically distinguishable at this sample size, Fisher exact p about 0.5, and the same test also timed out on base in the full run). Classification: **flaky (test runs 4.1 to 5.0 s against a 5 s timeout on both trees)**. A durable fix is a per-test timeout on that test, which belongs to whoever owns that file, not this branch. If the Handler wants more certainty, run the file 20 times per tree on a quiet machine.

Logs: `fe-<tree>-flaky-coa-display-{1,2,3}.log` (dot) and `fe-<tree>-flaky2-coa-display-{1..8}.log` (verbose).

## Rust

`git -C C:/tmp/Accu-Mk1-endo-s3 diff --stat 4efbd083 HEAD -- src-tauri` is empty (0 files changed). Rust fmt, clippy and test steps skipped.

## Reproduce

```bash
for t in base:/c/tmp/Accu-Mk1-endo-v2 branch:/c/tmp/Accu-Mk1-endo-s3; do
  n=${t%%:*}; d=${t#*:}
  (cd $d && npm run -s typecheck > /c/tmp/endo-s3-gates/fe-$n-typecheck.log 2>&1; echo "typecheck $?"
   npm run -s lint > /c/tmp/endo-s3-gates/fe-$n-lint.log 2>&1; echo "lint $?"
   npm run -s ast:lint > /c/tmp/endo-s3-gates/fe-$n-ast.log 2>&1; echo "ast $?"
   npm run -s format:check > /c/tmp/endo-s3-gates/fe-$n-format.log 2>&1; echo "format $?"
   npx vitest run --reporter=dot > /c/tmp/endo-s3-gates/fe-$n-test.log 2>&1; echo "vitest $?")
done
```
