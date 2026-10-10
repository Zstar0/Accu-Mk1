import { test, expect } from './fixtures/auth'

/**
 * PB-1062 (2026-10-09): a native blend vial whose every quantity is 0 has
 * nothing to calculate, so its two blend aggregates stay empty. They must take
 * a typed value while empty, then lock once saved.
 *
 * Precondition: E2E_BLEND_VIAL_ID names a native blend vial whose slot results
 * are all submitted with quantity 0 and whose aggregates are still empty
 * (stack `blendna`: PB-1003-S01). Saving is a real submit, so the spec runs once
 * per fresh vial.
 */

const VIAL = process.env.E2E_BLEND_VIAL_ID
const SHOTS = 'docs/superpowers/e2e/2026-10-09-blend-na'
const AGGREGATES = [
  'HPLC Blend Purity (mass-weighted)',
  'HPLC Blend Total Quantity',
]

test.use({ viewport: { width: 1400, height: 1000 } })

test('empty calculated blend aggregates take a typed value, then lock', async ({
  authedPage: page,
}) => {
  test.skip(!VIAL, 'E2E_BLEND_VIAL_ID not set')
  await page.goto(`/#senaite/sample-details?id=${VIAL}`)

  for (const title of AGGREGATES) {
    await expect(page.getByLabel(`Edit result for ${title}`)).toBeVisible({
      timeout: 20_000,
    })
  }
  await expect(
    page.getByLabel('Blend purity is calculated').first()
  ).toBeVisible()
  await expect(
    page.getByLabel('Blend total quantity is calculated').first()
  ).toBeVisible()
  await page
    .getByLabel(`Edit result for ${AGGREGATES[0]}`)
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/01-empty-aggregates-take-input.png` })

  for (const title of AGGREGATES) {
    const input = page.getByLabel(`Edit result for ${title}`)
    await input.fill('0')
    await input.press('Enter')
    await expect(input).toHaveCount(0, { timeout: 15_000 })
  }
  await expect(page.getByLabel(/^Edit result for HPLC Blend/)).toHaveCount(0)
  await expect(
    page.getByLabel('Blend purity is calculated').first()
  ).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/02-typed-zero-saved-read-only.png` })
})
