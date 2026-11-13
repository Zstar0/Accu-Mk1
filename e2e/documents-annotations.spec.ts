import { test, expect } from './fixtures/auth'
import type { Page } from '@playwright/test'

/**
 * The whole annotations loop (spec 2026-10-03 §12): comment, reload,
 * re-anchor, MCP-shaped revision, lost-its-place, apply a suggestion, resolve.
 * Runs against a devbox stack (see e2e/README.md). Needs E2E_BACKEND_URL and
 * an admin login; it publishes its own document through the API and cleans up
 * nothing (the stack is disposable).
 */
const BACKEND = process.env.E2E_BACKEND_URL
// The stamp keeps re-runs on one stack from hitting the content dedupe (409).
const RUN = Date.now().toString(36)
const HTML = (variant: string) =>
  `<!doctype html><html><head><title>e2e ${RUN}</title><style>/* accumark-docs v1 */</style></head><body><h1>E2E ${variant}</h1><h2>Rulings</h2><p>Dedupe on an EXPLICIT code still behaves as before.</p><p>Cd and Pb limits use fifty percent of spec.</p></body></html>`

test.skip(
  !BACKEND || !process.env.E2E_EMAIL || !process.env.E2E_PASSWORD,
  'set E2E_BACKEND_URL, E2E_EMAIL and E2E_PASSWORD (an admin) to run against a stack'
)

async function api(page: Page, method: string, path: string, body?: unknown) {
  const token = await page.evaluate(() =>
    localStorage.getItem('accu_mk1_auth_token')
  )
  const res = await page.request.fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(
    res.ok(),
    `${method} ${path}: ${res.status()} ${await res.text()}`
  ).toBeTruthy()
  return res.json()
}

test('annotate, reload, revise, lose a place, apply, resolve', async ({
  authedPage: page,
}) => {
  test.setTimeout(120_000)
  await page.goto('/#reports/documents')
  const categories = await api(page, 'GET', '/api/document-categories')
  expect(
    categories.length,
    'the stack has no document category'
  ).toBeGreaterThan(0)
  const doc = await api(page, 'POST', '/api/documents', {
    title: `E2E ${RUN}`,
    html: HTML('one'),
    category_id: categories[0].id,
    author: 'e2e',
  })

  await page.goto(`/#reports/documents?id=${doc.id}`)
  const frame = page.frameLocator('iframe[title]')
  await expect(frame.locator('h1')).toHaveText('E2E one')
  const cards = page.getByTestId('comment-card')

  // 1. select text inside the frame -> toolbar -> comment with a label.
  // dblclick does not reliably post a selection from the sandboxed frame, so
  // select programmatically and fire the mouseup the bridge listens for.
  const p = frame.locator('p').first()
  const toolbar = page.getByRole('toolbar', { name: 'Annotate selection' })
  await expect(async () => {
    await p.selectText()
    await p.dispatchEvent('mouseup')
    await expect(toolbar).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await toolbar.getByRole('button', { name: 'Comment' }).click()
  await page.getByPlaceholder('Add a comment…').fill('Which before?')
  await page.getByRole('button', { name: /Verify this/ }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(cards.first()).toContainText('Which before?')
  await expect(cards.first()).toContainText('Verify this')

  // 2. a suggestion through the API with a quote-only anchor (the agent path)
  await api(page, 'POST', `/api/documents/${doc.id}/comments`, {
    kind: 'suggestion',
    body: '',
    anchor: { originalText: 'fifty percent of spec' },
    suggested_text: '50% of spec',
  })
  // 3. a comment that will lose its place
  await api(page, 'POST', `/api/documents/${doc.id}/comments`, {
    kind: 'comment',
    body: 'doomed',
    anchor: { originalText: 'E2E one' },
  })

  // 4. reload: markers restored, numbered
  await page.reload()
  await expect(frame.locator('h1')).toHaveText('E2E one')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toHaveAttribute('data-number', '1')
  await expect(frame.locator('[data-plannotator-marker]')).not.toHaveCount(0)

  // 5. a new revision with the heading changed: comment 3 loses its place
  const r2 = await api(page, 'POST', '/api/documents', {
    code: doc.code,
    html: HTML('two'),
    author: 'e2e',
    activate: true,
  })
  await page.goto(`/#reports/documents?id=${r2.id}`)
  await expect(frame.locator('h1')).toHaveText('E2E two')
  const lost = page.getByRole('region', { name: 'Lost its place' })
  await expect(lost).toContainText('doomed')
  await expect(cards.filter({ hasText: 'Which before?' })).toContainText(
    'on r1'
  )

  // 6. apply the suggestion as admin on the ACTIVE r2: creates a draft r3,
  // navigates to it, and resolves the suggestion only after the save
  await cards
    .filter({ hasText: '50% of spec' })
    .getByRole('button', { name: 'Apply' })
    .click()
  await expect(page.getByText('Saved as a new draft revision')).toBeVisible()
  await expect(frame.locator('body')).toContainText(
    'Cd and Pb limits use 50% of spec.'
  )
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible()
  await page.getByLabel('Filter comments').click()
  await page.getByRole('option', { name: 'Resolved' }).click()
  await expect(cards.filter({ hasText: '50% of spec' })).toBeVisible()
  await expect(
    cards.filter({ hasText: '50% of spec' }).getByRole('button', {
      name: 'Reopen',
    })
  ).toBeVisible()
})
