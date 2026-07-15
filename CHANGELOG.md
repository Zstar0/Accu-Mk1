# Changelog

## v1.5.2 — 2026-07-14

Double hotfix: vial photos capture square again, and the Sample Preps page
no longer hides older active preps.

### Fixed

- **Vial photo center-square crop restored.** The 2026-06-30 receive-page
  rework replaced the old photo pipeline with a full-frame capture, so vial
  photos landed widescreen (letterboxed-small in the COA's square slot).
  Webcam capture and the file-picker fallback now center-crop to the shorter
  axis at full resolution (no downscale, no enhancement); the live preview
  is `aspect-square object-cover` so operators see exactly what is saved.
  Already-square file uploads pass through byte-identical. Packaging
  capture deliberately stays full-frame 4:3.
- **Sample Preps list: server-side status filtering.** The page fetched the
  newest-100 preps and hid completed statuses client-side, so active preps
  older than the newest-100 window silently vanished from the list while
  staying findable via search (38 hidden in prod at diagnosis: 23
  awaiting-HPLC + 15 on-hold, oldest from April 6). `GET /sample-preps` now
  accepts `exclude_statuses` (comma-separated) applied in SQL before the
  LIMIT; the page requests active preps only with a 500 limit and keeps a
  client-side re-filter for deploy skew.

## v1.5.1 — 2026-07-14

Backend-only hotfix: the mk1-mode worksheets inbox was incomplete/out of
sync because `lims_samples.status` (the registry mirror of SENAITE's
review_state) was not reliably maintained.

### Fixed

- **Receive/publish hooks now heal the registry status.** The Mk1 receive
  and publish paths recorded workflow transitions but never wrote
  `lims_samples.status` — and the IS event sync's dup guard then suppressed
  its own heal because the mk1 log row already "explained" the transition.
  The hooks' background writer now heals the status column in the same
  never-fail session.
- **Status heals are vocabulary-gated.** IS events carry WordPress
  order-progress statuses for some verbs (`worksheet_assigned` →
  `analyzing`) that are not SENAITE review states; healing them poisoned a
  column every read surface compares against SENAITE vocabulary. All heal
  paths now gate on the workflow catalog's sample-state whitelist. The
  transition log still records raw events.
- **One-time sweep script** (`scripts/heal_sample_status_from_transitions.py`,
  dry-run by default) heals rows frozen before the 1.4.0 event-sync
  cold-start cursor from the transition log itself — zero SENAITE load.
  Prod dry-run: 180 heals across 1,581 samples.

## v1.5.0 — 2026-07-14

Sample lot visibility end to end: lot codes on every sample card, lot search
on the Order Status and Customers pages, and a Lot column on the samples
list page.

### Added

- **Lot on sample cards.** Order Status (table + kanban), Customers detail,
  and failed-sample cards show the sample's lot — instantly from the order
  payload's `lot_code`, upgraded to SENAITE's authoritative `ClientLot` when
  the per-sample lookup loads. Blank values render nothing.
- **Lot search box on the Order Status page.** Client-side filter matching
  the payload lot instantly and the loaded SENAITE `client_lot` as lookups
  arrive (same progressive contract as the Analyte filter). Order-level
  semantics: an order stays visible when ANY of its samples matches.
- **Lot search axis on the Customers page.** Fourth debounced input on the
  customer-detail orders search, AND-combined server-side via the new
  Integration Service `search_lot` param (requires IS >= 1.0.9; on older IS
  the axis no-ops rather than erroring).
- **Lot column + filter on the samples list page.** Registry (Mk1) read mode
  serves the lot straight from `lims_samples.client_lot` with a single-table
  ILIKE filter — no extra queries, page speed unchanged. SENAITE read mode
  resolves matching ids from the local mirror, then bounded `getId` fetches.
- **Browser-find-style highlight.** Matched lot text is highlighted with a
  yellow mark on every card and list surface while a lot search is active.

### Fixed

- **27 pre-existing frontend test failures** (flag-hook pollution class) in
  the sample-card and order-row suites, healed via a one-line
  `getWorksheetUsers` test mock.

## v1.4.0 — 2026-07-13

SENAITE phase-out slice 3 (workflow state system) plus two independent
features: an attachment lightbox and a registry-served worksheets inbox.

### Added

- **Workflow state system (phase-out slice 3).** A native workflow catalog —
  states, allowed transitions, and entry requirements for samples and
  analyses — editable on a new admin Settings → Workflow page (form CRUD plus
  a graph view). Every sample state change is now recorded in Mk1's own
  transition log with actor, source, verb, from→to, and real timestamp,
  captured from three sources (Mk1 write hooks, the IS event stream, and
  reconcile drift synthesis) and deduped; a passive observer does the same
  for analysis-state drift at zero extra SENAITE load. Additive and dormant:
  nothing enforces yet, SENAITE remains the workflow authority. Historical
  transitions seed from the IS event stream via an idempotent backfill
  script (labeled `is_seed`, best-effort).
- **Attachment lightbox.** Image attachments on Sample detail open in a
  full-page overlay with type/size/dates/source-vial and uploader/receiver
  names (Mk1-side metadata only), with keyboard navigation between
  attachments.
- **Inbox read source.** The worksheets inbox can now be served entirely from
  the Mk1 registry (`source=mk1`), replacing both SENAITE fetch stages. Wired
  as a two-tier read-source setting (`worksheets_inbox`); the default stays
  SENAITE — flipping is a Preferences change after parity eyeballing.

## v1.3.0 — 2026-07-13

Receiving batch: order-wide packaging photos, phone capture via QR, and
partial check-in.

### Added

- **Packaging photos fan out to the whole order.** A packaging photo saved
  during an order check-in now lands on every sample in the order in one
  transactional call ("Photo added to N samples"). Copies are independent per
  sample — retake/delete on one never touches siblings.
- **QR phone capture for packaging photos.** The packaging tab shows a QR;
  scanning it opens a mobile page where a tech shoots box photos with the
  phone's native camera — no login. Access is a scoped capture token
  (SHA-256-stored, 2 h expiry, revocable, capture-only, frozen to the order's
  samples). Phone shots fan out order-wide and appear on the desktop within
  ~2.5 s. Retake stays desktop-side (delete, shoot again).
- **Partial check-in.** The Complete Check-In button gains a dropdown listing
  the order's samples with checkboxes — uncheck a sample to hold it back
  (e.g. its vials were forgotten); it stays Due with its vials attached and
  checks in later via the existing deferred flow. Unvialed samples show
  disabled ("no vials").

## v1.2.1 — 2026-07-13

### Added

- **Camera selector in the Receive-Sample wizard.** Multi-camera stations can
  now pick which webcam feeds the vial and packaging capture panels (dropdown
  appears when more than one camera is present). The choice persists per
  browser (`wizard-camera-device`); if the saved camera is unplugged the panel
  falls back to the default camera instead of showing "Camera unavailable".

## v1.2.0 — 2026-07-10

Bundles two independent work streams shipped in one release.

**SENAITE phase-out — slice 2 (native parent-analysis mirror).** Parent-sample
**analysis line items** now mirror natively into Accu-Mk1 — **inert by default**
(read-dormant shadow rows; every reader still sources SENAITE until a later
read-flip).

### Added

- **Native parent-analysis mirror (dual-write).** Every parent-analysis mutation
  (result entry, submit / verify / reject / retract / retest, method &
  instrument, analyte replace, publish, add / remove) tees a native
  `lims_analyses` shadow row alongside the SENAITE write. Shadow rows are
  fail-closed: a `senaite_mirror` sentinel keeps them out of every reader's
  allow-list, so they can't reach a COA, variance series, or bench view until a
  deliberate read-flip. The true SENAITE state lives in a new
  `mirror_review_state` column. Full parent lifecycle validated live 0-drift.
- **Backfill / reconcile script** (`scripts/backfill_parent_analysis_shadows.py`):
  idempotent, registry-cursor, one throttled SENAITE query per parent, dry-run
  preview; doubles as a manual reconcile.
- **Registry-inspect analyses column.** The admin registry panel now shows a
  per-keyword shadow-vs-SENAITE sync compare, so drift is observable, not silent.

### Fixed

- **Retract no longer reports a false failure.** SENAITE retract is
  retire-and-replace (the original goes `retracted` and a fresh copy spawns
  `unassigned` with the result carried), not a state flip — the endpoint now
  re-fetches to confirm success instead of falsely reporting "SENAITE returned
  no items."

**Flag System Phase 2 (general tasks + collaboration).** General tasks not tied
to a sample, task foundation (links, due dates), comments v2 (markdown, image
attachments, reactions), comment-body search, filters & saved visibility, Slack
round 2 (interactive actions, daily digest, recurring/scheduled tasks),
state-change watches, and a settings page with user-managed item kinds /
type-bucket board. New prod config required for the Slack/attachment features:
`MK1_SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `MK1_PUBLIC_URL`, `MK1_LAB_TZ`,
and flag-attachment storage (`MK1_FLAG_ATTACH_DIR`, or S3 via the photo bucket).

## v1.1.1 — 2026-07-09

### Fixed

- **Receive-by-order list no longer melts the backend (login outage fix).** The
  per-row expected-vials cell fired ~50 concurrent `box-label-summary` calls
  under HTTP/2, each holding a DB pool connection through a per-sample IS
  fan-out — exhausting the pool (30s `QueuePool` timeout waves) and taking
  `get_current_user`, and therefore login, down with it. The list now makes
  ONE batched `POST /orders/box-label-summaries` per page (bounded 8-thread IS
  fan-out server-side, per-order failure isolation, 100-order cap); the cell is
  presentational. The temporary edge guard on the per-row route can come off.
- **Verification codes read from the IS DB.** COA regeneration mints a new code
  the registry never sees; `/registry/samples` now overlays the active code
  (newest non-superseded primary generation, ingestion fallback) and
  verification-code search resolves via the IS DB — the stored column is only
  an IS-down fallback.

## v1.1.0 — 2026-07-09

First release of the 1.1.x series: the SENAITE phase-out line. Ships the full
read-from-Accu-Mk1 program — **inert by default** (every page still reads from
SENAITE until the Data Source preference is flipped, post-backfill).

### Added

- **Read-source settings + per-page toggle.** Admin "Data Source" Preferences
  pane sets a per-page global default (samples list / sample details); any user
  can override per-session. Sample details reads basic-info registry-first with
  per-field SENAITE fallback (`field_sources`); the samples list renders
  instantly from the registry with one batched SENAITE refresh.
- **Slim SENAITE listing** (`GET /senaite/samples?slim=true`): catalog-brains
  only — in Accu-Mk1 mode a list page load costs SENAITE one catalog query and
  zero object wake-ups (was: full `complete=yes` hydration of every row).
- **Registry-owned analytes.** Replace-analyte now refreshes the sample's
  registry row (the only Mk1-side slot mutation), so the list serves analytes
  registry-native; the background refresh merges workflow state only.
- **Provenance glyphs.** In Accu-Mk1 mode, SENAITE-pulled values are marked —
  per-field on sample details, and on the samples-list State column header.
- **Admin sample-registry debug panel** (dual-write observability): per-field
  registry-vs-SENAITE drift view with a one-click refresh.

### Fixed

- Sample-details registry overlay no longer shadows the live SENAITE
  `review_state` (workflow state is always live).
- `/registry/samples` accepts comma-separated multi-state `review_state`
  filters and prefers `client_title` for the Client column (hide-test parity).

## v1.0.29 — 2026-07-09

### Fixed

- **SharePoint folder crawl no longer OOMs the backend.** Listing the LIMS-CSV root (which grows daily) was unbounded, and the Sample Preps HPLC flows triggered it on dialog open plus a whole-root scan per prep — repeatedly OOM-killing `uvicorn` during lab hours (kernel oom-kill at 6.09 GiB, 2026-07-08).
  - **Backend:** `sharepoint.py` folder listing is now bounded (item / page / wall-clock caps) so a single listing can't crawl for hours; `/sharepoint/browse` reports a `truncated` flag.
  - **Frontend (Sample Preps):** the "Scan HPLC" button (whole-root crawl + per-prep recursive listing) is temporarily disabled pending a bounded rework, and the "Pick HPLC data folder" picker now defaults to the **Local files** tab — the SharePoint browser (and its root crawl) only loads if that tab is selected.

## v1.0.28 — 2026-07-08

### Fixed

- **Slack flag deep links no longer take ~10s to open the thread.** Three compounding causes fixed across two layers (the third, HTTP/2 at the prod edge, shipped as host-nginx config on 2026-07-07):
  - `GET /worksheets` was `async def` with zero awaits — ~2.5s of synchronous DB work running directly on the event loop, freezing every other request behind it (a 32ms flag fetch measured 5.3s behind two in-flight calls). Now a sync `def` handled in the threadpool.
  - The full worksheets list was fetched **twice** per sample-details load — `useWorksheetDrawer` (header badge) and the SampleDetails worksheet chip cached the identical list under different query keys. Both now share one cache entry; drawer mutations also refresh the worksheets inbox/list pages that previously went stale.
  - A `?flag=` deep link now prefetches the flag thread at navigation time, so its fetch leads the boot burst instead of dispatching last from the portaled flyout.


## v1.0.27 — 2026-07-07

### Changed

- **Dropped the SLA column from the by-order receive list.** Rendering it called `useSenaiteLookupMap`, which fired one `/wizard/senaite/lookup` per sample across the entire due list (200+ SENAITE round-trips, ~6.5 MB on load) to compute a verdict that is structurally always "awaiting" for not-yet-received samples. The column, its cell, and the per-sample lookup fan-out are removed; the cheap left-border state tint stays. `OrderSlaCell` is unchanged — the explorer / dashboard / customer pages still use it.

## v1.0.26 — 2026-07-07

### Added

- **Order # / Client search on receive-by-order.** A search box above the By-Order list on the Receive page filters orders by Order #, client name, or client email, with a "no matches" empty state; selection state is untouched by filtering.

### Fixed

- **Instant vial→box moves on the Boxing tab.** Drag, auto-assign, add-box, and delete-box no longer block ~5s on the awaited cache refetch (one SENAITE call per sample) — the UI now updates as soon as the save confirms (<100ms), the remaining box surfaces reconcile in the background, and a "Saving…" indicator shows while a save call is in flight.

## v1.0.25 — 2026-07-07

### Added

- **Order-first check-in + boxing.** Receive samples grouped by WooCommerce order, with an order-scoped boxing workflow: an **Active Boxes** page (Analysis → Boxes) with expand-to-vials and Sample ID / Order # / Box ID search; an order-scoped **Boxing tab** in the Manage Sub-Samples overlay; a **Box column** on the worksheet drawer; a **box chip** on the sample-details header; **ISO-17025 custody events** for box assign/move/remove/store; order-style **`BOX-{order#}-{n}`** labels with a **Print box labels** action; an **`xtra` (Extras)** boxable role; box location-tracking slices 1–2 (`stored_at`/`stored_by`, `GET /api/boxes/active`, `POST /api/boxes/{id}/close`); and an admin-gated **multi-order check-in** toggle (default off). The order Process button opens on the Packaging tab.
- **Canonical basic-info registry (base).** Server-side canonical basic-info population for LIMS samples, with a backfill script for historical rows (new COAs auto-populate).

### Fixed

- Pre-COA order-number sample search now resolves via `order_submissions.sample_results` (was ingestions-only, so nothing showed in check-in).
- Relative-base-safe URL building in `src/lib/api.ts` — `new URL()` threw `Invalid URL` on proxy stacks, silently 404-ing native `mk1://` vial pages.
- Server-side admin gate on admin-only settings keys; packaging-photo download serves a **derived** Content-Type (never the client-supplied value) with `X-Content-Type-Options: nosniff`; `next_box` retries on concurrent-create conflicts (was a 500); vials can no longer be assigned to a closed/stored box; box mutations invalidate every box surface (Active Boxes, header chip, worksheets).

## v1.0.24 — 2026-07-03

### Fixed

- **Flags live-stream no longer buffered at the frontend proxy.** `api/flags/stream` joins the HPLC streams in the frontend nginx's unbuffered-SSE location (which also re-signals `X-Accel-Buffering: no` to the host proxy). Previously the stream fell through to the generic API location and the host nginx buffered it dead — each open tab parked a zombie connection until the browser's per-host pool starved and every page spun (the 2026-07-03 "app not loading" incident; the host side was hot-fixed the same night, this bakes the fix into the image and syncs the `scripts/accumk1-nginx.conf` reference copy).
- **Browsers no longer cache a stale app shell across deploys.** `index.html` is now served with `Cache-Control: no-cache`, so every load revalidates it. Hashed bundle names change with each release, and a heuristically-cached shell pointed at deleted assets (blank page until a hard refresh). Hashed `/assets/` keep their 1-year immutable cache.

## v1.0.23 — 2026-07-03

### Fixed

- **Backend memory no longer climbs ~2 GB/hour during active lab sessions** (the 2026-07-02 "Memory High - Droplet" New Relic alert — host hit 93% before a restart). Every SENAITE-proxying, SharePoint, and COA-resolver request constructed a throwaway `httpx` client, and each construction builds a fresh SSL context with a full CA-bundle parse (~340 kB of allocations — even for plain-http URLs) that the allocator never returns to the OS. All 60 ad-hoc client sites now share one module-level SSL context (`httpx_shared.HTTPX_SSL_CONTEXT`). Measured on an isolated stack: 343.7 → 0.1 kB/call steady-state on the SENAITE lookup endpoint. A new AST-based regression test fails on any future bare `httpx` client construction. Not related to the Flag System (explicitly ruled out — SSE bus is bounded and connection counts stayed flat).

## v1.0.22 — 2026-07-02

### Changed

- **The Flags button count now reflects only flags assigned to you.** The colored per-type chips on the Flags button previously counted *all* open flags of each type across the whole lab; they now count only the open flags **assigned to you**, so the badge is a personal "my work" signal. (The pulse/glow remains the separate "you've been pinged" cue.) Backend-only — the summary endpoint's per-type breakdown is now scoped to the requesting user.

## v1.0.21 — 2026-07-02

### Fixed

- **"Add Type" in Preferences → Flags no longer double-creates on a fast double-click.** The button relied on `disabled` while a create was in flight, but that only takes effect on the next render, so a same-tick double-fire slipped two creates through (after the v1.0.20 slug fix, that produced a phantom extra type — e.g. `new_type_2` *and* `new_type_3` — and could race the slug uniquifier). A synchronous in-flight guard now collapses the burst to a single create and resets once it settles. Frontend-only.

## v1.0.20 — 2026-07-02

### Fixed

- **"Add Type" in Preferences → Flags no longer fails with a 409 after the first type.** The Add button always creates a placeholder labeled "New type" (renamed afterward), so the backend kept deriving the same immutable slug `new_type` and rejecting every subsequent add as a conflict. A label-derived slug now auto-uniquifies (`new_type`, `new_type_2`, …) instead of colliding; an explicitly-provided slug that collides still returns 409 (real user intent). Backend-only — no schema, migration, or data change.

## v1.0.19 — 2026-07-02

### Changed

- **Internal Remarks now render as amber "internal notes."** On the Sample Details page, each lab-internal remark is styled with the warm amber scheme from the Flags user guide (amber tint + left border, light/dark) and an "Internal — not shared with the customer" caption, making it obvious at a glance that these notes never reach the customer (distinct from the separate Customer Remarks card). Frontend-only; the inline card was extracted into a testable `InternalRemarkCard` component.

## v1.0.18 — 2026-07-02

### Added

- **Flags user guide.** A polished, self-contained HTML guide to the Flag System (what flags are, raising/assigning/watching, the status lifecycle, comments & @mentions, the flyout tabs, flags on samples/vials/worksheets, and Slack DM notifications — which are on by default for everyone), linked as a **Guide** button in the Flags flyout header. Built from `docs/guides/flags-system-guide.md` via the existing guide pipeline; served at `/guides/flags-system-guide.html`. Frontend + docs only.

## v1.0.17 — 2026-07-02

### Added

- **Admin edit-user flyout on User Management.** Click a user row to open a right-side slide-out (mirroring the Instruments page) and edit a user's **first name, last name, email, role, and active status**. Save sends only the changed fields via the existing admin update endpoint; editing your own account disables the role/active controls (no self-lockout). The redundant role/active quick-toggle icons fold into the flyout; reset-password stays a row action. Frontend-only — no backend, API, or migration change.

## v1.0.16 — 2026-07-02

### Added

- **Flag System.** A task/thread system on samples, vials, and worksheets: raise Issue or Signal flags, assign them, comment with @mentions, watch threads, and track status (Open → In progress → Blocked → Resolved → Closed). Real-time updates over SSE with a flyout showing Activity, mentions, and unread counts; admin-managed flag types; multi-flag affordances per entity. Internal, all-staff-visible in v1. Additive — new `flags`, `flag_comments`, `flag_events`, and `flag_participants` tables auto-create at startup.
- **Slack DM notifications for flags.** Flag activity can mirror to Slack DMs, with a per-user config card on the Account → Profile page (master toggle, link status, member-ID field, test-DM button, and five per-category toggles: assigned / mentioned / activity-on-flags-you-raised / activity-on-flags-you-watch / status changes). Recipients are computed server-side (assignee / creator / mentioned / watchers, minus the actor). Deep links land on the flagged entity's page and open the thread. **Env-gated — dormant unless `MK1_SLACK_BOT_TOKEN` is set** (zero overhead when unconfigured); optional mixed-domain email resolution via `MK1_SLACK_EMAIL_ALIAS_DOMAINS`. User-supplied text is escaped before Slack mrkdwn interpolation.

## v1.0.15 — 2026-07-01

### Added

- **Local files as a second HPLC data source.** The per-prep HPLC folder picker now has a **SharePoint** tab and a **Local files** tab. The Local tab lets a tech pick a folder on their machine; its `*_PeakData.csv` / `*_DAD1A.csv` files are read in the browser (nothing is uploaded) and processed through the exact same parse / peak / chromatogram / save flow as SharePoint. When a SharePoint browse call is throttled (429), the error offers a one-click switch to the Local tab. A "Local files: &lt;folder&gt;" badge marks local-sourced results for review. Frontend-only; no change to result / purity math.

## v1.0.14 — 2026-06-30

### Fixed

- **Variance COA per-vial series includes the core sub-vial.** `build_variance_replicates` now returns every in-set sub-vial (core + variance) instead of variance-only, gated on ≥1 in-set variance vial (non-variance certs still send nothing), and accepts the core's `promoted`-state rows via `_VIAL_COA_STATES`. This makes the physical sub-vials the single source of truth for the COA's page-3 per-vial table, fixing the P-1094 case where a variance vial at seq 1 dropped a page-3 row. Pairs with COA Builder 2.28.2.

## v1.0.13 — 2026-06-30

### Fixed

- **Numeric analysis results display at 2 dp on sample-details.** A promoted sub-sample value written to the parent AR at full precision (e.g. Fill Volume `9.710267415 mL` on BW-0037-S01) rendered in full on the SENAITE analyses table. `formatNumericResult()` trims only over-precise (>2 dp) numeric results to 2 dp at display; integers, ≤2 dp values, unit-suffixed values, and non-numeric text pass through unchanged. The stored value and the edit draft stay full precision — display-layer only. (Pairs with COA Builder 2.28.1.)

## v1.0.12 — 2026-06-29

### Fixed

- **Endotoxin product-chip completion classifies by keyword, not service group.** Prod has no 'Endotoxin' service group (ENDO-LAL lives under Microbiology), so the chip never went green despite a promoted result (P-0965). Endotoxin/sterility are now keyword-classified, working in prod and dev seeds.
- **Promote no longer 502s on duplicate analysis-service keywords.** `resolve_parent_analyte_target` tolerates duplicate keywords (picks the peptide-bearing row deterministically; fails loudly only if duplicates span different peptides). Fixes "parent slot resolution failed: Multiple rows were found" on PB-0186 TB-500 purity.
- **Analysis-service sync reconciles recreated SENAITE services.** When SENAITE deletes+recreates a service under a new UID, the sync adopts the existing row (same keyword, stale senaite_id) instead of cloning it — preserving result/slot references and preventing duplicate-keyword rows.

## v1.0.11 — 2026-06-28

### Fixed

- **AccuShield completion check now requires the full bundle.** The AccuShield
  product chip's green check fired on the HPLC portion alone; AccuShield is
  "Core + Full Biosafety Suite" (HPLC + Endotoxin + Sterility), so its check now
  turns green only when **every** live parent analysis — HPLC, Endotoxin, and
  Sterility — is promoted. Core (HPLC-only) is unchanged.

## v1.0.10 — 2026-06-28

### Added

- **Order-sourced PRODUCTS section.** The sample parent page's products now come
  from the customer's order (via Integration Service `package` + services),
  with a purchased-vs-assigned amber alert and family vial-assignment history in
  the activity flyout. Header chips sit above the action bar with a green
  completion check per product.
- **Rich hover tooltips for product chips.** Chips use the shadcn `Tooltip` +
  sectioned `font-mono` card (the SLA-breakdown style) instead of native
  `title=`; documented as the default for non-trivial hovers in
  `docs/developer/ui-patterns.md`.
- **Variance indicator on parent + inbox rows.** A sky Layers icon precedes the
  Sample ID wherever a parent has variance-assigned sub-samples — the SENAITE
  sample list parent row (entitlement OR assigned variance subs) and the
  worksheet inbox (parent cards, family-group headers, and the variance
  sub-vials themselves). Backed by an additive `has_variance_subs` aggregate
  flag (no migration).

### Fixed

- **Duplicate Samplevariance product chip.** WordPress sends both the
  `samplevariance` buy-flag and the `variance` data-points dict for one
  purchase; the products builder now renders a single "Variance HPLC" chip
  instead of also rendering a stray "Samplevariance" chip.

## v1.0.9 — 2026-06-26

### Fixed

- Worksheet inbox age showed a negative time (e.g. "-5h -59m") for a just-created
  order. The age timer parsed a timezone-less `date_received` as browser-local
  instead of UTC, putting "received" ~5h in the future. Now parses zone-less
  timestamps as UTC and never renders a negative age.

## v1.0.8 — 2026-06-25

### Added

- **Bulk vial check-in.** Create N identical vials in one step from the Receive
  wizard (Quantity input, 1–50) — one capture applied to all, then run through
  auto-assignment.
- **Edit or retake any vial.** Every sub-sample vial in the wizard is now
  editable (retake photo / edit remarks), not just this-session ones. Delete
  stays limited to this-session vials.
- **Capture controls.** Photo format toggle (JPEG default / PNG) and a
  camera-resolution selector driven by the device's real capabilities, so the
  stored photo is web-appropriate and as sharp as the camera allows; a stale
  resolution the camera can't reach auto-corrects to the highest supported.
- **Worksheet Sample ID search.** The HPLC worksheets list has a search box that
  filters to worksheets containing a given sample.
- **Worksheet link on sample details.** The sample-details header shows the
  worksheet a sample is on (if any) and opens the worksheet flyout on click.
- **Client → customer link.** The client on the sample-details header links to
  that customer's detail page (registered customers only; guest orders unchanged).

### Fixed

- Bulk vial create returned 500 — the route dropped a required argument when
  building the stored filename. Now creates correctly.
- Vial thumbnails in the Receive wizard now refresh immediately after a photo
  retake instead of requiring a page reload.
- Removing, reassigning, or re-prioritizing native (in-house-tracked) worksheet
  vials returned a 404 — the vial's `mk1://` id was mangled in the URL path by
  the proxy. These now key on the worksheet item id and work for all vial types
  (SENAITE-tracked vials were unaffected).
- Finished vials (Micro sterility/endotoxin, variance HPLC) bounced back into
  the worksheet inbox after their worksheet was marked Complete. The inbox now
  excludes terminal done-states and reads the live post-retest row, so completed
  work stays out of the queue.

## v1.0.7 — 2026-06-25

### Added

- **Durable S3-backed storage for sub-sample (vial) photos.** Photos now persist to
  S3 (`accumark-coa-private-west1/sub-sample-photos/{vial}/{uuid}.{ext}`) instead of
  ephemeral container `/data`, ending the loss-on-redeploy risk. Selected via the
  `MK1_PHOTO_S3_BUCKET` env var; falls back to filesystem storage when unset (dev).
  DB pointers (`mk1://{key}`) and the photo route are unchanged — no migration.

## v1.0.6 — 2026-06-24

### Added

- **Core COA + per-vial COAs.** Staff "Regular COA" card renamed to **Core COA**
  (customer-facing name; internal `regular` flag/meta unchanged). The Core COA child
  is emitted on variance sample generation and surfaced on the sample-details page.
  New **per-vial HPLC COA generation** endpoint + "Generate Per-Vial COAs" action and
  a Per-Vial COAs card on sample details (vial figure builder included).

## v1.0.5 — 2026-06-23

### Fixed

- **Replace analyte now works on pre-subsample (pre-vial) samples.** The Replace
  flow raised "parent sample not found" for older samples with no Mk1 vial rows —
  after the SENAITE-side field + identity writes had already run, leaving a
  partial change. It now no-ops the (nonexistent) vial re-mirror for these
  samples, and a new pre-subsample guard blocks the replace (409) before any
  write if the slot's identity or `ANALYTE-{slot}-PUR/QTY` are already
  verified/published in SENAITE.

## v1.0.4 — 2026-06-23

### Fixed

- **COA source resolver now honors SENAITE retests.** A retested analysis left
  in `verified` state alongside its superseded original (common on pre-subsample
  samples) no longer forces a "more than one result — pick a source" block. The
  resolver drops the superseded original (the one another analysis points at via
  `getRetestOfUID`), so the COA generates against the current retest result.

## v1.0.3 — 2026-06-22

### Added

- **Print Order # box labels.** The Print Labels tab can print one box label per
  department (HPLC / ENDO / PCR) for the whole order, showing the order number,
  the department's expected vial count, and the order date — for labeling the
  color-coded department bins. Backed by a new order box-label summary endpoint.

## v1.0.2 — 2026-06-20

### Fixed

- **Worksheet inbox** now shows native vials added to already-received
  (non-container) families; previously they were silently invisible to the
  bench. The parent's own row (vial 1) is kept alongside its native vials;
  container families remain depositories (parent row suppressed).
- **Identity conformance** (variance overlay + COA variance block) resolves
  now that identity Analysis Services auto-link to their peptide on startup
  (migration `9e7a53a`); prior to the link, identity read non-conforming and
  the COA variance series came back empty.

### Changed

- **Variance set** defaults to the first vial (baseline) plus any
  variance-marked vials, instead of every vial; assignment couples membership
  (variance replicates join, non-variance non-first vials drop, first vial
  always stays), and manual overlay selection still applies.
- **Native sub-sample creation** is now the default (`SUBSAMPLE_NATIVE_CREATE`
  defaults on; set `=0` for the legacy SENAITE-secondary path).

## v1.0.1 — 2026-06-17

### Changed

- **Customer Remarks are captured and delivered at *Publish*, not Generate.** The
  lab writes the customer remark after reviewing the generated COA, so `publish-coa`
  now reads the parent's current `customer_remarks` + "Include with Publish?" flag,
  sends them to the Integration Service (which forwards `lab_remarks` to the COA
  email + order-page Lab Remarks button), and stamps `customer_remarks_delivered_at`
  on a successful publish. The generate path no longer stamps delivery. Sample
  details now shows "Delivered to Customer <date time>". (Not rendered on the PDF
  or digital COA — customer comms only.) Requires integration-service ≥ 1.0.1.

## v1.0.0 — 2026-06-16 — Accumark 1.0 Platform Release

First production-stable release of **Accu-Mk1 as the primary LIMS**. This
milestone folds together the multi-vial sub-sample pipeline, variance testing
end-to-end, native Mk1 analyses with a full Manage-Analyses workflow, the
vial-scoped HPLC prep bridge, COA generation, and the Bacteriostatic-Water /
Benzyl-Alcohol order path — the systems that let Accu-Mk1 stand on its own and
begin phasing out SENAITE. Detailed per-area breakdown below; the two
sub-sample sections that follow document the intake foundation this builds on.

### Added — Variance Testing (end-to-end)

- **Per-vial `assignment_kind` (`core` | `variance`)** is the workflow gate, set
  at check-in on the receive wizard's Assignment step. Variance buckets render
  as drop zones beside each core bucket (HPLC / Endo / Sterility); dragging a
  vial in marks it a paid replicate. `variance_verify` requires kind=`variance`;
  promote rejects variance vials (re-assign to core to promote).
- **Lab-side variance override** — the "Variance Testing" box on the Assignment
  step sets the TOTAL vials tested per bucket (≥2; first is the core vial). The
  override merges into the vial plan and is the interim upsell path until the WP
  variance addon ships. Drop zones are entitlement-gated: shown only when there
  is ≥1 paid replicate (or a bucket already holds variance vials).
- **Variance set lifecycle** — membership, lock/unlock (self-service for now),
  and a variance-series COA that reports each replicate plus aggregate stats.
- **Variance indicators** across the dashboard, worksheet inbox vial cards, and
  worksheet drop-panel / drawer rows (Layers icon + "paid N" markers).

### Added — Native Mk1 Analyses & Manage Analyses

- **`lims_analyses` rows seeded per vial** on role assignment, with a state
  machine (`unassigned → assigned → to_be_verified → verified | promoted`) and a
  vial→parent **promote** that rolls a signed-off vial result up to the parent AR.
- **Manage Analyses overlay** — add or remove services on a sample. Removal is
  tiered by impact: pristine rows delete outright, worked-but-unverified rows
  require a retract-confirm (audited reject, restorable on re-add), and
  verified/published/promoted rows are blocked (invalidate/retest first).
- **Bulk overlay** with promote-aware, parent-lock-aware action gating.

### Added — Replace Analyte (wrong-variant correction)

- **Swap the peptide on one analyte slot** of a blend parent
  (`POST …/analytes/{slot}/replace`). Offer-only gate requires the new peptide
  to have a full ID_/PUR_/QTY_ service set; a strong-confirm force-retract clears
  worked/verified/promoted vial rows for the old variant; published results stay
  hard-blocked. Re-mirrors the slot to the new peptide across the vials.

### Added — Customer Remarks (COA delivery)

- **Customer-facing remarks** on a sample with an **"Include with Publish?"**
  toggle and a delivered-on timestamp stamped at COA generation, so remarks
  travel with the COA only when the lab opts in.

### Added — HPLC Prep Bridge (vial-scoped)

- **Sample preps tag to vials** (`sample_preps.lims_sub_sample_pk`); running a
  prep bridges its result into the vial's `lims_analyses` rows. Identity routes
  by **peptide_id catalog lookup** (token-match fallback), purity/quantity to the
  generic services, and **blend aggregates** fill `BLEND-PUR` (mass-weighted) and
  `PEPT-Total` once every per-component PUR/QTY is in. Per-vial chromatograms are
  served from the prep's `hplc_analyses` rows.

### Changed — COA generation

- COA is **variance-aware** and attributes generic purity/quantity to a variance
  vial's sole peptide. Customer-remarks delivery is gated on the include flag.

### Fixed (this release)

- **Variance drop zones no longer steal accidental drops** — gated to ≥1 paid
  replicate; fixes BW-0015 where dragging a vial core→XTRA→back-to-HPLC landed on
  the always-on nested variance zone and silently flipped `assignment_kind`.
- **Samples-list vial count** no longer counts the parent AR as a vial.
- **Prep-bridge identity** routes by peptide_id, fixing fragment-suffixed
  peptides (e.g. `TB500 (17-23 FRAGMENT)`) and the `ID_TB500` vs `ID_TB500-17-23`
  collision; never writes the legacy generic `HPLC-ID` for blends.
- **Seeder** excludes the Endotoxin service group from the HPLC vial mirror, so
  `ENDO-LAL` can't leak onto HPLC vials when Endotoxin is split out for SLA.
- **Retest-aware reads** use the current vial row (`retested=False`) rather than
  `retest_of_id IS NULL`, fixing variance-series and COA reads after a retest.

### Added — Analyte class & Benzyl Alcohol (Phase A)

- **`peptides.analyte_class` column** (`'peptide'` | `'additive'`, NOT NULL DEFAULT `'peptide'`). All existing peptide rows backfill to `'peptide'` on column add. Discriminates non-peptide HPLC analytes from peptides without renaming the table — keeps the existing `Peptide.id` FK plumbing across `CalibrationCurve`, `peptide_methods`, `instrument_methods`, `SamplePrep`, etc. usable for Benzyl Alcohol.
- **Benzyl Alcohol seeded as the first `'additive'` row** via startup migration (`name='Benzyl Alcohol'`, `abbreviation='Benzyl Alcohol'`, `is_blend=false`). Idempotent via `ON CONFLICT (abbreviation) DO NOTHING`.
- **`GET /peptides?analyte_class=peptide|additive`** opt-in query filter. Default unfiltered preserves all existing callers; only the HPLC wizard Step 1 picker uses the filter today.
- **HPLC wizard Step 1 context-filter** ([Step1SampleInfo.tsx](src/components/hplc/wizard/steps/Step1SampleInfo.tsx)). When the SENAITE lookup returns `sample_type === 'Bacteriostatic Water'`, the peptide dropdown shows **only** `'additive'`-class rows (currently just Benzyl Alcohol). All other contexts hide additives so peptide preps stay clean. Manual / pre-lookup default keeps additives hidden.
- **`AnalyteClass` type + `analyte_class` field on `PeptideRecord`** (`src/lib/api.ts`). `getPeptides({ analyteClass })` accepts the optional filter parameter.

### Added — Sub-sample publish guards

- **Hide "Publish Accumark COA" menu item on sub-sample detail pages** ([SampleDetails.tsx](src/components/senaite/SampleDetails.tsx)). The `<DropdownMenuItem>` is wrapped in `{isParent && (...)}` so the option simply doesn't render on `-S\d{2}` pages.
- **Backend 403 on sub-sample publish attempts** ([backend/main.py](backend/main.py) `POST /wizard/senaite/samples/{sample_id}/publish-coa`). Sub-samples inherit `ClientOrderNumber` from the parent via `INHERITABLE_FIELDS`, so publishing one would silently overwrite the parent's COA on the WP order line. Block stays in place until parent/sub linkage is wired through to WordPress.

### Changed — Single-vial check-in policy (revised)

- **First vial of a never-received parent now lands on the parent AR alone** — no `-S01` row created. Sub-samples represent vial 2+. This reverses the earlier "always create -S01" behavior and avoids redundant secondaries on single-vial check-ins. Receive wizard ([useReceiveWizard.ts](src/components/intake/ReceiveWizard/useReceiveWizard.ts)) skips `createSubSample` for the first vial of an unreceived parent and exposes a new `parentReceivedThisSession` flag.
- **Print labels list now includes the parent** when received this session, so the lab gets the parent's label alongside any sub-sample labels in one print pass. ([ReceiveWizard.tsx](src/components/intake/ReceiveWizard/ReceiveWizard.tsx))
- **Wizard sidebar renders the parent as Vial 1** (read-only, with "View details" link). Sub-sample vial labels now display `vial_sequence + 1` so `-S01` shows as "Vial 2" — matching the new single-vial policy where parent occupies vial 1. ([WizardSidebar.tsx](src/components/intake/ReceiveWizard/WizardSidebar.tsx))
- **`onSaveNew` callback returns `{ sampleId: string }` uniformly** (parent OR sub-sample). ([VialPanel.tsx](src/components/intake/ReceiveWizard/VialPanel.tsx), [PrintStep.tsx](src/components/intake/ReceiveWizard/PrintStep.tsx))

### Changed — Vial Panel UI

- **Native `<input type="file">` replaced with a styled `<Button>` + Upload icon** in the camera-failure branch ([VialPanel.tsx](src/components/intake/ReceiveWizard/VialPanel.tsx)). The input is `hidden`; the button triggers it via the existing `fileRef`. Disabled state mirrors `busy` to match the other action buttons.
- **Existing-photo preview** when editing a sub-sample with `photo_external_uid` now fetches and renders the actual image (via `fetchSubSamplePhotoUrl`) instead of a placeholder card. Renders inline in both camera-OK and camera-failure branches when in edit mode without a fresh capture.

### Schema

- New migrations in `database._run_migrations()` (run at backend startup, after the existing sub-samples tables):
  ```sql
  ALTER TABLE peptides ADD COLUMN IF NOT EXISTS analyte_class VARCHAR(20) NOT NULL DEFAULT 'peptide';
  UPDATE peptides SET abbreviation='Benzyl Alcohol' WHERE abbreviation='BA' AND name='Benzyl Alcohol';
  INSERT INTO peptides (name, abbreviation, is_blend, analyte_class, active, created_at, updated_at)
    VALUES ('Benzyl Alcohol', 'Benzyl Alcohol', FALSE, 'additive', TRUE, NOW(), NOW())
    ON CONFLICT (abbreviation) DO NOTHING;
  ```
  See [docs/deploy/2026-05-bw-subsamples-release.md](docs/deploy/2026-05-bw-subsamples-release.md) for the full deploy guide.

### Deferred / post-deploy

- **HplcMethod row + `peptide_methods` + `instrument_methods` links for Benzyl Alcohol** are pending lab-provided method params (RT, wavelength, column, gradient, instruments). BA samples can't be processed through the HPLC wizard until these land.
- **BA calibration curve.** Lab will run BA standards through the existing standard-prep workflow once the method exists.

---

## v1.0.0 — Sub-Samples (intake foundation)

### Added

- **Receive multiple vials per sample as native SENAITE secondaries.** A new grow-as-you-go wizard launches from the existing intake list (or from "+ Add Sub-Sample" on a parent's detail page for the after-the-fact case). The wizard walks the receiver through each vial: live camera preview, capture (preview swaps to a static still with a Retake button), optional remarks, save. Each save creates an `AnalysisRequestSecondary` in SENAITE under the parent (auto-named `<parent>-S<NN>`), uploads the captured photo as an attachment, and lands a row in the new local `lims_sub_samples` table. After saving, a confirmation card with the new sample ID + a "Receive another vial" primary button starts the next vial cleanly. The wizard's bottom-right footer carries [Print labels] (disabled while no session vials exist) and [Finished].
- **Parent sample detail page surfaces sub-samples.** A new "Sub-Samples (N)" section lists each child's vial sequence, sample ID, photo thumbnail (rendered through a new `/api/sub-samples/{id}/photo` proxy that streams the latest SENAITE attachment), received-at, received-by, plus per-row Open and Print Label buttons. Empty when zero children. A companion "Sub-Sample Analyses" section is built but intentionally empty in v1 — populates when the worksheet vial-to-test assignment phase ships. Sections only render on parent pages (sample id without `-S<NN>` suffix).
- **Sub-sample detail header shows parent linkage.** A breadcrumb-style "↳ Sub-sample of `<parent>` · Vial N of M" line sits between the sample ID heading and the Received row. Parent ID is clickable; vial count comes from the parent's children list.
- **`<SampleIdBadge>` shared component, rolled out across ~14 sites.** Auto-derives parent linkage from any `<parent>-S<NN>` ID format, so dropping `<SampleIdBadge id={sample_id} />` into a list cell, table row, or card automatically renders "↳ child of `<parent>`" inline whenever the ID is a sub-sample. Click on the parent portion navigates to the parent's detail; `stopPropagation()` makes it safe inside outer clickable cards. Swapped into COA Explorer, Order Detail Panel, Order Status (Sample / Kanban cards), Add Samples Modal, Sample Prep flyout, Worksheet Drawer Items, Analysis Results, Calibration Panel, and Purity Trend View.
- **Vial-count column on the receive intake list.** Each parent row shows "N received" or "—". TanStack Query per-row with a 60 s stale window.
- **QR-code labels via browser print.** New compact 30 × 15 mm label format: 9 mm QR code on the left, sample ID + WP-order-number on the right (8 pt mono with tightened letter-spacing so 11-character `<parent>-S<NN>` fits without truncation). Replaces the previous Code 39 barcode strip. Print preview hides everything except the labels via visibility-based isolation, so the wizard chrome / SENAITE site shell don't bleed into the printed output. Print Label is also wired into the per-row table button on the parent's Sub-Samples section and a header action "Print Label" on a sub-sample's own detail page. Both reuse a `usePrintLabel` hook + `<PrintLabelPortal>` that mount a single-label `.print-area` off-screen and trigger `window.print()` directly — no wizard round-trip required for reprints.
- **Sample-info panel in the receive wizard sidebar.** Restores the Client / Contact / Sample Type / Order # / Client Sample ID / Client Lot / Profiles / Declared Qty / Date Sampled / analyte chips that the legacy Step 2 receive panel showed, so the receiver retains full sample context while the camera has their attention. The vial panel header also gains a one-line "Client · Peptide · Qty" summary.
- **Backend API.** New `POST/GET/PATCH/DELETE /api/sub-samples` endpoints. `POST` creates the secondary in SENAITE, uploads the photo, copies inheritable parent fields onto the new AR (best-effort per-field fallback for the Plone-isDecimal-validator bug), and inserts the local row. The list response carries a `parent` summary block (sub_sample_count, last_synced_at) so the frontend can show counts without a separate fetch. The `GET /{sample_id}/photo` proxy resolves the AR's most-recent attachment and streams it through the existing auth boundary — the browser never needs SENAITE credentials.
- **Defense-in-depth on sub-sample creation.** Service refuses to create a child if the parent has no `contact_uid` (avoids a downstream 400 the Plone schema validator throws on `update_remarks`); auto-refreshes a stale cached parent UID and retries once before giving up; surfaces SENAITE silent-fallthrough as a structured `502 {code: "secondary_fallout", orphan_uid, orphan_sample_id, ...}` so the frontend can prompt for manual cleanup of the orphan AR (the SENAITE `/delete` route fails for orphans because they auto-receive past `sample_due`).
- **Drift reconciliation.** When the parent detail page renders the Sub-Samples section, the backend checks `last_synced_at` on the cached `lims_samples` row. If older than 5 min, re-fetches secondaries from SENAITE via `search?q=<parent_id>` (the v1 list endpoint silently drops parent-UID filters, so we filter client-side for `<parent>-S<NN>`), inserts any SENAITE-only secondaries into local cache, and warn-logs any local-only rows for human follow-up.

### Schema

- New tables in `accumark_mk1`: `lims_samples` (master sample registry, lazily populated as parents get sub-samples — designed as the seed of the eventual SENAITE-replacement schema with neutral `external_lims_*` columns) and `lims_sub_samples` (one row per vial, FK'd to `lims_samples.id`, unique constraint on `(parent_sample_pk, vial_sequence)`). Migration is additive via `database._run_migrations()` — no Alembic.
- ORM classes `LimsSample` and `LimsSubSample` (the `Sample`/`samples` names were taken by the existing HPLC-job-samples model). Convention: new LIMS-side tables use the `lims_` prefix.

### Changed

- The wizard's first vial of a never-received parent fires both the existing `/wizard/senaite/receive-sample` endpoint (parent state transition + WP comms — unchanged) AND the new `/api/sub-samples` endpoint, in that order. Subsequent vials and after-the-fact additions only call `/api/sub-samples`. The frontend orchestrates this; the backend service does not.

### Known limitations

- **Decimal-quantity fields don't inherit to children.** SENAITE/Plone-5's `isDecimal` validator rejects strings, ints, and floats from Python 3 clients on `Analyte{N}DeclaredQuantity` and `DeclaredTotalQuantity` (always returns "expected 'string'" regardless of type sent). All other custom fields inherit; quantities can be set manually in the existing UI until the validator is fixed server-side.
- **Worksheet inbox sub-sample handling deferred** to its own phase. Sub-samples currently appear individually in the worksheet inbox alongside parents, which is acceptable for v1 but will need grouping work as samples-with-2–6-vials become common.
- **Sample list grouping (parent rows expandable to children) deferred.** Nice-to-have; out of scope for v1.

## v0.38.0 — 2026-06-02 — Order Status page filters & Kanban refinements

### Added

- **Multi-select stage filters** on the Order Status page — stage chips now toggle
  independently (OR-matching) instead of single-select, via the pure
  `toggleFilterKey` helper (`src/components/explorer/order-filters.ts`, unit-tested).
- **SLA at-risk toggle** ("⚠ SLA at-risk") — narrows the list to amber + red orders
  through a `displayedOrders` memo; empty-state copy clarified when it matches none.
- **Client-side analyte filter** — a text input matching each card's displayed
  analysis names (case-insensitive), composing (AND) with stage / SLA / text filters
  across both table and Kanban views.

### Changed

- **Kanban refinements** — "Pending" hidden everywhere (removed from columns and
  state buttons; stale `pending` stripped from persisted filters); flat-Kanban
  columns are now collapsible (persisted `collapsedKanbanCols`, per-column chevron);
  the SLA indicator moved to its own full-width card row.

## v0.37.1 — 2026-06-02 — Bottlenecks bar order fix

### Fixed

- **Bottlenecks report** — phase bars now render in workflow sequence (Ordered →
  Received → Submitted → Verified → Published) instead of slowest-first, so
  `Submitted → Verified` sits in its correct position. Header relabeled to
  "process order"; the Slowest Phase summary card still highlights the worst
  phase. (The phase table below was already in sequence.)

## v0.37.0 — 2026-06-02 — Check-In Times & Bottlenecks reports

Two new analytical reports in the Reports area, built on the same thin-backend /
client-aggregation pattern: the backend extracts raw rows, the browser does all
timezone-dependent bucketing and aggregation so the period selectors recompute
without a refetch.

### Added

- **Check-In Times report** (`GET /reports/checkin-times`,
  [CheckInTimesReport.tsx](src/components/reports/CheckInTimesReport.tsx)). Check-in
  volume and time-of-day distribution from `worksheet_items.date_received` (the
  SENAITE sample-received timestamp, accumark_mk1 DB), deduped by `sample_uid` so
  counts reflect samples not analyses. Date-range selector (1M/3M/6M/1Y/ALL),
  summary cards (total, average time of day, busiest hour, busiest weekday), a
  by-day / by-hour bar chart with off-hours (before 9, after 17) dimmed and an
  average reference line, and a searchable raw list. All time-of-day bucketing is
  browser-local; raw UTC is returned from the server.
- **Bottlenecks (phase turnaround) report** (`GET /reports/turnaround`,
  [TurnaroundReport.tsx](src/components/reports/TurnaroundReport.tsx)). Systemic
  view of where time goes across SENAITE milestones (Ordered → Received →
  Submitted → Verified → Published), reading `sample_status_events` ⋈
  `order_submissions` from the integration DB (`accumark_integration`). Ranked
  horizontal bars slowest-first showing median per phase with a lighter p90 tail,
  summary cards (total median turnaround, slowest phase, cohort size), a per-phase
  table, period selector by received date, and a "Hide test orders" toggle.
  Calendar (wall-clock) time; `partial_submit`/`partial_verify` folded into
  Submitted/Verified.
- Reports sidebar gains **Check-In Times** and **Bottlenecks** sub-items.

## v0.36.0 — 2026-06-01 — SLA tracking & coverage

End-to-end SLA (turnaround-time) tracking: a configurable tier model, a
business-hours + holiday-aware elapsed/remaining engine, and SLA indicators on
every surface where staff previously saw hardcoded "Age"/"Processing Time"
fields.

### Added

- **SLA tier model.** New `sla_tiers` table (configurable `target_minutes`,
  `business_hours_only`, `amber_threshold_percent`, single-`is_default` tier,
  seeded at **48h (2d)** on a fresh DB) plus
  `sla_priority_tiers` (priority→tier overrides, global or scoped to a service
  group) and a `service_groups.sla_tier_id` column for per-group tier assignment.
  Resolution precedence: `(priority, group)` > `(priority, all groups)` > group's
  own tier > default. All schema applied via idempotent startup DDL in
  [backend/database.py](backend/database.py) — no manual migration step.
- **Business-hours + holiday-aware SLA engine.** [backend/sla_engine.py](backend/sla_engine.py)
  `compute_business_minutes` counts only configured business hours, skipping
  weekends and lab holidays; [backend/holidays_us.py](backend/holidays_us.py) supplies
  US federal holidays. New `business_hours_config` table + `lab_holidays` (seeded
  with the federal set on first run).
- **`POST /sla/status`** batch endpoint returning `{target, elapsed, remaining,
  breached}` per keyed item, with a `now_override` mode that freezes elapsed at a
  sample's publish date for historical "took Xh / Met / Missed" display.
- **Business Hours pane** in Preferences — schedule editor, lab-holiday CRUD, and a
  generate-US-federal-holidays action.
- **SLA indicators across the app**, replacing prior hardcoded aging fields:
  - Order list, **OrderExplorer**, and **OrderDashboard** SLA columns (replacing the
    hardcoded "Processing Time" / orange "Age" columns).
  - **Worksheet & Inbox** SLA age indicators (`SlaAgeIndicator`) replacing the
    hardcoded 24h/48h "AGE" field across WorksheetDrawerItems, WorksheetDropPanel,
    WorksheetsListPage, InboxSampleTable, and InboxServiceGroupCard.
  - **Sample Details** header indicator + per-analysis-row SLA cell.
  - Customer detail orders show SLA via the shared order row.
- **Multi-tier support** — a sample whose analyses span multiple service groups
  resolves one tier per group; order/worktime surfaces aggregate to the worst.
- **Shared `useSenaiteLookupMap` hook** — the per-sample SENAITE-lookup chain,
  previously duplicated inline in OrderStatusPage + CustomerStatusPage, extracted
  and reused by the explorer/dashboard SLA columns (exposes `isFetching` +
  `lastCachedAt` for "Updated X ago" headers).
- **Received date/time as the first field of the SLA breakdown tooltip** — the SLA
  clock start now leads the hover breakdown (`Received: …`) on every surface that
  hosts it, rendered with the same formatter as the sample page's "Received {date}".

### Changed

- **OrderStatusPage + CustomerStatusPage** rewired onto the shared
  `useSenaiteLookupMap` hook (deleted their inline lookup copies — pure DRY).
- Refreshed the SLA business-hours preference hint to describe the live behavior
  ("Counts only configured business hours, skipping weekends and lab holidays").

### Fixed

- **`WorksheetsListPage` avg-age KPI render purity** — seed `now` once via
  `useState` initializer instead of calling `Date.now()` in render; re-enabled
  React Compiler analysis for the file.

## v0.31.1 — 2026-05-04 — Bac Water analyte support (Wave 1)

### Added

- **`peptides.analyte_class` column** (`'peptide'` | `'additive'`, NOT NULL DEFAULT `'peptide'`). All existing peptide rows backfill to `'peptide'` on column add. Discriminates non-peptide HPLC analytes from peptides without renaming the table — keeps the existing `Peptide.id` FK plumbing across `CalibrationCurve`, `peptide_methods`, `instrument_methods`, `SamplePrep`, etc. usable for Benzyl Alcohol.
- **Benzyl Alcohol seeded as the first `'additive'` row** via startup migration (`name='Benzyl Alcohol'`, `abbreviation='Benzyl Alcohol'`, `is_blend=false`). Idempotent via `ON CONFLICT (abbreviation) DO NOTHING`.
- **`peptide_analytes` row for Benzyl Alcohol** auto-seeded so the Import Curves dialog populates BA. Joins to the SENAITE-synced `analysis_services` row with keyword `Benzyl_Alcohol_Assay`; silent no-op if the service hasn't synced yet (retries on every backend startup).
- **`GET /peptides?analyte_class=peptide|additive`** opt-in query filter. Default unfiltered preserves all existing callers; only the HPLC wizard Step 1 picker uses the filter today.
- **HPLC wizard Step 1 context-filter** ([Step1SampleInfo.tsx](src/components/hplc/wizard/steps/Step1SampleInfo.tsx)). When the SENAITE lookup returns `sample_type === 'Bacteriostatic Water'`, the peptide dropdown shows **only** `'additive'`-class rows (currently just Benzyl Alcohol). All other contexts hide additives so peptide preps stay clean.
- **`AnalyteClass` type + `analyte_class` field on `PeptideRecord`** (`src/lib/api.ts`). `getPeptides({ analyteClass })` accepts the optional filter parameter.

- **File picker fallback in receive sample intake** ([PhotoCapture.tsx](src/components/intake/PhotoCapture.tsx)). When the camera fails to initialize (no device, permission denied, or device in use), the error block now offers a **Choose File** button alongside **Try Again**. The picker accepts any `image/*` file and runs it through the same 500x496 preview pipeline as the camera path (center-crop to square + step-down). Lets a tech complete intake from a phone photo or scanned image when no webcam is attached.

### Fixed

- **`_run_migrations()` per-statement isolation.** A failure in one ALTER no longer halts subsequent statements — each runs in its own try/except with `migration_skipped` warning log + rollback. Previous bulk try/except masked silent migration drops on fresh-upgrade paths.
- **SSE curve-import failures now surface in the dialog** instead of failing silently with only a small "Failed" badge.
- **CoA publish from `ready_for_initial_review` warns instead of errors** ([backend/main.py](backend/main.py), [SampleDetails.tsx](src/components/senaite/SampleDetails.tsx)). The local CoA + IS publish have already succeeded by the time SENAITE workflow advances; failing the whole operation with HTTP 502 was misleading. `publish_sample_coa` now returns `success=True` with a `warning` field describing the SENAITE state lag for pre-publish states. The frontend renders it as `toast.warning` while keeping the console row green. Truly unexpected states (other than `ready_for_initial_review`) still raise HTTP 502.

### Deferred to Wave 2

- Sub-Samples (Phase 24), Vial Assignment Step, Phase 2 highlight, samples-list collapse, sub-sample publish guards. These live on `feat/vial-assignment-step` and ship in a follow-up release once Wave 1 has settled.

## v0.31.0 — 2026-04-26

### Added

- **Retest visibility on the sample detail page.** When a sample is itself a retest, a violet alert strip now sits at the top of the sticky header band: `↻ Retest of <source_sample_id> · WP order #<n> · <date>`. The source sample ID is a button that navigates to the source sample's detail page. Inverse view too: when a sample has been retested by other samples, an inline `↳ Retested as: <list>` pill appears next to the Received-time/Client line in the header, with each retest sample as a clickable navigation button. Driven by a new `GET /samples/{sample_id}/retest-info` endpoint that queries the integration-service Postgres directly (one indexed lookup + one JSONB lateral expansion against `order_submissions`).
- **Retest events in the activity timeline.** Two new event types added to `GET /samples/{sample_id}/activity`:
  - `retest_created` (accent / `↻`) — fires for retest samples at their order's `created_at`. Label: `Retest of <source> created — order #<n>`.
  - `retested_as` (warn / `↪`) — fires on the original sample, one entry per forward-chain retest. Label: `Retested as <new_sample_id> — order #<n>`.
- Both events sourced via JSONB lateral expansion on `order_submissions.payload->'samples'` (matching `retest_of_senaite_id`) joined to `os.sample_results` for the new senaite_id. No migrations — uses existing schema.

## v0.30.2 — 2026-04-26

### Fixed

- **Partial-publish no longer toasts "Regen failed" when add-on tests are pending.** `publish_sample_coa`'s post-transition guard previously allowlisted only `published` and `to_be_verified`; samples with sterility/endotoxin (or other SENAITE add-on analyses) outstanding land in `waiting_for_addon_results` after the `publish` transition fires, which the guard treated as a silent rejection and surfaced as a 502. The COA was already live (Integration Service had published it, the verification code was written, SENAITE accepted the transition into the addon-pending state) — staff just saw a confusing error and a refresh "fixed" it. `waiting_for_addon_results` is now an accepted post-transition state. Genuine silent rejections (`verified`, `sample_received`, etc.) still surface as 502s.

## v0.30.1 — 2026-04-25

### Changed

- **VERIFIED ClickUp column no longer triggers customer-facing completion.** The `verified` column now maps to internal `in_process` instead of `completed`. The completion email + $250 coupon + stepper-step-3 now fire only when the card moves to the Closed-group `added to accumk` column (= compound is actually live in the catalog). The lab tech's "testing finished" signal still drives the internal pipeline; customers just don't see "Complete" until it's real.

### Fixed

- **Coupon code now reaches the customer's request-detail page.** The completion side-effect that issues the $250 single-use coupon runs in a background thread *after* the original status-transition relay to wpstar has already fired. Without a follow-up sync, the wpstar snapshot stayed at `wp_coupon_code=NULL` and the "$250 coupon waiting" banner had no code to display. `run_coupon` now triggers a data-only relay (`send_email=False`) once the coupon lands in Postgres so the snapshot picks up the code and the detail page renders it. `relay_status_to_wp.run_once` includes `wp_coupon_code` in the forwarded payload.

## v0.30.0 — 2026-04-24

### Customer Peptide Request Submission + Retraction (Web Portal)

- **Feature:** Backend support for the customer-facing peptide-request portal flow on accumarklabs.com.  Customers can submit a new peptide-test request from `/portal/new-peptide-request/`; integration-service forwards to Accu-Mk1's new `POST /peptide-requests` endpoint, which inserts a row in the `peptide_requests` table and inline-creates a ClickUp card for the lab team to triage.
- **Feature:** Customer retraction — `POST /peptide-requests/{id}/retract` hard-deletes a pre-approval (or rejected) request, drops a "Customer retracted" comment on the ClickUp task, and moves the card to the new RETRACTED column.  Gate is authoritative on the backend (status must be `new` or `rejected`); stale-snapshot retract attempts surface as 409 envelopes.
- **Feature:** ClickUp column-map adds the `RETRACTED → retracted` mapping so the webhook handler tolerates inbound events for the new column.
- **Feature:** ClickUp client gains `post_task_comment(task_id, body)` and `set_task_status(task_id, status)` helpers used by the retraction flow.
- **Feature:** ClickUp APPROVED column is wired into the status map (column added on the list this cycle).
- **Endpoints (internal, X-Service-Token):** `POST /peptide-requests`, `GET /peptide-requests`, `GET /peptide-requests/{id}`, `GET /peptide-requests/{id}/history`, `POST /peptide-requests/{id}/retract`.  Plus admin `GET/POST /admin/clickup-users/...` mapping endpoints and `GET/POST /lims/peptide-requests/...` for in-app sync.
- **DB:** New `peptide_requests` table (UUID PK, status enum, customer wp_user_id + email/name, ClickUp task id, idempotency key, audit timestamps) and `peptide_request_status_log` table for transition history.
- **Tests:** +12 new tests covering the retract route (gate, ClickUp failure isolation, both retractable statuses, missing-row 404, auth) and the ClickUp client helpers.

## v0.29.0 — 2026-04-24

### Customer-Facing Analyte Aliases on COA

- **Feature:** Approved display aliases per peptide (managed in Peptide Config → Aliases tab) and per-sample alias picker on the sample-details ANALYTES card.  When a pick is active, the COA renders the alias instead of the real peptide name on the digital badge, IDENTITY / QUANTITY / PURITY rows, blend identity header, and the PDF peptide title.
- **Backend:** New `peptides.display_aliases` JSON column and `sample_analyte_aliases` table (`senaite_sample_id`, `slot`, `alias`, user-audit fields).  New endpoints `GET|PUT|DELETE /wizard/senaite/samples/{id}/analyte-aliases[/{slot}]`.
- **Wiring:** `generate-coa` and `regen-primary-coa` now include `analyte_display_names` in the COA Builder `/process` body when picks exist; the body is omitted when none are set so historical behavior is unchanged.
- **Conformance unchanged:** The real peptide name still drives identity matching — aliases only affect what the client sees on the COA.  Alias text is denormalized into `sample_analyte_aliases` so pruning a peptide's approved list later never retroactively invalidates a historical pick.

### Partial Publish When Tests Are Still Pending

- **Fix:** `publish-coa` now accepts `to_be_verified` as a valid post-transition SENAITE state, restoring the lab workflow where a COA is issued with currently-verified results (HPLC, endotoxin) while slower tests (sterility, ~14 days) are still running — the VerificationCode is already written to SENAITE and IS has already marked the generation published, so the client-facing COA is live.  A second publish runs when the final results come in.  Silent rejections for other states (`sample_received`, `open`, etc.) still surface as 502 errors.

### Senaite Publish Silent-Rejection Detection (PB-0050 fix)

- **Fix:** `publish_sample_coa` now re-reads `review_state` from the SENAITE response after POSTing the publish transition and raises **502** if the sample isn't actually in `published` (or `to_be_verified` per the partial-publish path above). Previously SENAITE returned 200 OK even when it silently refused the transition, so the verification code was minted on the integration-service side while the sample stayed unpublished in SENAITE — the failure mode that produced the PB-0050 ghost state.
- **Fix:** Accept `published` as a valid post-transition state for retried publishes (idempotency — the transition was already applied on a previous attempt that timed out client-side).

### Sample Details Badge + Per-Item Regen

- **Fix:** Sample Details right-column badge no longer shows "Generated" on a sample whose primary is actually `Published`. The page used to fetch only 10 newest COA generations and client-side `find()` the published primary; on samples with many regens × additional COAs (P-0453 had 45 rows), the published primary fell outside the window and the lookup returned undefined. Companion change in integration-service sorts primaries first in the response, so the active primary is always in the default page.
- **Feature:** Per-item Regen & Republish button on each additional COA card in Sample Details for ops correction. Enabled whenever a config has been generated (so re-generation is always reachable, not just when status is "published" or "wp_failed"). Refreshes the additional COAs list after the primary regen completes.
- **Fix:** Refresh additional COAs in the sidebar after a primary regen so newly-superseded children are reflected immediately without a hard reload.

## v0.28.10 — 2026-04-15

### Standard Prep Vial Data

- **Fix:** Backend now stores per-vial actual concentrations in `vial_data` for standard preps — previously only populated for blends
- **Result:** Standard calibration curves use gravimetric actual concentrations directly from the prep instead of parsing filenames

## v0.28.9 — 2026-04-15

### Standard Curve Gravimetric Correction Fix

- **Fix:** Standard preps with `target_conc_ug_ml = NULL` (all current standards) now infer the correction from the highest filename concentration level instead of silently defaulting to ratio=1
- **Fix:** Removed silent fallbacks — missing `actual_conc_ug_ml`, inferred correction ratios, and vials missing actuals now surface warnings in the UI
- **Reported on:** P-0475 (Kisspeptin-10) — concentrations were showing uncorrected nominal values (1, 10, 100, 250, 500, 1000) instead of actuals

## v0.28.8 — 2026-04-14

### Calibration Curve Fixes

#### Standard Curve — Actual Concentrations
- **Fix:** Single (non-blend) standard calibration curves now use gravimetric actual concentrations instead of nominal values from filenames
- **Fix:** Applies correction ratio (`actual_conc / target_conc`) to all standard points, accounting for weighing variance in the stock solution
- **Fix:** Blend calibration curves now prefer `actual_conc_ug_ml` over `target_conc_ug_ml` per vial (with fallback)

#### HPLC Processing — Instrument-Matched Curve Selection
- **Fix:** Auto-selected calibration curve now matches the sample prep's assigned instrument — previously grabbed the first active curve regardless of instrument, causing wrong-instrument curve selection (e.g. 1290b curve used for a 1290a sample)
- **Fix:** Applies to both single and blend sample processing paths

## v0.28.6 — 2026-04-11

### Digital COA Embed, Per-Instrument Calibration, UX Fixes

#### Digital COA
- **Embed:** AccuVerify badge rendered inline on Sample Details page under Generated COAs — no more navigating away to verify
- **Theme-aware:** Badge automatically matches the app's light/dark mode setting
- **Environment-aware:** Loads embed script from the active WordPress environment (local DevKinsta vs production)

#### Calibration Curves — Per-Instrument Starring
- **Fix:** Starring a curve now only deactivates curves on the same instrument, not all curves for the peptide
- **Fix:** HPLC analysis and wizard sessions now look up the starred curve matching the request's instrument — no silent fallback to wrong instrument
- **Error messaging:** Clear error when no starred curve exists for a specific instrument (e.g. "No active calibration curve for peptide 'BPC-157' on instrument '1290b'")

#### Samples List
- **Analytes column:** New column showing analyte peptide names as labels, with Enter-to-search filtering
- **Search UX:** All column search fields now require Enter to execute (no more auto-search on every keystroke)
- **Clear button:** Inline X icon appears in search fields after a search is committed

#### HPLC Processing
- **Fix:** Blend auto-fill "Peptide Total Quantity" now correctly uses the sum of all analyte quantities instead of the first analyte's individual value
- **Fix:** Blend-level aggregate analyses (Blend Purity, Peptide Total Quantity, Peptide ID) can no longer be claimed by per-analyte mappings

#### Sample Prep Wizard
- **Fix:** Step 1 vial label now shows "Autosampler vial" for regular preps and "scintillation vial" only for standards

## v0.28.2 — 2026-04-03

### Method-Instrument Many-to-Many & Identity Fix

#### Identity Check
- **Fix:** Single-peptide standard injection files (`_Std_PeakData.csv`) now correctly used as identity RT reference — previously fell back to calibration curve RT (different method) causing false DOES NOT CONFORM

#### Method-Instrument Relationship
- **Schema change:** Methods can now be shared across multiple instruments (M2M junction table replaces single FK)
- **Migration:** Automatic data migration on startup — existing method-instrument links preserved
- **Methods page:** "All" tab shows every method; per-instrument tabs filter by individual instrument
- **Instruments column:** Color-coded instrument tags on each method row
- **Bulk assign:** Select multiple methods via checkboxes and assign to an instrument in one click
- **Instrument sync:** Auto-parses title for model/brand/type (e.g., "HPLC 1290b" → model=1290, brand=Agilent) and backfills missing fields on existing instruments
- **Worksheets list:** Shows completed/total prep count per worksheet

## v0.28.0 — 2026-04-01

### Worksheet Feature Milestone

#### Phase 15: Foundation
- **Service Groups admin**: Create, edit, delete service groups with color-coded badges; assign analysis services to groups via checkbox membership editor
- **Analyst assignment**: View and assign analysts from AccuMark's local user list (SENAITE Analyst field is read-only)
- **Navigation**: Worksheets section accessible under HPLC Automation in sidebar (Inbox + Worksheets sub-items)

#### Phase 16: Received Samples Inbox
- **Live inbox**: All SENAITE received samples displayed in a polling queue (30s refresh) with aging timers and SLA color coding (green <12h, yellow 12-20h, orange 20-24h, red >24h)
- **Inline assignment**: Set priority (normal/high/expedited), assign tech, and set instrument per sample directly in the table
- **Bulk actions**: Select multiple samples via checkboxes; floating toolbar for bulk priority, tech, instrument, and worksheet creation
- **Worksheet creation**: Create worksheet from selected inbox items with stale-data guard (validates samples are still in received state)
- **Expandable rows**: Click to view analyses grouped by service group with color badges

#### Phase 17: Worksheet Detail
- **Floating clipboard drawer**: Global FAB button opens a slide-out drawer with full worksheet detail from any page
- **Worksheet management**: Edit title/notes, assign tech, add samples via mini inbox modal, remove items, reassign items between worksheets, mark complete
- **Start Prep**: Navigate from worksheet item directly to Sample Prep wizard with pre-filled fields
- **Multi-worksheet tabs**: Switch between open worksheets within the drawer
- **Completion tracking**: Records who completed a worksheet and when

#### Phase 18: Worksheets List
- **Worksheets overview page**: Table showing all worksheets with title, analyst, status badge, item count, priority breakdown, and oldest item age
- **KPI row**: Four stat cards — Open Worksheets, Items Pending, High Priority count, Average Age — computed live from current data
- **Filtering**: Status tabs (All/Open/Completed) with server-side filtering; analyst dropdown with client-side post-filter
- **Click-to-detail**: Row click opens the worksheet clipboard drawer
- **Completed timestamp**: Completed worksheets display their completion date/time in the list

## v0.27.7 — 2026-03-31

### Fix: Chromatogram upload to SENAITE

- **CSV instead of PNG**: Chromatogram data is now uploaded to SENAITE as a `.csv` file (time/signal columns) rather than a rendered PNG image
- **COA rendering fix**: Removed `RenderInReport=True` flag that was causing the chromatogram to render in the sample image slot on PDF COAs
- The in-app chromatogram preview is unaffected — only the SENAITE attachment format changed

## v0.27.5 — 2026-03-30

### Chromatogram Image for SENAITE

- **Chromatogram rendering**: HPLC chromatogram images are now rendered server-side via the Integration Service using the same matplotlib renderer as the COA Builder — matching style, peak labels, DAD header text, and Harmony Peptides watermark
- **SENAITE submit preview**: When navigating to the Submit to SENAITE step, a rendered chromatogram preview is shown inline
- **Auto-upload to SENAITE**: After auto-filling results, the chromatogram PNG is uploaded to SENAITE as an "HPLC Graph" attachment (best-effort, non-blocking)
- **New backend endpoints**: `POST /hplc/analyses/{id}/chromatogram-image` (render preview) and `POST /hplc/analyses/{id}/chromatogram-to-senaite` (render + upload)

### Integration Service

- **Chromatogram render endpoint**: `POST /v1/chromatogram/render` — accepts time/signal arrays, returns professional chromatogram PNG with peak detection, DAD header, and watermark
- **Slack notification module**: New adapter, service, and API router (`/v1/slack`) for Slack Bot Token integration — ready to activate with `SLACK_BOT_TOKEN` env var

## v0.27.4 — 2026-03-30

### Sample Analysis Management

- **Manage Analyses panel**: New inline panel on Sample Details page lets lab staff add or remove analysis services from a sample before work begins
- **Add service**: Searchable picker lists all 87 active Senaite analysis services; already-attached services are filtered out
- **Remove service**: Trash button on each unassigned/registered analysis removes it via ZMI; locked analyses (verified, published) cannot be removed
- **Guard**: Button only appears on samples in `sample_received`, `sample_due`, or `sample_registered` state
- **Bug fix**: Removal correctly targets the Zope object id (e.g. `ID_AOD9604-1`) rather than the keyword, preventing silent failures when retracted analyses left behind a renamed duplicate

### Integration Service

- New `list_analysis_services`, `add_analysis_to_sample`, `remove_analysis_from_sample` methods on the Senaite adapter
- New `GET /analysis-services`, `POST /samples/{id}/analyses`, `DELETE /samples/{id}/analyses/{keyword}` endpoints in `desktop.py`

## v0.27.3 — 2026-03-27

### Sample Prep Workflow

- **Manual HPLC Complete**: Status no longer auto-set after analysis — user clicks "Mark HPLC Complete" button on the SENAITE results page
- **Curve Created status**: Standard preps auto-set to `curve_created` when calibration curve is created
- **Completed preps filter**: Sample Preps list hides `hplc_complete`, `completed`, and `curve_created` preps

### History Page

- **Production/Standards tabs**: Split completed preps into separate tabs
- **Flyout integration**: Clicking a history prep opens the same Process HPLC flyout
- **History mode**: Flyout loads chromatograms and peak data from stored analysis records instead of re-downloading from SharePoint
- **Removed legacy tabs**: HPLC Import and Sample Prep Wizard tabs removed
- **Removed Import Analysis**: Sidebar nav item removed

### Fixes

- **Standard file warnings**: `P-0136_Std_100_PeakData.csv` no longer triggers "wrong file in folder" warnings

---

## v0.27.2 — 2026-03-27

### Order Status — Kanban Enhancements

- **"Services" toggle**: Expand kanban cards to show individual analysis service names per column state
- **Analyte name rewriting**: "Analyte 1 (Purity)" displays as "BPC-157 (Purity)" using the same logic as Sample Details
- **Waiting Addon services**: Shows outstanding (incomplete) analyses — Endotoxin, Sterility, etc.
- **Tech display on cards**: Shows assigned analyst(s) on each kanban card (e.g. "Tech: Forrest")
- **Retracted analyses excluded**: No longer counted as "Pending" in state counts and progress bars
- **Published column**: Skips service expansion (not useful for completed items)

---

## v0.27.1 — 2026-03-27

### Order Status Page Improvements

- **New filter states**: Sample Due, Ready for Review, Published, Waiting Addon, Received — covers the full SENAITE sample lifecycle
- **Tooltips on filter buttons**: Hover to see what each state means in the SENAITE workflow
- **Count badges on filters**: Each filter button shows how many samples match that state
- **Progress column**: Replaced "Samples 0/7" with a progress bar showing verified analyses out of total
- **Left border state indicator**: Color-coded left border on each row shows the order's earliest (most behind) sample state
- **Dimmed completed orders**: Rows where all samples are verified/published fade to 45% opacity
- **Time since received**: Sample cards show color-coded processing time (white <24h, amber 24-48h, red >48h) with hover text explaining the goal
- **Sample Details page**: Same color-coded time-since-received display in the header
- **Kanban cards**: Same time and hover text on kanban board sample items

---

## v0.27.0 — 2026-03-27

### User Tracking & Audit Trail

- **Sample Preps**: Record `created_by` and `updated_by` (user ID + email) on every create/update
- **HPLC Analysis**: Record `processed_by` on every analysis run
- **Peptides**: Record `created_by` and `updated_by` on create/update
- **Calibration Curves**: Record `created_by` and `updated_by` on create/update/activate
- **Backfill**: Older records without `created_by` are automatically backfilled on first edit

### Instrument Selection

- Instrument selector now available for **all** sample preps (previously standard-only)
- Wizard resolves `instrument_id` → `instrument_name` on session create and update
- HPLC analysis calls now pass the sample prep's instrument ID to the analysis record
- Methods panel in wizard filters to the selected instrument

### UI Enhancements

- **Wizard info panel**: Shows lab tech (logged-in user) and instrument throughout all wizard steps
- **HPLC flyout**: Shows lab tech and instrument context at the top of the Process HPLC sheet
- **Sample Preps list**: Added "Created By" column
- **Calibration Curves**: Shows "Created By" and "Last Edited By" in curve detail view

### Fixes

- Fixed stale SENAITE result persisting when opening a different sample prep in the wizard
- Fixed `_cal_to_response` not including user tracking fields in list views

---

## v0.26.1 — 2026-03-20

### HPLC Audit Trail & Debug Persistence

- **Debug log persisted to DB** — `debug_log` JSON column on `hplc_analyses` captures the full processing context (sample prep, parse results, calibration selection, warnings) for every analysis run
- **Source file archival** — raw CSV contents + SHA256 checksums stored in `raw_data` for audit proof and offline reproduction
- **Debug panel warnings** — visible amber warnings for missing standard injections, unmatched analytes, missing chromatograms, missing vial data, identity fallbacks, and SharePoint errors
- **Warnings banner on flyout** — critical issues surfaced prominently above analysis results with action links
- **Add Alias modal** — unmatched analyte warnings have an "Add as alias" button that opens a modal with peptide dropdown to save the alias immediately
- **SharePoint folder links** — missing data warnings link directly to the SharePoint .rslt folder for investigation
- **`sha256Hex` utility** — browser-native Web Crypto SHA256 for file checksums (no dependencies)

### SENAITE Results Summary

- **Results summary card** — SENAITE submission page shows per-analyte purity, quantity, and identity at a glance before submitting
- **Blend purity calculation** — mass-weighted average of component purities: `Σ(qty × purity) / Σ(qty)`
- **Blend identity** — all analytes must conform for blend to conform
- **Peptide Total Quantity** — sum of all analyte quantities

### HPLC File Aliases

- **Aliases tab on peptide flyout** — new "File Aliases" tab alongside Instruments for managing alternate HPLC filename labels per peptide
- **Add/remove alias tags** — type an alias, press Enter, changes save immediately to DB
- **Live alias enrichment** — flyout loads current aliases from live peptide records, not stale `components_json` snapshots
- **`hplc_aliases` on PeptideUpdate** — backend accepts alias updates via PUT endpoint

### Fixes

- **Standard prep file detection** — `_is_standard_injection()` now distinguishes standard injection refs (`_Inj_1_std_BPC157_`) from standard prep concentration files (`_Std_1000_`) by checking if the part after `_std_` is numeric
- **DB reload tab stability** — saved results labels persist during background SharePoint load instead of flickering to filename labels
- **DB reload latest run only** — filters to most recent `run_group_id` instead of showing all historical runs as duplicate tabs
- **DB reload active analyte** — `setActiveAnalyte` called on DB load so blend tabs are interactive immediately
- **Warnings gated on fresh runs** — parse-dependent warnings (unmatched analytes, missing std injections) only show during fresh analysis, not when loading saved results from DB
- **Per-vial weight routing** — blend analysis uses correct vial weights from `vial_data` per component
- **SharePoint search LIMS-first** — `search_sample_folder` checks LIMS CSV folder before Peptides/Raw Data tree
- **Blend chromatogram filtering** — alias-aware trace matching for filenames like `_BPC_TB17-23.dx_DAD1A.CSV`
- **Chromatogram auto-fetch multi-concentration** — backfill stores all DAD1A files keyed by concentration, not just the first one

---

## v0.26.0 — 2026-03-19

### Standard Sample Preps & Calibration Curves

- **Standard sample prep toggle** — wizard Step 1 has a "Standard Sample" switch that reveals manufacturer, instrument, and concentration level fields; standard preps flow through the same wizard steps as production
- **Standard badge + filter** — sample preps list shows a visible "Standard" badge; filter dropdown supports standard vs production
- **Auto-create calibration curve from standard** — Process HPLC on a standard prep shows a curve preview with chart, data table, and regression; "Create Calibration Curve" button generates a fully-linked curve with provenance
- **Standard chromatogram on curves** — calibration curve expanded view shows the standard's chromatogram with per-concentration tabs (1, 10, 100, 250, 500, 1000 µg/mL) and an "All" overlay option

### HPLC Results Persistence

- **Full provenance on analysis results** — `hplc_analyses` now stores `calibration_curve_id`, `sample_prep_id`, `instrument_id`, `source_sharepoint_folder`, `chromatogram_data`, and `run_group_id`
- **Blend run grouping** — per-analyte analysis rows from the same Process HPLC session share a `run_group_id` UUID
- **DB-first flyout reload** — reopening Process HPLC loads saved results instantly from DB, then loads SharePoint data in the background for chromatogram + peak table detail
- **Re-run Analysis** — banner with button to clear saved results and re-scan SharePoint for a fresh analysis
- **`hplc_complete` status** — sample prep status auto-updates after successful analysis; teal badge in list

### Calibration Curve Backfill

- **Source Sample ID + Vendor fields** — edit form on calibration curves includes Source Sample ID and Vendor inputs
- **SharePoint chromatogram auto-fetch** — when a Source Sample ID is saved, backend auto-fetches DAD1A chromatogram files from SharePoint (LIMS CSV folder) and stores them on the curve
- **Multi-concentration storage** — chromatogram data stored keyed by concentration level for per-level viewing

### Chromatogram Overlay

- **Standard trace overlay** — Process HPLC flyout renders the active calibration curve's standard chromatogram as a dashed, semi-transparent reference trace behind the sample's solid trace
- **Per-trace styling** — `ChromatogramTrace` supports optional `style` field (dashed, opacity) for visual distinction
- **`extractStandardTrace` helper** — handles both old single-trace and new multi-concentration chromatogram formats; picks highest concentration for best visual reference

### Same-Method Identity Check

- **Standard injection detection** — parser detects `_std_` PeakData files in .rslt folders and extracts main peak RT per analyte
- **Same-method RT comparison** — identity check uses standard injection RT (same HPLC method) when available, falling back to calibration curve reference_rt
- **Reference source display** — identity card shows "Ref: Standard injection (P-0111)" or "Ref: Calibration curve" so techs know which reference was used
- **Alias-aware analyte matching** — `hplc_aliases` field on peptides enables matching chromatogram filename labels (e.g., "TB17-23") to peptide records (e.g., "TB500 (17-23 FRAGMENT)")

### Instrument FK Relationships

- **Proper `instrument_id` FK** on `CalibrationCurve`, `WizardSession`, and `hplc_analyses` — replaces raw string instrument fields
- **Dynamic instrument dropdowns** — CalibrationPanel edit form, wizard Step 1, and PeptideConfig flyout all load instruments from DB instead of hardcoded values
- **Backfill migration** — existing curves and sessions auto-populated with `instrument_id` from name matching at startup

### Fixes

- **Sample prep duplication** — wizard `setCurrentStep(0)` fixed to `setCurrentStep(1)`; `POST /sample-preps` is now idempotent (checks `wizard_session_id` before creating)
- **Calibration curve filter mismatch** — `CalibrationPanel` filter changed from exact string match to ID-based comparison; default `flyoutInstrument` changed from hardcoded `'1290'` to `'all'`
- **Per-vial weights in blend analysis** — flyout routes each blend component to the correct vial's dilution measurements from `vial_data`
- **DB reload race condition** — `dbCheckActiveRef` (synchronous ref) prevents SharePoint scan from firing before DB check completes
- **Blend chromatogram filtering** — alias-aware trace filtering matches filenames like `_BPC_TB17-23.dx_DAD1A.CSV` to the correct analyte tabs
- **SharePoint search** — `search_sample_folder` now checks LIMS CSV folder first (where HPLC machines dump raw data), then falls back to Peptides/Raw Data tree

### Backend

- Schema migrations for `instrument_id` on calibration_curves, wizard_sessions, hplc_analyses
- `GET /hplc/analyses/by-sample-prep/{id}` endpoint for flyout reload
- `_analysis_to_response()` helper eliminates response construction duplication
- PATCH calibration endpoint accepts `source_sample_id`, `vendor`; auto-fetches chromatogram from SharePoint
- Standard injection parser with `StandardInjection` dataclass and `StandardInjectionResponse` API model
- Identity calculation tracks `reference_source`, `reference_source_id`, `calibration_curve_rt` in trace

---

## v0.25.0 — 2026-03-12

### Multi-Vial Blend Prep Support

- **Multi-vial sample prep wizard** — blend peptides with `prep_vial_count > 1` generate per-vial Stock Prep and Dilution steps in the wizard
- **Per-vial target parameters** — each vial has its own declared weight, target concentration, and target volume stored in `vial_params` JSONB
- **Per-vial measurements** — stock prep and dilution measurements tracked per vial number
- **Per-vial calculations** — backend computes stock_conc, required_volumes, and actual_conc independently per vial via `vial_calculations`
- **Peptide config — Prep Vials section** — configure vial count and assign blend components to vials from the Peptide Config page
- **Wizard info panel** — new left-hand panel (30% width) showing SENAITE sample data, context-aware vial details, and method cards with all fields (instrument, SENAITE ID, size peptide, starting organic %, MCT temp, dissolution, notes)
- **Context-aware vial details** — info panel switches between "Vial 1 Details" / "Vial 2 Details" based on active wizard step, showing assigned analytes and per-vial targets
- **Blend method priority** — direct methods on the blend peptide take priority; component-level method matching is fallback only
- **Smarter SENAITE auto-detection** — multi-analyte SENAITE lookups search for an exact blend match before falling back to single peptide selection
- **Per-analyte declared quantities** — SENAITE card shows declared_quantity next to each analyte
- **Horizontal step navigation** — wizard steps moved from left sidebar to horizontal top bar for better use of screen space

### Fixes

- **Next Step button** — fixed permanent disable caused by chained display states in `deriveStepStates`; now checks session data directly for step prerequisites
- **Methods missing when editing** — `selectedPeptide` now set in the store when returning to Step 1 with an existing session
- **Editable session summary** — multi-vial sessions show per-vial declared weights and editable per-vial target fields when navigating back to Step 1

### Backend

- Added `prep_vial_count` column on peptides, `vial_number` on blend_components and wizard_measurements
- Added `vial_params` JSONB on wizard sessions, `vial_data` JSONB on sample preps
- Peptide update endpoint accepts `prep_vial_count` and component vial assignments
- Wizard session endpoints accept and return `vial_params` and `vial_calculations`
- `updateWizardSession` accepts `vial_params` for per-vial target edits

---

## v0.24.0 — 2026-03-08

### Order Status — Kanban Board View

- **Kanban view** — new view toggle (Table / Kanban) persisted to localStorage; Kanban shows four columns: Pending, Assigned, To Verify, Verified
- **Sample cards duplicate across columns** — a sample with both pending and to-verify analyses appears in both columns, each card showing the count for that specific state (e.g. "17 to verify")
- **Group by Order mode** — swimlane per order with header showing order ID, email, and processing time; samples distributed into columns within each swimlane
- **Flat mode** — columns of sample cards with order reference on each card
- **Card clarity improvements** — count shown as a labeled pill ("17 to verify") with column-color background; sample SENAITE state shown as "LIMS: Received" to distinguish from analysis state
- **Kanban sort** — when in Group by Order mode, sort by Order ID or Outstanding time (oldest first by default); click active sort to toggle direction
- **Analysis state filter hidden in Kanban** — switching to Kanban clears and hides the filter strip since columns already show all states
- **Order number links to Order Explorer** — clicking an order number in a Kanban card navigates to Order Explorer and auto-opens the flyout for that order

### Order Explorer

- **Hide test orders persisted** — checkbox state saved to localStorage

---

## v0.23.0 — 2026-03-08

### Order Status — Analysis State Filters & Persistent Filter State

- **Analysis state filter strip** — new button row above the Status Matrix: **Active** (clear all) | **Pending** | **Assigned** | **To Verify** | **Verified**; single-select, filters the Sample Details column within each order
- **Sample-level filtering** — when a filter is active, only sample cards matching that analysis state are shown within each order row; orders with no matching samples are hidden entirely
- **Text filters** — Order ID, Email, and Sample ID text inputs for quick lookup
- **Persistent filter state** — all filter settings (active state, text inputs, Hide Test Orders checkbox) are saved to `localStorage` and restored on next visit

---

## v0.22.0 — 2026-03-08

### Analysis Table — Identity (HPLC) Result Handling

- **Conforms/Does Not Conform display** — `Identity (HPLC)` analyses now render human-readable labels ("Conforms" / "Does Not Conform") instead of raw SENAITE values in both the active row and history rows
- **Identity dropdown in edit mode** — editing an `Identity (HPLC)` cell shows a dedicated two-option dropdown ("Conforms" / "Does Not Conform") instead of the generic result options selector; the conforming value is resolved from the analyte name map by slot number

### Senaite Lookup Caching

- **Sample details always fetches fresh** — `lookupSenaiteSample` now defaults to `no_cache=true`, bypassing the 15-min server-side cache for all callers except Order Status
- **Order Status page opts into cache** — `enqueueSenaiteLookup` explicitly passes `noCache=false` to avoid hammering Zope when polling many samples
- **Backend `no_cache` param** — `/wizard/senaite/lookup` accepts `?no_cache=true/false`; default is `true` (fresh fetch)

---

## v0.21.0 — 2026-03-06

### Blend Peptides

- **Blend peptide data model** — `is_blend` flag on peptides, `blend_components` junction table (many-to-many), component peptides linked with display order
- **Auto-derived analytes** — creating/editing a blend auto-generates analyte slots from each component peptide's primary analyte; manual analyte selection hidden for blends
- **Blend creation form** — "This is a blend" toggle in PeptideForm; multi-select component picker; shows auto-linked analyte info
- **Sidebar indicators** — blend peptides show a "Blend" badge in the peptide list

### Blend HPLC Processing

- **Per-component calibration curves** — HPLC flyout loads calibration curves for each component peptide independently
- **Label-to-component fuzzy matching** — parsed HPLC filename labels (BPC, GHK, TB500(17-23)) are matched to DB component abbreviations (BPC-157, GHK-CU, TB500 (17-23 FRAGMENT)) via 3-tier matching: exact → prefix → first-word prefix
- **Per-analyte analysis** — each component runs against its own calibration curve; analyte tabs show per-component results
- **Per-analyte chromatograms** — chromatogram traces filtered by active analyte label; blanks excluded

### Sample Prep Wizard — Blend Support

- **Blend info card in Step 1** — when a blend peptide is selected, shows component badges and blend indicator
- **Component calibration validation** — wizard session creation checks component peptides for active calibration curves (blends don't have their own)
- **Blend metadata on sample preps** — `is_blend` and `components_json` columns stored on sample_preps for downstream HPLC processing

### Debug Console

- **Terminal overlay in HPLC flyout** — terminal icon in the header opens a dark terminal-style overlay (matching ScanConsole aesthetic) with full diagnostic readout
- **Per-analyte diagnostics** — shows SharePoint files, parsed injections with peak-level detail (RT, area, area%, height, main peak markers), calibration curve info, weights, analysis results, and calculation trace
- **Color-coded output** — errors in red, warnings in amber, success in emerald; error messages in calculation trace auto-detected and highlighted
- **Keyboard dismiss** — Escape key or X button closes the overlay

### Bug Fixes

- **Solvent front false positive** — peak parser no longer marks the only peak as solvent front; fixes early-eluting peptides (e.g., GHK-Cu at RT 1.2) returning null purity/quantity
- **Wizard session creation for blends** — fixed "No active calibration curve found" error by checking component peptides instead of the blend itself

---

## v0.20.0 — 2026-03-05

### Per-User Senaite Authentication

- **Senaite credentials on Profile page** — users can store their Senaite password so write operations (field updates, result submissions, workflow transitions, COA publishing) are attributed to their own Senaite account instead of the admin user
- **Encrypted storage** — Senaite passwords are encrypted at rest using Fernet symmetric encryption keyed off `JWT_SECRET`; each environment has its own encryption key
- **Validate-before-save** — the backend authenticates against Senaite before storing credentials; wrong passwords are rejected immediately
- **Admin fallback** — if a user has no stored credentials (or decryption fails), write operations transparently fall back to the admin Senaite account
- **8 write operations updated** — `generate_sample_coa`, `publish_sample_coa`, `upload_senaite_attachment`, `update_senaite_sample_fields`, `set_analysis_result`, `set_analysis_method_instrument`, `transition_analysis`, `receive_senaite_sample`
- **Lightweight migration system** — `database.py` now runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on startup before `create_all()`, solving the SQLAlchemy limitation where `create_all()` doesn't add columns to existing tables

### Profile Page

- **New Account → Profile page** — replaces the standalone Change Password page; consolidates user-specific settings in one place
- **Change Password section** — same functionality as before, now in a card layout
- **Senaite Integration section** — password input with verify/save flow, "Credentials configured" status with Remove/Update buttons

### Navigation Restructure

- **Analysis section** — renamed from "SENAITE"; now includes Samples, Receive Sample, and Event Log
- **LIMS section** (new) — Instruments, Methods, Peptides, and Analysis Services moved here from HPLC Analysis for better logical grouping
- **HPLC Automation** — renamed from "HPLC Analysis"; now focused on workflow: Overview, New Analysis, Import Analysis, History, Sample Preps

### Calibration Improvements

- **Import via SharePoint folder browser** — new "Browse Folder" mode in the peptide resync dialog; navigate SharePoint directories to pick a folder containing calibration CSVs
- **Manual entry mode** — enter calibration data points (concentration, area, RT) directly without a file
- **Notes field on calibration curves** — editable notes in the calibration edit form; displayed in the read-only view

### Blend Sample Prep Support

- **Per-analyte analysis in HPLC flyout** — blend peptides (e.g., "KPV + BPC-157") show analyte tabs; each analyte runs against its own calibration curve
- **Aggregated Senaite auto-fill** — `SenaiteResultsView` merges results from all analyte runs; per-analyte matches (e.g., "KPV Purity") are prioritized over generic matches ("Peptide Purity")

### Order Explorer

- **Slideout detail panel** — order details now open in a full-height sidebar panel with backdrop blur instead of an inline expansion
- **Order Status page** — new page for tracking order fulfillment status

### Backend

- **Senaite concurrency limiter** — frontend caps in-flight Senaite requests to 3 concurrent to avoid overwhelming the server
- **CalibrationDataInput** expanded — now accepts `rts`, `analyte_id`, `instrument`, and `notes` fields
- **`senaite_configured` flag** on user responses — frontend knows whether a user has stored Senaite credentials

---

## v0.19.0 — 2026-03-05

### HPLC Flyout Redesign

- **Single-page scrollable layout** — replaced multi-step wizard with a two-column flyout (1360px wide); left column shows results + data, right column shows sticky Calculation Trace
- **Auto-run analysis** — analysis runs automatically when data file + calibration are loaded; removed manual "Run Analysis" button
- **Consolidated chromatogram** — single chromatogram with peak table directly below; removed duplicate chart
- **`hideTrace` prop on AnalysisResults** — calculation trace can be hidden from the results card when rendered externally in the right column

### Senaite Results Submission

- **New `SenaiteResultsView` component** — second view in the HPLC flyout for submitting computed results to Senaite LIMS
- **"Submit Results" button** — navigates from analysis view to Senaite submission step
- **Sample ID selector** — load any Senaite sample by ID (needed for testing where local dev samples differ from SharePoint data files)
- **Auto-fill from HPLC** — matches computed purity, quantity, and identity values to Senaite analysis rows by title keyword; supports generic ("Peptide Purity (HPLC)", "Peptide Total Quantity") and per-analyte ("KPV Purity", "BPC-157 - Identity (HPLC)") naming conventions
- **One-click fill** — "Fill N results" button writes all matched values to Senaite via `setAnalysisResult` API with optimistic local updates and toast feedback

### Peptide & Calibration Management

- Enhanced `PeptideConfig` and `PeptideForm` with instrument tabs and expanded configuration options
- Improved `CalibrationPanel` with additional calibration curve management features
- Updated `MethodPanel` and `MethodsPage` with refined method management UI

### Backend

- Expanded HPLC backend endpoints and models
- Added SharePoint integration helpers

### Other

- New `CreateAnalysis` and `AnalysisServicesPage` components
- `DataPipelinePane` additions in preferences
- Sidebar and store updates for new navigation flows
- Wizard step improvements

---

## v0.18.0 — 2026-03-03

### Added

- **HPLC Scan on Sample Preps page** — new "Scan HPLC" button scans the `Analytical/LIMS CSVs and Endotoxin` SharePoint folder for peak data CSV files matching sample prep IDs; shows real-time progress in a console-style overlay that stays open until manually closed
  - Matching folders display a green "Process HPLC" button on the prep row
  - `GET /sample-preps/scan-hplc` SSE endpoint streams log lines, progress, and match events to the frontend
- **HPLC Flyout (`SamplePrepHplcFlyout`)** — opens when "Process HPLC" is clicked; three-step flow:
  - **Step 1 — Preview**: downloads peak + chromatogram CSVs from SharePoint, shows purity banner, chromatogram chart (above peak table), and full peak data table
  - **Step 2 — Configure**: displays sample prep weights (pre-filled from saved wizard measurements) and calibration curve selection
  - **Step 3 — Results**: runs analysis, shows full `AnalysisResults` with calculation trace
- **Self-healing chromatogram discovery** — flyout now detects `dx_DAD1A` chromatogram files even from stale scan results by browsing the SharePoint folder by item ID on the fly (`GET /sharepoint/folder-by-id/{id}/chrom-files`); no re-scan required
- **HPLC Methods** — new `HplcMethod` model and full CRUD API (`GET/POST/PATCH/DELETE /hplc/methods`); methods now link to an `Instrument` FK; peptides use a many-to-many `peptide_methods` junction table
- **Instruments** — `Instrument` model synced from SENAITE; new `Instruments` page in sidebar with `GET /instruments` and `POST /instruments/sync` endpoints; `InstrumentBrief` embedded in method responses
- **Calculation Trace reordering** — in analysis results, cards now stack vertically: Dilution & Stock Prep → Sample on Calibration Curve → Purity per Injection → Identity

### Fixed

- **New Analysis wizard step 2 "Next" button** — was permanently disabled because `canAdvance()` required `stock_conc_ug_ml` to be non-null (backend calculation dependent on all Step 1 fields being set); now unlocks as soon as both stock vial measurements are recorded regardless of calculation availability
- **New Analysis wizard step 3 "Next" button** — same fix applied: unlocks when all three dilution measurements are recorded
- **Sample prep weights showing "—" in flyout** — `list_sample_preps` SQL query was only selecting a subset of columns and omitting all five vial weight fields; expanded to `SELECT *` equivalent
- **Chromatogram file detection** — backend scan used `".dx_" in name` (literal period) which never matched actual filenames like `P-0248_Inj_1.dx_DAD1A.CSV`; fixed to `"dx_dad1a" in name.lower()` matching the same pattern used by the Import Analysis page
- **SENAITE analyte name fuzzy-matched to wrong peptide** — `_fuzzy_match_peptide` used a simple substring match; "Semaglutide" matched "Cagrilinitide + Semaglutide" because the blend name contains the substring; fixed with a 3-pass priority matcher: (1) exact normalized match, (2) substring against non-blend names only (skipping `+`), (3) abbreviation match
- **Diagnostic endpoint** — added `GET /wizard/senaite/raw-fields/{sample_id}` to expose raw SENAITE API field values for debugging analyte name mismatches

---

## v0.17.0 — 2026-03-03

### Added

- **Sample Preps** — new section in HPLC Analysis for saving and managing HPLC sample preparation records
  - Accessible from the left sidebar ("Sample Preps" under HPLC Analysis) and the HPLC Overview card
  - Sample prep records are persisted to the Integration-Services PostgreSQL database in a new `sample_preps` table
  - Sample IDs follow the `SP-YYYYMMDD-NNNN` format consistent with the rest of the integration DB
  - All wizard data is captured flat: declared weight, target params, all balance readings, and all derived concentrations/volumes
  - **Inline status selector** on each row — change status without opening the record; auto-saves to backend on change
  - Four statuses: 🔵 Awaiting HPLC · 🟢 Completed · 🟡 On Hold · 🟣 Review
  - **Click any row** to be taken back into the HPLC wizard at Step 3 (Dilution) pre-loaded with that session's data for review or re-weighing
  - Search bar filters by sample ID, SENAITE ID, or peptide
  - "New Prep" button navigates directly to the wizard
  - New Postgres-backed CRUD helpers in `integration_db.py`: `ensure_sample_preps_table`, `create_sample_prep`, `list_sample_preps`, `get_sample_prep`, `update_sample_prep`
  - New API endpoints: `POST /sample-preps`, `GET /sample-preps`, `GET /sample-preps/{id}`, `PATCH /sample-preps/{id}`
- **HPLC Wizard refinements**
  - Step 1 renamed to **"Peptide Vial Weight"**; declared weight input relabelled to "Sample Vial + cap + peptide (mg)"
  - Step 2 "Add Diluent" description updated to "Add 2000mL (enough to dissolve). Diluent volume will be calculated after vial weights are recorded."
  - Step 3.1 (first Dilution sub-step) renamed to **"Empty Autosample Vial + cap Weight"** with updated description and input label
  - Steps 4 (Results) and 5 (Summary) hidden from the wizard sidebar — visible step count is now 1–3
  - Final step's "Next Step" button replaced with **"Save Sample Prep"** — calls `POST /sample-preps` and navigates to the Sample Preps list on success, with spinner and error handling

### Infrastructure

- `ensure_sample_preps_table()` auto-migrates the new table on first API call — no migration script required

---

## v0.16.2 — 2026-03-02

### Added

- **Per-column search on SENAITE Samples** — replaced the general search bar with inline "Search…" inputs under Sample ID, Order #, and Verification Code column headers
- **Postgres-backed search for Order # and Verification Code** — SENAITE has no catalog indexes for these fields, so searches query the integration service's PostgreSQL database (ILIKE) for matching sample IDs, then fetch full sample data from SENAITE via `getId`; this scales to thousands of samples without bulk loading
- **`search_field` parameter on `/senaite/samples`** — backend accepts `search_field=verification_code` or `search_field=order_number` to route searches through Postgres; default (no field) uses SENAITE's `getId` catalog for sample ID lookup
- **`search_sample_ids_by_verification_code()`** and **`search_sample_ids_by_order_number()`** in `integration_db.py` — ILIKE queries against `ingestions`, `coa_generations`, and `order_submissions` tables

### Fixed

- **Order # search finds WP-prefixed numbers** — searches both `order_submissions.order_number` (bare "3066") and `ingestions.order_ref` (prefixed "WP-3066") so either format works

---

## v0.16.1 — 2026-03-02

### Fixed

- **SENAITE sample search finds all samples** — searching for older sample IDs like P-0177 now works; previously, search fetched the 500 most recent samples and filtered client-side, so anything older was invisible
- **Search moved to server-side** — search queries are now sent to the backend API instead of filtering a local cache; the backend uses SENAITE's `getId` catalog index for exact sample ID matches and a broad fetch with server-side filtering for order numbers, client names, and verification codes
- **SENAITE catalog quirks documented** — `SearchableText` tokenizes on hyphens (useless for sample IDs), `getClientOrderNumber` index returns all samples regardless of value, `getId` wildcards are not supported; only exact `getId` match is reliable

---

## v0.16.0 — 2026-02-26

### Added

- **Editable Method & Instrument in Analyses table** — pencil-to-edit UI on each analysis row for Method and Instrument fields; dropdowns are populated per-analysis from SENAITE's AnalysisService configuration so only the allowed options for that analysis type are shown
- **`POST /wizard/senaite/analyses/{uid}/method-instrument`** backend endpoint — saves Method and Instrument selections directly to SENAITE
- **WooCommerce order flyout on Sample Details** — "View Order Details" button opens an inline panel with the linked WooCommerce order (customer, line items, status, order notes) without leaving the page
- **SENAITE Samples search bar** — filters the samples list in real time by sample ID, client, or verification code
- **Samples pagination** — next/previous page controls with "X–Y of Z" count when results exceed one page
- **Hide test samples toggle** — checkbox on the Samples dashboard to suppress the internal test client from the list

### Changed

- **Samples default sort** changed from Date Received to Date Created (descending)

### Fixed

- **nginx upload limit** raised to 50 MB (`client_max_body_size 50M`) to support HPLC CSV and chromatogram uploads
- **Docker local WP routing** — added `accumarklabs.local` host alias to backend container so DevKinsta-hosted WooCommerce is reachable inside Docker
- **WordPress URL** corrected in `.env.docker` to local dev domain

---

## v0.15.0 — 2026-02-24

### Added

- **SENAITE promoted to top-level navigation** — SENAITE is now its own section in the sidebar (previously nested under Dashboard) with "Samples" and "Event Log" sub-items
- **Event Log page** — new table showing all sample workflow status transitions (receive, submit, verify, publish, retract, cancel, reinstate) fetched from the integration service's `sample_status_events` table
  - Color-coded transition badges and status badges per row
  - WP notification status (check/X icon) and WP status text columns
  - Clickable Sample ID links navigate directly to Sample Details
  - Sample ID filter with search input in card header and per-row filter icon toggle
  - Refresh button, loading spinner, empty states, and filtered-results empty state
- **`GET /explorer/sample-events`** backend proxy — forwards to integration service for cross-order event retrieval
- **`getAllSampleEvents()` API function** — frontend fetch wrapper for the new endpoint
- **Shared SENAITE utilities** — extracted `StateBadge`, `STATE_LABELS`, and `formatDate` into `senaite-utils.tsx` for reuse across SenaiteDashboard and SampleEventLog

### Changed

- **SENAITE components reorganized** — moved `SenaiteDashboard.tsx`, `SampleDetails.tsx`, and `EditableField.tsx` from `components/dashboard/` to `components/senaite/` for better cohesion
- **Navigation types updated** — `ActiveSection` now includes `'senaite'`; new `SenaiteSubSection` type; `navigateToSample()` routes to `senaite/sample-details` instead of `dashboard/sample-details`
- **Hash navigation** — `'senaite'` added to `VALID_SECTIONS`; deep links work at `#senaite/samples`, `#senaite/event-log`, and `#senaite/sample-details?id=XX`

## v0.14.0 — 2026-02-24

### Added

- **Inline editing for Sample Details** — click any editable field value to edit it in-place with save/cancel controls
  - New `EditableField` and `EditableDataRow` components with optimistic updates, loading spinners, and toast notifications
  - Editable fields: Order #, Client Sample ID, Client Lot, Date Sampled, Declared Qty, analyte peptide names, analyte declared quantities, and all COA branding fields (company name, website, email, address, verification code, logo URL, chromatograph BG URL)
  - Keyboard support: Enter to save, Escape to cancel, focus management on edit mode entry
  - Custom `onSave` prop allows reuse with non-SENAITE backends (used for additional COA configs)
- **Additional COAs section** in Sample Details — displays additional branded COA configurations from the Integration Service
  - Collapsible per-COA cards showing company name, status badge, and branding details
  - Inline editing of all additional COA fields (company name, website, email, address, logo URL, chromatograph BG URL)
  - Image thumbnails for logo and chromatograph background alongside text fields
  - `PATCH /explorer/additional-coas/{config_id}` backend proxy for updating additional COA branding
- **SENAITE field update endpoint** — `POST /wizard/senaite/samples/{uid}/update` proxies field writes to SENAITE
  - JSON-first strategy with form-encoded fallback to handle both extension fields and isDecimal-type fields
- **URL left-truncation** — `truncateStart` prop on editable fields shows the filename end of long URLs instead of the domain

### Fixed

- **Extension field saves now persist** — Logo URL and Chromatograph BG URL writes previously returned false success (SENAITE silently ignored form-encoded extension fields). Fixed with JSON-first approach that falls back to form-encoded on 400 errors.

## v0.13.0 — 2026-02-23

### Added

- **Sample Details page redesign** — complete UI overhaul of the SENAITE sample detail view
  - Two-column grid layout: sample info & order details on the left, analytes & COA info on the right
  - Analysis profile theming with color-coded chips (Peptide/violet, Endotoxin/teal, Sterility-PCR/rose)
  - Row-level status tinting in the analyses table (colored left border + subtle background per state)
  - New table columns: Retested indicator and Result Captured date
  - Integrated progress bar showing verified/pending analysis completion percentage
  - Collapsible sections with proper accessibility (`aria-expanded`, `aria-controls`)
  - Remarks rendered as sanitized HTML via DOMPurify (supports links, bold, italic)
- **Deep-linkable sample details** — hash navigation now supports query parameters (`#dashboard/sample-details?id=PB-0056`) for direct links to specific samples
- **Richer SENAITE analysis data** — backend returns `sort_key`, `captured` date, `retested` flag, and resolves selection-type results through SENAITE's ResultOptions mapping

### Fixed

- **SENAITE link follows active environment** — "Open in SENAITE" link now dynamically resolves based on the active API environment profile (local Docker vs production) instead of being fixed at build time
- **Docker env file separation** — `.env.docker` now targets local testing (SENAITE at localhost:8080); production builds use `--build-arg ENV_FILE=.env.docker.prod`
- **Sample ID normalization** — backend uppercases and trims sample IDs before SENAITE lookup

### Infrastructure

- Dockerfile accepts `ENV_FILE` build arg for switching between local and production env files
- docker-compose.yml passes `ENV_FILE` arg (defaults to `.env.docker`)

## v0.12.0 — 2026-02-21

### Added

- **Receive Sample wizard** — new 2-step intake workflow (Samples → Sample Details) for receiving samples from SENAITE
  - Step 1: Browse due samples with sortable table, search, and selection
  - Step 2: Dense single-card layout showing all SENAITE sample details, analytes, and collapsible COA information
  - **Photo capture** with live camera preview, guide overlay, auto-enhance (levels, contrast, white balance), and device selection
  - **Check-In to SENAITE** — uploads sample image, adds operator remarks, and transitions sample to "received" state in one click
  - "Check In Another Sample" button after successful receive to quickly process the next sample
- **`POST /wizard/senaite/receive-sample`** backend endpoint — performs image upload, remarks update, and workflow transition with CSRF handling and post-transition verification
- **SENAITE Dashboard** — embedded SENAITE view accessible from AccuMark Tools sidebar
- **Software Updates** section in Preferences — check for updates, download, and relaunch from within the app
- **Sidebar nav item** for Intake section with Receive Sample entry
- **Hash-based navigation** utility for SENAITE dashboard routing

### Changed

- **Docker Compose** — backend port now exposed directly (`ports` instead of `expose`) for easier local development
- **Tauri window lifecycle** — main window close now exits the full process (prevents hidden quick-pane window from keeping app alive)

### Fixed

- **SENAITE UID lookup** — backend now uses uppercase `UID` query parameter (SENAITE silently ignores lowercase `uid`, returning wrong sample)
- **SENAITE attachment upload** — `Analysis` form field set to `""` instead of literal "Attach to Sample" text (which caused 500 APIError)
- **CSRF token freshness** — always re-fetches CSRF token before workflow transition to prevent stale-token failures
- **Workflow state guard** — skip transition for samples already past `sample_due` state instead of failing

## v0.11.0 — 2026-02-19

## v0.10.0 — 2026-02-13

### Added

- **In Progress tab** in Order Explorer — shows samples awaiting COA publication with sample name, identity, lot code, SENAITE ID, and delivery/COA status
- **COA Explorer** — new standalone view for browsing COA generations across all orders, accessible from the sidebar
- **`sample_results` field** now returned from backend explorer orders endpoint, fixing the always-empty "Sample IDs" column in the orders table
- **`navigateToOrderExplorer()`** store action for cross-section navigation to Order Explorer
- **Integration Service network** added to Docker Compose for backend-to-Integration Service connectivity
- **`INTEGRATION_SERVICE_URL`** env var for proxying explorer requests
- **Per-peptide resync button** in Peptides list — re-imports a single peptide's calibration files from SharePoint without running a full import
- **`GET /hplc/peptides/{id}/resync/stream`** backend SSE endpoint for single-peptide resync

### Changed

- **Reference RT** now always updates from the active curve's retention times when switching curves via Set Active, full import, or single-peptide resync

- **Ingestions tab renamed** to "COAs Published" across all UI text (tab, loading, error, and empty states)
- **Order Explorer subtitle** updated from "Browse orders and ingestions" to "Browse orders and COAs"
- **AccuMark Tools** section refactored to route between Order Explorer and COA Explorer sub-sections

### Fixed

- **Sample IDs column** in orders table now shows SENAITE IDs (was always empty because `sample_results` wasn't queried from the database)
- **Set Active button** in Calibration Panel was silently failing due to wrong auth token localStorage key

## v0.9.0 — 2026-02-11

Calibration accuracy fixes, SharePoint reliability, analysis UX.

## v0.8.0 — 2026-02-05

Dashboard, Peptide Config UI overhaul, SharePoint improvements.

## v0.7.0

Docker deployment + production hosting.

## v0.6.0

JWT user authentication system.

## v0.5.0

HPLC peptide analysis pipeline.
