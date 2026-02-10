# Testing Patterns

**Analysis Date:** 2026-02-09

## Test Framework

**Runner:**
- Vitest v4.0.15
- Config: `vitest.config.ts`
- Environment: `jsdom`
- Globals: enabled (`globals: true`)

**Assertion Library:**
- Vitest built-in expect API
- @testing-library/jest-dom for DOM assertions

**Run Commands:**
```bash
npm run test              # Run in watch mode
npm run test:run         # Run once and exit
npm run test:ui          # Run with Vitest UI
npm run test:coverage    # Generate coverage report
npm run test:all         # Run both JS and Rust tests
```

## Test File Organization

**Location:**
- Co-located with source files (alongside implementation)
- Pattern: `src/**/*.{test,spec}.{ts,tsx}`

**Naming:**
- `*.test.ts` for TypeScript unit tests
- `*.test.tsx` for React component tests
- Example: `use-platform.test.ts`, `ui-store.test.ts`, `App.test.tsx`

**Directory Structure:**
```
src/
├── hooks/
│   ├── use-platform.ts
│   ├── use-platform.test.ts          # Co-located test
│   ├── use-keyboard-shortcuts.ts
│   └── ...
├── store/
│   ├── ui-store.ts
│   ├── ui-store.test.ts              # Co-located test
│   └── ...
├── lib/
│   ├── commands/
│   │   ├── commands.test.ts          # Complex system tests
│   │   ├── registry.ts
│   │   └── ...
│   └── ...
├── test/
│   ├── setup.ts                      # Global test setup
│   ├── test-utils.tsx                # Custom render wrapper
│   └── example.test.ts               # Example pattern
└── ...
```

## Test Structure

**Suite Organization:**
```typescript
describe('UIStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      leftSidebarVisible: true,
      rightSidebarVisible: true,
      commandPaletteOpen: false,
      preferencesOpen: false,
    })
  })

  it('has correct initial state', () => {
    const state = useUIStore.getState()
    expect(state.leftSidebarVisible).toBe(true)
  })
})
```

**Patterns:**
- Use `describe()` blocks for logical grouping of related tests
- Use `it()` for individual test cases (not `test()`)
- Always use `beforeEach()` to reset global state (stores, mocks) before each test
- Use `afterEach()` for cleanup when mocks persist across tests
- One logical assertion per test (though multiple expect calls on same data are fine)

## Mocking

**Framework:** Vitest `vi` module

**Patterns:**
```typescript
// Module mocking - at top of file before imports
vi.mock('@/store/ui-store', () => ({
  useUIStore: mockUIStore,
}))

// Function mocking
const mockFn = vi.fn()
const mockFnWithReturnValue = vi.fn().mockReturnValue(42)
const mockFnWithResolvedValue = vi.fn().mockResolvedValue({ status: 'ok' })

// Resetting mocks
beforeEach(() => {
  vi.clearAllMocks()  // Clear call counts and implementation
})

afterEach(() => {
  vi.clearAllMocks()
})
```

**Global Setup:** `src/test/setup.ts`
- Mocks Tauri APIs at application level:
  - `@tauri-apps/api/event` - mock `listen()`
  - `@tauri-apps/plugin-updater` - mock `check()`
  - `@/lib/tauri-bindings` - mock all typed commands
- Mocks browser APIs:
  - `window.matchMedia()` for media query tests
- All Tauri bindings return mocked responses ready for testing

**What to Mock:**
- External APIs (Tauri commands, HTTP requests)
- Browser APIs that don't exist in jsdom (matchMedia, etc.)
- Store dependencies in isolated unit tests
- Zustand store using `getState()` for controlled state

**What NOT to Mock:**
- Real utility functions and business logic (test the actual implementations)
- Built-in JavaScript functions
- React hooks internally (test component behavior instead)
- Store mutations if testing store behavior (test real store updates)

## Fixtures and Factories

**Test Data:**
```typescript
// Create mock context consistently
const createMockContext = (): CommandContext => ({
  openPreferences: vi.fn(),
  showToast: vi.fn(),
})

// Mock translations
const mockT = ((key: string): string => {
  const translations: Record<string, string> = {
    'commands.showLeftSidebar.label': 'Show Left Sidebar',
    'commands.hideLeftSidebar.label': 'Hide Left Sidebar',
  }
  return translations[key] || key
}) as TFunction
```

**Location:**
- Factories and builders defined in test files near usage
- Test utilities exported from `src/test/test-utils.tsx`
- Mock builders kept close to the test suite using them

**Custom Test Utilities:** `src/test/test-utils.tsx`
- `render()` - wrapper around Testing Library render with all providers
- Providers included:
  - `QueryClientProvider` - TanStack Query with retry: false
  - `I18nextProvider` - i18n configuration
  - `MockThemeProvider` - simplified theme provider for testing
- Export pattern: `export { customRender as render }`

## Coverage

**Requirements:**
- Thresholds enforced in `vitest.config.ts`:
  - Lines: 60%
  - Functions: 60%
  - Branches: 60%

**View Coverage:**
```bash
npm run test:coverage
```
- Generates coverage report in `coverage/` directory (default: v8 provider)
- Check `coverage/index.html` for detailed report

## Test Types

**Unit Tests:**
- Scope: Single function/hook/component
- Approach: Test pure functions and hooks with various inputs
- Example: `use-platform.test.ts` tests `usePlatform()` hook
- Example: `ui-store.test.ts` tests store actions and state
- Setup: Mock external dependencies, use `beforeEach` for state reset

**Integration Tests:**
- Scope: Multiple components/systems working together
- Approach: Test command system with mocked UI store and context
- Example: `commands.test.ts` tests command registration, filtering, and execution
- Setup: Mock dependencies at module level, create realistic test scenarios

**E2E Tests:**
- Framework: Not currently in use
- Approach: Would require full Tauri environment

## Common Patterns

**Async Testing:**
```typescript
// With async/await
it('executes show-left-sidebar command correctly', async () => {
  const result = await executeCommand('show-left-sidebar', mockContext)
  expect(result.success).toBe(true)
})

// Testing promises
it('loads preferences', async () => {
  const promise = commands.loadPreferences()
  expect(promise).toBeInstanceOf(Promise)
  const result = await promise
  expect(result.status).toBe('ok')
})
```

**Error Testing:**
```typescript
// Testing error handling
it('handles command execution errors', async () => {
  const errorCommand: AppCommand = {
    id: 'error-command',
    labelKey: 'commands.error.label',
    execute: () => {
      throw new Error('Test error')
    },
  }
  registerCommands([errorCommand])

  const result = await executeCommand('error-command', mockContext)
  expect(result.success).toBe(false)
  expect(result.error).toContain('Test error')
})

// Testing failed API calls
it('handles failed preferences loading', async () => {
  mockUIStore.loadPreferences.mockResolvedValueOnce({
    status: 'error',
    error: 'File not found'
  })

  // Test component behavior when command fails
  const result = await usePreferences()
  expect(result.isPending).toBe(true)
})
```

**React Component Testing:**
```typescript
// Using custom render wrapper
it('renders main window layout', () => {
  render(<App />)
  expect(
    screen.getByRole('heading', { name: /hello world/i })
  ).toBeInTheDocument()
})

// Testing component with state
it('renders title bar with traffic light buttons', () => {
  render(<App />)
  const titleBarButtons = screen
    .getAllByRole('button')
    .filter(
      button =>
        button.getAttribute('aria-label')?.includes('window') ||
        button.className.includes('window-control')
    )
  expect(titleBarButtons.length).toBeGreaterThan(0)
})
```

**Store Testing:**
```typescript
// Always reset store before each test
beforeEach(() => {
  useUIStore.setState({
    leftSidebarVisible: true,
    rightSidebarVisible: true,
    commandPaletteOpen: false,
    preferencesOpen: false,
  })
})

// Access state with getState()
it('has correct initial state', () => {
  const state = useUIStore.getState()
  expect(state.leftSidebarVisible).toBe(true)
})

// Call state update functions
it('toggles left sidebar visibility', () => {
  const { toggleLeftSidebar } = useUIStore.getState()
  toggleLeftSidebar()
  expect(useUIStore.getState().leftSidebarVisible).toBe(false)
})
```

**Testing with i18n:**
```typescript
// Use mock translation function in tests
const mockT = ((key: string): string => {
  const translations: Record<string, string> = {
    'commands.label': 'Command Label',
  }
  return translations[key] || key
}) as TFunction

// Filter and search with translations
const searchResults = getAllCommands(mockContext, 'label', mockT)
searchResults.forEach(cmd => {
  const label = mockT(cmd.labelKey).toLowerCase()
  expect(label.includes('label')).toBe(true)
})
```

## Testing Best Practices

**Isolation:**
- Each test should be independent
- Use `beforeEach()` to reset state, mocks, and stores
- Never rely on test execution order

**Clarity:**
- Test names should describe behavior, not implementation
- Use `describe()` to organize related tests logically
- Each test tests one logical behavior

**Mocking Strategy:**
- Mock Tauri at setup.ts level (used globally)
- Mock stores at test file level when testing individual units
- Mock API calls with realistic response shapes
- Return mocked values that match actual API contract

**Assertions:**
- Use specific matchers: `toBe()`, `toContain()`, `toBeDefined()`, not generic `toBeTruthy()`
- Check multiple aspects of important test outcomes
- Group related assertions in single test

---

*Testing analysis: 2026-02-09*
