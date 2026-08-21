# Handoff: USP<71> end-to-end proof + spec-ownership / IS-registry specs

*Created 2026-08-03. Paste this into a fresh session to resume with full context.*

---

You're picking up the new-test-families program. **Two code commits shipped to open PRs, two design
specs written and pushed, and the full Mk1→COABuilder chain for a brand-new test family was PROVEN
end-to-end on stack `s3rehe` against real certificates.** Nothing is deployed — everything attaches to
the ONE combined deploy window per standing ruling. Your job is to drive whatever the user asks next;
most likely turning one of the two specs into an implementation plan.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Mk1 spec-4 worktree | `C:\tmp\Accu-Mk1-bench` | `feat/catalog-driven-bench` | `a1841c5` (clean, pushed → PR #91) |
| COABuilder worktree | `C:\tmp\coabuilder-order-routing` | `feat/catalog-order-routing` | `64e5981` (pushed → PR #6; `logs/coabuilder.log` dirty, pre-existing) |
| Mk1 main checkout (specs/handoffs) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `docs/analysis-catalog-specs` | `c9b98db` (pushed → PR #87) |
| IS worktree (READ-ONLY this session) | `C:\tmp\is-order-routing` | `feat/catalog-order-routing` | `5cabb6f` (untouched) |
| Devbox s3rehe Mk1 | `forrestparker@100.73.137.3:~/worktrees/Accu-Mk1-s3rehe` | `feat/catalog-driven-bench` | **`489dc1b` — STALE, see gotchas** |
| Devbox s3rehe COABuilder | `forrestparker@100.73.137.3:~/worktrees/coabuilder-s3rehe` | `feat/catalog-order-routing` | **`baeebeb` + uncommitted edit — see gotchas** |

**Open PRs:** Mk1 #91 (`a1841c5`) · coabuilder #6 (`64e5981`) · Mk1 #87 docs (`c9b98db`) · plus the
pre-existing chain #87/#88/#89/#90, IS #20 (+#19), accumarklabs #20.

## What's on the branch

### Layer 1 — the investigation (no code)

The user asked how a newly-created USP<71> analysis profile would get a result all the way to the COA,
"like heavy metals." Tracing all four repos found the LIMS half was complete but surfaced a
**latent wrong-certificate bug**: a native section's verdict hangs on exact case-insensitive string
equality between `analysis_services.result_options[].value` (editable in the Mk1 admin UI) and a
hardcoded literal in COABuilder `baked_specs.py`, with **nothing cross-checking the pair** and **no
fail-closed behaviour** — `_verdict`'s `equals` branch silently returns `False`.

### Layer 2 — the end-to-end proof on `s3rehe` (the load-bearing result)

Proven live, in order, all with **zero code changes** for the family itself: profile created in the
admin UI → vial role `usp71` auto-minted → vial plan grew `usp71: 1` → re-roling vial `P-0141-S04`
(`ster` → `usp71`) auto-seeded the analysis → custody edge written (`host`, profile 8) → result
submitted and promoted to a verified parent-tier row **with the SENAITE write-back correctly skipped**
(the spec-2 origin gate, proven for a brand-new native family) → Mk1 emitted both sections → COABuilder
verdicted and rendered.

**Before/after on real PDFs, page 4:**

```
BEFORE  Sterility USP<71>  Not Detected  Pos/Neg  No Growth     Does Not Conform  → cert FAILED
AFTER   Sterility USP<71>  Not Detected  Pos/Neg  Not Detected  Conforms          → cert PASSED
```

Verification codes `F6UX-5UWP` (wrong) and `AH5F-2QSD` (correct), with all four heavy metals conforming
in the section above. Both the variance primary and the Regular child carried 2 sections and flipped
together.

### Layer 3 — shipped code (2 commits, both TDD, RED verified first)

- **coabuilder `64e5981`** — baked spec aligned to `{"equals": "Not Detected", "display": "Not
  Detected"}`. Existing test updated to the new vocabulary (watched fail: `assert False is True`) plus a
  NEW test pinning the other pole (`"Detected"` → non-conforming + badge FAILED). The old test only
  covered the passing case, which is why a wrong vocabulary could never have been caught.
- **Mk1 `a1841c5`** — `coa_section_title` / `coa_sort_order` / `role_boxable` settable at profile
  CREATE. `coa_archetype` stays PATCH-only and now **400s instead of being silently dropped** (arming
  is retroactive: rule A2 refuses the COA of any in-flight sample lacking a verified parent row).
  Includes the FE companion — the create panel sends the new fields, the boxable checkbox renders where
  a role will actually be minted, and title/order stay enabled on create. **Without the FE change the
  backend fields were unreachable** (COA inputs were edit-only AND disabled until an archetype existed).

### Layer 4 — design work (2 specs written + 1 program parked)

- `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-03-native-spec-ownership-design.md`
  (`a46abbc`) — moves native-section specs + verdicts from COABuilder `BAKED_SPECS` onto Mk1 Analysis
  Services. Nullable lab-controlled `matrix` column (NULL = all matrices), deliberately NOT the
  customer intake dropdown. Auditability in-slice.
- `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-08-03-is-catalog-registry-design.md`
  (`b278ae5`, refined by `c9b98db`) — IS declared-key registry syncs from Mk1 instead of needing a
  deploy per family. Startup fetches fresh (non-blocking, 3× bounded retry); frozenset is the floor.
- **Parked program** (user: "we'll get to WP after all these systems are solid") — native Order object,
  shadow products, flags on orders/products. Full decomposition + the ONE open ruling (mirror vs
  authority) is in memory: `project_mk1_commercial_layer_program.md`.

**Both specs are AWAITING USER REVIEW.** Neither has an implementation plan yet.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **s3rehe Mk1 runs `489dc1b`, NOT `a1841c5`** | The profile-create fields (`coa_section_title`/`coa_sort_order`/`role_boxable`) are NOT on the running stack. Testing them there will show the OLD behaviour and look like a regression | `git -C ~/worktrees/Accu-Mk1-s3rehe pull` then `docker restart accumark-s3rehe-accu-mk1-backend accumark-s3rehe-accu-mk1-frontend` (bind mounts, no file-watch) |
| **s3rehe COABuilder carries the spec fix as an UNCOMMITTED working-tree edit** at `baeebeb` | The equivalent change is committed as `64e5981` on origin, but the devbox worktree never pulled. A `git checkout`/`pull` there will conflict or clobber | Discard the local edit and pull: `git -C ~/worktrees/coabuilder-s3rehe checkout -- src/coabuilder_core/baked_specs.py && git -C ~/worktrees/coabuilder-s3rehe pull`, then restart the container |
| Mk1 backend :5770 has **MIXED route prefixes** | `POST /auth/login` and `/analysis-profiles` have NO `/api`; `/api/sub-samples` and `/api/lims-analyses` DO. The `/api`-double trap in reverse | Read `curl -s http://localhost:5770/openapi.json` and grep the real path before guessing |
| `git stash` in `C:\tmp\coabuilder-order-routing` **fails to pop** | `logs/coabuilder.log` is TRACKED and every pytest run dirties it → `git stash pop` aborts with "local changes would be overwritten". Bit me mid-session; edits sat stranded in the stash | `git checkout -- logs/coabuilder.log` then `git stash pop`. Never commit that file |
| COABuilder has 2 PRE-EXISTING failures | `tests/test_native_sections_server.py` errors at COLLECTION (missing `SENAITE_URL`/`USERNAME`/`PASSWORD` env) and `test_variance_page_4_analytes_vial1_from_parent` FAILS. Both verified on a clean stashed tree — NOT regressions | Gate with `--ignore=tests/test_native_sections_server.py`; expect `1 failed, 140 passed` |
| **P-0141 needs its variance set LOCKED to generate a COA** | Generation 409s with `variance_not_locked`. The lock was deliberately cleared for the spec-4 drag/auto-assign UAT | Lock → generate → **unlock** (`POST /api/sub-samples/P-0141/variance-set/{lock,unlock}`). I restored it: `variance_locked_at` is NULL again |
| psql over SSH eats double quotes | `psql -c "select ...'x'..."` → the shell mangles quoting and psql reads `"col"` as an identifier | Always use a heredoc: `ssh host "docker exec -i <pg> psql -U postgres -d <db>" <<'SQL' … SQL` |
| **`analysis_profiles.key` is immutable via the API** | No `key` field on `AnalysisProfileUpdate` — you cannot fix a typo'd key even before any order references it | Direct SQL. The guard arguably should be "immutable once referenced"; flagged, not filed |
| **WP `sanitize_key()` LOWERCASES `profile_key`** | An uppercase Mk1 `analysis_profiles.key` can NEVER match a WP-sent key → silent drop at `catalog_demand.py:27`, customer charged, no vial, no test | Keep profile keys lowercase snake_case. This is why `STERILITY_USP71` → `sterility_usp71` |
| **WP product NAME must normalize to the same string as the wire key** | `Cart_Order.php:1684` builds the product map from `$svc['name']` while `:1459` looks up the normalized wire key. The normalizer strips only `[space - _ & ( )]` — **NOT `<` or `>`**. `"Sterility USP<71>"` → `sterilityusp<71>` ≠ `sterilityusp71` → no add-on line item, price silently folded into base | Name the WC product `Sterility USP 71` or `Sterility USP-71` |
| Mk1 suppresses ALL `logger.info` (no basicConfig) | Seed/mint log lines never appear in `docker logs` — looks like nothing ran | Verify via DB or API, never logs |
| GitNexus "index is stale" advisory fires on nearly every Bash call | Pure noise unless you're using GitNexus MCP tools | Ignore, or clear with `npx gitnexus analyze --embeddings` |

## Infrastructure state

**Devbox `forrestparker@100.73.137.3`** — `s3rehe` is the UAT stack for this work, all 11 containers up
and healthy (21/21 validate).

- Ports: Mk1 BE **:5770** / FE **:5772** / IS :5765 / COABuilder :5768 / WP :5775 / SENAITE :5778 /
  Postgres :5760 / MinIO :5779
- Login `forrest@valenceanalytical.com` / `s3rehe-uat`
- Databases: `accumark_mk1`, `accumark_integration` (user `postgres`, container `accumark-s3rehe-postgres`)
- Both Mk1 and COABuilder are **bind-mounted from `~/worktrees/*-s3rehe`** — restart containers after any
  git operation; there is no file-watch.

**State I changed on s3rehe this session (all reversible test-stack data):**

- `analysis_profiles` id 8: key `STERILITY_USP71` → **`sterility_usp71`**, `coa_archetype='limit_table'`,
  `coa_section_title='Sterility Testing'`, `coa_sort_order=20`
- `analysis_services` id 234: `result_options` values now match labels (`Not Detected`/`Detected`),
  `variance_capable=false`
- `vial_roles` id 7 (`usp71`): `boxable=true`
- IS `order_submissions` order `3269` payload: gained `"sterility_usp71": true`
- Vial `P-0141-S04` re-roled `ster` → `usp71`; parent-tier row 3645 verified with `Not Detected`
- 4 COA generations minted on P-0141 (`F6UX-5UWP`, `V2AQ-JSBZ`, `AH5F-2QSD`, `Y4XB-A32P`)
- P-0141 variance lock: locked then **unlocked** — back to the pre-session state

**15 devbox stacks are currently up** (`boxing cat1d catalog catui flagp2 gfinal lotuat plain registry
s2e2e s3rehe sbs slackdm unlock xfer`). Most are stale from earlier programs — teardown candidate.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Mk1 backend gate (failure-set diff — NEVER zero-failures) | `cd /c/tmp/Accu-Mk1-bench/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/ -q 2>&1 \| grep -E "^FAILED" \| sed 's/ - .*//' \| sort > /tmp/now.txt; diff /c/tmp/Accu-Mk1-bench/.superpowers/sdd/2026-07-30-catalog-driven-bench/baseline-failures.txt /tmp/now.txt` (empty = green; baseline is 64) |
| Mk1 FE typecheck | `cd /c/tmp/Accu-Mk1-bench && npx tsc --noEmit` (NEVER `npm run check:all`) |
| Mk1 FE profile tests | `cd /c/tmp/Accu-Mk1-bench && npx vitest run src/test/analysis-profiles-fulfillment.test.tsx src/test/analysis-profiles-ride-hosts.test.tsx` (27/27) |
| COABuilder suite | `cd /c/tmp/coabuilder-order-routing && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/test_native_sections_server.py` (expect `1 failed, 140 passed`) |
| Stack health | `ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate s3rehe'` (21/21) |
| Live spec-4 + USP<71> spot-check | `ssh forrestparker@100.73.137.3 "docker exec -i accumark-s3rehe-postgres psql -U postgres -d accumark_mk1" <<'SQL'` … `select code, boxable from vial_roles order by sort_order;` … `SQL` (7 rows incl. `usp71`) |

## Outstanding items the user may want next

1. **Review the two specs and pick one to turn into an implementation plan.** Both are pushed on PR #87
   and awaiting review. Spec ownership is the one that compounds (kills the string-coupling bug class);
   the IS registry is the one that removes a deploy per family.
2. **Two open lab/product questions blocking the spec-ownership slice:** (a) is USP<71> (and heavy
   metals) sellable on **Bacteriostatic Water**? Every native baked spec is `("Peptide", …)`-keyed
   today, so a BW native section 422s the entire certificate — `matrix=NULL` fixes it either way, but
   an explicit answer lets the lab file BW-specific limits. (b) Should unit divergence become
   fail-closed? Currently warns and renders, which can produce a confidently wrong verdict on ppm-vs-ppb
   — tightening it is a production-behaviour change needing sign-off.
3. **Refresh s3rehe to `a1841c5`** and UAT the profile-create fields (see gotcha #1). Nothing on the
   running stack exercises them yet.
4. **Display calls the lab should make on the USP<71> certificate:** `Pos/Neg` currently prints in the
   Unit column (legacy sterility hardcodes blank), and page 2 shows PCR as `Result = Pass` while page 4
   shows USP<71> as `Result = Not Detected` — same document, two vocabularies.
5. **The G-A ruling proper:** the exact reporting string lives in TWO repos with nothing cross-checking
   them. `Not Detected` was shipped to match the Sterility PCR bench vocabulary; if the lab wants
   different wording, both sides move together.
6. **Security finding, independent of all of this:** `C:\tmp\Accu-Mk1-bench\backend\main.py:9734` calls
   WooCommerce with `verify=False` — TLS verification disabled on a client holding full WC consumer
   key + secret (`main.py:9715-9716`). Small, isolated, fix on its own merits.
7. **PR reviews/merges** — 10+ open across 4 repos; #91 merges after #90.
8. **Devbox stack teardown** — 15 stacks up; most are stale from earlier programs.
9. **WordPress / G-PUB** — explicitly deferred by the user ("we'll get to WP after all these systems are
   solid"). Note the wizard card grid is still the actual wall blocking *sale* of a new family.

## User collaboration preferences

- **Push + PR per spec; NO deploy until the ONE combined window.** Sign-offs attach there.
- **Additive only.** Failing tests default to "the test is stale"; production-behaviour changes need
  sign-off (which is why the vial-delete CASCADE and unit-divergence questions are rulings, not fixes).
- **Drive forward without check-ins.** Surface only genuine blockers/decisions. Prose recommendations
  over multiple-choice. **Full absolute paths everywhere.**
- **TDD is expected and enforced** — write the test, watch it fail for the right reason, then implement.
  Baseline any pre-existing failures on a clean tree before claiming green.
- **Don't make unasked-for display decisions** — surface them instead (the `Pos/Neg` unit was
  deliberately left alone and reported rather than "fixed").
- **Don't mutate the user's in-flight UAT state** without restoring it (the P-0141 variance lock was
  locked, used, and unlocked).
- npm only for Mk1 FE; worktrees at `C:\tmp\<name>`; rich sectioned font-mono tooltips are the FE default.
- The user tests hands-on and reports UI friction conversationally — fix small UI feedback immediately on
  the branch, push, and update the stack in the same breath.

## Recommended first action in the new session

Confirm the four heads still read as above, then **ask which spec to plan first** — that is the genuine
fork and the user has not chosen:

```bash
git -C /c/tmp/Accu-Mk1-bench log --oneline -1                                                    # a1841c5
git -C /c/tmp/coabuilder-order-routing log --oneline -1                                          # 64e5981
git -C "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" log --oneline -1   # c9b98db
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-s3rehe log --oneline -1'             # 489dc1b (STALE — expected)
```

Both specs are written and pushed; neither has a plan. `git log` and the spec files are authoritative
over this document.
