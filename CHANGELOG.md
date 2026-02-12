# Changelog

## [0.9.0] - 2026-02-11

### Fixed

- **Calibration extraction from Excel** — Fixed header detection for files using "Target (ug/mL)" / "Actual (ug/mL)" column headers. Old code failed to match these headers, fell through to a fixed-layout fallback, and extracted wrong columns (e.g., "Total uL" instead of "Peak Area"), producing garbage calibration curves (R²=0.77 instead of 0.9999). Quantity calculations now match lab COA figures.
- **Prefer "Actual" over "Target" concentrations** — When both columns exist in calibration data, the extractor now correctly uses the actual measured concentrations rather than nominal targets
- **Weight extraction from Excel** — Extended scan range from 40 to 70 rows and added a header-label scan strategy for files with weights in non-standard positions (rows 55-60). Handles layouts where weight headers like "Weight Vial and cap (mg)" appear above data rows.
- **SharePoint token expiry (401 errors)** — Added `_invalidate_token()` and auto-retry with token refresh on all Graph API calls (`_get_site_id`, `_get_drive_id`, `_list_folder_at_root`, `download_file`, `download_file_by_path`). No more "Invalid or expired token" errors after leaving the app idle.
- **SharePoint import re-downloading files** — Added `SharePointFileCache` table to track all downloaded files regardless of whether they produced a calibration curve. Previously only files that yielded a `CalibrationCurve` record were tracked, causing files without standard data to be re-downloaded every import run.
- **Identity card empty for peptides without reference RT** — Analysis endpoint now falls back to deriving reference RT from the active calibration curve's standard data RTs when the peptide has no explicit `reference_rt` configured

### Added

- **Peptide navigation from Analysis Results** — Clickable peptide abbreviation in the analysis summary line navigates to Peptide Config with the flyout auto-opened for that peptide. Identity card shows an amber "Configure" link when no reference RT is set.
- **`peptide_id` in analysis response** — Enables cross-linking between analysis results and peptide configuration UI

### Changed

- `backend/models.py`: Added `SharePointFileCache` model
- `src/store/ui-store.ts`: Added `peptideConfigTargetId` state and `navigateToPeptide` action
- `src/components/hplc/PeptideConfig.tsx`: Consumes `peptideConfigTargetId` to auto-open flyout
- `src/lib/api.ts`: Added `peptide_id` to `HPLCAnalysisResult` interface

## [0.8.0] - 2026-02-10

### Added

- **Dashboard** — New default landing page with system overview
  - KPI cards: Total Peptides, Missing Curves, Orders Today, Outstanding Orders
  - Peptides Without Curves panel — lists peptides needing calibration data with quick-nav to Peptide Config
  - Orders bar chart (Recharts) — last 14 days with today highlighted in blue
  - Outstanding Orders table — pending/processing/failed orders with Order ID, Order #, Email, Status, Samples, Created, and Age columns
  - Test email filtering — orders from internal test accounts are excluded from all dashboard stats and charts
  - Quick-nav links to Peptide Config and Order Explorer from each panel

- **Peptide Config UI Overhaul** — Full-width table with slide-out sidebar
  - Replaced 2-column grid layout with full-width peptide table
  - Slide-out sidebar overlay from the right when clicking a peptide row (smooth animation, blurred backdrop, X close)
  - Filter dropdown (All / Has Calibration / No Calibration)
  - Curve Date column showing active calibration's file date
  - Yellow "No Curve" badges for peptides without calibration
  - Incremental commits during import with real-time SSE refresh of the peptide list

- **SharePoint Integration Improvements**
  - Direct Excel Online links: `webUrl` captured from Graph API and stored on CalibrationCurve records
  - New `sharepoint_url` database column with migration
  - Retry-with-backoff for file downloads (handles 503/429 errors, up to 3 retries with exponential backoff)
  - Fallback URL construction for legacy records imported before `webUrl` capture

### Changed

- Default landing page changed from Lab Operations → Dashboard
- Removed "Sample Intake" from sidebar navigation (deprecated by Dashboard)
- Version footer updated to show current version (0.8.0)
- Tauri app version synced to 0.8.0

### New Files

- `src/components/Dashboard.tsx` — Dashboard component with KPI cards, order chart, and outstanding orders table

## [0.7.0] - 2026-02-10

### Added

- **Docker Deployment** — Full containerization for production hosting
  - Multi-stage `Dockerfile` for frontend (Node 20 build → Nginx Alpine serve)
  - Backend `Dockerfile` (Python 3.12 slim + Uvicorn)
  - `docker-compose.yml` orchestrating frontend + backend with named volume for SQLite persistence
  - Nginx config with SPA fallback, `/api/` reverse proxy to backend, gzip, and asset caching
  - `.env.docker` / `.env.docker.prod` for Docker-specific Vite build vars (`VITE_API_URL=/api`)
  - `.dockerignore` files for both frontend and backend

- **Production Deployment** — Live at `https://accumk1.valenceanalytical.com`
  - Hosted on DigitalOcean droplet (`165.227.241.81`) alongside SENAITE
  - Nginx reverse proxy with Let's Encrypt SSL (auto-renewing)
  - Deploy script (`scripts/deploy.sh`) with rsync, Docker build, health checks, and cleanup
  - Supports `--dry-run`, `--frontend`, `--backend` flags

- **Favicon** — Custom microscope SVG icon matching the app's sidebar nav icon

### Changed

- Explorer API endpoints now use JWT Bearer auth (`get_current_user`) instead of `X-API-Key` header
- CORS origins updated to include Docker local test (`localhost:3100`) and production domain
- API configuration refactored to use Vite environment variables (`VITE_API_URL`, `VITE_WORDPRESS_URL`)
- `SettingsComponents.tsx` label prop widened from `string` to `ReactNode`
- Fixed `WORDPRESS_PROD_HOST` from Kinsta staging URL to `accumarklabs.com`

### New Files

- `Dockerfile` — Frontend multi-stage build
- `backend/Dockerfile` — Backend container
- `docker-compose.yml` — Service orchestration
- `nginx.conf` — Frontend Nginx config (SPA + API proxy)
- `.dockerignore`, `backend/.dockerignore` — Build context filters
- `.env.docker`, `.env.docker.prod` — Docker build environment variables
- `.env.development`, `.env.production` — Vite environment configs
- `public/favicon.svg` — Microscope favicon
- `scripts/deploy.sh` — Production deploy automation
- `backend/.env.example` — Updated with all required env vars

## [0.6.0] - 2026-02-09

### Added

- **User Authentication** — JWT-based login with bcrypt password hashing
  - Login page with email/password form and auth gate (unauthenticated users see login page)
  - Zustand auth store with localStorage persistence (survives refresh and app restart)
  - Bearer token authorization on all API endpoints (except `/health`, `/auth/login`)
  - Two roles: standard and admin, with backend enforcement (403 for unauthorized)
  - First admin auto-seeded on startup with random password logged to console

- **Admin User Management** — Full CRUD for user accounts
  - Create new users with email, password, and role selection
  - View all users with role badges and active status
  - Deactivate/reactivate user accounts
  - Reset user passwords (temporary password displayed once)

- **Account Section** — User self-service
  - Change password form (requires current password verification)
  - User email display in sidebar
  - Sign out button

- **Dark Mode Autofill Fix** — CSS overrides for password manager compatibility in dark theme

### Changed

- All ~30 existing API endpoints now require JWT Bearer authentication
- Backend default port moved from 8009 to 8012 (avoid conflicts with other services)
- CSP connect-src updated to allow ports 8011 and 8012
- Replaced passlib with direct bcrypt library (passlib incompatible with bcrypt>=4.1)

### New Dependencies

- `bcrypt>=4.0.0` — password hashing
- `python-jose[cryptography]>=3.3.0` — JWT token creation and validation
- `python-multipart>=0.0.9` — form data parsing for login endpoint

### New Files

- `backend/auth.py` — Auth module (JWT utilities, password hashing, Pydantic schemas, FastAPI dependencies)
- `src/components/auth/LoginPage.tsx` — Login form component
- `src/components/auth/UserManagement.tsx` — Admin user management table with CRUD actions
- `src/components/auth/ChangePassword.tsx` — Password change form
- `src/lib/auth-api.ts` — Auth API client functions (login, logout, CRUD, password reset)
- `src/store/auth-store.ts` — Zustand auth state with token/user persistence

## [0.5.0] - 2026-02-09

### Added

- **HPLC Analysis Pipeline** - Full purity, quantity, and identity analysis from Agilent HPLC output files
  - PeakData CSV parser supporting both plain PeakData and Report CSV formats
  - Purity calculation: averaged main peak Area% across injections (excluding solvent front)
  - Quantity calculation: calibration curve regression, dilution factor from 5 balance weights, final mass in mg
  - Identity check: retention time comparison against reference RT within configurable tolerance
  - Full calculation trace with step-by-step audit trail

- **Peptide Configuration** - Manage peptides and calibration curves
  - CRUD for peptides (name, abbreviation, reference RT, RT tolerance, diluent density)
  - Calibration curve management with linear regression (slope, intercept, R-squared)
  - Upload calibration from Excel or enter manually
  - Calibration scatter chart with regression line (recharts)
  - Seed script to bulk-import peptides and calibration data from lab Excel workbooks

- **New Analysis Workflow** - Multi-step guided analysis flow
  - Drag-and-drop folder support with recursive file scanning and progress bar
  - Auto-detection of sample ID from folder/file names (P-XXXX pattern)
  - Auto-extraction of balance weights from lab Excel workbooks
  - Auto-selection of peptide based on which peptide folder the sample was found in
  - Chromatogram visualization with LTTB downsampling (~30k points to 1.5k) and multi-trace overlay
  - Peak data tables with main peak highlighting and solvent front de-emphasis
  - Live-calculated dilution factor and stock volume from weight inputs
  - Result cards for Purity (%), Quantity (mg), and Identity (CONFORMS/DOES NOT CONFORM)

- **Calculation Visuals** - Interactive charts in the calculation trace
  - Purity bar chart with average reference line and RSD
  - Quantity scatter plot showing sample on calibration curve with step-by-step formula
  - Identity RT band visual with tolerance zone and sample marker
  - Dilution breakdown table with vial masses and volumes

- **Analysis History** - Browse and search past analyses
  - Searchable table with sample ID, peptide, purity, quantity, identity, date
  - Detail view reusing the full results display

- **Chromatogram Chart** - DAD1A signal visualization
  - Parses Agilent `.dx_DAD1A.CSV` chromatogram files client-side
  - LTTB (Largest Triangle Three Buckets) downsampling preserves peak shapes
  - Multiple injection traces overlaid with distinct colors
  - Optional peak RT reference lines
  - Displayed in both parse preview (Step 1) and final results (Step 3)

### Changed

- Sidebar navigation updated with HPLC Analysis section and sub-items
- `api.ts` extended with ~15 new types and ~10 new API functions
- UI store updated with `hplc-analysis` section and subsection routing

## [0.4.1] - 2026-02-08

- Chromatograph viewer improvements
- Sidebar navigation migration to shadcn

## [0.4.0] - 2026-02-07

- AccuMark Tools section
- API key and server selector in settings
- Chromatograph visualizer tool
