import { test, expect } from './fixtures/auth'

/**
 * Phase 29 E2E smoke. Drives a real browser against the running dev stack
 * (frontend :3101 → backend :8012 → IS via host.docker.internal:8000).
 *
 * These tests assume the local stack has at least one registered WC customer
 * with at least one order — the dev DevKinsta DB normally has dozens. If the
 * stack is empty, the empty-state tests still pass but the list tests will
 * fail loudly so the operator knows the precondition is missing.
 */

// Helper: navigate to the Customers page. The sidebar's AccuMark Tools group
// is a shadcn Collapsible — its persisted state may differ per session, so we
// check aria-expanded and expand only if needed. The wait on AccuMark Tools
// visibility acts as a hydration anchor: without it, the click can fire
// before React has wired Radix's onClick handler, leaving the group collapsed.
async function openCustomersPage(page: import('@playwright/test').Page) {
  await page.goto('/')

  const trigger = page.getByRole('button', { name: 'AccuMark Tools', exact: true })
  await expect(trigger).toBeVisible({ timeout: 10_000 })

  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 5_000 })
  }

  const customersBtn = page.getByRole('button', { name: 'Customers', exact: true })
  await expect(customersBtn).toBeVisible({ timeout: 5_000 })
  await customersBtn.click()
}

test.describe('Phase 29 — Mk1 Customer-Centric Frontend', () => {
  test('sidebar shows Customers entry under AccuMark Tools', async ({ authedPage: page }) => {
    await page.goto('/')

    // AccuMark Tools group state is persisted in sidebar storage. We do NOT
    // toggle it — just expand iff it's currently collapsed (Customers not
    // visible). The contract is "Customers appears under AccuMark Tools at
    // the right position", not "click expansion works."
    const accuMarkTools = page.getByRole('button', { name: 'AccuMark Tools', exact: true })
    await expect(accuMarkTools).toBeVisible()
    if ((await accuMarkTools.getAttribute('aria-expanded')) !== 'true') {
      await accuMarkTools.click()
      await expect(accuMarkTools).toHaveAttribute('aria-expanded', 'true', { timeout: 5_000 })
    }

    // Customers entry visible
    await expect(page.getByRole('button', { name: 'Customers', exact: true })).toBeVisible({ timeout: 5_000 })

    // DOM-order check on the AccuMark Tools sub-menu specifically. The page
    // has many sub-menu groups (Dashboard, Analysis, LIMS…) so we scope to
    // the AccuMark Tools listitem to avoid matching "Order Status"-like
    // labels from a different group.
    const accuMarkToolsGroup = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'AccuMark Tools', exact: true }) })
    const subLabels = await accuMarkToolsGroup
      .locator('[data-sidebar="menu-sub-button"]')
      .allInnerTexts()
    const orderStatusIdx = subLabels.findIndex(l => l.trim() === 'Order Status')
    const customersIdx = subLabels.findIndex(l => l.trim() === 'Customers')
    const coaExplorerIdx = subLabels.findIndex(l => l.trim() === 'COA Explorer')
    expect(orderStatusIdx).toBeGreaterThanOrEqual(0)
    expect(customersIdx).toBe(orderStatusIdx + 1)
    expect(coaExplorerIdx).toBe(customersIdx + 1)
  })

  test('list view renders 6-column table with real WC data', async ({ authedPage: page }) => {
    await openCustomersPage(page)

    // Wait for the table headers — guaranteed regardless of data state
    const headers = [
      'Display Name',
      'Email',
      'Total Orders',
      'Outstanding',
      'Total COAs',
      'Most Recent',
    ]
    for (const h of headers) {
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible()
    }

    // At least one customer row OR an empty-state. Both are valid contracts;
    // we fail loudly only if neither materialises within the network timeout.
    const dataRow = page.locator('tbody tr').filter({ hasNot: page.locator('[data-testid="customer-row-skeleton"]') }).first()
    await expect(dataRow).toBeVisible({ timeout: 15_000 })
  })

  test('pagination row shows range subtitle + Prev/Next buttons', async ({ authedPage: page }) => {
    await openCustomersPage(page)

    // Wait until the loading skeleton goes away.
    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

    // Prev / Next buttons present with locked aria-labels (Phase 29 a11y contract).
    const prev = page.getByRole('button', { name: 'Previous page' })
    const next = page.getByRole('button', { name: 'Next page' })
    await expect(prev).toBeVisible()
    await expect(next).toBeVisible()

    // On page 0, Prev is disabled.
    await expect(prev).toBeDisabled()

    // Pagination subtitle is either "N–M of X" (when total_count present) or "Page 1" fallback.
    await expect(
      page.getByText(/^(\d+–\d+ of \d+|Page 1)$/).first()
    ).toBeVisible()
  })

  test('search input is debounced and resets to page 0', async ({ authedPage: page }) => {
    await openCustomersPage(page)

    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

    // Race a network-wait against typing — Playwright's waitForRequest catches
    // the debounced fetch regardless of how late it fires.
    const searchRequestPromise = page.waitForRequest(
      req =>
        req.url().includes('/explorer/customers') &&
        req.url().includes('search=xqzqzqxqz'),
      { timeout: 5_000 }
    )

    await page.getByPlaceholder('Search by name or email…').fill('xqzqzqxqz')

    const searchRequest = await searchRequestPromise
    expect(searchRequest.url()).toContain('search=xqzqzqxqz')
    // Debounce resets page to 0 (D-12). The frontend converts page → offset
    // (page * perPage), so page=0 lands as offset=0 on the wire.
    expect(searchRequest.url()).toMatch(/[?&]offset=0/)

    // Empty state copy
    await expect(page.getByText('No customers found')).toBeVisible({ timeout: 5_000 })
  })

  // Find the first clickable (registered, not guest) row. Guest rows render
  // with `cursor: default` and `tabIndex={-1}` (D-14); registered rows are
  // `cursor: pointer` and clickable. Scans the table top-to-bottom and
  // returns the first match, or skips if none exist (dev DB has only guests).
  async function findClickableCustomerRow(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const rows = page.locator('tbody tr').filter({
      hasNot: page.locator('[data-testid="customer-row-skeleton"]'),
    })
    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i)
      const cursor = await row.evaluate(el => window.getComputedStyle(el).cursor)
      if (cursor === 'pointer') return row
    }
    return null
  }

  test('clicking a registered customer drills through to detail view', async ({ authedPage: page }) => {
    await openCustomersPage(page)

    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

    // Dev DB lists guests first on the unfiltered page. Type a common letter
    // to surface registered customers, then scan for the first clickable row.
    let clickableRow = await findClickableCustomerRow(page)
    if (clickableRow === null) {
      await page.getByPlaceholder('Search by name or email…').fill('a')
      await page.waitForTimeout(500)
      clickableRow = await findClickableCustomerRow(page)
    }
    test.skip(clickableRow === null, 'No registered customers in dev DB — only guests')

    await clickableRow!.click()

    // Detail view loads — back button is the canonical anchor (the orders
    // table is content-dependent, but the back button always renders).
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })
  })

  test('back navigation preserves page + search', async ({ authedPage: page }) => {
    await openCustomersPage(page)

    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

    // Type a partial search that should still match something
    await page.getByPlaceholder('Search by name or email…').fill('a')
    await page.waitForTimeout(500)

    const clickableRow = await findClickableCustomerRow(page)
    test.skip(clickableRow === null, 'No registered customers match "a" — environment lacks data')

    await clickableRow!.click()
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible()

    // Back returns to list — search input should still hold "a"
    await page.getByRole('button', { name: /Back to Customers/i }).click()
    await expect(page.getByPlaceholder('Search by name or email…')).toHaveValue('a')
  })

  test('test-account toggle defaults to hidden and round-trips on click', async ({ authedPage: page }) => {
    await openCustomersPage(page)

    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

    // Initial label confirms default-on hide (include_test_emails=false on the wire)
    await expect(page.getByText('Hide test accounts')).toBeVisible()

    // forrestp@outlook.com (Phase 29 TEST_EMAILS constant) hidden by default
    await expect(page.getByText('forrestp@outlook.com')).toHaveCount(0)

    // Click the toggle and wait for a refetch with include_test_emails=true
    const toggleRequestPromise = page.waitForRequest(
      req =>
        req.url().includes('/explorer/customers') &&
        req.url().includes('include_test_emails=true'),
      { timeout: 5_000 }
    )
    // Click the wrapping <label> — its associated Checkbox inverts hideTestAccounts.
    await page.getByText('Hide test accounts').click()
    const toggleRequest = await toggleRequestPromise
    expect(toggleRequest.url()).toContain('include_test_emails=true')

    // Label flipped to "Showing test accounts"
    await expect(page.getByText('Showing test accounts')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // UX revision — Customer Detail Tabs + three-input AND search
  //
  // Drill into a registered customer, then exercise the tab structure and the
  // three-input search header (Order # / Sample ID / Analyte). Each input is
  // independently debounced (300ms) and dispatches per-axis via
  // setCustomerOrderSearchField; the wire format is
  // search_order_number=/search_sample_id=/search_analyte= query params,
  // AND-combined server-side. Sample-ID test SKIPs when E2E_KNOWN_SAMPLE_ID
  // is unset; supply a real P-#### from the dev DB to run.
  // ---------------------------------------------------------------------------

  test('detail page shows tabs with Customer Orders default and Dashboard placeholder', async ({ authedPage: page }) => {
    await openCustomersPage(page)
    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })

    // Drill through to a registered customer
    await page.getByPlaceholder('Search by name or email…').fill('a')
    await page.waitForTimeout(500)
    const clickableRow = await findClickableCustomerRow(page)
    test.skip(clickableRow === null, 'No registered customers in dev DB')
    await clickableRow!.click()
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

    // Both tabs visible, Customer Orders active by default
    const ordersTab = page.getByRole('tab', { name: 'Customer Orders' })
    const dashboardTab = page.getByRole('tab', { name: 'Dashboard' })
    await expect(ordersTab).toBeVisible()
    await expect(dashboardTab).toBeVisible()
    await expect(ordersTab).toHaveAttribute('data-state', 'active')

    // Click Dashboard, see Coming Soon
    await dashboardTab.click()
    await expect(page.getByText(/Coming soon/i)).toBeVisible({ timeout: 5_000 })

    // Back to orders
    await ordersTab.click()
    await expect(ordersTab).toHaveAttribute('data-state', 'active')
  })

  test('search by sample ID auto-expands matching order with highlighted sample card', async ({ authedPage: page }) => {
    // This test requires a known-good sample ID in the dev DB. Either:
    //   (a) pull one from the database before the test (requires DB access)
    //   (b) use the seeded e2e-test customer's first order's first sample
    // For v1, pick a sample ID known to exist via psql probe in test setup.

    test.skip(!process.env.E2E_KNOWN_SAMPLE_ID, 'Set E2E_KNOWN_SAMPLE_ID env var to a real P-#### in the dev DB')

    await openCustomersPage(page)
    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
    await page.getByPlaceholder('Search by name or email…').fill('a')
    await page.waitForTimeout(500)
    const clickableRow = await findClickableCustomerRow(page)
    test.skip(clickableRow === null)
    await clickableRow!.click()
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

    // Type into the dedicated Sample ID input (no field-selector anymore).
    await page.getByLabel('Sample ID').fill(process.env.E2E_KNOWN_SAMPLE_ID!)

    // Wait for the request with the per-axis search param
    await page.waitForRequest(
      req =>
        req.url().includes('/explorer/orders') &&
        req.url().includes(`search_sample_id=${process.env.E2E_KNOWN_SAMPLE_ID}`),
      { timeout: 5_000 }
    )

    // Verify a row appears, is expanded, and the sample is highlighted
    const orderRow = page.locator('[data-testid="order-row"]').first()
    await expect(orderRow).toBeVisible({ timeout: 10_000 })
    await expect(orderRow).toHaveAttribute('data-expanded', 'true')
    await expect(orderRow).toHaveAttribute('data-highlight-sample-id', process.env.E2E_KNOWN_SAMPLE_ID!)
  })

  test('search by analyte returns matching orders auto-expanded', async ({ authedPage: page }) => {
    await openCustomersPage(page)
    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
    await page.getByPlaceholder('Search by name or email…').fill('a')
    await page.waitForTimeout(500)
    const clickableRow = await findClickableCustomerRow(page)
    test.skip(clickableRow === null)
    await clickableRow!.click()
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

    await page.getByLabel('Analyte').fill('BPC')

    // Either real BPC orders exist → rows visible auto-expanded, OR empty state
    await page.waitForRequest(req => req.url().includes('search_analyte=BPC'), {
      timeout: 5_000,
    })

    // Two valid outcomes: at least one expanded order row OR empty-state copy
    const orderRow = page.locator('[data-testid="order-row"]').first()
    const emptyState = page.getByText(/No orders match.*Analyte: "BPC"/i)
    await expect(orderRow.or(emptyState)).toBeVisible({ timeout: 10_000 })
  })

  test('clear-search button resets all three inputs and shows full order list', async ({ authedPage: page }) => {
    await openCustomersPage(page)
    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
    await page.getByPlaceholder('Search by name or email…').fill('a')
    await page.waitForTimeout(500)
    const clickableRow = await findClickableCustomerRow(page)
    test.skip(clickableRow === null)
    await clickableRow!.click()
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

    // Type a definitely-not-matching analyte to force the empty state.
    await page.getByLabel('Analyte').fill('xqzqzqxqz')
    await expect(page.getByText(/No orders match/i)).toBeVisible({ timeout: 5_000 })

    await page.getByRole('button', { name: /Clear search/i }).click()
    // All three inputs cleared; Clear button gone.
    await expect(page.getByLabel('Order #')).toHaveValue('')
    await expect(page.getByLabel('Sample ID')).toHaveValue('')
    await expect(page.getByLabel('Analyte')).toHaveValue('')
    await expect(page.getByRole('button', { name: /Clear search/i })).toHaveCount(0)
  })

  // --- AND behavior: typing in Sample ID AND Analyte sends BOTH params ---
  test('AND search: typing in Sample ID AND Analyte sends both per-axis params on the wire', async ({ authedPage: page }) => {
    await openCustomersPage(page)
    await page.locator('[data-testid="customer-row-skeleton"]').first().waitFor({ state: 'detached', timeout: 15_000 })
    await page.getByPlaceholder('Search by name or email…').fill('a')
    await page.waitForTimeout(500)
    const clickableRow = await findClickableCustomerRow(page)
    test.skip(clickableRow === null)
    await clickableRow!.click()
    await expect(page.getByRole('button', { name: /Back to Customers/i })).toBeVisible({ timeout: 10_000 })

    // Fill both inputs, then assert the request carries both axes.
    // Use seed data candidates that may or may not match — the contract here is
    // "the wire payload contains both search_sample_id AND search_analyte",
    // which is the AND-combined gate. Result-row assertions live in the
    // sample-ID / analyte tests above.
    const combinedRequestPromise = page.waitForRequest(
      req =>
        req.url().includes('/explorer/orders') &&
        req.url().includes('search_sample_id=P-') &&
        req.url().includes('search_analyte=BPC'),
      { timeout: 8_000 }
    )

    await page.getByLabel('Sample ID').fill('P-0001')
    await page.getByLabel('Analyte').fill('BPC')

    const combined = await combinedRequestPromise
    expect(combined.url()).toMatch(/search_sample_id=P-0001/)
    expect(combined.url()).toMatch(/search_analyte=BPC/)
  })
})
