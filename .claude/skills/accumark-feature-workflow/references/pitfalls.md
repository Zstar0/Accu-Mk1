# Pitfalls and house rules memory cannot derive from the code

Read once, then let Hindsight surface the specifics. When you hit a new one,
ingest it (`hindsight_ingest_document`) so the next person does not.

## Doctrine (all repos)

- **Additive only.** New behaviour extends what exists. Never re-architect a
  flow to add a feature. A failing test defaults to "the test is stale", not
  "the code is wrong"; changing production behaviour needs the Handler's
  explicit sign-off, recorded in the PR.
- **Accu-Mk1 is the primary LIMS.** Integration Service is the WordPress
  bridge only. SENAITE is legacy and being disconnected; do not add SENAITE
  writes, never flip a sample's `origin`, and expect SENAITE to answer 200 on
  transitions it silently ignored.
- **`JWT_SECRET` must be identical across Integration Service, COA Builder and
  WordPress.** Drift makes COA generation fail silently (no verification
  code). Stacks generate their own per stack; never copy one between stacks.
- **Never overwrite prod env files** (`backend/.env`, `/root/<svc>/.env`,
  `wp-config.php`) and never run DevKinsta "Push to Production" with DB sync.
- **Secrets never land in repos, PR bodies, chat or logs.** Stack `.env`
  files and `creds` output are dev credentials but still stay out of commits.
- **Evidence over vibes.** A claim about behaviour comes with the command
  output, the log line, the config line or the diff that proves it.
- **House style in prose and commits: no em dashes.** Use a comma, a colon or
  a new sentence.

## Accu-Mk1 (Tauri desktop + web SPA, FastAPI backend)

- **npm only.** Never pnpm, never yarn. `npm run check:all` is the full gate;
  on a machine without a Rust toolchain run the frontend subset
  (`typecheck`, `lint`, `ast:lint`, `format:check`, `test:run`) and say so.
- **FastAPI `response_model` silently drops undeclared keys.** Adding a field
  to a response means adding it to the Pydantic model, then smoking the
  deployed route on a stack, not just the unit test.
- **LIMS-side tables use the `lims_` prefix** (`lims_samples`,
  `lims_sub_samples`). Bare `samples` belongs to HPLC job samples.
- **Test baseline is not zero.** Backend: roughly 19 pre-existing failures
  (flaky auth-order and time-based tests plus stale tests over intentional
  behaviour). Frontend: 34 across five files, including `App.test.tsx`'s
  "hello world" case. Gate on the failure-set diff against the base commit.
  Backend tests run inside the stack container, not on your laptop.
- **Editing tools can leave CRLF in this LF repo** and `git show` hides it.
  Check with `grep -c $'\r'` before you blame prettier.
- **vitest 4 quirk:** a `vi.fn` cleared or reset in `beforeEach` reports a
  later mocked rejection as unhandled even when the component catches it.
  Wait on call counts per test instead of resetting in a hook.
- **Vial / analysis model:** parent sample vs sub-sample (vial) worlds have
  different state machines; `verify` is a parent-tier transition. Read
  `docs/developer/` and ask Hindsight before touching workflow code.
- **Sub-sample fan-out can exhaust the DB pool** (two outages in 2026-09).
  Anything that loops queries per vial gets a bounded query, not N+1.
- **SLA tiers hang off analysis profiles, not service groups**, and the
  surfaces disagree; do not "fix" one surface in isolation.
- **Local dev quirks:** the SPA's API base is relative `/api` behind nginx or
  the Vite proxy; browser links to SENAITE/WordPress fall back to localhost
  defaults over Tailscale (known, deferred).

## integration-service (FastAPI)

- Lint gate is `ruff check . && mypy app`; `pytest -m smoke` needs live data
  and is for the Handler's environments only.
- The `/s2s/*` routes into Mk1 need `ACCUMK1_BASE_URL` and the internal
  service token; stacks set both. A 500 "internal service auth not
  configured" means config, not code.
- Response models drop undeclared keys here too.

## coabuilder

- Runs from a detached HEAD in production; do not reason about "the branch"
  on the server. Verification codes are `XXXX-XXXX`; regenerating a COA mints
  a new code, so bulk regenerations need the Handler's sign-off.
- Attachment downloads trust `200 + non-empty body`. Any base URL change is
  verified by bytes (JPEG magic, real CSV), never by "no error".

## accumarklabs (WordPress theme `wpstar`, child of hello-elementor)

- **Elementor overrides are mandatory for UI changes**; verify the rendered
  page, not the template. Marketing pages are PHP templates, not Elementor.
- **The theme's login wall** refuses password logins until user meta
  `_accumark_email_verified` is set; wp-cli-created users need it.
- Direct SQL writes are invisible until `wp cache flush`. Kinsta has three
  cache layers; new authenticated routes need a cache rule or buster.
- Bundle price sums use `is_bundle_member`, never bare `profile_key`.
- phpunit for any branch runs by copying the branch into the DevKinsta
  container; never switch the DevKinsta checkout itself.

## When you are unsure

Ask Hindsight (`hindsight_reflect`) with the symptom, then ask the Handler in
the PR or chat with the smallest concrete question. Do not guess at rulings;
rulings are recorded in memory as "RULED:" and they win.
