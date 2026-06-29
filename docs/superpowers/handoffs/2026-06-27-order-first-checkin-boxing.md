# Handoff: Order-First Check-in + Boxing — Phase 1 ready to execute on devbox

*Created 2026-06-27. Paste this into a fresh session (on the devbox) to resume with full context.*

---

You're picking up the **order-first check-in + boxing** feature for Accu-Mk1. **Status: spec approved + Phase 1 plan written and committed — NOT yet implemented.** Your job is to execute Phase 1 **inside an isolated `accumark-stack` on the devbox**, then (after it lands) plan Phases 2–4. Do NOT run this against the user's day-to-day shared stack.

## Working directories

| Repo / dir | Path | Branch | Notes |
|---|---|---|---|
| Accu-Mk1 (origin) | `github.com/Zstar0/Accu-Mk1.git` | `feat/order-first-checkin-boxing` | Branched off `master` (`4cb10df`). Carries the spec, plan, and this handoff. |
| Spec | `docs/superpowers/specs/2026-06-25-checkin-boxing-worksheet-sop-design.md` | — | The full design (read first). |
| Phase 1 plan | `docs/superpowers/plans/2026-06-25-phase1-order-first-checkin-boxing.md` | — | 7 TDD tasks with complete code (execute this). |

> The feature touches **Accu-Mk1 only** (backend models/db/`boxes` module + frontend receive/boxing UI). No integration-service, coabuilder, or WordPress changes in any phase.

## What's on the branch

**Layer 1 — the SOP & design (spec).** Captures the lab's check-in→worksheet flow: front desk receives a package (one order, sometimes several same-customer orders) → photographs/labels vials → assigns each vial a role (HPLC / Endo / Ster) → boxes them into color-coded bins with `WP-{order}-{n}` labels → lab manager assigns orders to per-person worksheets → tech sees a "boxes to grab" list. Four phases; ISO 17025 alignment baked in (the lab is *aligning to pursue* accreditation).

**Layer 2 — Phase 1 plan (this branch's executable work).** Order-first check-in + boxing, 7 tasks:
1. Schema: `lims_boxes` table (keyed by `order_key` string, running `box_number` per order, `role`, create/print attribution) + `lims_sub_samples.box_id` + idempotent migrations.
2. `/api/boxes` service + routes: list / create / assign (role-match validated) / print.
3. Frontend api client (`listOrderBoxes`/`createBox`/`assignVialsToBox`/`printBox` + `LimsBox` type).
4. `groupSamplesByOrder` helper (+ vitest).
5. By-order / By-sample toggle + order list on `ReceiveSample.tsx`.
6. `OrderReceiveSession` — sample stepper around the existing `ReceiveWizard`.
7. `BoxStep` order-level boxing UI + `BoxLabelTemplate` (reuses existing label format).

**Layer 3 — not yet planned.** Phase 2 (inbox order tier + order drag), Phase 3 (worksheet boxes-to-grab panel + `worksheet_items.order_number`/`role` stamping), Phase 4 (update the two SOP guides). Plan these against Phase 1's concrete interfaces *after* Phase 1 lands.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| Do NOT use the user's day-to-day shared stack | The `accu-mk1-*` containers (frontend :3100/:3101, backend :8012) share MariaDB/Postgres/ZODB with the user's live local data. Phase 1 adds a migration — running it there mutates their working DB and collides with other agents. | Spin up a dedicated `accumark-stack` on the devbox; run everything there. |
| Migrations against host need sign-off | Platform rule + workspace non-negotiable. `accumark-stack` CLI refuses to touch the `host` stack. | Validate the `lims_boxes` migration in the isolated stack only. Host migration is a later user-initiated deploy. |
| `accumark-stack` is mid-polish | Another agent is finishing the platform on devbox docker. It may not be fully ready when you start. | First action: `accumark-stack list` / `validate` to confirm it's healthy before relying on it. |
| Box `label_code` = verbatim order number | The vial label renders `client_order_number` (already `WP-…` style) as-is. `label_code = f"{order_key}-{box_number}"` — **never prepend a second `WP-`** or you ship `WP-WP-3066-1`. | Plan Task 7 `boxLabelLines` test guards this; keep it. |
| Boxing is an ORDER-LEVEL stage, not per-sample | A box holds an order's vials across *multiple samples*; the per-sample `ReceiveWizard` only sees one sample's vials. Per-sample boxing contradicts the model. | `OrderReceiveSession` runs per-sample capture/assign/label, then a single order-level `BoxStep` (plan Tasks 6–7). |
| Fresh `JWT_SECRET` per stack → Senaite re-auth | Snapshot's encrypted Senaite password can't decrypt under the new Fernet key. The receive flow reads Senaite. | On the new stack: log into Mk1 → Settings → re-enter the Senaite password (same one) before testing receive. |
| Mk1 migration style | Mk1 = `create_all` + hand-rolled idempotent `ALTER … IF NOT EXISTS` in `backend/database.py:_run_migrations()` (Postgres). Tests use in-memory SQLite via `Base.metadata.create_all()`. | Don't test raw Postgres `ALTER IF NOT EXISTS` under SQLite; seed models directly in tests (plan does this). |
| GitNexus rules (Accu-Mk1) | `AGENTS.md`/`CLAUDE.md` require `gitnexus_impact` before editing a symbol and `gitnexus_detect_changes` before committing; warn on HIGH/CRITICAL. | Honor on code-touching tasks (1, 2, 5, 6, 7). |
| Windows vs devbox paths | Plan/handoff reference `C:/tmp/...` worktrees (host is Windows). Devbox is Linux. | Use the devbox's worktree convention (e.g. `/tmp/Accu-Mk1-boxing` or the platform's `<repo>-<agent>` path); adjust commands. |
| npm only | Frontend is npm, never pnpm. First `--mk1` mount runs `npm install` in-container (~60–120s). | Wait for `VITE … ready` in `accu-mk1-frontend` logs; hard-refresh. |

## Infrastructure state

**This Windows host (do NOT target for the feature):**
- Day-to-day stack: `accu-mk1-frontend` (`:3100`→80, `:3101`→5173 vite), `accu-mk1-backend` (`:8012`), `coabuilder_service` (`:5000`), `integration-service` (`:8000`). Shared DBs.
- Separate persistent subvial stack: `accumark-subvial-*` (`:5525`–`:5539`).

**Target (devbox):**
- `accumark-stack` on devbox docker — isolated full stacks (WP + MariaDB + Postgres + Redis + Mailhog + IS + coabuilder + Mk1 backend/frontend + Senaite), own port block + volumes + data per stack.
- CLI: `<workspace>/accumark-stack/bin/accumark-stack` (single stdlib Python file). Per-stack ports live in `~/.accumark-stack/stacks/<name>/.env`.
- Workflow: `create <name>` → `validate <name>` → `mount <name> --mk1 <mk1-worktree>` (uvicorn --reload + vite HMR) → work → `destroy <name> --yes`. Cap 24 stacks; destroy when done.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Backend box tests | `docker compose -p accumark-<name> exec accu-mk1-backend pytest tests/test_boxes_schema.py tests/test_boxes_service.py tests/test_boxes_routes.py -v` |
| Backend full | `… pytest` (mind the ~19-failure baseline; net-new only) |
| Frontend gate | `npm run check:all` in the mk1 worktree (typecheck + lint + ast:lint + format + tests) |
| Frontend single | `npx vitest run src/test/inbox-orders.test.ts src/test/box-step.test.tsx` |
| Stack health | `accumark-stack validate <name>` |

## Outstanding items the user may want next

1. **Execute Phase 1** (the 7-task plan) in an isolated devbox stack. Execution mode was **not finalized** — ask: Subagent-Driven (recommended) vs Inline.
2. **Plan Phases 2–4** once Phase 1 lands (against its real interfaces).
3. Spec open questions to resolve during/after Phase 1: vial→box **move history** (minimal `updated_at` now vs full history v2); **receive-list 50-row pagination** (`getSenaiteSamples('sample_due', 50, 0)` can split an order across the boundary — raise limit / server-side group if volumes approach 50).
4. Confirm box-label **physical media** matches the existing configured label format on the real printer.

## User collaboration preferences

- **Additive only** — never re-architect; a failing existing test defaults to "stale test," not "broken code." No production-behavior change without sign-off.
- **npm only** for the frontend (never pnpm).
- **No unsolicited commits** (Accu-Mk1 `AGENTS.md`) — commit only when explicitly asked.
- **Isolation discipline:** risky/migration/PR-testing work goes in an isolated `accumark-stack`; never modify the host stack or run migrations against it without sign-off.
- **ISO 17025: aligning to pursue** — lab-workflow specs include a short "ISO 17025 alignment" section (identification/traceability, attribution, traceable amendments, document control of SOP guides).
- **Worktrees off `master`** per feature (`C:/tmp/accu-mk1-*` on Windows; Linux equivalent on devbox); main checkout stays untouched.
- Flow: **brainstorm → spec → plan → execute** (superpowers); session logs to the user's Obsidian vault.

## Recommended first action in the new session (on devbox)

1. `git fetch origin && git checkout feat/order-first-checkin-boxing` and read the spec + Phase 1 plan.
2. Confirm the platform is ready: `accumark-stack list` / `accumark-stack validate <existing>` (it's being polished — verify before relying on it).
3. Ask the user: **Subagent-Driven or Inline** execution? Then create the worktree + `accumark-stack create boxing` + `mount --mk1`, re-enter the Senaite password in Mk1 settings, and begin **Task 1** (schema) of the plan.
