import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures/auth'

/**
 * SENAITE read mode: the published certificate card (PublishedCOACard, the
 * SENAITE-era "Generated COAs" card that mounts when SENAITE holds an attached
 * ARReport) carries the same per-row Manage popover as the Accu-Mk1 fallback
 * list: Regen & Republish and, for an admin, Revoke with its dialog.
 *
 * The stack reads samples from Accu-Mk1 by default, so the spec flips the
 * page's read-source override to SENAITE and walks a list of SENAITE-era
 * samples until one renders the card. Nothing is minted or revoked: the
 * Revoke dialog is opened and cancelled.
 *
 * Env:
 *   E2E_SENAITE_SAMPLE_IDS  comma-separated SENAITE-era samples with a
 *                           published certificate (default: the stack golden's)
 */

const CANDIDATES = (
  process.env.E2E_SENAITE_SAMPLE_IDS ||
  // Published in the stack golden's SENAITE (GET /senaite/samples?review_state=published).
  'P-0119,P-0112,P-0111,P-0110,PB-0066,BW-0006'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const EVIDENCE = path.resolve(
  'docs/superpowers/e2e/2026-09-30-coa-senaite-card'
)
const notes: string[] = []
function note(line: string) {
  notes.push(`${new Date().toISOString()} ${line}`)
  console.log(line)
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) })
}

/** The SENAITE-era card is headed "<sample> COA"; the fallback rows read "Generation #N". */
function senaiteCard(page: Page, sampleId: string): Locator {
  return page
    .getByText(`${sampleId} COA`, { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
}

async function openInSenaiteMode(page: Page, sampleId: string) {
  await page.goto(`/#senaite/sample-details?id=${sampleId}`)
  await expect(
    page.getByRole('heading', { name: sampleId, level: 1 })
  ).toBeVisible({ timeout: 30_000 })
  // The override re-runs the details lookup against live SENAITE. (The page
  // keeps a live stream open, so "networkidle" never settles; wait for the
  // provenance indicator to flip, then for the COA card to settle.)
  await page.getByRole('button', { name: 'SENAITE', exact: true }).click()
  await expect(page.getByText('Read from SENAITE')).toBeVisible({
    timeout: 90_000,
  })
  // Either the SENAITE card or the Accu-Mk1 fallback list settles within a few seconds.
  await page
    .getByText(`${sampleId} COA`, { exact: true })
    .or(page.getByText(/^Generation #\d+$/).first())
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => undefined)
}

test.describe('SENAITE read mode: published certificate card', () => {
  test.use({ viewport: { width: 1400, height: 1000 } })

  test.afterAll(() => {
    fs.mkdirSync(EVIDENCE, { recursive: true })
    fs.writeFileSync(
      path.join(EVIDENCE, 'run-notes.txt'),
      notes.join('\n') + '\n'
    )
  })

  test('the card carries the Manage popover with Regen & Republish and Revoke, and the Revoke dialog opens', async ({
    authedPage: page,
  }) => {
    test.setTimeout(300_000)

    let sampleId: string | null = null
    for (const candidate of CANDIDATES) {
      await openInSenaiteMode(page, candidate)
      const card = senaiteCard(page, candidate)
      if (!(await card.count())) {
        note(`${candidate}: no attached SENAITE report, skipped`)
        continue
      }
      // The popover needs the IS generation behind the SENAITE report's code;
      // a golden whose SENAITE and IS codes disagree shows the bare Regen button.
      if (
        !(await card.first().getByRole('button', { name: 'Manage' }).count())
      ) {
        note(
          `${candidate}: SENAITE report code has no IS generation here, skipped`
        )
        continue
      }
      await expect(card.first()).toBeVisible()
      sampleId = candidate
      break
    }
    expect(
      sampleId,
      `one of ${CANDIDATES.join(', ')} renders the SENAITE certificate card`
    ).not.toBeNull()
    const card = senaiteCard(page, sampleId!).first()
    const code = await card
      .getByRole('link', { name: CODE })
      .first()
      .innerText()
      .catch(() => '')
    note(`${sampleId}: SENAITE card rendered${code ? ` for ${code}` : ''}`)
    await shot(page, '01-senaite-card')

    // Inline: only Manage (plus View Digital COA / PDF); no bare Regen or Revoke.
    await expect(card.getByRole('button', { name: 'Manage' })).toBeVisible()
    await expect(
      card.getByRole('button', { name: 'Regen & Republish', exact: true })
    ).toHaveCount(0)
    await expect(card.getByRole('button', { name: /^revoke/i })).toHaveCount(0)

    await card.getByRole('button', { name: 'Manage' }).click()
    const popover = page.getByRole('dialog')
    await expect(popover).toBeVisible()
    // Each row = title + help icon + the action (the row title and the action
    // button share the Regen text, so match the button and the icon).
    await expect(
      popover.getByRole('button', { name: 'Regen & Republish', exact: true })
    ).toBeVisible()
    await expect(popover.getByLabel('About Regen & Republish')).toBeVisible()
    await expect(popover.getByRole('button', { name: 'Revoke…' })).toBeVisible()
    await expect(popover.getByLabel('About Revoke')).toBeVisible()
    // A published row has no Forward row: only a superseded one does.
    await expect(popover.getByText('Forward to current')).toHaveCount(0)
    note(
      `${sampleId}: Manage popover shows Regen & Republish and Revoke, no Forward`
    )
    await shot(page, '02-senaite-card-manage-popover')

    await popover.getByRole('button', { name: 'Revoke…' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: /^Revoke COA/ })
    await expect(
      dialog.getByText(/^Revoke COA [A-Z0-9]{4}-[A-Z0-9]{4}$/)
    ).toBeVisible()
    await expect(dialog.getByRole('textbox').first()).toBeVisible()
    note(
      `${sampleId}: Revoke dialog opened from the SENAITE card (reason field shown); cancelled`
    )
    await shot(page, '03-senaite-card-revoke-dialog')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
