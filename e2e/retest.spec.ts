import { test, expect } from './fixtures/auth'

/**
 * Mk1-native retest overlay v2: sample details > Actions > Retest.
 *
 * Runs against a devbox stack with IS and WordPress mounted (see e2e/README.md).
 * Precondition: E2E_RETEST_SAMPLE_ID names a published sample that IS can map to
 * a WooCommerce order (on stack `retest` that is P-9001 -> order 3134).
 *
 * Create is idempotent per spec (Mk1 sends Idempotency-Key retest:<sample>:<hash>),
 * so re-running this spec replays the same WordPress order instead of minting
 * another one. Payment is not driven here: it happens in WordPress.
 */

const SAMPLE_ID = process.env.E2E_RETEST_SAMPLE_ID

type RetestCreated = {
  order_id: number
  order_number: string
  status: string
  payment_url?: string | null
}

const price = (text: string | null) =>
  Number(text?.match(/\$([\d.]+)/)?.[1] ?? NaN)

async function openRetestDialog(page: import('@playwright/test').Page) {
  await page.goto(`/#senaite/sample-details?id=${SAMPLE_ID}`)
  await expect(
    page.getByRole('heading', { name: SAMPLE_ID!, level: 1 })
  ).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByTestId('retest-menu').click()

  const dialog = page.getByRole('dialog', { name: /Re-test|Add services/ })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

test.describe('Mk1-native retest dialog', () => {
  // The overlay is taller than Playwright's 1280x720 default and the body scroll is
  // locked while it is open, so Create never scrolls into view at that height.
  test.use({ viewport: { width: 1400, height: 1000 } })
  test.skip(
    !SAMPLE_ID,
    'Set E2E_RETEST_SAMPLE_ID to a published sample IS can map to a WP order'
  )

  test('Re-test tab: customer block, fee on first Re-test, total = fee, creates the WP order', async ({
    authedPage: page,
  }) => {
    // Retest options wait on IS -> WP for prices, and Create goes Mk1 -> IS -> WP.
    test.setTimeout(120_000)
    const dialog = await openRetestDialog(page)
    await expect(
      dialog.getByRole('heading', { name: `Re-test ${SAMPLE_ID}` })
    ).toBeVisible()

    // Customer / order block comes from WP retest-context via IS.
    const block = dialog.getByTestId('retest-context-block')
    // Anchored: pending retest order rows in the same block read "Order <n> · ...".
    await expect(block.getByText(/^Order \d+$/)).toBeVisible({
      timeout: 15_000,
    })
    await expect(block.getByText(/\S+@\S+\.\S+/)).toBeVisible()
    await expect(dialog.getByText(/Customer .*unavailable/)).toHaveCount(0)

    // Nothing re-tested yet: no fee radio, Create disabled with its reason.
    await expect(
      dialog.getByRole('radiogroup', { name: 'Retest fee' })
    ).toHaveCount(0)
    await expect(dialog.getByTestId('retest-disabled-reason')).toHaveText(
      'Tick at least one Re-test'
    )
    const create = dialog.getByRole('button', { name: 'Create retest order' })
    await expect(create).toBeDisabled()

    // Tick Re-test on the first profile row (HPLC on the stack fixture).
    await dialog
      .getByRole('checkbox', { name: /^Re-test / })
      .first()
      .click()
    const charged = dialog.getByRole('radio', { name: /^Charged \$[\d.]+$/ })
    await expect(charged).toBeChecked()
    const fee = price(
      await dialog.getByText(/^Charged \$[\d.]+$/).textContent()
    )
    expect(fee).toBeGreaterThan(0)
    await expect(dialog.getByTestId('retest-summary-total')).toHaveText(
      `Total$${fee.toFixed(2)}`
    )

    await dialog
      .getByRole('textbox', { name: 'Reason (required)' })
      .fill('e2e: HPLC rerun')

    const created = page.waitForResponse(
      r =>
        r.url().includes(`/api/samples/${SAMPLE_ID}/retest`) &&
        r.request().method() === 'POST',
      { timeout: 60_000 }
    )
    await create.click()
    const response = await created
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as RetestCreated
    expect(body.order_number).toMatch(/\d+/)
    // Idempotent replay: a re-run returns the same order, possibly completed.
    expect(['pending', 'completed']).toContain(body.status)

    await expect(dialog).toBeHidden({ timeout: 10_000 })
  })

  test('Add services tab: fixed title, catalog add-ons, no fee radio', async ({
    authedPage: page,
  }) => {
    const dialog = await openRetestDialog(page)
    await expect(
      dialog.getByTestId('retest-context-block').getByText(/^Order \d+$/)
    ).toBeVisible({ timeout: 15_000 })

    await dialog.getByRole('tab', { name: 'Add services' }).click()
    await expect(
      dialog.getByRole('heading', { name: `Add services to ${SAMPLE_ID}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole('radiogroup', { name: 'Retest fee' })
    ).toHaveCount(0)
    await expect(dialog.getByTestId('retest-disabled-reason')).toHaveText(
      'Tick at least one service'
    )
    await expect(
      dialog.getByRole('button', { name: 'Create add-on order' })
    ).toBeDisabled()
  })
})
