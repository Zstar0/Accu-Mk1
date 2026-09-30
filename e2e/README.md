# Accu-Mk1 E2E Tests (Playwright)

Real-stack browser tests. Drives Chromium against the running dev frontend
(default `http://localhost:3101`) which proxies through the dev backend
(`http://localhost:8012`) to the local integration-service.

## Prerequisites

1. Dev stack running. Confirm with `docker ps` — you should see at minimum:
   - `accu-mk1-frontend` (port 3101)
   - `accu-mk1-backend` (port 8012)
   - `accumark-host-integration-service` (port 5505, reached via host.docker.internal:8000 from inside the backend)
2. Credentials for a backend user with admin or operator role. The seed admin
   on first-run is `admin@accumark.local` with a random password printed to
   the backend container log; if you've lost it, reset via the running app
   or seed a fresh test user.

## Run against a devbox stack (preferred)

Every stack from `accumark-stack` exposes the Mk1 frontend and backend on its
port block, and `accumark-stack creds <stack>` prints the seeded admin login.
Put the values in a file outside the repo and source it:

```bash
# /c/tmp/<stack>-e2e.env  (never commit this)
export E2E_EMAIL=stackdev@accumark.local
export E2E_PASSWORD=<from: ./bin/accumark-stack creds <stack>>
export E2E_BASE_URL=http://100.73.137.3:<MK1_FRONTEND_PORT>
export E2E_BACKEND_URL=http://100.73.137.3:<MK1_BACKEND_PORT>
export E2E_RETEST_SAMPLE_ID=P-9001   # retest.spec.ts: a published sample IS maps to a WP order
export E2E_ADDON_SAMPLE_ID=<P-id>    # retest.spec.ts: an IN-PROGRESS sample IS maps to a WP order, lacking a sellable add-on
```

```bash
. /c/tmp/<stack>-e2e.env && npm run test:e2e
```

The whole suite runs in about 25 s. Specs that need a fixture the stack may not
have skip with a message naming the env var to set.

## Run

```pwsh
# Headless (CI-style)
$env:E2E_EMAIL = 'admin@accumark.local'
$env:E2E_PASSWORD = '<your-password>'
npm run test:e2e

# Headed (watch the browser drive itself)
npm run test:e2e:headed

# Interactive (Playwright UI mode — best for debugging)
npm run test:e2e:ui

# View the last run's HTML report
npm run test:e2e:report
```

You can also point at a different stack via env:

```pwsh
$env:E2E_BASE_URL = 'http://localhost:5512'    # default 3101
$env:E2E_BACKEND_URL = 'http://localhost:5510' # default 8012
```

## Coverage

`retest.spec.ts` drives the Mk1-native retest overlay (sample details > Actions
> Retest) on a stack with IS and WordPress mounted:

| Test | Verifies |
|------|----------|
| customer block with live WordPress prices | order number, customer, lines; Carry default; Fee radio appears with the live retest price once a profile is set to Retest |
| HPLC retest plus add-on creates the WP order | Delta = fee + add-on price; Create returns 200 with a WP order number; idempotent on re-run (same spec, same order) |
| Add services on the published sample | the published sentence (new sample, results carried); Create reads "Create add-on order (new sample)" |
| Same-sample add-on (`E2E_ADDON_SAMPLE_ID`, skipped when unset) | the in-progress sentence; first sellable add-on, Billing Waived, "Add services to <id>" posts `/api/samples/<id>/addon-order` and returns 200 with status `completed`; re-runs replay the same order |

`E2E_ADDON_SAMPLE_ID` must name a sample that is in progress (not published), sits on a
WooCommerce order IS can resolve, and lacks at least one sellable add-on. The first run adds
that service to the sample; later runs replay the same order (same body, idempotent).

Payment is not driven by the spec: it happens in WordPress (on a stack, run
`payment_complete()` with `php -d memory_limit=1024M` inside the WP container).

`customers.spec.ts` (Phase 29, revived 2026-09-27; two locators updated for the
sidebar entries and the global Sample ID search field added since):

`customers.spec.ts` exercises the smoke checklist from `29-VALIDATION.md`:

| Test | Verifies |
|------|----------|
| sidebar shows Customers entry | UI-01, success criterion 1 |
| list view renders 6-column table | UI-02, UI-03 |
| pagination row shows range + Prev/Next | D-20, D-21, UI-SPEC L202-207 |
| search debounce + page reset | UI-04, D-12 |
| drill-through to detail | UI-03, UI-04 |
| back navigation preserves state | D-08, D-11 |
| test-account toggle | UI-05 |

## Adding tests

Tests live in `e2e/*.spec.ts`. Import `test` and `expect` from
`./fixtures/auth` — that gives you the `authedPage` fixture (a `Page` with
the bearer token already injected into `localStorage`). Standard Playwright
assertions for everything else.

```ts
import { test, expect } from './fixtures/auth'

test('my new test', async ({ authedPage: page }) => {
  await page.goto('/')
  // ...
})
```

## Architecture notes

- **No MSW, no fixtures, no mocks.** Every request hits the real stack.
- **No login form** — auth fixture POSTs to `/auth/login`, injects token via
  `page.addInitScript()` into the `accu_mk1_auth_token` / `accu_mk1_auth_user`
  localStorage keys. The app's auth-store hydrates from there on load.
- **Workers: 1.** Sequential execution avoids racing the same auth state.
  Bump up for parallel-safe tests once the suite grows.
- **Artifacts** (`test-results/`, `playwright-report/`) are gitignored. The
  HTML report is the best post-mortem tool when a test fails.
