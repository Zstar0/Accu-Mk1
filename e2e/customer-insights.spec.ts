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

/** The app scrolls inside an inner container, so grow the viewport to fit it. */
async function shootFull(page: Page, path: string) {
  await page.mouse.move(0, 0)
  const extra = await page.evaluate(() => {
    let max = 0
    document.querySelectorAll('*').forEach(el => {
      const o = getComputedStyle(el).overflowY
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight)
        max = Math.max(max, el.scrollHeight - el.clientHeight)
    })
    return max
  })
  const vp = page.viewportSize()!
  await page.setViewportSize({ width: vp.width, height: vp.height + extra })
  await page.waitForTimeout(1200)
  await page.mouse.move(0, 0)
  await page.screenshot({ path })
  await page.setViewportSize(vp)
}

const tile = (page: Page, label: string) =>
  page.locator('div.rounded-lg').filter({ has: page.getByText(label, { exact: true }) }).first()

test('insights page renders and matches the API', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  await expect(page.getByRole('heading', { name: 'Customer Insights', level: 1 })).toBeVisible({ timeout: 20_000 })
  // Stack orders are old, so 90D is empty; tie the All period to the API instead.
  const s = await api<{ kpis: { paid_orders: { value: number }; active_customers: { value: number } } }>(
    page,
    '/reports/customers/summary?period=all'
  )
  expect(s.kpis.paid_orders.value).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(tile(page, 'Paid orders').getByText(s.kpis.paid_orders.value.toLocaleString('en-US'), { exact: true })).toBeVisible()
  await expect(tile(page, 'Active customers').getByText(s.kpis.active_customers.value.toLocaleString('en-US'), { exact: true })).toBeVisible()
  await expect(page.locator('.recharts-wrapper').first()).toBeVisible()
  await shootFull(page, `${SHOTS}/01-insights.png`)
})

test('customer dashboard tab opens from the at-risk list or the list', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const risk = await api<{ rows: { key: string; name: string; email: string }[] }>(page, '/reports/customers/at-risk')
  const list = await api<{ rows: { key: string; name: string; email: string }[] }>(page, '/reports/customers/list?period=all&page_size=1')
  const target = risk.rows[0] ?? list.rows[0]
  test.skip(!target, 'no customers with paid orders on this stack')
  if (risk.rows[0]) {
    await page.getByText(target.name, { exact: true }).first().click()
  } else {
    await page.goto('/#accumark-tools/customers')
    // The Customers page labels rows by email, so match on that.
    await page.getByText(target.email, { exact: true }).first().click()
  }
  // Detail-view-only evidence: neither control exists on the Insights page.
  await expect(page.getByRole('button', { name: /Back to Customers/ })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('tab', { name: 'Dashboard' }).click()
  // The opened customer is the clicked one: check the header card, not the page.
  const header = page.locator('[data-slot="card"]').first()
  await expect(header.getByText(target.email).or(header.getByText(target.name)).first()).toBeVisible()
  await expect(page.getByText(/Lifetime spend/i)).toBeVisible({ timeout: 20_000 })
  const d = await api<{ kpis: { lifetime: string; orders: number } }>(page, `/reports/customers/${encodeURIComponent(target.key)}`)
  const money = (v: string) => {
    const n = Number(v)
    return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n).toLocaleString('en-US')}`
  }
  await expect(tile(page, 'Lifetime spend').getByText(money(d.kpis.lifetime), { exact: true })).toBeVisible()
  await expect(tile(page, 'Paid orders').getByText(String(d.kpis.orders), { exact: true })).toBeVisible()
  await shootFull(page, `${SHOTS}/02-customer-dashboard.png`)
})

test('agent feed responds', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const r = await api<{ events: unknown[] }>(page, `/reports/customers/changes?since=${encodeURIComponent(since)}`)
  expect(Array.isArray(r.events)).toBeTruthy()
})
