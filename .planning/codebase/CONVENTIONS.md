# Coding Conventions

**Analysis Date:** 2026-02-09

## Naming Patterns

**Files:**
- React components: `PascalCase.tsx` (e.g., `AppSidebar.tsx`, `CommandPalette.tsx`)
- Hooks: `use[Feature].ts` or `use[Feature].tsx` (e.g., `use-platform.ts`, `use-keyboard-shortcuts.ts`)
- Utils/services: `kebab-case.ts` (e.g., `context-menu.ts`, `query-client.ts`)
- Directories: `kebab-case` for feature directories (e.g., `command-palette/`, `layout/`)
- Index files: `index.ts` or `index.tsx` for barrel exports

**Functions:**
- React components: `PascalCase` (e.g., `export function AppSidebar() {}`)
- Hooks: `camelCase` starting with `use` (e.g., `export function usePlatform()`, `export function usePreferences()`)
- Regular functions: `camelCase` (e.g., `getPlatform()`, `mapPlatform()`, `createMockContext()`)
- Store actions: `camelCase` with `set` or `toggle` prefix (e.g., `setLeftSidebarVisible()`, `toggleCommandPalette()`)

**Variables:**
- `camelCase` for all variables (e.g., `leftSidebarVisible`, `queryClient`)
- `UPPER_SNAKE_CASE` for constants (e.g., query keys object structure: `preferencesQueryKeys`)
- Type unions use kebab-case: `'lab-operations' | 'accumark-tools'` (see `ui-store.ts`)
- Boolean variables: `is`, `has`, or `visible` prefix (e.g., `isDevelopment`, `leftSidebarVisible`)

**Types:**
- `PascalCase` for type names (e.g., `AppPlatform`, `UIState`, `CommandContext`, `AppCommand`)
- Interfaces use `PascalCase` without `I` prefix (e.g., `interface UIState {}`)
- Union types: kebab-case string literals (e.g., `type ActiveSection = 'lab-operations' | 'accumark-tools'`)
- Discriminated unions used for command results (e.g., `{ success: true } | { success: false; error: string }`)

## Code Style

**Formatting:**
- Tool: Prettier
- Config: `prettier.config.js`
- Key settings:
  - Semi-colons: off (no semicolons)
  - Single quotes: on (except JSX attributes)
  - Trailing comma: es5 (include in multi-line structures)
  - Tab width: 2 spaces
  - Print width: 80 characters
  - Arrow function parens: avoid (single param has no parens)
  - JSX single quote: off (JSX attributes use double quotes)

**Linting:**
- Tool: ESLint with TypeScript support
- Config: `eslint.config.js`
- Key enforced rules:
  - `react-compiler/react-compiler`: error (React Compiler enabled for performance)
  - `@typescript-eslint/consistent-type-imports`: imports types using `type` keyword
  - `@typescript-eslint/no-unused-vars`: error (ignores `_` prefix)
  - `@typescript-eslint/no-import-type-side-effects`: error
  - `react-refresh/only-export-components`: warn for non-UI files (disabled in `src/components/ui/` and `src/test/`)
  - Rules disabled: `react/react-in-jsx-scope`, `react/prop-types`

**TypeScript:**
- Config: `tsconfig.json`
- `target: ES2022`
- `strict: true` enabled
- `noUnusedLocals` and `noUnusedParameters` enabled
- `noUncheckedIndexedAccess` enabled
- Path aliases: `@/*` → `./src/*`

## Import Organization

**Order:**
1. React and third-party library imports (e.g., `import { useEffect } from 'react'`)
2. @tauri-apps imports
3. Project imports using `@/` alias
4. Type-only imports using `import type` syntax
5. Style imports (e.g., `import './App.css'`)

**Path Aliases:**
- `@/` resolves to `./src/`
- Always use `@/` for project imports, never relative paths like `../../../lib`
- Examples: `@/store/ui-store`, `@/lib/logger`, `@/components/ui/sidebar`

**Type Imports:**
- Always use `import type { ... } from ...` for type-only imports
- Enforced by eslint rule `@typescript-eslint/consistent-type-imports`
- Example: `import type { AppCommand } from './types'`

## Error Handling

**Patterns:**
- Tauri commands return `{ status: 'ok'; data: T } | { status: 'error'; error: string }`
- Check status before accessing data (see `src/services/preferences.ts`)
- For async operations that might fail, use try-catch around command invocations
- Store state with `Result` type patterns for loading states

**Logging:**
- Use `logger.info()`, `logger.warn()`, `logger.error()` for operation outcomes
- Include context object with relevant data: `logger.info('message', { key: value })`
- Avoid swallowing errors - always log them before re-throwing

**Fallback Strategy:**
- Provide sensible defaults when commands fail (see preferences loading)
- Use optional chaining and nullish coalescing for defensive coding
- Example: `result.status === 'ok' ? result.data.theme : 'system'`

## Logging

**Framework:** Custom logger singleton at `src/lib/logger.ts`

**Methods Available:**
- `logger.trace(message, context?)`
- `logger.debug(message, context?)`
- `logger.info(message, context?)`
- `logger.warn(message, context?)`
- `logger.error(message, context?)`

**Patterns:**
- Import as singleton: `import { logger } from '@/lib/logger'`
- Use convenience exports: `import { info, warn, error } from '@/lib/logger'`
- Always include context object for structured logging: `logger.info('Operation complete', { userId: 123 })`
- Development: logs to browser console with timestamp prefix
- Production: implementation includes commented-out backend logging option

**When to Log:**
- Initialization steps (app startup, feature setup)
- Before/after significant operations (preferences loaded, commands executed)
- Warnings for recoverable errors
- Errors for exceptions

## Comments

**When to Comment:**
- JSDoc blocks for exported functions and hooks
- Inline comments explaining WHY (not WHAT) code does something
- TODO/FIXME style comments are not used in codebase
- Comments for non-obvious architectural decisions

**JSDoc/TSDoc:**
- All exported functions should have JSDoc blocks
- Use `@param`, `@returns`, `@example` tags
- Include use case examples in public API documentation
- Types should be documented inline in interfaces

**Examples from Codebase:**
```typescript
/**
 * React hook to get the current platform.
 *
 * The platform is detected synchronously and cached, so this hook
 * always returns a value immediately (no loading state).
 *
 * @example
 * const platform = usePlatform()
 * if (platform === 'macos') {
 *   // Render macOS-specific UI
 * }
 */
export function usePlatform(): AppPlatform {
  return initPlatform()
}
```

## Function Design

**Size:** Prefer small, focused functions (10-30 lines typical)

**Parameters:**
- Limit to 2-3 parameters
- Use object destructuring for multiple related params
- Example: `function createMockContext(): CommandContext`

**Return Values:**
- Functions either return data or perform side effects, not both
- Use discriminated unions for operations that can succeed or fail
- Example: `{ success: true } | { success: false; error: string }`

**Async Functions:**
- Always declare as `async` even if not awaiting internally
- Return `Promise<T>`
- Handle errors with try-catch blocks

## Module Design

**Exports:**
- Prefer named exports over default exports
- Barrel files (`index.ts`) re-export from modules for convenient imports
- Example from `src/components/layout/index.ts`: re-exports all layout components

**Barrel Files:**
- Used in `src/components/*/index.ts` for component directories
- Used in `src/lib/commands/index.ts` to expose command system
- Simplifies imports: `import { AppSidebar } from '@/components/layout'` instead of full path

**Store Pattern (Zustand):**
- Stores created with `create<State>()(devtools(...))` for dev tools support
- Use selector syntax, NEVER destructure: `const value = store(state => state.value)`
- Enforced by ast-grep rule: `.ast-grep/rules/zustand/no-destructure.yml`
- Access state outside components with `store.getState()`

**Query Pattern (TanStack Query):**
- Query keys organized in nested object: `queryKeys.all`, `queryKeys.feature()`
- Mutation functions perform async operations and handle errors
- Use `onSuccess` for cache updates and side effects
- Example: `src/services/preferences.ts` shows full pattern

## Architecture Rules (Enforced by ast-grep)

**Rules Located:** `.ast-grep/rules/`

1. **No Destructuring from Zustand:**
   - Rule: `.ast-grep/rules/zustand/no-destructure.yml`
   - BAD: `const { leftSidebarVisible } = useUIStore()`
   - GOOD: `const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)`
   - Reason: Destructuring causes render cascades on every store update

2. **Hooks Must Be in `src/hooks/` Directory:**
   - Rule: `.ast-grep/rules/architecture/hooks-in-hooks-dir.yml`
   - All hook files start with `use` prefix and live in `src/hooks/`

3. **Store Files Must Be in `src/store/` Directory:**
   - Rule: `.ast-grep/rules/architecture/no-store-in-lib.yml`
   - Stores use Zustand and live in `src/store/`

---

*Convention analysis: 2026-02-09*
