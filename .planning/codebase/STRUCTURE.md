# Codebase Structure

**Analysis Date:** 2026-02-09

## Directory Layout

```
project-root/
├── src/                        # React frontend application
│   ├── main.tsx               # Vite entry point, React root
│   ├── quick-pane-main.tsx    # Quick pane window entry point
│   ├── App.tsx                # Top-level app component with initialization
│   ├── App.css                # App styling
│   ├── App.test.tsx           # App component tests
│   ├── vite-env.d.ts          # Vite type definitions
│   ├── components/            # React components
│   │   ├── layout/            # Main layout components
│   │   │   ├── MainWindow.tsx     # Main window shell
│   │   │   ├── MainWindowContent.tsx # Content area router
│   │   │   ├── AppSidebar.tsx     # Sidebar navigation
│   │   │   ├── LeftSideBar.tsx    # Left panel (deprecated?)
│   │   │   └── RightSideBar.tsx   # Right panel (deprecated?)
│   │   ├── ui/                # shadcn/ui primitives (60+ components)
│   │   │   ├── button.tsx, card.tsx, dialog.tsx, etc.
│   │   │   └── Custom composites: data-table.tsx, tag-input.tsx
│   │   ├── command-palette/   # Command palette feature
│   │   │   ├── CommandPalette.tsx
│   │   │   └── index.ts       # Barrel export
│   │   ├── preferences/       # Settings/preferences UI
│   │   │   ├── PreferencesDialog.tsx
│   │   │   ├── ShortcutPicker.tsx
│   │   │   ├── panes/         # Settings pages
│   │   │   │   ├── GeneralPane.tsx
│   │   │   │   ├── AppearancePane.tsx
│   │   │   │   ├── AdvancedPane.tsx
│   │   │   │   └── DataPipelinePane.tsx
│   │   │   ├── shared/        # Shared preference components
│   │   │   │   └── SettingsComponents.tsx
│   │   │   └── index.ts       # Barrel export
│   │   ├── titlebar/          # Platform-specific window controls
│   │   │   ├── TitleBar.tsx
│   │   │   ├── TitleBarContent.tsx
│   │   │   ├── MacOSWindowControls.tsx
│   │   │   ├── WindowsWindowControls.tsx
│   │   │   ├── LinuxTitleBar.tsx
│   │   │   ├── WindowControlIcons.tsx
│   │   │   └── index.ts       # Barrel export
│   │   ├── quick-pane/        # Quick pane window UI
│   │   │   └── QuickPaneApp.tsx
│   │   ├── ErrorBoundary.tsx  # React error boundary
│   │   ├── ThemeProvider.tsx  # Theme context provider
│   │   ├── FileSelector.tsx   # File import UI
│   │   ├── BatchReview.tsx    # Batch sample review UI
│   │   ├── PreviewTable.tsx   # File preview table
│   │   ├── AccuMarkTools.tsx  # AccuMark tools section
│   │   ├── OrderExplorer.tsx  # Order/ingestion explorer
│   │   ├── ChromatographViewer.tsx # Chromatograph visualization
│   │   └── PayloadPanel.tsx   # Order payload display
│   ├── store/                 # Zustand state stores
│   │   ├── ui-store.ts        # Navigation and UI state
│   │   └── ui-store.test.ts   # Store tests
│   ├── lib/                   # Library/utility code
│   │   ├── bindings.ts        # Generated Tauri type bindings (auto-generated)
│   │   ├── tauri-bindings.ts  # Tauri bindings wrapper with Result helper
│   │   ├── api.ts             # FastAPI client (500+ lines)
│   │   ├── api-profiles.ts    # API profile management
│   │   ├── api-key.ts         # API key management
│   │   ├── config.ts          # Configuration helpers
│   │   ├── logger.ts          # Logging utility
│   │   ├── query-client.ts    # TanStack Query config
│   │   ├── theme-context.ts   # Theme state management
│   │   ├── menu.ts            # Application menu builder
│   │   ├── notifications.ts   # Notification utilities
│   │   ├── context-menu.ts    # Context menu handlers
│   │   ├── context-menu.test.ts
│   │   ├── platform-strings.ts # Platform-specific strings
│   │   ├── utils.ts           # Generic utilities (cn, etc.)
│   │   ├── recovery.ts        # Emergency recovery data
│   │   ├── commands/          # Command system
│   │   │   ├── index.ts       # System initialization
│   │   │   ├── registry.ts    # Command registration
│   │   │   ├── types.ts       # Command types
│   │   │   ├── navigation-commands.ts  # Nav commands
│   │   │   ├── window-commands.ts      # Window commands
│   │   │   ├── notification-commands.ts # Notification commands
│   │   │   └── commands.test.ts
│   ├── hooks/                 # Custom React hooks
│   │   ├── use-theme.ts       # Theme hook
│   │   ├── use-platform.ts    # Platform detection
│   │   ├── use-platform.test.ts
│   │   ├── use-mobile.ts      # Mobile viewport detection
│   │   ├── use-command-context.ts # Command context hook
│   │   ├── use-keyboard-shortcuts.ts # Keyboard handling
│   │   └── useMainWindowEventListeners.ts # Main window setup
│   ├── services/              # Service layer
│   │   └── preferences.ts     # Preferences service
│   ├── i18n/                  # Internationalization
│   │   ├── config.ts          # i18next config
│   │   ├── index.ts           # i18n initialization
│   │   ├── language-init.ts   # Language detection/init
│   │   └── i18n.d.ts          # Type definitions
│   ├── assets/                # Static assets
│   │   └── react.svg
│   ├── test/                  # Testing utilities
│   │   ├── setup.ts           # Vitest setup (Tauri mocks)
│   │   ├── test-utils.tsx     # Test render utilities
│   │   └── example.test.ts
│   ├── App.tsx                # Root component (duplicated from src/ entry)
│   └── vite-env.d.ts          # Vite type definitions
├── src-tauri/                 # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs           # Tauri window/menu setup
│   │   └── lib.rs            # Rust command handlers
│   ├── Cargo.toml            # Rust dependencies
│   ├── Cargo.lock
│   └── tauri.conf.json       # Tauri app config
├── locales/                   # Translation files
│   ├── en.json
│   ├── es.json
│   └── [other languages]
├── data/                      # Data files or example data
├── docs/                      # Documentation
│   └── developer/            # Developer guides
├── dist/                      # Built frontend output (generated)
├── package.json              # npm dependencies
├── tsconfig.json             # TypeScript config
├── vite.config.ts            # Vite config (multi-entry)
├── vitest.config.ts          # Test config
├── index.html                # Main window HTML
├── quick-pane.html           # Quick pane window HTML
├── eslint.config.js          # ESLint config
└── knip.json                 # Dead code analyzer config
```

## Directory Purposes

**src/components/ui/:**
- Purpose: Shadcn/ui component library - base elements for building UI
- Contains: Button, Card, Dialog, Input, Table, Select, etc. - 60+ components
- Key files: `button.tsx`, `card.tsx`, `dialog.tsx`, `data-table.tsx` (custom composite)
- Imported everywhere; never modified directly (regenerate from shadcn/ui CLI)

**src/components/layout/:**
- Purpose: Application shell and window structure
- Contains: MainWindow (provider tree + layout), MainWindowContent (content router), AppSidebar (nav)
- Key files: `MainWindow.tsx` (entry point with health checks), `AppSidebar.tsx` (nav structure)
- Used by: App.tsx root component

**src/components/preferences/:**
- Purpose: Settings/preferences UI for app configuration
- Contains: PreferencesDialog (modal container), panes (General/Appearance/Advanced/DataPipeline), SettingsComponents (shared UI)
- Key files: `PreferencesDialog.tsx` (controller), `panes/*.tsx` (settings pages)
- Triggered by: Sidebar footer "Settings" button or keyboard shortcut

**src/lib/:**
- Purpose: Utilities, services, and infrastructure code
- Key areas:
  - `api.ts` (500+ lines) - All FastAPI endpoints, health checks, import/export APIs
  - `commands/` - Command registry and keyboard shortcut handlers
  - `tauri-bindings.ts` - Type-safe Rust command wrapper
  - Other utils: logger, query client, theme, menu builder

**src/store/:**
- Purpose: Global state management via Zustand
- Key file: `ui-store.ts` - Navigation state (activeSection, activeSubSection), sidebar visibility, modal states
- Selector pattern used to prevent cascading re-renders

**src/hooks/:**
- Purpose: Reusable React logic
- Examples: `use-theme.ts` (theme switching), `use-platform.ts` (OS detection), `use-keyboard-shortcuts.ts` (global shortcuts)
- Convention: Prefixed with `use-` for custom hooks

**src/i18n/:**
- Purpose: Internationalization setup and language management
- Key file: `config.ts` - i18next configuration with locale resources
- Pattern: Language preference stored in Tauri, initialized on app startup

**src-tauri/:**
- Purpose: Desktop window management, file system access, Rust command handlers
- Key file: `main.rs` - Window creation, menu setup, command handlers
- Commands: Preference persistence, emergency recovery, notifications
- Generated: `src/lib/bindings.ts` auto-generated from Rust via tauri-specta

**locales/:**
- Purpose: Translation files for i18n
- Format: JSON with key-value pairs grouped by feature/section
- Files: Language codes as filenames (en.json, es.json, etc.)

## Naming Conventions

**Files:**
- **React Components:** PascalCase, `.tsx` extension (e.g., `FileSelector.tsx`, `MainWindow.tsx`)
- **Utilities/Services:** camelCase, `.ts` extension (e.g., `api.ts`, `logger.ts`, `use-theme.ts`)
- **Tests:** Suffixed with `.test.ts` or `.spec.ts` (e.g., `App.test.tsx`, `context-menu.test.ts`)
- **Styles:** `[ComponentName].css` co-located or CSS-in-JS via Tailwind classes

**Directories:**
- **Feature folders:** kebab-case (e.g., `command-palette/`, `quick-pane/`, `ui/`)
- **Layer folders:** lowercase (e.g., `components/`, `lib/`, `store/`, `hooks/`)
- **UI components:** shadcn/ui convention (kebab-case: `button.tsx`, `data-table.tsx`)

**Functions & Variables:**
- **Functions:** camelCase (e.g., `healthCheck()`, `getApiKey()`, `useTheme()`)
- **Constants:** UPPER_SNAKE_CASE for true constants (e.g., `API_PROFILE_CHANGED_EVENT`)
- **React Hooks:** Prefixed with `use` (e.g., `useUIStore`, `useTheme`)

**Types:**
- **Interfaces:** PascalCase (e.g., `MainWindowContentProps`, `UIState`, `ExplorerOrder`)
- **Type Aliases:** PascalCase (e.g., `ActiveSection`, `HealthResponse`)
- **Enums:** PascalCase (implicit in union types; e.g., `'lab-operations' | 'accumark-tools'`)

## Where to Add New Code

**New Feature (e.g., Sample Analysis Tool):**
- Primary component: `src/components/SampleAnalyzer.tsx`
- Tests: `src/components/SampleAnalyzer.test.tsx`
- API calls: Add functions to `src/lib/api.ts` (e.g., `analyzeSample()`)
- State (if complex): Create store file like `src/store/analyzer-store.ts`
- Routing: Update `src/store/ui-store.ts` with new section/subsection, add to `src/components/layout/AppSidebar.tsx`

**New Preferences Pane:**
- File: `src/components/preferences/panes/[FeatureName]Pane.tsx`
- Add to tabs in `src/components/preferences/PreferencesDialog.tsx`
- Shared UI helpers: `src/components/preferences/shared/SettingsComponents.tsx`

**New Modal/Dialog:**
- Component: `src/components/[FeatureName]Dialog.tsx`
- Trigger: State in `useUIStore` (add `[feature]Open: boolean` and toggle action)
- Render: Add to global components in `src/components/layout/MainWindow.tsx` alongside `CommandPalette`, `PreferencesDialog`

**New Custom Hook:**
- File: `src/hooks/use-[feature].ts`
- Pattern: Follow existing hooks; return object with state and actions
- Testing: Co-located `.test.ts` file

**New API Endpoint:**
- Location: `src/lib/api.ts`
- Pattern: Named export function (e.g., `export async function getSampleResults(sampleId: number)`)
- Error handling: Try-catch wraps fetch, logs errors, re-throws
- Types: Define interfaces at top of file or in separate types file

**New Tauri Command:**
- Rust: `src-tauri/src/lib.rs` - Implement command handler
- Bindings: Run `npm run rust:bindings` to auto-generate `src/lib/bindings.ts`
- Usage: Import from `src/lib/tauri-bindings` with type safety

**Utilities:**
- Shared helpers: `src/lib/utils.ts` (general) or feature-specific file
- Test utilities: `src/test/test-utils.tsx` (render wrapper, mocks)

## Special Directories

**src/components/ui/:**
- Purpose: Shadcn/ui component library
- Generated: Yes (via `npx shadcn-ui@latest add [component]`)
- Committed: Yes (checked into git)
- Modification: Do NOT modify; regenerate from CLI if needed

**dist/:**
- Purpose: Built frontend output (Vite bundle)
- Generated: Yes (via `npm run build`)
- Committed: No (gitignored)

**src-tauri/target/:**
- Purpose: Rust compilation artifacts
- Generated: Yes (via `cargo build`)
- Committed: No (gitignored)

**src/lib/bindings.ts:**
- Purpose: Auto-generated Tauri type bindings from Rust
- Generated: Yes (via `npm run rust:bindings` or build)
- Committed: Yes (checked in for CI)
- Modification: Do NOT edit manually; regenerate from Rust

**locales/:**
- Purpose: Translation files for i18n
- Format: JSON
- Committed: Yes (source of truth for translations)
- Modification: Edit JSON files directly; i18next hot-reloads in dev

---

*Structure analysis: 2026-02-09*
