/**
 * API configuration for the web app.
 *
 * PRIMARY source: Vite env vars (VITE_API_URL), baked at build time.
 *   - .env.development  → http://127.0.0.1:8012
 *   - .env.production   → https://api.accumarklabs.com
 *
 * ADMIN OVERRIDE: admins can temporarily point at a different backend
 * via the Settings UI. The override is stored in sessionStorage so it
 * dies when the browser tab is closed and never leaks to other users.
 */

// ── Storage key (sessionStorage, NOT localStorage) ─────────────
const SESSION_OVERRIDE_KEY = 'accu_mk1_api_url_override'

// ── Custom event for reactivity ────────────────────────────────
export const API_PROFILE_CHANGED_EVENT = 'accu-mk1-api-profile-changed'

// ── Known environments for the admin switcher ──────────────────
export interface ApiEnvironment {
  id: string
  name: string
  url: string
}

export const KNOWN_ENVIRONMENTS: ApiEnvironment[] = [
  {
    id: 'local',
    name: 'Local Development',
    url: 'http://127.0.0.1:8012',
  },
  {
    id: 'production',
    name: 'Production',
    url: 'https://api.accumarklabs.com',
  },
]

// ── Core getters ───────────────────────────────────────────────

/**
 * Get the active API base URL.
 *
 * Resolution order:
 *   1. sessionStorage override (admin-only, tab-scoped)
 *   2. VITE_API_URL env var (baked at build time)
 *   3. Fallback to localhost
 */
export function getServerUrl(): string {
  if (typeof window !== 'undefined') {
    const override = sessionStorage.getItem(SESSION_OVERRIDE_KEY)
    if (override) return override
  }
  return import.meta.env.VITE_API_URL || 'http://127.0.0.1:8012'
}

/**
 * Get the default (non-overridden) API URL from the build-time env var.
 */
export function getDefaultUrl(): string {
  return import.meta.env.VITE_API_URL || 'http://127.0.0.1:8012'
}

/**
 * Check whether an admin override is currently active.
 */
export function hasOverride(): boolean {
  if (typeof window === 'undefined') return false
  return sessionStorage.getItem(SESSION_OVERRIDE_KEY) !== null
}

/**
 * Get the current override URL, or null if none is set.
 */
export function getOverrideUrl(): string | null {
  if (typeof window === 'undefined') return null
  return sessionStorage.getItem(SESSION_OVERRIDE_KEY)
}

// ── Admin override management ──────────────────────────────────

/**
 * Set an admin override to use a different backend URL for this session.
 */
export function setOverride(url: string): void {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(SESSION_OVERRIDE_KEY, url)
  window.dispatchEvent(
    new CustomEvent(API_PROFILE_CHANGED_EVENT, { detail: { url } })
  )
}

/**
 * Clear the admin override, reverting to the build-time default.
 */
export function clearOverride(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(SESSION_OVERRIDE_KEY)
  window.dispatchEvent(
    new CustomEvent(API_PROFILE_CHANGED_EVENT, { detail: { url: getServerUrl() } })
  )
}

/**
 * Get a human-readable label for the current active environment.
 */
export function getActiveEnvironmentName(): string {
  const url = getServerUrl()
  const known = KNOWN_ENVIRONMENTS.find(e => e.url === url)
  if (known) return known.name
  // Check if it's an override to an unknown URL
  if (hasOverride()) return 'Custom Override'
  return 'Unknown'
}

// ── WordPress URL (from env var) ───────────────────────────────

/**
 * Get the WordPress URL for admin links (Order Explorer, etc.).
 * Comes from the VITE_WORDPRESS_URL env var.
 */
export function getWordpressUrl(): string {
  return import.meta.env.VITE_WORDPRESS_URL || 'https://accumarklabs.local'
}

// ── Legacy compatibility ───────────────────────────────────────
// These existed for the old API key system. The API key now lives
// in the backend .env, so these return null / false.

/** @deprecated API key is now backend-side config */
export function hasApiKey(): boolean {
  return true // Always "configured" — key is in backend .env
}

/** @deprecated API key is now backend-side config */
export function getApiKey(): string | null {
  return null
}
