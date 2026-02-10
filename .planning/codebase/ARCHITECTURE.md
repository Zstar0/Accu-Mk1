# Architecture

**Analysis Date:** 2026-02-09

## Pattern Overview

**Overall:** Tauri Desktop App with React Frontend + FastAPI Backend Integration

The application follows a three-tier architecture:
1. **Tauri Desktop Shell** - Window management, file system access, native integrations
2. **React UI Layer** - Component-driven UI with TypeScript and shadcn/ui design system
3. **External Services** - FastAPI backend for business logic, Integration Service for third-party data

**Key Characteristics:**
- Type-safe command system (tauri-specta) for Rust-React communication
- State management via Zustand (UI state) and TanStack Query (data caching)
- Desktop-first patterns (no window focus refetch, offline-ready)
- Multi-window support (main window + quick-pane window)
- Event-driven communication between Rust and React layers

## Layers

**Presentation Layer (React Components):**
- Purpose: Render UI, handle user interactions, manage component state
- Location: `src/components/`
- Contains: React functional components, shadcn/ui primitives, domain-specific components
- Depends on: Hooks, stores, API client, i18n
- Used by: Application shell (App.tsx → MainWindow)

**State Management Layer:**
- Purpose: Manage application state across components
- Location: `src/store/` (Zustand stores) and TanStack Query context
- Contains: `useUIStore` for navigation/UI state, `queryClient` for data queries
- Depends on: Nothing
- Used by: Components (via custom hooks)

**Services & Integration Layer:**
- Purpose: Handle external communications (FastAPI backend, Integration Service)
- Location: `src/lib/api.ts`, `src/lib/api-profiles.ts`, `src/services/`
- Contains: API client functions, health checks, authentication profiles
- Depends on: Config, logger
- Used by: Components, TanStack Query mutations

**Tauri Interop Layer:**
- Purpose: Type-safe bridge between React and Rust
- Location: `src/lib/tauri-bindings.ts` (re-exports generated bindings), `src/lib/commands/`
- Contains: Command registry, navigation commands, window commands, notifications
- Depends on: Tauri API
- Used by: App initialization, event handlers, preferences

**Utilities & Infrastructure:**
- Purpose: Logging, theming, i18n, configuration
- Location: `src/lib/` (utilities), `src/i18n/`, `src/hooks/`
- Contains: Logger, theme context, language initialization, custom hooks
- Depends on: External packages (tauri, i18next)
- Used by: All layers

## Data Flow

**File Import Workflow:**

1. User selects files in `FileSelector` component
2. Component calls `previewFile()` from `src/lib/api.ts`
3. Backend parses and returns `ParsePreview` data
4. Component displays preview in `PreviewTable`
5. User confirms import, component calls `importBatch()` or `importBatchData()`
6. Backend creates Job and Sample records, returns `ImportResult`
7. Component stores job_id in state, displays results
8. User reviews batch via `BatchReview` component
9. Component calls `approveSample()` or `rejectSample()` for each sample
10. `calculateSample()` runs backend calculations when sample is approved

**Navigation State Flow:**

1. User clicks sidebar item in `AppSidebar`
2. Calls `navigateTo()` action on `useUIStore`
3. Zustand updates `activeSection` and `activeSubSection`
4. `MainWindowContent` selector re-renders with new section
5. Content component renders based on `activeSection` switch statement

**Backend Connection Flow:**

1. `MainWindow` initializes on mount
2. Checks API key configuration via `hasApiKey()`
3. Calls `healthCheck()` to verify backend connectivity
4. Polls every 5 seconds if disconnected (interval cleanup on connect)
5. Listens for profile changes via `API_PROFILE_CHANGED_EVENT` custom event
6. Updates status display and content availability based on state

**State Management:**

- **Component Local State:** Form values, loading states, UI toggles (via useState)
- **Global UI State:** Sidebar visibility, active section, preferences modal (via Zustand `useUIStore`)
- **Data Caching:** API responses cached by TanStack Query (queryClient with 5-minute stale time)
- **Persistence:** Preferences saved to Tauri storage, API profiles in memory with event-based updates

## Key Abstractions

**Command System:**
- Purpose: Centralized registration and execution of app-wide commands
- Examples: `src/lib/commands/registry.ts`, `src/lib/commands/navigation-commands.ts`, `src/lib/commands/window-commands.ts`
- Pattern: Commands map keyboard shortcuts → actions; registered at app startup via `initializeCommandSystem()`

**API Client:**
- Purpose: Encapsulate HTTP communication with backend services
- Examples: `src/lib/api.ts` (FastAPI backend), `src/lib/api-key.ts`, `src/lib/api-profiles.ts`
- Pattern: Named export functions for each endpoint, centralized error handling, auth header injection

**Tauri Bindings Wrapper:**
- Purpose: Type-safe access to Rust commands with Result unwrapping
- Examples: `src/lib/tauri-bindings.ts` re-exports generated `src/lib/bindings.ts`
- Pattern: `commands.loadPreferences()` returns `{ status: 'ok'; data }` or `{ status: 'error'; error }`, unwrapResult() helper throws on error

**React Hooks:**
- Purpose: Encapsulate component logic and reusable patterns
- Examples: `src/hooks/use-keyboard-shortcuts.ts`, `src/hooks/use-platform.ts`, `src/hooks/use-theme.ts`
- Pattern: Custom hooks follow React conventions, prefixed with `use-`

## Entry Points

**Main Application Window:**
- Location: `src/main.tsx` → `src/App.tsx` → `src/components/layout/MainWindow.tsx`
- Triggers: Application startup
- Responsibilities:
  - Vite/React setup via ReactDOM.createRoot()
  - Provider tree (QueryClientProvider)
  - App initialization (command system, language, menu, updates)
  - Window layout and sidebar/content structure

**Quick Pane Window:**
- Location: `src/quick-pane-main.tsx` → `src/components/quick-pane/QuickPaneApp.tsx`
- Triggers: Secondary window spawned by Tauri
- Responsibilities: Lightweight quick-entry interface for batch operations

**Tauri Initialization:**
- Location: `src-tauri/src/main.rs`
- Triggers: Desktop app launch
- Responsibilities: Window creation, menu setup, file system access permissions

## Error Handling

**Strategy:** Layered error handling with graceful degradation

**Patterns:**

- **API Errors:** Wrapped in try-catch, logged via logger, displayed to user via toast notifications (Sonner)
- **Tauri Command Errors:** Result type with explicit error handling; unwrapResult() throws for sync propagation
- **Component Errors:** ErrorBoundary component catches React rendering errors, displays fallback UI
- **Async Errors:** Promise-based error handling in useEffect, event listeners cleaned up on unmount
- **Backend Offline:** Main window shows "Backend Offline" status, continues with cached data when available
- **Missing API Key:** Shows card with CTA to open Settings, blocks API-dependent features

## Cross-Cutting Concerns

**Logging:**
- Tool: `src/lib/logger.ts` wraps tauri-apps/plugin-log
- Pattern: Structured logging with context objects, debug/info/warn/error levels
- Usage: App startup, backend checks, language initialization, update checks

**Validation:**
- Approach: TypeScript types enforce structure; API responses validated implicitly via type contracts
- Missing explicit runtime validation (zod/joi); relies on backend and TypeScript strict mode

**Authentication:**
- Approach: API key stored locally in settings; injected via X-API-Key header for explorer endpoints
- Pattern: `getApiKey()` retrieves from profiles, `hasApiKey()` checks configuration
- Custom events broadcast profile changes (`API_PROFILE_CHANGED_EVENT`) for reactive updates

**Internationalization (i18n):**
- Tool: react-i18next with i18n config
- Pattern: `useTranslation()` hook in components, i18n.t() in non-React contexts
- Storage: Language preference persisted via Tauri commands (`loadPreferences`/`savePreferences`)
- Initialization: Language detected from system locale or saved preference during app startup

**Theming:**
- Tool: Custom theme context + TailwindCSS (v4 with Vite plugin)
- Pattern: `useTheme()` hook provides current theme, className-based CSS (dark: selector)
- Storage: Theme preference persisted via Tauri commands

**Persistence:**
- Approach: Tauri file system API for recovery data, Tauri storage for preferences, HTTP for backend data
- Pattern: `cleanupOldFiles()` runs on startup to clear stale recovery files

---

*Architecture analysis: 2026-02-09*
