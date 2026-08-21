import '@testing-library/jest-dom'
import { vi } from 'vitest'

// jsdom doesn't implement Element.scrollIntoView, but Radix's Select uses it
// after the popover mounts. Polyfill so tests that open Radix Select dropdowns
// (e.g. SLA preferences pane) don't crash on the uncaught exception.
if (!Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    writable: true,
    value: vi.fn(),
  })
}

// jsdom doesn't implement ResizeObserver, but Radix's Checkbox mounts a
// hidden bubble input sized via useSize whenever it renders inside a <form>
// (e.g. the AddMethodForm covered-services picker). Stub it so those mount.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
  // configurable so suites that install their own stub (e.g.
  // promoted-source-retest) can still redefine it.
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  })
}

// Mock matchMedia for tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock Tauri APIs for tests
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {
    // Mock unlisten function
  }),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}))

// Mock typed Tauri bindings (tauri-specta generated)
vi.mock('@/lib/tauri-bindings', () => ({
  commands: {
    greet: vi.fn().mockResolvedValue('Hello, test!'),
    loadPreferences: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: { theme: 'system' } }),
    savePreferences: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    sendNativeNotification: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: null }),
    saveEmergencyData: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    loadEmergencyData: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    cleanupOldRecoveryFiles: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: 0 }),
  },
  unwrapResult: vi.fn((result: { status: string; data?: unknown }) => {
    if (result.status === 'ok') return result.data
    throw result
  }),
}))
