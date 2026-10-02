import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures/auth'

/**
 * AccuVerify forward pointer: re-publishing a certificate mints a new
 * verification code and the old code starts announcing its replacement
 * (Handler ruling 2026-09-29; IS `mark_superseded` on both publish paths).
 *
 * Runs against a devbox stack with IS and WordPress mounted (see e2e/README.md).
 * Preconditions:
 *   E2E_COA_SAMPLE_ID  a sample with a published primary and at least one
 *                      published additional COA that COA Builder can render
 *                      (on stack `coarevoke` that is PB-0069, WP order 3166)
 *   E2E_IS_URL         the stack's Integration Service (public verify endpoint)
 *   E2E_WP_URL         the stack's WordPress as the browser reaches it
 *   E2E_MAILHOG_URL    the stack's Mailhog (COA Reissued email)
 *
 * Each run mints two new codes on the sample (one primary, one additional);
 * the previous ones become superseded. Screenshots and the API verdicts land
 * in docs/superpowers/e2e/2026-09-29-coa-forward-default/.
 */

const SAMPLE_ID = process.env.E2E_COA_SAMPLE_ID
const IS_URL = process.env.E2E_IS_URL
const WP_URL = process.env.E2E_WP_URL
const MAILHOG_URL = process.env.E2E_MAILHOG_URL
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const EVIDENCE = path.resolve(
  'docs/superpowers/e2e/2026-09-29-coa-forward-default'
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

async function openSample(page: Page) {
  await page.goto(`/#senaite/sample-details?id=${SAMPLE_ID}`)
  await expect(
    page.getByRole('heading', { name: SAMPLE_ID!, level: 1 })
  ).toBeVisible({
    timeout: 20_000,
  })
}

/** The COA row that shows this code: the nearest container holding a Manage button. */
function rowOf(page: Page, code: string): Locator {
  return page
    .getByRole('link', { name: code, exact: true })
    .first()
    .locator('xpath=ancestor::*[.//button[normalize-space()="Manage"]][1]')
}

async function openManage(scope: Locator): Promise<Locator> {
  await scope.getByRole('button', { name: 'Manage' }).first().click()
  const popover = scope.page().getByRole('dialog')
  await expect(popover).toBeVisible()
  return popover
}

async function publicVerdict(request: APIRequestContext, code: string) {
  const response = await request.get(`${IS_URL}/v1/coa/public/${code}`)
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = (await response.json()) as {
    status: string
    forward_enabled: boolean
    current_verification_code: string | null
  }
  note(
    `IS public verdict ${code}: status=${body.status} forward_enabled=${body.forward_enabled} current=${body.current_verification_code}`
  )
  return body
}

async function expectWpAnnounces(page: Page, oldCode: string, newCode: string) {
  await page.goto(`${WP_URL}/?pagename=accuverify&accuverify_code=${oldCode}`)
  await expect(page.getByText('superseded by a newer version')).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.getByRole('link', { name: new RegExp(newCode) })
  ).toBeVisible()
}

async function expectWpAsIssued(page: Page, code: string) {
  await page.goto(`${WP_URL}/?pagename=accuverify&accuverify_code=${code}`)
  await expect(page.getByText('Authenticity Confirmed')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText('superseded by a newer version')).toHaveCount(0)
}

test.describe('AccuVerify forward pointer on re-publish', () => {
  test.skip(
    !SAMPLE_ID || !IS_URL || !WP_URL || !MAILHOG_URL,
    'Set E2E_COA_SAMPLE_ID, E2E_IS_URL, E2E_WP_URL and E2E_MAILHOG_URL (see the spec header)'
  )
  test.use({ viewport: { width: 1400, height: 1000 } })

  test.afterAll(() => {
    fs.mkdirSync(EVIDENCE, { recursive: true })
    fs.writeFileSync(
      path.join(EVIDENCE, 'run-notes.txt'),
      notes.join('\n') + '\n'
    )
  })

  test('Regen & Republish on the primary: old code announces the new one; lab can switch it off and on', async ({
    authedPage: page,
    request,
  }) => {
    // COA Builder renders the PDF and the IS publishes and notifies WordPress.
    test.setTimeout(360_000)
    page.on('dialog', dialog => dialog.accept())
    await openSample(page)

    // The current primary is the root generation whose badge reads Published.
    const generations = page.getByText(/^Generation #\d+$/)
    await expect(generations.first()).toBeVisible({ timeout: 20_000 })
    let oldRow: Locator | null = null
    for (let i = 0; i < (await generations.count()); i++) {
      // The row container holds the header line (badge, Manage) and the grid below it (code).
      const row = generations
        .nth(i)
        .locator(
          'xpath=ancestor::*[.//button[normalize-space()="Manage"] and .//*[normalize-space()="Verification Code"]][1]'
        )
      if (
        /^Published/.test(await row.locator('span[title]').first().innerText())
      ) {
        oldRow = row
        break
      }
    }
    expect(oldRow, 'a published root generation').not.toBeNull()
    const oldCode = await oldRow!
      .getByRole('link', { name: CODE })
      .first()
      .innerText()
    note(`primary before: ${oldCode} published on ${SAMPLE_ID}`)
    expect((await publicVerdict(request, oldCode)).status).toBe('verified')

    const manage = await openManage(oldRow!)
    const regen = page.waitForResponse(
      r =>
        r.url().includes('/regen-primary-coa') &&
        r.request().method() === 'POST',
      { timeout: 300_000 }
    )
    // exact: the row's help icon is named "About Regen & Republish".
    await manage
      .getByRole('button', { name: 'Regen & Republish', exact: true })
      .click()
    const response = await regen
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      success: boolean
      verification_code?: string
      message?: string
    }
    expect(body.success, body.message).toBe(true)
    const newCode = body.verification_code!
    expect(newCode).toMatch(CODE)
    note(`primary after: ${newCode} published, ${oldCode} retired`)
    await expect(
      page.getByText('Primary COA regenerated & republished')
    ).toBeVisible({ timeout: 15_000 })

    // Mk1: on a fresh load the old row reads Superseded and its Manage popover shows Forward to current ON.
    await openSample(page)
    const oldRowAfter = rowOf(page, oldCode)
    await expect(oldRowAfter.locator('span[title]').first()).toHaveText(
      'Superseded',
      { timeout: 30_000 }
    )
    await expect(
      rowOf(page, newCode).locator('span[title]').first()
    ).toHaveText(/^Published/)
    await shot(page, '01-mk1-primary-republished-old-row-superseded')
    const oldManage = await openManage(oldRowAfter)
    const forward = oldManage.getByRole('checkbox', {
      name: 'Forward to current',
    })
    await expect(forward).toBeChecked()
    await shot(page, '02-mk1-old-primary-manage-forward-on')
    await page.keyboard.press('Escape')

    // IS: the old code is superseded, the pointer is on and names the new code.
    const verdict = await publicVerdict(request, oldCode)
    expect(verdict.status).toBe('superseded')
    expect(verdict.forward_enabled).toBe(true)
    expect(verdict.current_verification_code).toBe(newCode)
    expect((await publicVerdict(request, newCode)).status).toBe('verified')

    // WordPress: the old code's page announces the supersession and links to the new one.
    await expectWpAnnounces(page, oldCode, newCode)
    await shot(page, '03-wp-old-primary-code-announces-successor')
    await expectWpAsIssued(page, newCode)
    await shot(page, '04-wp-new-primary-code-verified')

    // The customer was told: WordPress sends COA Reissued naming both codes.
    const mail = await request.get(
      `${MAILHOG_URL}/api/v2/search?kind=containing&query=${encodeURIComponent(newCode)}`
    )
    expect(mail.ok()).toBeTruthy()
    const inbox = (await mail.json()) as {
      count: number
      items: { Content: { Headers: { Subject?: string[]; To?: string[] } } }[]
    }
    expect(inbox.count, `an email mentioning ${newCode}`).toBeGreaterThan(0)
    const subject = inbox.items[0].Content.Headers.Subject?.[0] ?? ''
    note(
      `mailhog: ${inbox.count} message(s) mention ${newCode}; newest subject: ${subject}`
    )
    await page.goto(`${MAILHOG_URL}/`)
    await expect(
      page.getByText(subject.replace(/=\?.*\?=/, '').trim() || newCode).first()
    ).toBeVisible({
      timeout: 15_000,
    })
    await shot(page, '05-mailhog-coa-reissued-email')

    // The lab can still switch the pointer off (page renders as issued) and back on.
    await openSample(page)
    const offManage = await openManage(rowOf(page, oldCode))
    const patchOff = page.waitForResponse(
      r => r.url().includes('/forward') && r.request().method() === 'PATCH',
      { timeout: 30_000 }
    )
    await offManage
      .getByRole('checkbox', { name: 'Forward to current' })
      .click()
    expect((await patchOff).status()).toBe(200)
    await expect(
      offManage.getByRole('checkbox', { name: 'Forward to current' })
    ).not.toBeChecked()
    expect((await publicVerdict(request, oldCode)).forward_enabled).toBe(false)
    await expectWpAsIssued(page, oldCode)
    await shot(page, '06-wp-old-primary-code-as-issued-after-lab-switched-off')

    await openSample(page)
    const onManage = await openManage(rowOf(page, oldCode))
    const patchOn = page.waitForResponse(
      r => r.url().includes('/forward') && r.request().method() === 'PATCH',
      { timeout: 30_000 }
    )
    await onManage.getByRole('checkbox', { name: 'Forward to current' }).click()
    expect((await patchOn).status()).toBe(200)
    expect((await publicVerdict(request, oldCode)).forward_enabled).toBe(true)
    await expectWpAnnounces(page, oldCode, newCode)
  })

  test('Regen on an additional COA: its old code announces the new one', async ({
    authedPage: page,
    request,
  }) => {
    test.setTimeout(360_000)
    page.on('dialog', dialog => dialog.accept())
    await openSample(page)

    // A published additional COA card: "#N <company> published".
    const header = page
      .getByRole('button', { name: /^#\d+\s.*published$/i })
      .first()
    await expect(header).toBeVisible({ timeout: 20_000 })
    const card = header.locator('xpath=..')
    await header.click()
    const oldCode = await card
      .getByRole('link', { name: CODE })
      .first()
      .innerText()
    note(`additional before: ${oldCode} published on ${SAMPLE_ID}`)
    expect((await publicVerdict(request, oldCode)).status).toBe('verified')

    const manage = await openManage(card)
    const regen = page.waitForResponse(
      r => r.url().includes('/regen-coa') && r.request().method() === 'POST',
      { timeout: 300_000 }
    )
    await manage.getByRole('button', { name: 'Regen', exact: true }).click()
    const response = await regen
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      success: boolean
      verification_code?: string
      message?: string
    }
    expect(body.success, body.message).toBe(true)
    const newCode = body.verification_code!
    expect(newCode).toMatch(CODE)
    note(`additional after: ${newCode} published, ${oldCode} retired`)
    await expect(page.getByText(/Additional COA #\d+ regenerated/)).toBeVisible(
      { timeout: 15_000 }
    )

    // Mk1: on a fresh load the card shows the new code; the old one sits under Earlier versions with Forward ON.
    await openSample(page)
    const header2 = page
      .getByRole('button', { name: /^#\d+\s.*published$/i })
      .first()
    await expect(header2).toBeVisible({ timeout: 20_000 })
    const card2 = header2.locator('xpath=..')
    await header2.click()
    await expect(
      card2.getByRole('link', { name: newCode, exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await card2
      .getByRole('button', { name: /^Earlier versions \(\d+\)$/ })
      .click()
    const oldItem = card2
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: oldCode, exact: true }) })
    await expect(oldItem).toContainText('superseded')
    const oldManage = await openManage(oldItem)
    await expect(
      oldManage.getByRole('checkbox', { name: 'Forward to current' })
    ).toBeChecked()
    await shot(page, '07-mk1-additional-old-code-forward-on')
    await page.keyboard.press('Escape')

    const verdict = await publicVerdict(request, oldCode)
    expect(verdict.status).toBe('superseded')
    expect(verdict.forward_enabled).toBe(true)
    expect(verdict.current_verification_code).toBe(newCode)

    await expectWpAnnounces(page, oldCode, newCode)
    await shot(page, '08-wp-old-additional-code-announces-successor')
    await expectWpAsIssued(page, newCode)
  })
})
