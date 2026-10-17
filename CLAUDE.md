# Accu-Mk1

The primary LIMS for Accumark Labs: a React SPA (Vite, TypeScript, Zustand, TanStack Query) over a
FastAPI backend on Postgres. It owns samples, vials, analyses, worksheets, sample-tier status and the
hand-off into the COA pipeline. Integration Service is the WordPress bridge only; SENAITE is legacy
and being disconnected (no new SENAITE writes, never flip a sample's `origin`). The Tauri desktop
build under `src-tauri/` is not in use; the web build from `Dockerfile` is what ships.

## Commands
- Frontend dev: `npm run dev`. npm only, never pnpm or yarn.
- Frontend gate: `npm run check:all`. Without a Rust toolchain run the subset and say so:
  `npm run typecheck && npm run lint && npm run ast:lint && npm run format:check && npm run test:run`
- Release gate adds the real image build (`docker build --build-arg ENV_FILE=.env.production -f Dockerfile .`):
  the image's tsc sees no `backend/`, so src tests read backend fixtures at run time, never import them.
- Backend tests run inside a devbox stack's backend container, never on the laptop:
  `docker exec <backend container> python -m pytest tests -q`. Two suites at once deadlock the dev DB.
- Baselines are not zero (backend about 19 failures, frontend 34). Gate on the failure-set diff
  against the base commit, never on a count.
- E2E: `npm run test:e2e` (Playwright, `e2e/`).

## Non-negotiables
- Additive only. Extend what exists, never re-architect. A failing test defaults to "the test is
  stale". Production-behaviour changes need the Handler's sign-off, recorded in the PR.
- `JWT_SECRET` must be identical across Integration Service, COA Builder and WordPress. Drift makes
  COA generation fail silently (no verification code). Rotate all three in one window.
- LIMS-side tables use the `lims_` prefix (`lims_samples`, `lims_sub_samples`). Bare `samples`
  belongs to HPLC job samples.
- Never overwrite prod env files (`backend/.env`, `/root/<svc>/.env`, `wp-config.php`). Secrets
  never land in the repo, PR bodies or logs.
- No em dashes in prose or commit messages.

## Traps
- FastAPI `response_model` silently drops undeclared keys. Add the field to the Pydantic model, then
  smoke the deployed route on a stack.
- No Alembic. New columns are `ADD COLUMN IF NOT EXISTS` strings in `backend/database.py`, run at
  every startup; new tables come from `create_all`. Every entry must be safe to re-run.
- Parent samples and sub-samples (vials) have different state machines; `verify` is parent-tier.
  Anything that loops queries per vial gets one bounded query, not N+1 (two pool outages in 2026-09).
- SLA tiers hang off analysis profiles, not service groups; the surfaces disagree, do not fix one alone.
- Editing tools can leave CRLF in this LF repo and `git show` hides it: `grep -c $'\r' <file>`.
- vitest 4: a `vi.fn` reset in `beforeEach` reports a caught rejection as unhandled; wait on call counts.
- State onion: `useState` for component state, Zustand for global UI, TanStack Query for server data.
  Select from stores (`useStore(s => s.x)`), never destructure; ast-grep enforces it (`.ast-grep/rules`).
- Rust commands go through `src/lib/tauri-bindings.ts` (tauri-specta), never a string `invoke`.

## Read more
`docs/developer/README.md` (index), `architecture-guide.md`, `state-management.md`,
`static-analysis.md`, `testing.md`.

## Process
Follow the `accumark-feature-workflow` skill (`.claude/skills/accumark-feature-workflow/`, on PR #250
until merged): one PR per change, stack evidence in the PR body, the Handler reviews and merges.
