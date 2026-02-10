# External Integrations

**Analysis Date:** 2026-02-09

## APIs & External Services

**FastAPI Backend:**
- Backend service for data processing and calculations
- Base URL configured via API profiles system: `http://127.0.0.1:8009` (local), `https://api.accumarklabs.com` (production)
- Client: Fetch API with custom error handling
- Located: `src/lib/api.ts`

**Integration Service Database:**
- External WordPress/WooCommerce integration database
- Used for orders and ingestion tracking
- Accessible via endpoints under `/explorer/*`
- SDK/Client: Fetch API with API Key authentication
- Auth method: `X-API-Key` header (custom header-based authentication)
- Environment switching: Local vs Production database environments

## Data Storage

**Databases:**
- Integration Service Database - External MySQL/PostgreSQL database
  - Connection: Via API Gateway at `${API_BASE_URL}/explorer/*`
  - Auth: API key-based (stored in localStorage)
  - Purpose: Order data, ingestion tracking, WordPress integration
  - ORM/Client: Direct HTTP API calls (RESTful)

**Local Storage:**
- Browser localStorage
  - Purpose: Preferences, API profiles, API key storage
  - Keys: `accu_mk1_api_key`, `accu_mk1_api_profiles`
  - Client: Native localStorage API

**File System:**
- Local filesystem access via Tauri
  - Purpose: User preferences file (`preferences.json`)
  - Location: App data directory (platform-specific, managed by Tauri)
  - Client: `@tauri-apps/plugin-fs`
  - User home directory access for file selection/import

**Caching:**
- TanStack Query (React Query) - In-memory caching
  - Stale time: 5 minutes
  - Cache retention: 10 minutes
  - Retry policy: 1 retry on failure
  - Config: `src/lib/query-client.ts`

## Authentication & Identity

**Auth Provider:**
- Custom API Key-based authentication
- Implementation: API key stored in localStorage, passed via `X-API-Key` header
- Key format validation: Starts with `ak_`, minimum 10 characters
- Profile system: Multiple API key + server URL combinations can be saved
- Profiles: Local development (default) and production profiles
- Key storage: `src/lib/api-key.ts` (deprecated), `src/lib/api-profiles.ts` (current)
- Event listener: Custom event `accu-mk1-api-profile-changed` for reactive updates

## Monitoring & Observability

**Error Tracking:**
- None detected - errors handled locally with console.error() logging

**Logs:**
- Tauri plugin-log v2.7.1 for system logging
- Local console logging for development
- Log output location: Platform-dependent (managed by Tauri)

## CI/CD & Deployment

**Hosting:**
- Cross-platform desktop application (Windows, macOS, Linux) via Tauri v2
- Updater: @tauri-apps/plugin-updater v2.9.0 for automatic updates

**CI Pipeline:**
- None detected - no CI configuration files found
- Manual builds via npm scripts

**Build Targets:**
- Development: `npm run tauri:dev`
- Production: `npm run tauri:build`
- Type checking: `npm run typecheck`
- Linting: `npm run lint`

## Environment Configuration

**Required Environment Variables:**
- `TAURI_DEV_HOST` - Dev server hostname (optional, for remote dev)
- None critical for runtime (API configuration via UI instead of env vars)

**Configuration Storage:**
- API profiles stored in localStorage: `accu_mk1_api_profiles`
- Preferences stored in: `{APP_DATA_DIR}/preferences.json`
  - Theme preference
  - Quick pane keyboard shortcut
  - Custom application preferences
- No .env files in use - configuration via UI

**API Configuration:**
- Active profile system with pre-configured environments:
  - Local: `http://127.0.0.1:8009`
  - Production: `https://api.accumarklabs.com`
- WordPress URL per profile: `https://accumarklabs.local` (dev), `https://accumarklabs.com` (prod)

## API Endpoints (Backend Integration)

**Health & Status:**
- `GET /health` - Health check (local backend)
- `GET /v1/health` - Health check (Integration Service)

**Audit Logging:**
- `POST /audit` - Create audit log entry
- `GET /audit?limit={n}` - Get recent audit logs

**Settings Management:**
- `GET /settings` - Get all settings
- `GET /settings/{key}` - Get single setting
- `PUT /settings/{key}` - Create/update setting

**Import Operations:**
- `POST /import/file?file_path={path}` - Preview single file parse
- `POST /import/batch` - Import multiple files from filesystem
- `POST /import/batch-data` - Import pre-parsed file data from browser

**Jobs & Samples:**
- `GET /jobs?limit={n}` - Get recent jobs
- `GET /jobs/{jobId}` - Get job details
- `GET /jobs/{jobId}/samples` - Get samples for job
- `GET /jobs/{jobId}/samples-with-results` - Get samples with flattened calculation results
- `GET /samples?limit={n}` - Get recent samples
- `GET /samples/{sampleId}` - Get sample details
- `PUT /samples/{sampleId}/approve` - Approve sample
- `PUT /samples/{sampleId}/reject` - Reject sample with reason
- `GET /samples/{sampleId}/results` - Get calculation results for sample

**Calculations:**
- `POST /calculate/{sampleId}` - Run all applicable calculations
- `GET /calculations/types` - Get available calculation types
- `POST /calculate/preview` - Preview calculation without saving

**File Watcher:**
- `GET /watcher/status` - Get file watcher status
- `POST /watcher/start` - Start watching report directory
- `POST /watcher/stop` - Stop file watcher
- `GET /watcher/files` - Get and clear detected files

**Explorer (Integration Service Database):**
- `GET /explorer/status` - Check connection to external database (requires API key)
- `GET /explorer/environments` - List available database environments
- `POST /explorer/environments` - Switch environment
- `GET /explorer/orders?search={term}&limit={n}&offset={n}` - Query orders (requires API key)
- `GET /explorer/orders/{orderId}/ingestions` - Get ingestions for order (requires API key)

## Webhooks & Callbacks

**Incoming:**
- None detected - app polls backend for data

**Outgoing:**
- None detected - unidirectional API consumption

## Event System

**Tauri Event Emitter:**
- React components listen for events via `@tauri-apps/api/event`
- Custom events dispatched from React to notify across windows
- Event: `accu-mk1-api-profile-changed` - Fired when API profile/key changes
- Event: `accu-mk1-api-key-changed` (deprecated) - Legacy API key change event

## Data Flow

**Backend Communication:**
1. React components call functions from `src/lib/api.ts`
2. Fetch API makes HTTP requests to FastAPI backend at configured URL
3. Active API profile (server URL + API key) used for all requests
4. Response data cached in TanStack Query
5. State updates via React hooks trigger re-renders

**Settings Persistence:**
1. Preferences loaded from app data directory on startup (Rust)
2. Changes saved via Tauri commands
3. API profiles loaded from localStorage on app start
4. Profile changes trigger custom events for reactive updates

**File Operations:**
1. File selection via Tauri dialog plugin
2. File paths sent to backend for processing
3. Preview data returned to frontend
4. User confirms import, batch operation created

---

*Integration audit: 2026-02-09*
