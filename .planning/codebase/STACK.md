# Technology Stack

**Analysis Date:** 2026-02-09

## Languages

**Primary:**
- TypeScript 5.9.3 - Frontend and build configuration
- Rust 1.82 - Desktop application backend (Tauri)
- JavaScript - Build scripts and configuration

**Secondary:**
- JSON - Configuration and localization files

## Runtime

**Environment:**
- Node.js ≥20.0.0 - Build and dev server runtime
- Tauri v2.9.6 - Desktop application framework
- Cargo (Rust package manager) - Rust dependency management

**Package Manager:**
- npm - JavaScript/TypeScript package management
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- Tauri v2.9.1 - Desktop application framework (cross-platform: Windows, macOS, Linux)
- React 19.2.3 - UI framework
- Vite 7.3.0 - Build tool and dev server

**State Management:**
- Zustand 5.0.9 - Global UI state (sidebar, preferences, navigation)
- TanStack Query 5.90.12 - Server state and data synchronization (for API calls)

**UI & Styling:**
- Tailwind CSS 4.1.18 - Utility-first CSS framework
- @tailwindcss/vite 4.1.18 - Tailwind integration for Vite
- shadcn/ui (via @radix-ui components) - Accessible UI component library
  - @radix-ui/react-alert-dialog ^1.1.15
  - @radix-ui/react-dialog ^1.1.15
  - @radix-ui/react-select ^2.2.6
  - @radix-ui/react-dropdown-menu ^2.1.16
  - @radix-ui/react-checkbox ^1.3.3
  - @radix-ui/react-radio-group ^1.3.8
  - @radix-ui/react-switch ^1.2.6
  - @radix-ui/react-toggle ^1.1.10
  - @radix-ui/react-scroll-area ^1.2.10
  - And 8 additional Radix UI components
- class-variance-authority 0.7.1 - Component variant management
- clsx 2.1.1 - Conditional className utility
- tailwind-merge 3.4.0 - Merge Tailwind class utilities
- lucide-react 0.561.0 - Icon library
- recharts 3.7.0 - Chart and visualization library

**Internationalization:**
- i18next 25.7.3 - i18n framework
- react-i18next 16.5.0 - React integration for i18next
- Supported languages: English, French, Arabic (locales in `locales/*.json`)

**Other UI:**
- react-day-picker 9.12.0 - Date picker component
- react-resizable-panels 3.0.6 - Resizable layout panels
- sonner 2.0.7 - Toast notifications
- cmdk 1.1.1 - Command/search palette

**Testing:**
- Vitest 4.0.15 - Unit test runner (configured for jsdom environment)
- @testing-library/react 16.3.1 - React component testing utilities
- @testing-library/jest-dom 6.9.1 - DOM matchers for Vitest
- @testing-library/user-event 14.6.1 - User interaction simulation
- @vitest/coverage-v8 4.0.15 - Code coverage with V8 provider

**Build & Dev:**
- @vitejs/plugin-react 5.1.2 - React plugin for Vite
- babel-plugin-react-compiler 1.0.0 - React compiler for automatic memoization
- TypeScript - Static type checking

**Linting & Code Quality:**
- ESLint 9.39.2 - JavaScript/TypeScript linter
- typescript-eslint 8.49.0 - TypeScript ESLint rules
- eslint-plugin-react 7.37.5 - React linting rules
- eslint-plugin-react-hooks 7.0.1 - React hooks best practices
- eslint-plugin-react-compiler 19.1.0-rc.2 - React compiler linting
- eslint-plugin-react-refresh 0.4.25 - React Fast Refresh rules
- eslint-config-prettier 10.1.8 - Prettier integration
- Prettier 3.7.4 - Code formatter
- @ast-grep/cli 0.40.3 - AST-based linting (custom architecture patterns)
- knip 5.73.4 - Unused code detection
- jscpd 4.0.5 - Duplicate code detection

**Tauri Plugins:**
- @tauri-apps/api 2.9.1 - Tauri API client
- @tauri-apps/plugin-clipboard-manager 2.3.2 - Clipboard access
- @tauri-apps/plugin-dialog 2.4.2 - File dialogs
- @tauri-apps/plugin-fs 2.4.4 - File system access
- @tauri-apps/plugin-log 2.7.1 - Logging
- @tauri-apps/plugin-notification 2.3.3 - Desktop notifications
- @tauri-apps/plugin-opener 2.5.2 - Open external apps/URLs
- @tauri-apps/plugin-os 2.3.2 - OS information
- @tauri-apps/plugin-process 2.3.1 - Process management
- @tauri-apps/plugin-updater 2.9.0 - Auto-updates
- @tauri-apps/plugin-window-state 2.4.1 - Window state persistence
- @tauri-apps/plugin-clipboard-manager 2.3.2 - Clipboard operations
- @tauri-apps/plugin-persisted-scope 2 - Secure file scoping
- @tauri-apps/plugin-single-instance 2 - Single app instance enforcement
- @tauri-apps/plugin-global-shortcut 2 - Global keyboard shortcuts

**Type Generation:**
- specta 2.0.0-rc.22 - Type-safe command generation (Rust→TypeScript)
- tauri-specta 2.0.0-rc.21 - Tauri integration for specta
- specta-typescript 0.0.9 - TypeScript code generator for specta

**macOS Specific:**
- tauri-nspanel (from ahkohd/tauri-nspanel@v2.1) - Native NSPanel behavior for floatables

## Key Dependencies

**Critical:**
- Tauri 2.9.1 - Core desktop framework for cross-platform app
- React 19.2.3 - UI rendering engine
- TypeScript 5.9.3 - Type safety and development experience
- Zustand 5.0.9 - Lightweight global state management
- TanStack Query 5.90.12 - Server state synchronization with backend

**Infrastructure:**
- Vite 7.3.0 - Modern build tooling with HMR support
- Tailwind CSS 4.1.18 - Efficient CSS utility framework
- Prettier 3.7.4 - Enforced code formatting
- ESLint - Static code quality enforcement

## Configuration

**TypeScript:**
- Target: ES2022
- Module: ESNext
- Strict mode enabled
- Path alias: `@/*` → `./src/*`
- Config file: `tsconfig.json`

**Build:**
- Vite config: `vite.config.ts`
  - React plugin with React Compiler enabled
  - Tailwind CSS plugin enabled
  - Path alias resolution for `@/` imports
  - Development server on port 1420
  - Multiple entry points: `index.html` (main), `quick-pane.html` (secondary window)
  - Chunk size warning limit: 600kb

**Test:**
- Vitest config: `vitest.config.ts`
  - Environment: jsdom
  - Global test utilities enabled
  - Setup file: `src/test/setup.ts`
  - Coverage thresholds: 60% (lines, functions, branches)
  - Coverage provider: v8

**Code Style:**
- ESLint: `eslint.config.js`
  - Strict TypeScript rules enabled
  - React compiler rule enforced
  - Consistent type imports required
  - React Refresh enabled
  - Rule: No unused vars (prefixed with `_` allowed)
  - UI components and tests exempt from React compiler rule
- Prettier: `prettier.config.js`
  - Print width: 80 characters
  - Tab width: 2 spaces
  - Single quotes (JavaScript)
  - Double quotes (JSX)
  - Trailing commas: ES5
  - Line ending: LF
  - No semicolons
  - Avoid arrow parens

**Rust:**
- Edition: 2021
- Minimum version: 1.82
- Cargo.toml: `src-tauri/Cargo.toml`
- Release optimizations: LTO, size optimization, no panic unwinding, stripped symbols

## Platform Requirements

**Development:**
- Node.js ≥20.0.0
- Cargo/Rust ≥1.82
- npm
- Source environment: `~/.cargo/env` (loaded for Rust commands on Unix-like systems)

**Production:**
- Windows (via Tauri)
- macOS 10.13+ (with native NSPanel support)
- Linux (via Tauri)
- Deployment via Tauri's built-in updater with electron-builder

---

*Stack analysis: 2026-02-09*
