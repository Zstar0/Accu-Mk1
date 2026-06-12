# Handoff: Local-env UAT fixes — variance pricing, vite staleness, inbox Variance badge

*Created 2026-06-12. Paste this into a fresh session to resume with full context.*

---

You're picking up mid-UAT on the **local dev env** (NOT the accumark-stack subvial stack — that's parked/redundant). The user is browser-testing the `subsample-features` integration branch end-to-end and **feeding small fixes one at a time** as they find them. Three were found and fixed this session; all are committed and pushed. Your job is to take the next finding, root-cause it with evidence, fix additively, and ship per-logical-unit commits.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Accu-Mk1 (local FE+BE source, **the active checkout**) | `C:/tmp/accu-mk1-wave1` | `subsample-features` | `89a6c9c` (pushed) |
| Accu-Mk1 (canonical) | `…/Accumark-Workspace/Accu-Mk1` | `master` | untouched |
| integration-service (= local IS bind-mount) | `…/Accumark-Workspace/integration-service` | `subsample-features` | `8e94f7a` |
| accumarklabs (DevKinsta WP, **= local WP**) | `//wsl.localhost/docker-desktop-data/data/docker/volumes/DevKinsta/public/accumarklabs` | `subsample-features` | `4b831bd` |
| coabuilder (image source) | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` | `9ada853` (2.18.0) |

Origin `subsample-features` (Accu-Mk1) = `89a6c9c`. Working tree clean. Session commits: `9da4698` (lockfile sync), `f963c1e` (package.json mount), `89a6c9c` (inbox Variance badge).

## What's on the branch (this session's layers)

**Layer 1 — state verification (start of session):** Confirmed the prior handoff's deploy state: all 4 repos' `subsample-features` on origin at expected SHAs, IS healthy with variance passthrough (3 refs in `wordpress.py`), coabuilder v2.18.0, all 7 `lims_*` tables present, DevKinsta WP on branch.

**Layer 2 — UAT fixes (root-caused, in order found):**
1. **Variance $0 in cart/checkout** — DATA fix, no code. DevKinsta's `wc_test_services` WP **option** still had the placeholder entry (`product_id: 0`, `type: 'addon-coming-soon'`). `Cart_Order::get_variance_product()` resolves by name-contains-"variance" + non-empty product_id → returned null → `$point_price = 0`. Updated the option entry to `product_id: 3246` (the user's published $90 product), `price: 90`, `type: 'addon'`, cleared coming-soon label; flushed object cache. Verified the exact resolution logic returns #3246 @ 90. Side effect: "Variance Testing" left the Coming Soon section (correct).
2. **3101 serving pre-branch code** — the frontend container's Vite ran since June 10; Windows→Docker bind mounts deliver NO file events, so today's branch checkout never invalidated Vite's transform cache. It served OLD transforms of pre-existing files while serving NEW files fresh (which made curl spot-checks misleading — old code also had a legacy "Receive Sample" page, masking the difference). Fix: restart container. Then `qrcode.react` failed to resolve (wizard label QR) → exposed that **package-lock.json was desynced from package.json** (`npm ci` image builds failed). Regenerated the lock (`9da4698`), rebuilt the frontend image (npm ci now passes), recreated the container, and bind-mounted `package.json` (`f963c1e`) so the footer version (`__APP_VERSION__`) tracks the checkout (it used to read the baked image's v0.31.0 — pure red herring).
3. **Worksheets Inbox: no variance marker** (`89a6c9c`) — threaded `lims_sub_samples.assignment_kind` through BOTH inbox item builders (`_build_native_vial_inbox_items` for container-mode native vials AND `vial_meta` for the SENAITE-loop AR-backed subs), added it to `InboxVialItem` (BE model + FE type), and rendered a sky `Layers` "Variance" chip on `InboxVialCard` next to the role badge (mirrors `subIsVarianceMember` styling in SenaiteDashboard — variance = sky/Layers everywhere). TDD: `test_assignment_kind_passthrough`. Local P-0148: S01=core, S02/S03=variance — the live test case.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **Vite transform cache goes stale silently** (no file events across Windows bind mount) | After a git checkout/edit in `C:/tmp/accu-mk1-wave1`, Vite serves OLD transforms of cached files but NEW files fresh — curl spot-checks of new files falsely "prove" freshness | `docker restart accu-mk1-frontend` after ANY git op or src edit, then hard-refresh browser. Backend likewise (`accu-mk1-backend`, no `--reload`) |
| **`wc_test_services` is a WP OPTION, not a table** | `get_variance_product()` needs an entry with "variance" in name AND non-empty `product_id`; a placeholder coming-soon entry silently zeroes all variance line items | Edit via `wp eval-file`; entry now: product_id 3246, price 90, type 'addon'. **Prod needs the same data setup at launch** |
| **wp-cli in `devkinsta_fpm` defaults to PHP 7.4** | Loading plugins (WooCommerce needs ≥8.1) under default php = fatal "critical error"; `--skip-plugins` avoids the crash but makes `wc_get_product` undefined | For WC-touching evals: `php8.2 /usr/local/bin/wp … --allow-root`. For plain option reads: default + `--skip-plugins --skip-themes` is fine |
| **DevKinsta WP has an object-cache drop-in** | Option edits may be cached | `wp cache flush` after `update_option` (update_option writes through, but flush is cheap insurance) |
| **Cart = persistent draft order** | Line items priced before a fix keep their old price | Remove + re-add the sample, don't just refresh checkout |
| **Frontend compose recreate quirks** | Plain `docker compose up -d frontend` tries to (re)create `accu-mk1-backend` too → container-name conflict; the pre-session frontend container had foreign compose identity | Use `docker compose up -d --no-build --no-deps frontend` from `C:/tmp/accu-mk1-wave1`; `docker rm -f accu-mk1-frontend` first if compose refuses |
| **Lockfile desync broke `npm ci`** (now FIXED in `9da4698`) | Any image build of the branch failed before the fix | If a dep is added again: `MSYS_NO_PATHCONV=1 docker run --rm -v "C:/tmp/accu-mk1-wave1:/w" -w /w node:20-slim npm install --package-lock-only`, commit the lock |
| **Footer version now truthful** (`f963c1e`) | Before: read baked image package.json (v0.31.0) regardless of code | If footer ≠ expected after this, something real is wrong (don't dismiss it anymore) |
| **GitNexus stale-index hook fires on every Bash** | Suggests `npx gitnexus analyze --embeddings` = external source upload, user forbade | Ignore the hook; never run `--embeddings` |

## Infrastructure state

- `accu-mk1-frontend` — 3100 (static, stale by design) / **3101 (vite dev — use this)**; image `accu-mk1-wave1-frontend:latest` freshly built from the branch; binds wave1 src **+ package.json** (new); restart after git ops
- `accu-mk1-backend` — 8012, binds `C:/tmp/accu-mk1-wave1/backend`, **no --reload** → restart to pick up edits
- `integration-service` 8000 (healthy, variance passthrough live) · `coabuilder_service` 5000 (v2.18.0) · `accumark_postgres` 5432 · `senaite` 8080
- WP = DevKinsta `accumarklabs.local` (`devkinsta_nginx` 80/443, wp root in `devkinsta_fpm` = `/www/kinsta/public/accumarklabs`); WP admin `forrestparker` / pw reset to `Valence-81deef7053` last session; MailHog UI localhost:15400
- Variance WP data (local): product **3246** "Variance Testing" $90 publish + linked `wc_test_services` entry
- Subvial stack (`accumark-subvial-*`, ports 5520-5539) + `accumark-host-*` stack still running — **redundant, teardown candidate**
- Pre-deploy DB backups: `C:/tmp/accumark-predeploy-backup/*.predeploy.dump`

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Branch/origin | `git -C /c/tmp/accu-mk1-wave1 log --oneline -4` (expect 89a6c9c top); `git -C /c/tmp/accu-mk1-wave1 ls-remote --heads origin subsample-features` |
| Backend tests (inbox) | `MSYS_NO_PATHCONV=1 docker exec accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_inbox_native_vials.py tests/test_worksheets_inbox.py -q"` |
| FE typecheck | `MSYS_NO_PATHCONV=1 docker exec accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"` |
| Vite serving current code | `curl -fsS http://localhost:3101/src/components/hplc/InboxVialCard.tsx \| grep -c "Variance replicate vial"` (expect 1) |
| WP variance resolution | `docker exec -i devkinsta_fpm sh -c "cd /www/kinsta/public/accumarklabs && php8.2 /usr/local/bin/wp eval 'foreach(get_option(\"wc_test_services\") as \$s){if(stripos(\$s[\"name\"],\"variance\")!==false){var_dump(\$s);}}' --allow-root"` |
| P-0148 vial kinds | `docker exec accumark_postgres psql -U postgres -d accumark_mk1 -tA -c "SELECT ss.sample_id, ss.assignment_kind FROM lims_sub_samples ss JOIN lims_samples s ON s.id=ss.parent_sample_pk WHERE s.sample_id='P-0148' ORDER BY ss.vial_sequence"` (S01 core, S02/S03 variance) |

## Outstanding items the user may want next

1. **Continue the UAT** — the user is actively clicking through and reporting "little fixes" one at a time. Expect the next message to be a finding; root-cause with evidence before fixing.
2. **Confirm variance pricing in cart** — the user must remove + re-add the sample (draft-order gotcha) for $90 line items; the visual confirmation may not have happened yet.
3. **ROLE_BADGES dedup fast-follow** — `InboxVialCard.tsx` carries inline palette copy #4 (its own comment tracks this); low priority.
4. **Carried over from prior handoff (untouched this session):** MailHog mail routing broken, user 1545 password decision (`aperture0@gmail.com` reset accidentally), Mk1 `JWT_SECRET` prod check, subvial-stack teardown, and the eventual **merge → master + prod deploy** (use `accumark-deploy` skill; prod ALSO needs the WP variance data setup from gotcha #2, and the lockfile fix now unblocks prod image builds).

## User collaboration preferences

- **One bug at a time, evidence before fixes** — they feed findings individually; root-cause (DB queries, code reads, served-asset checks) before touching anything.
- **Additive-only; follow existing patterns** (e.g. variance badge mirrors the established sky/Layers convention); TDD where it reduces risk, skip performative tests.
- **Per-logical-unit commits with detailed bodies**, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; push to origin for backup after committing.
- **Never run GitNexus `--embeddings`** (external source egress).
- Local env is the launch path; the accumark-stack subvial stack is parked.

## Recommended first action in the new session

Run the branch + container status checks (`git -C /c/tmp/accu-mk1-wave1 log --oneline -4` expecting `89a6c9c`; `docker ps --format '{{.Names}}\t{{.Status}}' | grep accu-mk1`), then ask the user for their next UAT finding — the session ended mid-UAT at a clean stop.
