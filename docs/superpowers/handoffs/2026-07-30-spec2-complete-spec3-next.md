# Handoff: Spec 2 (Native COA Sections) COMPLETE — spec 3 planning next

*Created 2026-07-30. Paste this into a fresh session to resume with full context.*

---

You're picking up the new-test-families program (Heavy Metals / Moisture / Sterility USP<71> / à-la-carte pH via a UI-managed Mk1 catalog). **Status: specs 1 AND 2 fully executed, reviewed, E2E-proven, and PR'd. Deployment is deferred to one combined window after spec 3.** Your job is to drive whatever the user asks next — most likely spec-3 planning, PR-review follow-ups, or lab-gate prep.

## Working directories (verified fresh at handoff time)

| Repo / dir | Path | Branch | Head |
|---|---|---|---|
| Mk1 spec-2 worktree | `C:\tmp\Accu-Mk1-coa-sections` | `feat/native-coa-sections` | `a9338a2` |
| COABuilder spec-2 worktree | `C:\tmp\coabuilder-coa-sections` | `feat/native-coa-sections` | `03507d4` |
| IS spec-2 worktree | `C:\tmp\is-coa-sections` | `feat/native-coa-sections` | `ee3746c` (tree has an uncommitted ` M .planning/STATE.md` — GSD hook residue, NOT part of the work; leave or `git checkout --` it, never commit it) |
| Mk1 spec-1 worktree | `C:\tmp\Accu-Mk1-catalog-foundation` | `feat/catalog-foundation` | `08e972f` |
| Mk1 main checkout (specs+plans) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | `docs/analysis-catalog-specs` | `092fdf2` (pre-existing dirty AGENTS.md/CLAUDE.md/scripts — CRLF artifacts, not ours) |
| COABuilder main checkout | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\coabuilder` | detached HEAD **v2.14.8, 64 commits stale — INTENTIONAL parking; never recon/plan from it; use `git show origin/master:` or a worktree** | `2c95762` |

**Open PRs (all "multiple PRs, deploy later" per Handler ruling):** spec 1 — Mk1 [#87](https://github.com/Zstar0/Accu-Mk1/pull/87) (docs→master) + [#88](https://github.com/Zstar0/Accu-Mk1/pull/88) (code, stacked on the docs branch); spec 2 — Mk1 [#89](https://github.com/Zstar0/Accu-Mk1/pull/89) (stacked on `feat/catalog-foundation`), coabuilder [#5](https://github.com/ValenceAnalytical/coabuilder/pull/5), IS [#19](https://github.com/ValenceAnalytical/accumark-integration-service/pull/19).

## What's on the branches

**Layer 1 — spec-1 close-out (2026-07-29):** catalog foundation (Departments, service CRUD w/ origin+local_overrides, Analysis Profiles, admin UI) finished 9/9 tasks + final review; UAT'd on devbox stack `catui` (Handler drove the UI; controller drove all guard paths — every 400/409 verbatim-verified); pushed + PRs #87/#88. Devbox golden refreshed to latest masters first (`golden-20260729-210904.tar.gz`, upgrade-in-place procedure).

**Layer 2 — spec-2 plan (this session):** recon of all three repos (the COABuilder recon initially read the stale parked checkout and wrongly concluded the variance machinery didn't exist — re-run against `origin/master` blobs). Plan at `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\plans\2026-07-30-native-coa-sections.md` (also on the branch), 9 tasks, one documented spec correction (dynamic-bg allow-list must include `Generic Page 2 - Addons`).

**Layer 3 — spec-2 execution (SDD, 11 tasks — 14 plan defects caught):** Mk1: origin-gated ID-keyed native promote (write-back skipped when the PARENT row's service is `origin='mk1'`; identity/unit from the catalog service), profile `coa_section_title`/`coa_archetype`(NULL=dark)/`coa_sort_order` + admin UI, fail-closed `build_native_sections` (`backend/coa/native_sections.py`), S2S `GET /samples/{id}/coa-sections`, attach on ALL Mk1 builder POSTs (closed world: generate, regular-child, regen-primary [Task 4b — E2E found it]; vial-tier out). COABuilder: `attach_native_sections` (rules 2/3/5/6, spec-fill from baked specs incl. HM/USP71 initials + INFORMATIONAL_KEYWORDS + `equals` specs; peptide-class matrix normalization; badge downgrade), 3-site server intake with HTTPException-safe boundaries, digital parity (key omitted when empty), `Templates/Additional Analyses` paginated renderer, both-branch template routing, 3-member bg allow-list. IS: `get_native_sections` adapter (404 body-matcher — Mk1's not-found wording is deliberately load-bearing; status-error body logging) + fail-closed gates on BOTH doors (webhook `_trigger_additional_coa_if_published`; desktop `regenerate_additional_coa` [Task 8b — implementer found it]).

**Layer 4 — proof + wrap:** full E2E on devbox stack `s2e2e` — catalog seeded via the admin API, `heavy_metals: true` injected into IS `order_submissions`, bench→promote (SENAITE silent), golden render, FAILED-badge both directions (route-level, discharging the Task-6 binding obligation), retract abort, additional-COA both directions incl. Mk1-down abort, empty-order semantics (coa_data OMITS the key). Final whole-branch review (most capable model): **Ready to merge — Yes**; final IS fix wave (404 matcher + body logging) re-reviewed clean.

The authoritative record is the SDD ledger: `C:\tmp\Accu-Mk1-coa-sections\.superpowers\sdd\2026-07-30-native-coa-sections\progress.md` (spec-1's: `C:\tmp\Accu-Mk1-catalog-foundation\.superpowers\sdd\2026-07-30-...` sibling dir `2026-07-28-catalog-foundation`).

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| COABuilder main checkout is 64 commits stale (intentional detached parking) | A recon agent "proved" master code didn't exist | `git show origin/master:<path>` / worktrees only; memory `architecture_coabuilder_detached_head` updated |
| accumark-stack `create` false-fails (minio-init) BEFORE restore | Healthy-but-empty stack stuck in 'creating' | Manual `restore.sh` + state-fix in allocations.json+meta.json (proven 3×; in memory) |
| accumark-stack NEVER wires `ACCUMK1_BASE_URL`/`ACCUMK1_INTERNAL_SERVICE_TOKEN`/`COA_BUILDER_URL` for IS | S2S + builder calls dead on any stack | s2e2e has `~/.accumark-stack/stacks/s2e2e/docker-compose.override.yml` — **wiped if `mount` reruns; reapply + force-recreate IS**. Platform fix unsigned |
| Mk1 backend drops ALL `logger.info` stack-wide (no basicConfig; root=WARNING) | Log-based assertions silently unobservable (bit the E2E) | Pre-existing; use behavior/DB proofs; deferred item |
| Each repo's venv lives in the MAIN checkout, worktrees have none | Wrong interpreter = bogus results | Mk1 `.../Accu-Mk1/backend/.venv/Scripts/python.exe`; coabuilder + IS `.../.venv/Scripts/python.exe` in their main checkouts; run FROM the worktree |
| COABuilder gates need env dummies + `app_settings.json` at worktree root, and `--ignore=scripts/test_ui_mock.py` (hard access-violation crash) | Suite won't collect / interpreter dies | `SENAITE_URL/USERNAME/PASSWORD=dummy`; app_settings.json copied (has creds — NEVER commit); baseline = 5 failures |
| `logs/coabuilder.log` is TRACKED and dirties on every test run | Commit pollution | `git checkout -- logs/coabuilder.log` before staging; never `git add -A` |
| Test baselines are non-zero by design: Mk1 64, COABuilder 5, IS 127 | Zero-failure gating = everything looks broken | Gate on sorted failure-set DIFF vs the baseline files in the spec-2 sdd dir |
| IS 404-matcher couples to Mk1's `sample {id} not found` detail wording | Rewording Mk1's 404 outside "not found"+id makes IS fail-loud (deliberate) | Documented in `app/adapters/accumk1.py`; keep in mind if touching the Mk1 endpoint |
| Pushing to a devbox branch checked out in a worktree is refused | Branch updates to devbox fail | Push to `refs/heads/staging/<x>` then `git -C ~/worktrees/<wt> merge --ff-only staging/<x>`; delete staging ref |
| `get_database_url()` ignores `DATABASE_URL` (Mk1) | Local dev Postgres got branch schemas twice (additive) | Standing Handler item, unfixed |
| Opus subagent tier had a ~30-min 529 outage this session | Agents die mid-dispatch | Resume via SendMessage; if repeated, re-dispatch on sonnet |

## Infrastructure state (verified fresh)

- **Devbox** `forrestparker@100.73.137.3`: stack **`s2e2e` RUNNING** (ports 5720-5739; Mk1 backend **:5730**, frontend **:5732**, IS :5725, COABuilder :5728, PG :5720) — spec-2 showcase: sample P-0120, latest generation **LANA-J3TU** (PASSED, Heavy Metals table on p2); login `forrest@valenceanalytical.com` / `s2e2e-uat`. Mounted worktrees `~/worktrees/{Accu-Mk1,integration-service,coabuilder}-s2e2e` at the PR heads. Stack **`catui` RUNNING** (ports 5740-5759) — spec-1 UAT; login pw `catui-uat-2026`. Both left up deliberately for Handler inspection; destroy via `./bin/accumark-stack destroy <name> --yes` + worktree removal when done.
- E2E artifacts: `forrestparker@100.73.137.3:~/s2e2e-artifacts/` (PDFs, extracted text, coa_data dumps, PROVISION-STATE.md).
- Laptop: no services started by this session. GitNexus index stale for Accu-Mk1 (advisory only).

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Mk1 gate | `cd /c/tmp/Accu-Mk1-coa-sections/backend && /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest tests/ -q 2>&1 \| grep -E "^FAILED" \| sed 's/ - .*//' \| sort > /tmp/now.txt && diff /c/tmp/Accu-Mk1-coa-sections/.superpowers/sdd/2026-07-30-native-coa-sections/baseline-failures.txt /tmp/now.txt` |
| Mk1 frontend | `cd /c/tmp/Accu-Mk1-coa-sections && npx tsc --noEmit` (NEVER `npm run check:all`) |
| COABuilder gate | `cd /c/tmp/coabuilder-coa-sections && SENAITE_URL=http://x SENAITE_USERNAME=t SENAITE_PASSWORD=t "/c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/.venv/Scripts/python.exe" -m pytest -q --ignore=scripts/test_ui_mock.py` then diff FAILED-set vs `coab-baseline-failures.txt` (same sdd dir) |
| IS gate | `cd /c/tmp/is-coa-sections && ".../integration-service/.venv/Scripts/python.exe" -m pytest -q` diff vs `is-baseline-failures.txt`; plus `ruff check . && mypy app` = net-zero-new vs 2467/241 |
| Stack health | `ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack validate s2e2e'` (21/21) |

## Outstanding items the user may want next

1. **Spec-3 planning** (catalog order routing — the last spec before the combined deploy). Agenda accumulated in memory + ledger: `is_addon` re-semantics (`standalone`/`requires_base`; registry fact `is_addon` ⇔ `fulfillment_role IS NOT NULL`), `active` consumption, IS 422 on unknown service keys, `_accumark_profile_key` WP meta, vial-role `hm` 7-site checklist, ordered_keys dedup, reserved-prefix keyword validation, unit cross-check-as-warning. Spec doc already written: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\docs\superpowers\specs\2026-07-28-catalog-order-routing-design.md`.
2. **Lab-gate rulings** (before the combined deploy): **G-A incl. the result-lexicon decision** ("ND"/"<0.05" aborts HM certs as shipped — numeric-entry mandate or lt-rules); G-B (shipped default: native non-conformance does NOT force remarks); G-C (first-render sign-off + method-column question); G-D (release point). All detailed at the ledger tail.
3. **PR reviews/merges** (5 open across 3 repos; Mk1 chain #87→#88→#89 auto-retargets on merge; safe partial order COABuilder→Mk1→IS; activation = seed `coa_archetype` LAST).
4. **Deploy-runbook additions** to the `accumark-deploy` skill: coupling facts, seed-catalog-last, IS env vars, ENDO-LAL unit edit, rehearsal regression + fixture gap (no fully-worked golden sample in the snapshot).
5. **Platform fixes (unsigned):** accumark-stack compose wiring for ACCUMK1_*/COA_BUILDER_URL; minio-init create-abort; Mk1 logging basicConfig.
6. **Stack teardown** of `catui`/`s2e2e` + devbox worktrees when inspection is done.

## User collaboration preferences

- Push + PR per spec; **NO deploy until all specs done** — one combined window, sign-offs attach there.
- Additive only; restoring status quo needs no sign-off, widening does. Failing tests default to "test is stale."
- Explicit-path staging always; full absolute paths in every reference; prose recommendations over MCQ; drive forward without check-ins, surface only genuine blockers/decisions.
- npm only (Mk1 FE); Zustand selector syntax; shadcn sectioned font-mono tooltips; worktrees at `C:\tmp\<name>`.
- The user thinks out loud and expects push-back — investigate hunches against code before agreeing (the `is_addon` and Mk1-promote questions both improved the design this session).

## Recommended first action in the new session

Confirm ground truth, then ask which of items 1-3 to drive:

```
git -C /c/tmp/Accu-Mk1-coa-sections log --oneline -1
git -C /c/tmp/coabuilder-coa-sections log --oneline -1
git -C /c/tmp/is-coa-sections log --oneline -1
cat /c/tmp/Accu-Mk1-coa-sections/.superpowers/sdd/2026-07-30-native-coa-sections/progress.md | tail -30
```

If heads are `a9338a2` / `03507d4` / `ee3746c` and the ledger tail reads "SPEC-2 SDD RUN COMPLETE", everything above is current. The ledger and `git log` are authoritative over this document.
