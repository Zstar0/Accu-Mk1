import { test, expect } from './fixtures/auth'

/**
 * Mk1-native retest: sample details > Actions > Retest.
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

async function openRetestDialog(page: import('@playwright/test').Page) {
  await page.goto(`/#senaite/sample-details?id=${SAMPLE_ID}`)
  await expect(
    page.getByRole('heading', { name: SAMPLE_ID!, level: 1 })
  ).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByTestId('retest-menu').click()

  const dialog = page.getByRole('dialog', { name: /Retest/ })
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

  test('shows the customer block with live WordPress prices', async ({
    authedPage: page,
  }) => {
    const dialog = await openRetestDialog(page)

    // Customer / order block comes from WP retest-context via IS.
    await expect(dialog.getByText(/^Order \d+/)).toBeVisible({
      timeout: 15_000,
    })
    await expect(dialog.getByText(/\S+@\S+\.\S+/)).toBeVisible()
    await expect(dialog.getByText(/Customer .*unavailable/)).toHaveCount(0)

    // Every original profile starts as Carry: nothing to do, no fee section, Create disabled.
    const carry = dialog.getByRole('button', { name: 'Carry', exact: true })
    expect(await carry.count()).toBeGreaterThan(0)
    for (const b of await carry.all())
      await expect(b).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByRole('radiogroup', { name: 'Fee' })).toHaveCount(0)
    await expect(dialog.getByText(/^Delta: \$0\.00$/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()

    // Setting one profile to Retest reveals the fee radio with the live retest price.
    await dialog
      .getByRole('button', { name: 'Retest', exact: true })
      .first()
      .click()
    const paid = dialog.getByRole('radio', { name: /^Paid \(\$[\d.]+\)$/ })
    await expect(paid).toBeChecked()
    const fee = (await dialog
      .getByText(/^Paid \(\$[\d.]+\)$/)
      .textContent())!.match(/\$([\d.]+)/)![1]
    await expect(dialog.getByText(`Delta: $${fee}`)).toBeVisible()
  })

  test('HPLC retest plus an add-on prices the delta and creates the WP order', async ({
    authedPage: page,
  }) => {
    // Retest options wait on IS -> WP for prices, and Create goes Mk1 -> IS -> WP.
    test.setTimeout(120_000)
    const dialog = await openRetestDialog(page)
    await expect(dialog.getByText(/^Order \d+/)).toBeVisible({
      timeout: 15_000,
    })

    // Retest the first profile row (HPLC on the stack fixture) and add the first priced add-on.
    await dialog
      .getByRole('button', { name: 'Retest', exact: true })
      .first()
      .click()
    const addon = dialog
      .getByRole('checkbox', { name: /\(\$[\d.]+ · \d+ vials\)/ })
      .first()
    await addon.check()

    // Fee and add-on prices are rendered in their labels; the Delta must be their sum.
    const price = (text: string | null) =>
      Number(text?.match(/\$([\d.]+)/)?.[1] ?? NaN)
    const fee = price(
      await dialog.getByText(/^Paid \(\$[\d.]+\)$/).textContent()
    )
    const addonPrice = price(
      await dialog
        .getByText(/\(\$[\d.]+ · \d+ vials\)/)
        .first()
        .textContent()
    )
    expect(fee).toBeGreaterThan(0)
    expect(addonPrice).toBeGreaterThan(0)
    await expect(
      dialog.getByText(`Delta: $${(fee + addonPrice).toFixed(2)}`)
    ).toBeVisible()

    await dialog
      .getByRole('textbox', { name: 'Reason' })
      .fill('e2e: HPLC rerun + add-on')

    const created = page.waitForResponse(
      r =>
        r.url().includes(`/api/samples/${SAMPLE_ID}/retest`) &&
        r.request().method() === 'POST',
      { timeout: 60_000 }
    )
    await dialog.getByRole('button', { name: 'Create' }).click()
    const response = await created
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as RetestCreated
    expect(body.order_number).toMatch(/\d+/)
    expect(['pending', 'completed']).toContain(body.status)

    await expect(dialog).toBeHidden({ timeout: 10_000 })
  })
})
