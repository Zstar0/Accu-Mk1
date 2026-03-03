# Changelog

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
