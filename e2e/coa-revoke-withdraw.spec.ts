import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures/auth'

/**
 * Revoke, PDF withdrawal and the revocation follow-ups, end to end on a stack
 * with the IS, WordPress, Mailhog and object storage mounted.
 *
 * Drives Revoke from the Manage popover on a published primary, then checks:
 *   - the IS revoke response reports the PDF withdrawn (pdfs_withdrawn) and
 *     WordPress notified, with no withdrawal failure;
 *   - the public verdict is revoked with the reason and serves no PDF URL;
 *   - the PDF's former public URL no longer answers 200;
 *   - the WordPress verify page says Certificate Revoked;
 *   - the COA Revoked email reached Mailhog;
 *   - "Revocation follow-ups > Retry" on the revoked row re-runs the follow-ups
 *     idempotently: resumed, nothing left to withdraw, no second email.
 *
 * Env:
 *   E2E_REVOKE_SAMPLE_ID  a sample with ONE published primary that has a PDF
 *                         and a linked order (`PB-0064` on stack coarevoke).
 *                         Its primary is revoked for good by this run.
 *   E2E_IS_URL, E2E_WP_URL, E2E_MAILHOG_URL  as in coa-forward.spec.ts
 */

const SAMPLE_ID = process.env.E2E_REVOKE_SAMPLE_ID
const IS_URL = process.env.E2E_IS_URL
const WP_URL = process.env.E2E_WP_URL
const MAILHOG_URL = process.env.E2E_MAILHOG_URL
const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const EVIDENCE = path.resolve(
  'docs/superpowers/e2e/2026-10-28-coa-revoke-withdraw'
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

interface RevokeResult {
  revoked: { verification_code: string; status: string }[]
  skipped: string[]
  wp_notified: boolean
  wp_error: string | null
  wp_warning: string | null
  pdfs_withdrawn: string[]
  pdfs_withdraw_failed: string[]
  resumed: boolean
}

async function openSample(page: Page) {
  await page.goto(`/#senaite/sample-details?id=${SAMPLE_ID}`)
  await expect(
    page.getByRole('heading', { name: SAMPLE_ID!, level: 1 })
  ).toBeVisible({ timeout: 30_000 })
}

function rowOf(page: Page, code: string): Locator {
  return page
    .getByRole('link', { name: code, exact: true })
    .first()
    .locator(
      'xpath=ancestor::*[.//button[normalize-space()="Manage"] and .//*[normalize-space()="Verification Code"]][1]'
    )
}

async function publicVerdict(request: APIRequestContext, code: string) {
  const response = await request.get(`${IS_URL}/v1/coa/public/${code}`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as {
    status: string
    revocation_reason?: string | null
    pdf_url?: string | null
  }
}

/**
 * HEAD the public PDF URL. On a stack the IS hands out its container-internal
 * origin (http://minio:9000); E2E_MINIO_URL (e.g. http://<devbox>:5579) maps
 * it to something the browser host can reach. 0 = unreachable, recorded only.
 */
async function headStatus(request: APIRequestContext, url: string) {
  const reachable = process.env.E2E_MINIO_URL
    ? url.replace(/^https?:\/\/[^/]+/, process.env.E2E_MINIO_URL)
    : url
  try {
    const response = await request.head(reachable, {
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: 10_000,
    })
    return response.status()
  } catch {
    return 0
  }
}

async function mailhogMentions(request: APIRequestContext, needle: string) {
  const response = await request.get(
    `${MAILHOG_URL}/api/v2/search?kind=containing&query=${encodeURIComponent(needle)}`
  )
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    total: number
    items: { Content: { Headers: { Subject?: string[] } } }[]
  }
  return body
}

test.describe('Revoke withdraws the PDF; follow-ups are resumable', () => {
  test.skip(
    !SAMPLE_ID || !IS_URL || !WP_URL || !MAILHOG_URL,
    'Set E2E_REVOKE_SAMPLE_ID, E2E_IS_URL, E2E_WP_URL and E2E_MAILHOG_URL (see the spec header)'
  )
  test.use({ viewport: { width: 1400, height: 1000 } })

  test.afterAll(() => {
    fs.mkdirSync(EVIDENCE, { recursive: true })
    fs.writeFileSync(
      path.join(EVIDENCE, 'run-notes.txt'),
      notes.join('\n') + '\n'
    )
  })

  test('revoke the primary: PDF withdrawn, verdict revoked, WordPress and email updated, follow-ups idempotent', async ({
    authedPage: page,
    request,
  }) => {
    test.setTimeout(240_000)
    await openSample(page)

    // The current primary: the published root row.
    const generations = page.getByText(/^Generation #\d+$/)
    await expect(generations.first()).toBeVisible({ timeout: 20_000 })
    let row: Locator | null = null
    let code = ''
    for (let i = 0; i < (await generations.count()); i++) {
      const candidate = generations
        .nth(i)
        .locator(
          'xpath=ancestor::*[.//button[normalize-space()="Manage"] and .//*[normalize-space()="Verification Code"]][1]'
        )
      if (
        /^Published/.test(
          await candidate.locator('span[title]').first().innerText()
        )
      ) {
        row = candidate
        code = await candidate
          .getByRole('link', { name: CODE })
          .first()
          .innerText()
        break
      }
    }
    expect(row, 'a published root generation').not.toBeNull()
    expect(code).toMatch(CODE)

    const before = await publicVerdict(request, code)
    expect(before.status).toBe('verified')
    expect(
      before.pdf_url,
      'the published certificate serves a PDF URL'
    ).toBeTruthy()
    const pdfUrl = before.pdf_url!
    const pdfBefore = await headStatus(request, pdfUrl)
    const mailBefore = (await mailhogMentions(request, code)).total
    note(
      `${SAMPLE_ID}: primary ${code} verified; pdf_url HEAD ${pdfBefore}; mailhog mentions ${mailBefore}`
    )
    await shot(page, '01-primary-published')

    // Revoke from the popover (admin), email on.
    await row!.getByRole('button', { name: 'Manage' }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Revoke…' })
      .click()
    const dialog = page.getByRole('dialog').filter({ hasText: /^Revoke COA/ })
    await expect(dialog).toBeVisible()
    await dialog
      .getByPlaceholder(/reason/i)
      .fill('E2E: PDF withdrawal and follow-ups check')
    await shot(page, '02-revoke-dialog')
    const revokeResponse = page.waitForResponse(
      r =>
        r.url().includes(`/revoke`) &&
        !r.url().includes('/resume') &&
        r.request().method() === 'POST',
      { timeout: 120_000 }
    )
    await dialog
      .getByRole('button', { name: /^revoke 1 certificate$/i })
      .click()
    const revoked = (await (await revokeResponse).json()) as RevokeResult
    note(`revoke response: ${JSON.stringify(revoked)}`)
    expect(revoked.revoked.map(r => r.verification_code)).toEqual([code])
    expect(revoked.pdfs_withdrawn).toEqual([code])
    expect(revoked.pdfs_withdraw_failed).toEqual([])
    expect(revoked.wp_notified, revoked.wp_error ?? '').toBe(true)
    expect(revoked.wp_warning).toBeNull()

    // Verdict and PDF.
    const after = await publicVerdict(request, code)
    expect(after.status).toBe('revoked')
    expect(after.revocation_reason).toContain('PDF withdrawal')
    expect(after.pdf_url ?? null).toBeNull()
    const pdfAfter = await headStatus(request, pdfUrl)
    note(
      `after revoke: verdict ${after.status}; old pdf_url HEAD ${pdfBefore} -> ${pdfAfter}`
    )
    if (pdfBefore === 200) expect(pdfAfter).not.toBe(200)

    await expect(rowOf(page, code).locator('span[title]').first()).toHaveText(
      /^Revoked/,
      {
        timeout: 20_000,
      }
    )
    await shot(page, '03-row-revoked')

    // WordPress public page.
    await page.goto(`${WP_URL}/?pagename=accuverify&accuverify_code=${code}`)
    await expect(page.getByText(/Certificate Revoked/i).first()).toBeVisible({
      timeout: 30_000,
    })
    await shot(page, '04-wp-certificate-revoked')

    // Email.
    await expect
      .poll(async () => (await mailhogMentions(request, code)).total, {
        timeout: 60_000,
      })
      .toBeGreaterThan(mailBefore)
    const mail = await mailhogMentions(request, code)
    const subjects = mail.items.map(i => i.Content.Headers.Subject?.[0] ?? '')
    expect(subjects.some(s => /revoked/i.test(s))).toBe(true)
    note(
      `mailhog: ${mail.total} mention(s) of ${code}; newest subject: ${subjects[0]}`
    )
    await page.goto(`${MAILHOG_URL}/`)
    await shot(page, '05-mailhog-coa-revoked')

    // Follow-ups: idempotent re-run from the revoked row.
    await openSample(page)
    const revokedRow = rowOf(page, code)
    await revokedRow.getByRole('button', { name: 'Manage' }).click()
    const popover = page.getByRole('dialog')
    await expect(popover.getByText('Revocation follow-ups')).toBeVisible()
    await shot(page, '06-revoked-row-follow-ups')
    const resumeResponse = page.waitForResponse(
      r =>
        r.url().includes('/revoke/resume') && r.request().method() === 'POST',
      { timeout: 60_000 }
    )
    await popover.getByRole('button', { name: 'Retry' }).click()
    const resumed = (await (await resumeResponse).json()) as RevokeResult
    note(`resume response: ${JSON.stringify(resumed)}`)
    expect(resumed.resumed).toBe(true)
    expect(resumed.pdfs_withdrawn).toEqual([])
    expect(resumed.pdfs_withdraw_failed).toEqual([])
    expect(resumed.wp_notified, resumed.wp_error ?? '').toBe(true)
    await expect(page.getByText('Revocation follow-ups re-run')).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(async () => (await mailhogMentions(request, code)).total, {
        timeout: 15_000,
      })
      .toBe(mail.total)
    note(`resume: idempotent, no second email (${mail.total} mention(s) still)`)
  })
})
