import { test as base, expect, type Page } from '@playwright/test'

/**
 * Auth fixture for Accu-Mk1 E2E tests.
 *
 * Strategy: POST credentials to /auth/login, grab the bearer token, then
 * inject it into the browser's localStorage BEFORE navigating to the SPA.
 * The auth-store (`src/store/auth-store.ts`) hydrates from these two keys on
 * load:
 *   - accu_mk1_auth_token  → JWT bearer
 *   - accu_mk1_auth_user   → { email, role, is_active, ... }
 *
 * This avoids driving the login form on every test and keeps the suite fast.
 *
 * Credentials come from env vars E2E_EMAIL and E2E_PASSWORD. The suite skips
 * with a clear message if they're missing rather than failing cryptically.
 */

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const TOKEN_KEY = 'accu_mk1_auth_token'
const USER_KEY = 'accu_mk1_auth_user'

type LoginResponse = {
  access_token: string
  // The backend includes user under one of these shapes depending on version;
  // we accept both and normalize. See src/lib/auth-api.ts:LoginResponse.
  user?: { email: string; role: string; is_active?: boolean }
}

let cachedToken: { token: string; user: object } | null = null

async function fetchToken(): Promise<{ token: string; user: object }> {
  if (cachedToken) return cachedToken

  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password) {
    throw new Error(
      'E2E_EMAIL and E2E_PASSWORD env vars are required. ' +
        'Set them before running: E2E_EMAIL=admin@accumark.local E2E_PASSWORD=... npm run test:e2e'
    )
  }

  const response = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Login failed (${response.status}): ${detail}`)
  }

  const data = (await response.json()) as LoginResponse
  const user = data.user ?? { email, role: 'admin', is_active: true }
  cachedToken = { token: data.access_token, user }
  return cachedToken
}

export async function authenticate(page: Page): Promise<void> {
  const { token, user } = await fetchToken()

  // Set the auth storage entries on the document origin BEFORE any navigation.
  // Playwright's addInitScript fires on every new document, so the auth-store
  // hydration in src/store/auth-store.ts:30-32 picks them up immediately.
  await page.addInitScript(
    ({ token, user, tokenKey, userKey }) => {
      window.localStorage.setItem(tokenKey, token)
      window.localStorage.setItem(userKey, JSON.stringify(user))
    },
    { token, user, tokenKey: TOKEN_KEY, userKey: USER_KEY }
  )
}

/**
 * Authenticated page fixture. Each test gets a fresh page with auth pre-seeded.
 */
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await authenticate(page)
    await use(page)
  },
})

export { expect }
