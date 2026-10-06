import { test, expect } from './fixtures/auth'
import type { Page } from '@playwright/test'

/**
 * AccuMark Tools > Customer Insights against a devbox stack. Screenshots land
 * in docs/superpowers/e2e/2026-10-05-customer-insights/ as PR evidence.
 */

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS = 'docs/superpowers/e2e/2026-10-05-customer-insights'
test.use({ viewport: { width: 1600, height: 1000 } })

async function api<T>(page: Page, path: string): Promise<T> {
  const token = await page.evaluate(() => window.localStorage.getItem('accu_mk1_auth_token'))
  const res = await page.request.get(`${BACKEND_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()) as T
}

test('insights page renders and matches the API', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  await expect(page.getByRole('heading', { name: 'Customer Insights', level: 1 })).toBeVisible({ timeout: 20_000 })
  const s = await api<{ kpis: { paid_orders: { value: number } } }>(page, '/reports/customers/summary?period=90d')
  await expect(page.getByText(s.kpis.paid_orders.value.toLocaleString('en-US')).first()).toBeVisible()
  // Stack orders are old, so the 90D window is empty; evidence shot uses All.
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(page.locator('.recharts-wrapper').first()).toBeVisible()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${SHOTS}/01-insights.png`, fullPage: true })
})

test('customer dashboard tab opens from the at-risk list or the list', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const risk = await api<{ rows: { key: string; name: string }[] }>(page, '/reports/customers/at-risk')
  const list = await api<{ rows: { key: string; name: string }[] }>(page, '/reports/customers/list?period=all&page_size=1')
  const target = risk.rows[0] ?? list.rows[0]
  test.skip(!target, 'no customers with paid orders on this stack')
  if (risk.rows[0]) {
    await page.getByText(target.name, { exact: true }).first().click()
  } else {
    await page.goto('/#accumark-tools/customers')
    await page.getByText(target.name, { exact: true }).first().click()
    await page.getByRole('tab', { name: 'Dashboard' }).click()
  }
  await expect(page.getByText(/Lifetime spend/i)).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/02-customer-dashboard.png`, fullPage: true })
})

test('agent feed responds', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const r = await api<{ events: unknown[] }>(page, `/reports/customers/changes?since=${encodeURIComponent(since)}`)
  expect(Array.isArray(r.events)).toBeTruthy()
})
