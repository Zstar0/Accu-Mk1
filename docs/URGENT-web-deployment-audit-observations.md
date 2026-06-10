# URGENT: Web Deployment Audit Observations

Last reviewed: 2026-04-25

Context: Accu-Mk1 is currently treated as a web-deployed application on a DigitalOcean droplet, not primarily as a desktop/Tauri application. These observations prioritize production web risk, backend exposure, auth behavior, deployment configuration, and quality gates.

GitNexus status at review time: refreshed with embeddings. Local metadata reported 7,524 nodes, 13,325 edges, 300 flows, and 6,827 embeddings.

## Highest-Risk Findings

### 1. Production DB migrations can silently fail

[backend/database.py](../backend/database.py#L183) catches any migration error and then continues with `pass`.

Risk:

- A deployment can leave the database partially migrated while the app continues serving traffic.
- Later startup logic may run against an unexpected schema.
- Production schema drift may be hard to detect until users hit broken paths.

Recommended action:

- Fail fast on migration errors in production.
- Log the exact failed migration and stop startup.
- Move the hand-rolled startup migration list toward Alembic or another explicit migration system.
- Add a deployment health check that confirms required columns/tables exist.

### 2. TLS verification is disabled for WooCommerce calls

[backend/main.py](../backend/main.py#L7288) uses `verify=False` on an external HTTP call.

Risk:

- The backend may accept spoofed TLS certificates.
- WooCommerce credentials and order data can be exposed to a man-in-the-middle attacker.
- This is especially risky for a droplet-hosted web service calling public internet endpoints.

Recommended action:

- Remove `verify=False`.
- If a local/self-signed test endpoint is needed, gate that behavior behind an explicit local-only environment mode.
- Add a test or startup validation to prevent disabled TLS verification in production.

### 3. Backend is directly exposed in production compose

[docker-compose.prod.yml](../docker-compose.prod.yml#L34) maps the backend port as `8012:8012`.

Risk:

- If the droplet firewall allows this port, users can bypass host Nginx and hit FastAPI directly.
- This bypasses expected TLS/proxy/rate-limit controls.
- It expands the public attack surface.

Recommended action:

- Remove the backend host port mapping if only the frontend container needs backend access.
- Alternatively bind to localhost only: `127.0.0.1:8012:8012`.
- Verify DigitalOcean firewall rules block direct external access to port `8012`.

### 4. Web auth stores bearer tokens in localStorage and allows client API override

[src/store/auth-store.ts](../src/store/auth-store.ts#L30) persists the JWT in `localStorage`.

[src/lib/api-profiles.ts](../src/lib/api-profiles.ts#L58) allows a `sessionStorage` API base override before using the build-time environment URL.

Risk:

- XSS can steal the bearer token from `localStorage`.
- A user with console access can redirect API calls to another origin.
- Combined, this creates an easy token exfiltration path.

Recommended action:

- Prefer httpOnly, secure, sameSite cookie auth for the web deployment.
- Reduce access-token lifetime and use a refresh strategy if needed.
- Remove arbitrary client-side API base URL overrides from production builds.
- Add a stronger Content Security Policy.

### 5. `backend/main.py` is too large to govern safely

`backend/main.py` is roughly 558 KB and contains 178 FastAPI route decorators.

Risk:

- Auth, ClickUp, SENAITE, HPLC, SharePoint, peptide requests, admin behavior, and integration code are concentrated in one file.
- It is difficult to audit permissions consistently.
- Future changes are more likely to create regression risk.

Recommended action:

- Split routes into FastAPI routers by domain.
- Move business logic into service modules.
- Keep permission dependencies near each router.
- Add route-level integration tests for sensitive mutation paths.

## Medium-Risk Findings

### 6. SSE proxy behavior may differ between container and droplet host

[nginx.conf](../nginx.conf#L22) handles several streaming routes with buffering disabled.

[scripts/accumk1-nginx.conf](../scripts/accumk1-nginx.conf#L33) only special-cases one stream route.

Risk:

- If the host-level DigitalOcean Nginx config resembles the script, some Server-Sent Events routes may buffer or hang.
- Users may see stalled HPLC/import/sync progress even if the backend is working.

Recommended action:

- Align host and container Nginx configs for all SSE endpoints.
- Disable buffering and caching for every streaming route.
- Test each production stream route through the public domain, not only inside Docker.

### 7. Some mutating LIMS sync actions are authenticated but not admin-gated

[backend/main.py](../backend/main.py#L13128) uses `get_current_user` for sync apply behavior rather than an admin dependency.

Risk:

- Authenticated non-admin users may be able to mutate ClickUp/Accu-Mk1 sync state.
- The intended permission model is not obvious from the route.

Recommended action:

- Decide whether lab users should be able to run sync apply.
- If yes, add an explicit role such as `sync_manager`.
- If no, gate the route with admin permissions.
- Add tests for allowed and denied roles.

### 8. The web app still has Tauri runtime coupling

[src/App.tsx](../src/App.tsx#L47), [src/i18n/language-init.ts](../src/i18n/language-init.ts#L41), and related menu/preferences/recovery/theme paths still call Tauri APIs.

Risk:

- Browser-only usage can produce caught runtime errors and noisy tests.
- Web behavior depends on desktop APIs that are not present in production.
- Preference, language, updater, and menu behavior are harder to reason about.

Recommended action:

- Introduce a runtime adapter for web vs Tauri behavior.
- Use browser-native language detection and storage in web mode.
- Keep updater/menu/recovery logic out of the web entry path.
- Update tests to mock only the web-facing adapter.

### 9. Closed peptide request filtering is likely paging-incorrect

[src/pages/PeptideRequestsList.tsx](../src/pages/PeptideRequestsList.tsx#L24) fetches without a status filter for the Closed tab, then filters client-side.

Risk:

- The backend returns a paginated unfiltered list.
- Older closed or retired rows can be missed if they are not present in the first returned page.
- The UI can show an incomplete Closed tab.

Recommended action:

- Add server-side support for closed and retired filters.
- Avoid client-filtering over a paginated unfiltered result set.
- Update the failing list test around the intended server contract.

### 10. Quality gates are currently too noisy

`npm run check:all` passes typecheck but fails ESLint with 119 errors and 14 warnings.

`npm run format:check` reports 358 files, partly because generated/tooling directories are not ignored.

[eslint.config.js](../eslint.config.js#L98) and [.prettierignore](../.prettierignore#L1) need scope cleanup.

Risk:

- Real regressions are hidden in known noise.
- CI or local checks cannot be trusted as a clean release gate.
- The team may stop running checks because the output is too noisy.

Recommended action:

- Exclude `backend/.venv`, tool caches, planning artifacts, and generated folders from frontend lint/format checks.
- Fix the remaining source lint errors after ignore scope is corrected.
- Make `npm run check:all` a meaningful release gate again.

## Additional Operational Concerns

### Production defaults should fail closed

Relevant examples:

- [backend/auth.py](../backend/auth.py#L25) has a fallback JWT secret.
- [backend/database.py](../backend/database.py#L29) has a fallback database password.
- [backend/main.py](../backend/main.py#L76) has a fallback API key.

Recommended action:

- In production, fail startup when required secrets are missing.
- Keep development defaults only in explicit local/dev mode.

### First-run admin password is printed to logs

[backend/auth.py](../backend/auth.py#L149) creates a default admin and prints the random password.

Recommended action:

- Keep this behavior out of production or make it an explicit one-time provisioning command.
- Treat Docker logs as sensitive if this remains enabled.

### Backend exception details may leak to authenticated users

Many backend paths raise HTTP errors with raw exception details.

Recommended action:

- Return user-safe error messages.
- Log detailed exceptions server-side with correlation IDs.

### Stale template branding remains

[src/lib/menu.ts](../src/lib/menu.ts#L19) still uses `Tauri Template`.

Recommended action:

- Replace stale template branding or remove unused Tauri menu code from the web path.

## Verification Notes

Commands attempted during review:

- `npx gitnexus analyze --embeddings`: completed successfully.
- `npm run check:all`: typecheck passed, ESLint failed.
- `npm run ast:lint`: failed one architecture rule around `useHashNavigation`.
- `npm run format:check`: failed due broad formatting scope.
- `npm run test:run`: ran outside sandbox, 2 frontend tests failed.
- `cargo fmt --check`: passed.
- `cargo test`: compiled, then failed with Windows `STATUS_ENTRYPOINT_NOT_FOUND`.
- Backend pytest: blocked by a broken local Python/venv path.
- `npm run build`: not verified because the escalated build run was interrupted.

Known failing frontend tests at review time:

- [src/App.test.tsx](../src/App.test.tsx#L11): stale `Hello World` expectation.
- [src/test/peptide-requests-list.test.tsx](../src/test/peptide-requests-list.test.tsx#L98): closed-tab expectation no longer matches current behavior.

## Suggested First Pass

1. Make production DB migrations fail fast.
2. Remove disabled TLS verification from external calls.
3. Stop exposing the backend port publicly.
4. Fix web auth/token storage and production API override behavior.
5. Clean lint/format ignore scope so quality gates become useful.
6. Split web runtime behavior away from Tauri-only code.
7. Add server-side closed/retired peptide request filtering.
8. Begin breaking `backend/main.py` into domain routers and services.
