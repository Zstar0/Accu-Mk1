# Codebase Concerns

**Analysis Date:** 2026-02-09

## Tech Debt

**Bare catch blocks swallowing errors:**
- Issue: Multiple API functions use `catch {}` without logging, preventing error visibility during development
- Files: `src/lib/api.ts` (lines 61, 71)
- Impact: Silent failures in health check logic make debugging difficult; fallback behavior may execute without clear indication
- Fix approach: Add console logging or proper error tracking to catch blocks. Consider using error boundary patterns or error reporting service

**API fetch calls lack timeout and retry logic:**
- Issue: All fetch() calls in `src/lib/api.ts` have no timeout, no retry mechanism, and no AbortController for cancellation
- Files: `src/lib/api.ts` (50+ fetch calls throughout)
- Impact: Long-hanging requests can block UI indefinitely; network failures provide poor UX with no recovery mechanism
- Fix approach: Implement fetch wrapper with configurable timeout (5-10s), exponential backoff retry (max 3 attempts), and AbortController integration

**API key stored in localStorage:**
- Issue: API keys stored in plain localStorage without encryption
- Files: `src/lib/api-key.ts` (line 28), `src/lib/api-profiles.ts` (lines 97-99)
- Impact: API keys exposed to XSS attacks; compromised browser = compromised credentials
- Fix approach: Use Tauri's secure storage plugin (tauri-plugin-keychain) or mark keys with httpOnly restrictions if moving to server-side

**Windows path separator bugs in API endpoints:**
- Issue: API endpoints use backslashes `\` instead of forward slashes `/` on watcher endpoints
- Files: `src/lib/api.ts` (lines 657, 674: `${API_BASE_URL()}\watcher\start` should be `/watcher/start`)
- Impact: Windows-style paths will break the API requests on all platforms, causing file watcher to fail
- Fix approach: Replace all backslashes with forward slashes in endpoint URLs

**Insufficient data validation in batch import:**
- Issue: File preview parsing in `src/components/FileSelector.tsx` is overly permissive; assumes tab-delimited format without validation
- Files: `src/components/FileSelector.tsx` (lines 98-116)
- Impact: Malformed files silently parse incorrectly; no feedback on parsing errors; backend may reject data after preview showed success
- Fix approach: Add schema validation, detailed error reporting for unparseable lines, and sync validation between frontend and backend

## Known Bugs

**Health check fallthrough returns generic error:**
- Symptoms: When both `/health` and `/v1/health` fail, error message doesn't indicate which endpoints were tried
- Files: `src/lib/api.ts` (line 75)
- Trigger: Backend offline or misconfigured on both endpoints
- Workaround: Check backend logs directly; unclear which endpoint failed

**API profile migration loses data on malformed JSON:**
- Symptoms: If stored API profiles JSON is corrupted, app falls back to defaults without warning user
- Files: `src/lib/api-profiles.ts` (lines 87-91)
- Trigger: Manual localStorage edit or file corruption
- Workaround: None; users must manually clear localStorage

**Column mapping JSON parsing silently fails:**
- Symptoms: Invalid column_mappings JSON uses default values without error notification
- Files: `src/components/preferences/panes/DataPipelinePane.tsx` (lines 56-61)
- Trigger: Manual database edit or corrupted setting
- Workaround: Reset preferences through UI

## Security Considerations

**API key transmitted in plain headers without HTTPS validation:**
- Risk: API keys in `X-API-Key` headers over HTTP (development) are exposed to MITM attacks
- Files: `src/lib/api.ts` (lines 706-712)
- Current mitigation: HTTPS enforced on production API URLs; development uses HTTP intentionally
- Recommendations:
  - Add HTTPS enforcement checks in production builds
  - Document that HTTP is dev-only
  - Consider adding request signing if API key alone is insufficient

**No CSRF protection on state-changing requests:**
- Risk: Settings updates, sample approvals, batch imports have no CSRF tokens
- Files: `src/lib/api.ts` (all POST/PUT requests lack CSRF tokens)
- Current mitigation: Tauri runs as desktop app (same-origin policy enforced by OS), not web app
- Recommendations: Document this assumption; if web version is planned, add CSRF token support

**Error responses may leak sensitive data:**
- Risk: API error messages in rejections include details that could expose system architecture
- Files: `src/lib/api.ts` (lines 659-660, 800-803, 831-834, 866-868)
- Current mitigation: Only seen in development; production URLs not exposed
- Recommendations: Sanitize error messages before displaying to user; log full details server-side only

**Crash recovery saves to plaintext files:**
- Risk: Crash state may contain user input, URLs, or sensitive data saved to unencrypted recovery files
- Files: `src/lib/recovery.ts` (lines 175-178)
- Current mitigation: Recovery files stored in app data directory with OS-level permissions
- Recommendations: Encrypt recovery files; add option to exclude sensitive data; implement retention policy

## Performance Bottlenecks

**Large table renders without virtualization:**
- Problem: OrderExplorer and data tables render all rows at once; causes jank with 100+ rows
- Files: `src/components/OrderExplorer.tsx` (uses DataTable without virtualization), `src/components/ui/data-table.tsx`
- Cause: TanStack Table renders all rows to DOM; no pagination or lazy loading
- Improvement path: Implement TanStack Table's pagination feature or virtualizer for large datasets; consider server-side pagination

**No query request deduplication:**
- Problem: Multiple components may trigger identical API queries simultaneously, wasting bandwidth
- Files: All components using TanStack Query without proper dependency/stale time configuration
- Cause: Query staleTime not configured; independent query instances created
- Improvement path: Set global staleTime in QueryClientConfig; use query key strategies to reuse requests

**Unoptimized file preview parsing:**
- Problem: Large HPLC export files (1000+ rows) freeze UI during local parsing
- Files: `src/components/FileSelector.tsx` (lines 101-117 parses all rows synchronously)
- Cause: Synchronous JSON parsing and DOM updates for all data at once
- Improvement path: Stream-parse large files; use Web Worker for parsing; lazy-render table with virtualization

**Sidebar component complexity:**
- Problem: AppSidebar renders extensive sub-navigation without code-splitting
- Files: `src/components/layout/AppSidebar.tsx` (166 lines)
- Cause: All sections loaded eagerly regardless of active tab
- Improvement path: Lazy load sidebar panes; move preferences into separate bundle

## Fragile Areas

**Error boundary recovery limited:**
- Files: `src/components/ErrorBoundary.tsx`
- Why fragile: Only catches React render errors, not async errors or API failures; "Try Again" button doesn't clear error state reliably
- Safe modification: Add AbortController to active requests before reset; test async error scenarios
- Test coverage: Only has basic rendering test; missing async error scenarios

**API profile state management lacks conflict resolution:**
- Files: `src/lib/api-profiles.ts`
- Why fragile: No merge strategy if user modifies profiles from multiple windows or manual localStorage edit
- Safe modification: Add version numbers to profiles; detect conflicts on load
- Test coverage: Only basic profile CRUD tested; missing concurrent modification scenarios

**Data pipeline settings hardcoded to backend sync:**
- Files: `src/components/preferences/panes/DataPipelinePane.tsx`
- Why fragile: Column mappings must match backend schema exactly; no validation or schema versioning
- Safe modification: Add schema validation before save; fetch schema from backend on load
- Test coverage: No integration tests with actual backend; missing validation error scenarios

**Crash recovery file cleanup may race:**
- Files: `src/lib/recovery.ts` (lines 128-149)
- Why fragile: Cleanup runs on app startup; concurrent app instances may delete files needed by others
- Safe modification: Add file locking mechanism; check if file is in-use before deleting
- Test coverage: No testing of concurrent app scenarios; edge case with multiple windows

**Batch import state not persisted:**
- Files: `src/components/FileSelector.tsx`
- Why fragile: If user selects files then closes window, files are lost; no resume capability
- Safe modification: Save file list to recovery before import; allow resuming partial imports
- Test coverage: No persistence testing; missing resume scenarios

## Scaling Limits

**LocalStorage capacity for API profiles:**
- Current capacity: ~5MB per domain in browsers; ~100 profiles × 500 bytes = 50KB used
- Limit: Scales linearly; at 10K profiles would hit 5MB limit
- Scaling path: Move to Tauri's file-based settings or SQLite for unlimited profile storage

**In-memory query cache grows unbounded:**
- Current capacity: TanStack Query caches all requests; with active polling may consume significant RAM
- Limit: Unknown staleTime/cacheTime means queries never auto-cleanup; long sessions accumulate memory
- Scaling path: Configure queryClient with maxSize, staleTime: 5min, cacheTime: 10min; implement query cleanup on low memory

**API requests not throttled:**
- Current capacity: No rate limiting on health checks, settings fetches, or explorer queries
- Limit: Rapid clicks can send 10+ requests/second to backend; DOS potential
- Scaling path: Add request debouncing/throttling; implement per-endpoint rate limits in client

**File upload size not validated client-side:**
- Current capacity: File preview reads entire file into memory with `file.text()`
- Limit: Large files (100MB+) will freeze UI during read
- Scaling path: Add file size validation before reading; stream large files in chunks; use FormData with chunked upload

## Dependencies at Risk

**No explicit version constraints on TanStack Query:**
- Risk: Major version bumps may change API behavior; no lockfile enforcement
- Impact: `npm install` on new machine may pull incompatible version
- Migration plan: Ensure package-lock.json is committed; use `npm ci` instead of `npm install`; test on version bumps

**Tauri plugin updates may break API:**
- Risk: tauri-specta generated bindings auto-update but may be incompatible with Rust backend
- Impact: Frontend calls Rust commands with wrong signatures after backend update
- Migration plan: Version-gate bindings; regenerate and test after each Tauri plugin update

**i18n translations incomplete:**
- Risk: Missing translation keys fall back to key name instead of English
- Impact: Untranslated keys visible in UI
- Migration plan: Add linting to detect missing keys in all locales; enforce translation completion before release

## Missing Critical Features

**No offline mode:**
- Problem: All features require active API connection; file watcher requires backend running
- Blocks: Work cannot continue if network is down
- Recommendation: Implement local-first architecture with sync queue; cache query results for offline read access

**No undo/redo for data operations:**
- Problem: Sample approvals, rejections, and calculations are permanent without recovery
- Blocks: User mistakes are costly; no audit trail for compliance
- Recommendation: Implement optimistic updates with mutation undo stack; add soft-delete for audit trail

**No role-based access control:**
- Problem: All authenticated users have access to all functions
- Blocks: Cannot restrict sample approval to specific roles
- Recommendation: Add permission checks in API; implement role-based UI in preferences for self-service

## Test Coverage Gaps

**API functions untested:**
- What's not tested: Error cases in fetch calls; retry logic absent; timeout behavior
- Files: `src/lib/api.ts` (902 lines, 0 tests directly testing it)
- Risk: Silent API failures; integration with backend assumptions may be wrong
- Priority: High - Core business logic depends on reliable API communication

**UI components lack integration tests:**
- What's not tested: FileSelector with real file data; OrderExplorer with explorer API; OrderExplorer filter/sort
- Files: `src/components/OrderExplorer.tsx`, `src/components/FileSelector.tsx`, `src/components/BatchReview.tsx`
- Risk: Regressions in core workflows go undetected; user data operations not validated
- Priority: High - User-facing critical workflows

**State management edge cases:**
- What's not tested: Concurrent profile changes; corrupted localStorage recovery; multiple window sync
- Files: `src/store/ui-store.ts`, `src/lib/api-profiles.ts`
- Risk: Data loss or inconsistency in edge cases; user frustration with state out-of-sync
- Priority: Medium - Affects reliability under unusual scenarios

**Error boundary error recovery:**
- What's not tested: Async errors; multiple sequential errors; recovery state persistence
- Files: `src/components/ErrorBoundary.tsx`
- Risk: Users stuck on error screen after first error
- Priority: Medium - Affects user experience during failures

**Keyboard shortcut conflicts:**
- What's not tested: Shortcut collisions across platform; custom shortcuts with special keys
- Files: `src/components/preferences/ShortcutPicker.tsx`, `src/hooks/use-keyboard-shortcuts.ts`
- Risk: Shortcuts silently fail to register if conflicting
- Priority: Low - Advanced feature; requires testing on all platforms

---

*Concerns audit: 2026-02-09*
