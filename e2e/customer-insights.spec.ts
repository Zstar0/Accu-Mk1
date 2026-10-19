import { test, expect } from './fixtures/auth'
import type { Page } from '@playwright/test'

/**
 * AccuMark Tools > Customer Insights against a devbox stack. Screenshots land
 * in docs/superpowers/e2e/2026-10-19-customer-insights-tabs/ as PR evidence
 * (the 2026-10-05 run's shots stay in their own directory).
 */

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS = 'docs/superpowers/e2e/2026-10-19-customer-insights-tabs'
test.use({ viewport: { width: 1600, height: 1000 } })

async function api<T>(page: Page, path: string): Promise<T> {
  const token = await page.evaluate(() =>
    window.localStorage.getItem('accu_mk1_auth_token')
  )
  const res = await page.request.get(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
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
  page
    .locator('div.rounded-lg')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()

test('insights page renders and matches the API', async ({
  authedPage: page,
}) => {
  await page.goto('/#accumark-tools/customer-insights')
  await expect(
    page.getByRole('heading', { name: 'Customer Insights', level: 1 })
  ).toBeVisible({ timeout: 20_000 })
  // Stack orders are old, so 90D is empty; tie the All period to the API instead.
  const s = await api<{
    kpis: {
      paid_orders: { value: number }
      active_customers: { value: number }
    }
    product_prices: { product: string; avg_price: string }[]
  }>(page, '/reports/customers/summary?period=all')
  expect(s.kpis.paid_orders.value).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(
    tile(page, 'Paid orders').getByText(
      s.kpis.paid_orders.value.toLocaleString('en-US'),
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    tile(page, 'Active customers').getByText(
      s.kpis.active_customers.value.toLocaleString('en-US'),
      { exact: true }
    )
  ).toBeVisible()
  await expect(page.locator('.recharts-wrapper').first()).toBeVisible()
  const top = s.product_prices[0]
  expect(top, 'stack has paid line items').toBeTruthy()
  const priceRow = page
    .getByRole('row')
    .filter({ has: page.getByText(top.product, { exact: true }) })
    .first()
  await expect(priceRow).toContainText(`$${Number(top.avg_price).toFixed(2)}`)
  await shootFull(page, `${SHOTS}/01-insights.png`)
})

test('customer dashboard tab opens from the at-risk list or the list', async ({
  authedPage: page,
}) => {
  await page.goto('/#accumark-tools/customer-insights')
  const risk = await api<{
    rows: { key: string; name: string; email: string }[]
  }>(page, '/reports/customers/at-risk')
  const list = await api<{
    rows: { key: string; name: string; email: string }[]
  }>(page, '/reports/customers/list?period=all&page_size=1')
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
  // Opened from Insights the back button says so; from the Customers page it does not.
  await expect(
    page.getByRole('button', {
      name: risk.rows[0] ? /Back to Insights/ : /Back to Customers/,
    })
  ).toBeVisible({ timeout: 20_000 })
  await page.getByRole('tab', { name: 'Dashboard' }).click()
  // The opened customer is the clicked one: check the header card, not the page.
  const header = page.locator('[data-slot="card"]').first()
  await expect(
    header.getByText(target.email).or(header.getByText(target.name)).first()
  ).toBeVisible()
  await expect(page.getByText(/Lifetime spend/i)).toBeVisible({
    timeout: 20_000,
  })
  const d = await api<{ kpis: { lifetime: string; orders: number } }>(
    page,
    `/reports/customers/${encodeURIComponent(target.key)}`
  )
  const money = (v: string) => {
    const n = Number(v)
    return n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : `$${Math.round(n).toLocaleString('en-US')}`
  }
  await expect(
    tile(page, 'Lifetime spend').getByText(money(d.kpis.lifetime), {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    tile(page, 'Paid orders').getByText(String(d.kpis.orders), { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'What they pay' })
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Coupons' })).toBeVisible()
  await expect(page.getByText('Sales rep', { exact: true })).toBeVisible()
  await shootFull(page, `${SHOTS}/02-customer-dashboard.png`)
})

test('agent feed responds', async ({ authedPage: page }) => {
  await page.goto('/#accumark-tools/customer-insights')
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const r = await api<{ events: unknown[] }>(
    page,
    `/reports/customers/changes?since=${encodeURIComponent(since)}`
  )
  expect(Array.isArray(r.events)).toBeTruthy()
})

test('tabs render, cells degrade without Close or Plain, cohort drill-down matches the grid', async ({
  authedPage: page,
}) => {
  await page.goto('/#accumark-tools/customer-insights')
  await expect(
    page.getByRole('heading', { name: 'Customer Insights', level: 1 })
  ).toBeVisible({ timeout: 20_000 })
  for (const name of [/^At risk/, /^New customers/, /^Cohorts$/])
    await expect(page.getByRole('tab', { name })).toBeVisible()

  // Stacks have no Close, so every Last CRM cell reads n/a and the page still loads.
  const panel = page.getByRole('tabpanel')
  const crmCellsAllNa = async () => {
    const table = panel
      .locator('table')
      .filter({ has: page.getByRole('columnheader', { name: 'Last CRM' }) })
    const col = (await table.locator('thead th').allTextContents()).findIndex(
      t => t.trim() === 'Last CRM'
    )
    const cells = table.locator(`tbody tr td:nth-child(${col + 1})`)
    await expect(cells.first()).toHaveText('n/a', { timeout: 20_000 })
    await expect(cells.filter({ hasNotText: 'n/a' })).toHaveCount(0)
  }
  const risk = await api<{ rows: unknown[] }>(
    page,
    '/reports/customers/at-risk'
  )
  if (risk.rows.length) await crmCellsAllNa()
  await shootFull(page, `${SHOTS}/01-at-risk.png`)

  await page.getByRole('tab', { name: /^New customers/ }).click()
  await expect(
    panel.getByText(
      'First testing order in this period, ranked by lifetime spend'
    )
  ).toBeVisible()
  await shootFull(page, `${SHOTS}/02-new-customers.png`)

  await page.getByRole('tab', { name: /^Cohorts$/ }).click()
  const c = await api<{ rows: { cohort: string; size: number }[] }>(
    page,
    '/reports/customers/cohorts?exclude_launch_accounts=true'
  )
  const first = c.rows[0]
  expect(first, 'stack has at least one cohort').toBeTruthy()
  await panel.getByRole('button', { name: first.cohort, exact: true }).click()
  await expect(
    panel.getByRole('heading', {
      name: `${first.cohort} cohort · ${first.size} customers`,
    })
  ).toBeVisible({ timeout: 20_000 })
  const members = await api<{ total: number }>(
    page,
    `/reports/customers/list?cohort=${encodeURIComponent(first.cohort)}&exclude_launch_accounts=true&page_size=1`
  )
  expect(members.total).toBe(first.size)
  // The member table carries the same check, so it runs even with no at-risk rows.
  await crmCellsAllNa()
  await shootFull(page, `${SHOTS}/03-cohorts.png`)
})
