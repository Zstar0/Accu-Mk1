# Handoff: COA Variance Arc — identity-N/A, variance series, lab remarks, variance report page

*Created 2026-06-12. Paste this into a fresh session to resume with full context.*

---

You're picking up a multi-repo COA feature arc that's getting close to a coordinated deploy. Three features are **built + tested** (identity-gated N/A, variance results series, customer lab remarks). A fourth (customer Variance Report page) has **spec + plan written but NOT built**. There are also **uncommitted working changes** in Accu-Mk1 that fix a production-shape gap in the variance-series builder — verify and commit those first. Your job is to drive whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Accu-Mk1 (subvial worktree) | `C:/tmp/Accu-Mk1-subvial` | `subvial/continue` | `3466d17` docs(plan): variance report page |
| COABuilder (feature worktree) | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` | `21192e7` lab_remarks + gate (2.17.0) |
| Integration Service | `…/Accumark-Workspace/integration-service` | `feat/variance-services-map` | `5b989e4` lab_remarks passthrough |
| wpstar theme (accumarklabs repo) | `//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs` | (WP repo) | committed `c4bb3ad` lab remarks (this session) |
| Design bundle (extracted, read-only) | `C:/tmp/variance-design/accumark-labs-design-system` | — | source for the variance report concepts |

**Uncommitted in Accu-Mk1-subvial** (intentional, NOT yet committed): `M backend/coa/variance_series.py`, `M backend/tests/test_variance_series.py`. Also `M package-lock.json` (pre-existing, leave it).

## What's on the branch

**Layer 1 — Identity-gated N/A (COABuilder, shipped):** when an analyte's identity doesn't conform, its purity & quantity render `N/A` on both the PDF and the digital/verify COA. Lives in `ConformanceEngine` (`_na_if_identity_fails`, `_NA_COLOR=#6B7280`); covers single-peptide + blend per-analyte rows. wpstar got a neutral `.na` badge (committed in accumarklabs). COABuilder 2.14.8→2.15.0. Tests: `tests/test_identity_fail_na.py` (3).

**Layer 2 — Variance results series (Mk1 + COABuilder, shipped):** purity/quantity cells show the parent figure + each `assignment_kind='variance'` vial comma-delimited (PDF only); identity shows a roll-up summary (`Conforms 3/3` / `Mixed 2/3` / `Does Not Conform 0/3`, green when all conform, slate `#444F5B` otherwise). The **digital COA is unchanged** — each variance row carries a `digital` single-value override that `_build_coa_data_json` renders. Mk1 `coa/variance_series.py` `build_variance_replicates` sends per-vial records in the `/process` body; COABuilder prepends its own parent figure (style 2) and gates each figure by its own identity. Status stays parent-driven. COABuilder →2.16.0. Tests: Mk1 `test_variance_series.py`, COABuilder `test_variance_series_render.py` (8).

**Layer 3 — Customer Lab Remarks (all 4 repos, shipped):** new `lims_samples.customer_remarks` (Mk1) — "Remarks" renamed "Internal Remarks", new "Customer Remarks" card on parent pages. Rides the publish rail: Mk1 `generate-coa` → COABuilder `coa_data.lab_remarks` → IS `COANotificationPayload.lab_remarks` → WP `_accumark_coas[sid]['lab_remarks']` → "Remarks from the Lab" in the COA email (published + reissued, html + plain) and a "Lab Remarks" button/modal on the order page. **Hard gate in COABuilder:** a non-conforming COA (any identity/purity row not conforming) with empty remarks → 422 (`coa_requires_lab_remarks`), on every generation incl. re-publish (field persists, so re-publish only blocks if the lab cleared it). COABuilder →2.17.0. Tests: Mk1 `test_customer_remarks.py` (4), COABuilder `test_lab_remarks_gate.py` (4), IS `test_lab_remarks_payload.py` (2). wpstar committed `c4bb3ad` (this session's accumarklabs HEAD).

**Layer 4 — Customer Variance Report page (SPEC + PLAN ONLY, not built):** a dedicated `/variance-report/` WP page (shortcode), reached from a new order-page button, rendering the design handoff's **C-then-B** concepts (replicate dashboard cards + range/conformance plot) as server-side SVG, customer-toned (Conforms/Does Not Conform, coral only for genuine out-of-spec, "Result 1…N" labels). Push rail: COABuilder `build_variance_report` → `coa_data.variance_report` → IS payload → WP order meta → page. Spec `docs/superpowers/specs/2026-06-12-variance-report-page-design.md`; plan `docs/superpowers/plans/2026-06-12-variance-report-page.md` (6 tasks). **Nothing implemented yet.**

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Uncommitted variance_series.py fix is load-bearing** | Production single-peptide vials use GENERIC purity/quantity services (`HPLC-PUR`, `PEPT-Total`) with `peptide_id=NULL`. The original builder keyed only on `AnalysisService.peptide_id`, so those rows were dropped. The uncommitted edit resolves the vial's *sole* peptide (from its identity row) and attaches generic PUR/QTY to it, plus a local `_category` that recognizes `PEPT-Total`. | Run `test_variance_series.py` (passes 4/4 now), then commit it before building Layer 4 — `build_variance_report` (plan Task 1) builds on this same data. |
| COABuilder gate fires inside COABuilder, not Mk1 | The non-conforming-remarks 422 reaches the tech via the generic COA-failure toast, not Mk1's structured-422 UX | By design; don't "fix" it unless the Handler asks for styled error |
| Variance series is PDF-only; digital uses `digital` override | Putting the series in `result` alone would leak it to the verify page | The `digital` dict on each variance row is what `_build_coa_data_json` reads; blend identity composite reads `(r.get("digital") or r)` |
| IS repo mandates GitNexus before edits | `CLAUDE.md` requires `gitnexus_impact` before editing a symbol + `gitnexus_detect_changes` before commit; `COANotificationPayload` is HIGH risk (hub) | Run them; scope for payload additions is always the same 4 files (adapter + 3 publish paths). Stale-index advisory after Bash is just advisory — `npx gitnexus analyze --embeddings` to refresh |
| Git Bash mangles `/var/...` paths in `docker exec` | `php -l "/var/www/..."` becomes `C:/Program Files/Git/var/...` | Wrap in `docker exec <c> sh -c 'cd /var/www/html/wp-content/themes/wpstar && php -l <f>'` |
| Backticks in `git commit -m "..."` trigger shell substitution | Dropped a word once this session | Use `git commit -F -` with a heredoc for bodies containing backticks |
| Pre-existing baseline test failures | `test_sub_samples_routes::test_list_sub_samples_with_children` fails on master too; `test_generic_page2_layout` errors on missing `reportlab` (env) | Stash-baseline before blaming new work; both verified pre-existing this session |
| wpstar theme IS the live WSL volume | `php -l` in the container resolved the same files I edited | Edits are live on the subvial stack immediately; no copy step |

## Infrastructure state

All `accumark-subvial-*` containers healthy. Ports (from earlier handoffs): FE 5532, Mk1 API 5530, SENAITE 5538 (`forrest@valenceanalytical.com` / `Valence2025!`), WP 5535, IS 5525, coabuilder 5528, Postgres 5520, MailHog UI 5522. Mk1 stack login `forrest@valenceanalytical.com` / `test123`.

- Mk1 backend bind-mounts `C:/tmp/Accu-Mk1-subvial/backend` with `--reload`; recreate (not restart) for env changes (see prior handoffs for the compose command).
- **COABuilder + IS containers run pinned images** — the `feat/*` branch code is NOT in the running stack containers. Per-repo unit tests cover the seams; full cross-stack E2E needs rebuilt images or local services.
- Postgres: user `postgres`, pw in container env; DBs `accumark_mk1`, `accumark_integration`.
- venv for Mk1 tests: `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe` (worktree has none). Never `pytest tests/` bare — `test_coa_gate.py` (untracked) has a syntax error; name files explicitly.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Mk1 variance series (incl. uncommitted prod-shape test) | `cd C:/tmp/Accu-Mk1-subvial/backend && <venv-python> -m pytest tests/test_variance_series.py tests/test_customer_remarks.py -q` |
| COABuilder full arc | `cd C:/tmp/coabuilder-variance && python tests/test_identity_fail_na.py && python tests/test_variance_series_render.py && python tests/test_lab_remarks_gate.py && python tests/test_addon_parsing.py` |
| IS payload | `cd …/integration-service && .venv/Scripts/python.exe -m pytest tests/test_lab_remarks_payload.py -q` |
| WP php-lint | `docker exec accumark-subvial-wordpress sh -c 'cd /var/www/html/wp-content/themes/wpstar && php -l <file>'` |

## Outstanding items the user may want next

1. **Commit the uncommitted `variance_series.py` + test** (production generic-services fix) — verify 4/4, then commit on `subvial/continue`. Do this before Layer 4.
2. **Build the Variance Report page** (Layer 4) — plan `docs/superpowers/plans/2026-06-12-variance-report-page.md`, 6 tasks. Suggested split: Tasks 1–3 (COABuilder `build_variance_report` → coa_data → IS passthrough) first; Tasks 4–6 (WP store/button + the `/variance-report/` page + PHP-ported SVG charts) as the bigger second chunk. Design truth: `C:/tmp/variance-design/accumark-labs-design-system/project/templates/variance-report/` (`comps.jsx` CompC ~L138 / CompB ~L97, `varicharts.jsx`).
3. **Deploy the whole COA arc together** when the Handler calls it: COABuilder 2.17.0 (→2.18.0 if Layer 4 lands) to GHCR, IS `feat/variance-services-map`, Mk1 `subvial/continue`, wpstar theme. Use the `accumark-deploy` skill (ordering + JWT consistency). UAT on a real non-conforming sample (gate + N/A + email/order-page remarks) and a variance sample (series + report).
4. **Push/PR the feature branches** — `subvial/continue`, `feat/coa-identity-na-variance`, `feat/variance-services-map` are local-only.
5. Earlier-arc backlog (still open from the subvial work): COA attachments gate UAT (`fa27d67`), vial-level worksheets inbox follow-ups.

## User collaboration preferences

- **Compact design proposal → "go ahead" → build.** Ask only genuinely user-owned decisions; AskUserQuestion with a recommended option works well. (User twice asked to *clarify* an AskUserQuestion rather than answer — be ready to reframe conversationally.)
- **Additive-only**; failing tests default to "stale test" — prove regressions with a stash baseline.
- **Spec → plan → build per feature**, specs in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`, on `subvial/continue`. Commit per logical unit with detailed bodies (heredoc for backticks).
- **TDD**: failing test first, then implement.
- npm only; recreate (not restart) the backend for env changes; Handler UATs in the browser personally — give exact URLs/steps + hard-refresh reminder.
- Reuse existing rails over new mechanisms (lab remarks + variance report both ride the COA-publish notify rail; charts port from the design bundle, matching SVG output not JS structure).
- COABuilder work in a `/tmp/coabuilder-*` worktree on a feature branch; Mk1 on `subvial/continue`; wpstar in the accumarklabs repo.

## Recommended first action in the new session

Confirm state, then commit the uncommitted prod-shape fix:
`git -C C:/tmp/Accu-Mk1-subvial status --short` and
`cd C:/tmp/Accu-Mk1-subvial/backend && <venv-python> -m pytest tests/test_variance_series.py -q` (expect 4 passed) → commit `backend/coa/variance_series.py` + `backend/tests/test_variance_series.py` with a message describing the generic-services (HPLC-PUR/PEPT-Total, peptide_id NULL) attribution fix. Then ask the Handler whether to start Layer 4 (variance report page, plan Task 1) or move to deploy.
