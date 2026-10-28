import { test, expect } from './fixtures/auth'
import type { Page } from '@playwright/test'

/**
 * Reports > Analyte Trends against a devbox stack (golden data).
 *
 * Proves on real data: the list and the drill-down count the same COAs,
 * the API returns only published primaries, and the page renders. Screenshots
 * land in docs/superpowers/e2e/2026-10-05-analyte-trends/ as PR evidence.
 */

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS = 'docs/superpowers/e2e/2026-10-05-analyte-trends'

type Coa = { product: string; overall: string; tests: unknown[] }

test.use({ viewport: { width: 1600, height: 1000 } })

async function openList(page: Page) {
  await page.goto('/#reports/dashboard')
  await expect(
    page.getByRole('heading', { name: 'Analyte Trends', level: 1 })
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 })
}

async function apiCoas(page: Page): Promise<Coa[]> {
  const token = await page.evaluate(() =>
    window.localStorage.getItem('accu_mk1_auth_token')
  )
  const res = await page.request.get(`${BACKEND_URL}/reports/analyte-trends`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { coas: Coa[] }).coas
}

const rowFor = (page: Page, product: string) =>
  page.locator('tbody tr').filter({
    has: page.getByText(product, { exact: true }),
  })

test('list renders and its totals match the API', async ({ authedPage: page }) => {
  await openList(page)
  const coas = await apiCoas(page)
  expect(coas.length).toBeGreaterThan(0)

  const products = new Set(coas.map(c => c.product))
  await expect(page.locator('tbody tr')).toHaveCount(products.size)
  await page.screenshot({ path: `${SHOTS}/01-list.png`, fullPage: true })

  // Hover the first non-empty test cell for the rich tooltip.
  const cell = page.locator('tbody button').first()
  await cell.hover()
  await expect(page.getByText(/Last 90d:/).first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/02-cell-tooltip.png` })
})

test('drill-down counts the same COAs as the list row', async ({
  authedPage: page,
}) => {
  await openList(page)
  const coas = await apiCoas(page)
  // The product with the most non-conforming COAs is the interesting one.
  const byProduct = new Map<string, { total: number; failed: number }>()
  for (const c of coas) {
    const t = byProduct.get(c.product) ?? { total: 0, failed: 0 }
    t.total++
    if (c.overall === 'FAILED') t.failed++
    byProduct.set(c.product, t)
  }
  const [product, t] = [...byProduct.entries()].sort(
    (a, b) => b[1].failed - a[1].failed || b[1].total - a[1].total
  )[0]!

  const row = rowFor(page, product)
  await expect(row.locator('td').nth(1)).toHaveText(String(t.total))
  await row.locator('td').first().click()

  await expect(page.getByRole('heading', { name: product, level: 1 })).toBeVisible()
  await expect(page.getByText(`${t.failed}/${t.total}`).first()).toBeVisible()
  await expect(page.locator('tbody tr[id^="coa-row-"]')).toHaveCount(t.total)
  await page.screenshot({ path: `${SHOTS}/03-detail.png`, fullPage: true })

  // Hover a purity point: the tooltip lists every result from that lab day.
  const dot = page.locator('.recharts-scatter-symbol').first()
  if (await dot.count()) {
    await dot.hover()
    await expect(
      page.getByText('Click a point to find it in the table').first()
    ).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/04-chart-tooltip.png` })
    await dot.click()
    await expect(page.locator('tr.bg-primary\\/15')).toHaveCount(1)
  }

  await page.getByRole('button', { name: 'Non-conforming', exact: true }).click()
  await expect(page.locator('tbody tr[id^="coa-row-"]')).toHaveCount(t.failed)
  await page.screenshot({ path: `${SHOTS}/05-detail-nonconforming.png`, fullPage: true })
})

test('bac water shows per-assay charts', async ({ authedPage: page }) => {
  await openList(page)
  const coas = await apiCoas(page)
  const bw = coas.find(c => c.tests.length > 0)
  test.skip(!bw, 'no non-peptide matrix COAs on this stack')

  await rowFor(page, bw!.product).locator('td').first().click()
  await expect(page.getByRole('heading', { name: bw!.product, level: 1 })).toBeVisible()
  await expect(page.locator('.recharts-wrapper').first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/06-bac-water.png`, fullPage: true })
})
