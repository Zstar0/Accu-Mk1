import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

/**
 * Document spaces (spec 2026-10-06): a restricted space is visible only to the groups
 * granted it, across the grid, the list, the viewer, the document routes and the
 * document flag threads. Creates its own group, two standard users (member, outsider),
 * a restricted space and two documents, all suffixed per run. Also covers the admin
 * move from the viewer's Edit details dialog, revocation on the next request, and the
 * agent-token space allow-list through the publish script, the comment, attachment
 * and comment-index routes (scenario 5), and a board editor outside the space seeing a
 * pinned document masked, including in a stale-version 409 (scenario 10).
 *
 * Scenario 9 needs E2E_AGENT_TOKEN, a token the stack's backend carries as
 * MK1_DOCUMENT_AGENT_TOKENS=e2e:<token>:general (General only); E2E_PYTHON optionally
 * names the interpreter for the publish script (default `python`).
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ?? 'docs/superpowers/e2e/2026-10-06-document-spaces'
const RUN = Date.now().toString(36).slice(-4)
const SPACE_SLUG = `leadership-${RUN}`
const SPACE_NAME = `Leadership ${RUN}`
const DOC_TITLE = `Q4 plan (${RUN})`
const SECOND_TITLE = `Board minutes (${RUN})`
const FLAG_TITLE = `Review Q4 plan (${RUN})`
const TOKEN_KEY = 'accu_mk1_auth_token'
const USER_KEY = 'accu_mk1_auth_user'
const MISSING_ID = 999999999
const BOARD_SLUG = `spaces-board-${RUN}`
// Smallest body the attachment sniffer accepts as image/png.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0x30),
])

test.describe.configure({ mode: 'serial' })

async function login(
  request: APIRequestContext,
  email: string,
  password: string
) {
  const r = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { email, password },
  })
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy()
  return ((await r.json()) as { access_token: string }).access_token
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

// Same hydration path as e2e/planning-boards-slice2.spec.ts: the auth-store reads these
// two keys at load, then App.tsx replaces `user` with the real /auth/me row.
async function asUser(page: Page, token: string, email: string, role: string) {
  await page.addInitScript(
    ({ token, user, tokenKey, userKey }) => {
      window.localStorage.setItem(tokenKey, token)
      window.localStorage.setItem(userKey, JSON.stringify(user))
    },
    {
      token,
      user: {
        id: 0,
        email,
        role,
        is_active: true,
        created_at: new Date().toISOString(),
        senaite_configured: false,
      },
      tokenKey: TOKEN_KEY,
      userKey: USER_KEY,
    }
  )
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name) })
}

const world: Record<string, unknown> = { run: RUN }
function record(k: string, v: unknown) {
  world[k] = v
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(
    path.join(SHOTS, 'api-summary.json'),
    JSON.stringify(world, null, 2) + '\n'
  )
}

const page_html = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><h1>${title}</h1><p>E2E document spaces run ${RUN}.</p></body></html>`

let admin = ''
let memberTok = ''
let outsiderTok = ''
let memberEmail = ''
let outsiderEmail = ''
let memberId = 0
let gid = 0
let spaceId = 0
let generalId = 0
let docId = 0
let docCode = ''
let secondId = 0
let secondCode = ''
let flagId = 0

async function openAs(
  browser: import('@playwright/test').Browser,
  token: string,
  email: string,
  role: string,
  hash: string
) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await asUser(page, token, email, role)
  await page.goto(`/#${hash}`)
  return { ctx, page }
}

test('1. setup: group, member, outsider', async ({ request }) => {
  admin = await login(
    request,
    process.env.E2E_EMAIL!,
    process.env.E2E_PASSWORD!
  )
  const h = bearer(admin)
  memberEmail = `member-${RUN}@accumark.local`
  outsiderEmail = `outsider-${RUN}@accumark.local`
  const pw = randomBytes(12).toString('base64url')
  const created: number[] = []
  for (const email of [memberEmail, outsiderEmail]) {
    const r = await request.post(`${BACKEND_URL}/auth/users`, {
      headers: h,
      data: { email, password: pw, role: 'standard' },
    })
    expect([200, 201]).toContain(r.status())
    created.push(r.status())
  }
  const users = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as { id: number; email: string }[]
  memberId = users.find(u => u.email === memberEmail)!.id
  const g = await request.post(`${BACKEND_URL}/api/groups`, {
    headers: h,
    data: { slug: `leaders-${RUN}`, name: `Leaders ${RUN}` },
  })
  expect(g.status(), await g.text()).toBe(201)
  gid = ((await g.json()) as { id: number }).id
  const m = await request.put(`${BACKEND_URL}/api/groups/${gid}/members`, {
    headers: h,
    data: { user_ids: [memberId] },
  })
  expect(m.status()).toBe(200)
  memberTok = await login(request, memberEmail, pw)
  outsiderTok = await login(request, outsiderEmail, pw)
  record('1_setup', {
    create_users: created,
    create_group: g.status(),
    add_member: m.status(),
  })
})

test('2. admin creates a restricted space, grants the group, publishes into it', async ({
  request,
}) => {
  const h = bearer(admin)
  const sp = await request.post(`${BACKEND_URL}/api/document-spaces`, {
    headers: h,
    data: { slug: SPACE_SLUG, name: SPACE_NAME, visibility: 'restricted' },
  })
  expect(sp.status(), await sp.text()).toBe(201)
  spaceId = ((await sp.json()) as { id: number }).id
  const gr = await request.put(
    `${BACKEND_URL}/api/document-spaces/${spaceId}/grants`,
    { headers: h, data: { group_ids: [gid] } }
  )
  expect(gr.status(), await gr.text()).toBe(200)
  expect(((await gr.json()) as { group_ids: number[] }).group_ids).toEqual([
    gid,
  ])
  const spaces = (await (
    await request.get(`${BACKEND_URL}/api/document-spaces`, { headers: h })
  ).json()) as { id: number; slug: string }[]
  generalId = spaces.find(s => s.slug === 'general')!.id
  const statuses: number[] = []
  for (const title of [DOC_TITLE, SECOND_TITLE]) {
    const d = await request.post(`${BACKEND_URL}/api/documents`, {
      headers: h,
      data: {
        title,
        html: page_html(title),
        category: 'ART',
        space: SPACE_SLUG,
      },
    })
    expect(d.status(), await d.text()).toBe(201)
    statuses.push(d.status())
    const body = (await d.json()) as {
      id: number
      code: string
      space_slug: string
    }
    expect(body.space_slug).toBe(SPACE_SLUG)
    if (title === DOC_TITLE) {
      docId = body.id
      docCode = body.code
    } else {
      secondId = body.id
      secondCode = body.code
    }
  }
  record('2_space', {
    create_space: sp.status(),
    put_grants: gr.status(),
    publish: statuses,
    doc_code: docCode,
  })
})

test('3. admin: grid shows General and the restricted space; the scoped list shows the doc', async ({
  browser,
}) => {
  const { ctx, page } = await openAs(
    browser,
    admin,
    process.env.E2E_EMAIL!,
    'admin',
    'reports/documents'
  )
  await expect(page.getByRole('button', { name: /General/ })).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page.getByRole('button', { name: new RegExp(SPACE_NAME) })
  ).toBeVisible()
  await shot(page, '01-admin-grid.png')
  await page.getByRole('button', { name: new RegExp(SPACE_NAME) }).click()
  await expect(
    page.getByRole('heading', { name: `Documents / ${SPACE_NAME}` })
  ).toBeVisible()
  await expect(page.getByText(DOC_TITLE)).toBeVisible({ timeout: 15_000 })
  await shot(page, '02-admin-leadership-list.png')
  await ctx.close()
  record('3_admin_ui', { grid: ['General', SPACE_NAME], list_has_doc: true })
})

test('4. member sees the space and opens the document', async ({
  browser,
  request,
}) => {
  const { ctx, page } = await openAs(
    browser,
    memberTok,
    memberEmail,
    'standard',
    'reports/documents'
  )
  await expect(
    page.getByRole('button', { name: new RegExp(SPACE_NAME) })
  ).toBeVisible({ timeout: 20_000 })
  await page.goto(`/#reports/documents?id=${docId}`)
  await expect(
    page
      .frameLocator(`iframe[title="${DOC_TITLE}"]`)
      .getByRole('heading', { name: DOC_TITLE })
  ).toBeVisible({ timeout: 20_000 })
  await shot(page, '03-member-sees-doc.png')
  await ctx.close()
  const r = await request.get(`${BACKEND_URL}/api/documents/${docId}`, {
    headers: bearer(memberTok),
  })
  expect(r.status()).toBe(200)
  record('4_member', { grid_has_space: true, get_document: r.status() })
})

test('5. outsider: General only; every read is a 404 like a missing id', async ({
  browser,
  request,
}) => {
  const o = bearer(outsiderTok)
  const hidden = await request.get(`${BACKEND_URL}/api/documents/${docId}`, {
    headers: o,
  })
  const missing = await request.get(
    `${BACKEND_URL}/api/documents/${MISSING_ID}`,
    { headers: o }
  )
  const hiddenContent = await request.get(
    `${BACKEND_URL}/api/documents/${docId}/content`,
    { headers: o }
  )
  const missingContent = await request.get(
    `${BACKEND_URL}/api/documents/${MISSING_ID}/content`,
    { headers: o }
  )
  expect(hidden.status()).toBe(404)
  expect(missing.status()).toBe(404)
  expect(hiddenContent.status()).toBe(404)
  expect(missingContent.status()).toBe(404)
  // The detail names the id the caller sent, so compare with the id swapped out.
  const detail = async (r: typeof hidden, id: number) =>
    String(((await r.json()) as { detail: unknown }).detail).replace(
      String(id),
      '<id>'
    )
  const hd = await detail(hidden, docId)
  const md = await detail(missing, MISSING_ID)
  expect(hd).toBe(md)
  expect(await detail(hiddenContent, docId)).toBe(
    await detail(missingContent, MISSING_ID)
  )
  const list = await request.get(
    `${BACKEND_URL}/api/documents?space_id=${spaceId}`,
    { headers: o }
  )
  expect(list.status()).toBe(200)
  const listBody = (await list.json()) as { items: unknown[]; total: number }
  expect(listBody.items).toHaveLength(0)
  expect(listBody.total).toBe(0)
  const spaces = (await (
    await request.get(`${BACKEND_URL}/api/document-spaces`, { headers: o })
  ).json()) as { slug: string }[]
  expect(spaces.map(s => s.slug)).not.toContain(SPACE_SLUG)

  // Comments and attachments on the hidden document read exactly like missing ones.
  const a = bearer(admin)
  const made = await request.post(
    `${BACKEND_URL}/api/documents/${docId}/comments`,
    { headers: a, data: { kind: 'comment', body: `E2E comment ${RUN}` } }
  )
  expect(made.status(), await made.text()).toBe(201)
  const commentId = ((await made.json()) as { id: number }).id
  const att = await request.post(
    `${BACKEND_URL}/api/documents/${docId}/comment-attachments`,
    {
      headers: a,
      multipart: {
        file: { name: 'shot.png', mimeType: 'image/png', buffer: PNG },
      },
    }
  )
  expect(att.status(), await att.text()).toBe(201)
  const attId = ((await att.json()) as { id: number }).id
  const pairs: [string, number, string][] = [
    ['/api/documents/<id>/comments', docId, 'comments'],
    ['/api/documents/<id>/comments/export', docId, 'export'],
    ['/api/documents/comments/<id>', commentId, 'comment'],
    ['/api/documents/comment-attachments/<id>', attId, 'attachment'],
  ]
  const commentReads: Record<string, number> = {}
  for (const [route, id, name] of pairs) {
    const h = await request.get(
      `${BACKEND_URL}${route.replace('<id>', String(id))}`,
      { headers: o }
    )
    const m = await request.get(
      `${BACKEND_URL}${route.replace('<id>', String(MISSING_ID))}`,
      { headers: o }
    )
    expect(h.status(), `${name}: ${await h.text()}`).toBe(404)
    expect(m.status()).toBe(404)
    expect(await detail(h, id)).toBe(await detail(m, MISSING_ID))
    commentReads[name] = h.status()
  }
  const index = await request.get(
    `${BACKEND_URL}/api/documents/comments?status=all`,
    { headers: o }
  )
  expect(index.status()).toBe(200)
  const indexItems = (
    (await index.json()) as { items: { document_id: number }[] }
  ).items
  expect(indexItems.map(i => i.document_id)).not.toContain(docId)
  expect(await index.text()).not.toContain(DOC_TITLE)

  const { ctx, page } = await openAs(
    browser,
    outsiderTok,
    outsiderEmail,
    'standard',
    'reports/documents'
  )
  await expect(page.getByRole('button', { name: /General/ })).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page.getByRole('button', { name: new RegExp(SPACE_NAME) })
  ).toHaveCount(0)
  await shot(page, '04-outsider-grid.png')
  await page.goto(`/#reports/documents?id=${docId}`)
  await expect(page.getByText(/Could not load this document/)).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText(DOC_TITLE)).toHaveCount(0)
  await shot(page, '05-outsider-deep-link.png')
  await ctx.close()
  record('5_outsider', {
    get_document: hidden.status(),
    get_content: hiddenContent.status(),
    missing_document: missing.status(),
    detail_matches_missing: true,
    comment_routes: commentReads,
    comment_index_has_doc: false,
    list_space_total: listBody.total,
    spaces_include_restricted: false,
    deep_link: 'not found state',
  })
})

test('6. a doc_review flag on the code follows the space', async ({
  request,
}) => {
  const fl = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: bearer(memberTok),
    data: {
      entity_type: 'document',
      entity_id: docCode,
      type: 'doc_review',
      title: FLAG_TITLE,
    },
  })
  expect(fl.status(), await fl.text()).toBe(201)
  flagId = ((await fl.json()) as { id: number }).id
  const o = bearer(outsiderTok)
  const m = bearer(memberTok)
  const oPoint = await request.get(`${BACKEND_URL}/api/flags/${flagId}`, {
    headers: o,
  })
  const mPoint = await request.get(`${BACKEND_URL}/api/flags/${flagId}`, {
    headers: m,
  })
  expect(oPoint.status()).toBe(404)
  expect(mPoint.status()).toBe(200)
  const titles = async (t: Record<string, string>) =>
    (
      (await (
        await request.get(`${BACKEND_URL}/api/flags?tab=all_open`, {
          headers: t,
        })
      ).json()) as { title: string }[]
    ).map(f => f.title)
  expect(await titles(o)).not.toContain(FLAG_TITLE)
  expect(await titles(m)).toContain(FLAG_TITLE)
  record('6_flags', {
    raise_by_member: fl.status(),
    outsider_point_read: oPoint.status(),
    member_point_read: mPoint.status(),
    outsider_all_open_has_flag: false,
    member_all_open_has_flag: true,
  })
})

test('7. admin moves the code to General from Edit details; the outsider sees it', async ({
  browser,
  request,
}) => {
  const { ctx, page } = await openAs(
    browser,
    admin,
    process.env.E2E_EMAIL!,
    'admin',
    `reports/documents?id=${docId}`
  )
  await page.getByRole('button', { name: 'Edit details' }).click()
  await page.locator('#doc-space').click()
  await page.getByRole('option', { name: 'General' }).click()
  const patched = page.waitForResponse(
    r =>
      r.url().includes(`/api/documents/${docId}`) &&
      r.request().method() === 'PATCH'
  )
  await page.getByRole('button', { name: 'Save' }).click()
  const resp = await patched
  expect(resp.status()).toBe(200)
  expect(resp.request().postDataJSON()).toMatchObject({ space_id: generalId })
  await ctx.close()

  const o = bearer(outsiderTok)
  const r = await request.get(`${BACKEND_URL}/api/documents/${docId}`, {
    headers: o,
  })
  expect(r.status()).toBe(200)
  expect(((await r.json()) as { space_slug: string }).space_slug).toBe(
    'general'
  )
  const oPoint = await request.get(`${BACKEND_URL}/api/flags/${flagId}`, {
    headers: o,
  })
  expect(oPoint.status()).toBe(200)
  const out = await openAs(
    browser,
    outsiderTok,
    outsiderEmail,
    'standard',
    `reports/documents?id=${docId}`
  )
  await expect(
    out.page
      .frameLocator(`iframe[title="${DOC_TITLE}"]`)
      .getByRole('heading', { name: DOC_TITLE })
  ).toBeVisible({ timeout: 20_000 })
  await shot(out.page, '06-moved-to-general.png')
  await out.ctx.close()
  record('7_move', {
    patch_from_dialog: resp.status(),
    outsider_get_document: r.status(),
    outsider_flag_point_read: oPoint.status(),
  })
})

test('8. revocation: removing the member hides the other secret doc on the next request', async ({
  request,
}) => {
  const m = bearer(memberTok)
  const before = await request.get(`${BACKEND_URL}/api/documents/${secondId}`, {
    headers: m,
  })
  expect(before.status()).toBe(200)
  const rm = await request.put(`${BACKEND_URL}/api/groups/${gid}/members`, {
    headers: bearer(admin),
    data: { user_ids: [] },
  })
  expect(rm.status()).toBe(200)
  const after = await request.get(`${BACKEND_URL}/api/documents/${secondId}`, {
    headers: m,
  })
  expect(after.status()).toBe(404)
  record('8_revocation', {
    before: before.status(),
    remove_member: rm.status(),
    after: after.status(),
  })
})

test('9. agent token: General-only allow-list refuses the restricted space', async () => {
  const token = process.env.E2E_AGENT_TOKEN
  expect(token, 'E2E_AGENT_TOKEN is required').toBeTruthy()
  const file = path.join(os.tmpdir(), `docspaces-${RUN}.html`)
  fs.writeFileSync(file, page_html(`Agent page (${RUN})`))
  const script =
    '.claude/skills/mk1-publish-document/scripts/publish_document.py'
  const run = (extra: string[]) =>
    spawnSync(
      process.env.E2E_PYTHON ?? 'python',
      [
        script,
        file,
        '--title',
        `Agent page (${RUN})`,
        '--category',
        'ART',
        ...extra,
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          MK1_API_BASE_URL: BACKEND_URL,
          ACCUMK1_INTERNAL_SERVICE_TOKEN: token,
        },
      }
    )
  const refused = run(['--space', SPACE_SLUG])
  expect(refused.status, refused.stderr).toBe(1)
  expect(refused.stderr).toContain('HTTP 400')
  expect(refused.stderr).toContain(
    `space '${SPACE_SLUG}' is not allowed for this agent`
  )
  const ok = run([])
  expect(ok.status, ok.stderr).toBe(0)
  expect(ok.stdout).toContain('space=general')
  fs.rmSync(file, { force: true })
  record('9_agent', {
    restricted_space_exit: refused.status,
    restricted_space_http: Number(
      /HTTP (\d{3})/.exec(refused.stderr)?.[1] ?? NaN
    ),
    general_exit: ok.status,
  })
})

test('10. board editor outside the space sees the pinned document masked', async ({
  request,
}) => {
  // Scenario 7 moved the first document to General; the second is still restricted.
  const h = bearer(admin)
  const o = bearer(outsiderTok)
  const users = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as { id: number; email: string }[]
  const outsiderId = users.find(u => u.email === outsiderEmail)!.id
  const g = await request.post(`${BACKEND_URL}/api/groups`, {
    headers: h,
    data: { slug: `board-editors-${RUN}`, name: `Board editors ${RUN}` },
  })
  expect(g.status(), await g.text()).toBe(201)
  const editorsId = ((await g.json()) as { id: number }).id
  const m = await request.put(
    `${BACKEND_URL}/api/groups/${editorsId}/members`,
    { headers: h, data: { user_ids: [outsiderId] } }
  )
  expect(m.status()).toBe(200)
  const b = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: {
      slug: BOARD_SLUG,
      name: `Spaces board ${RUN}`,
      visibility: 'company',
    },
  })
  expect(b.status(), await b.text()).toBe(201)
  const gr = await request.put(
    `${BACKEND_URL}/api/boards/${BOARD_SLUG}/grants`,
    {
      headers: h,
      data: [{ group_id: editorsId, can_edit: true }],
    }
  )
  expect(gr.status(), await gr.text()).toBe(200)
  const pin = await request.post(
    `${BACKEND_URL}/api/boards/${BOARD_SLUG}/nodes`,
    {
      headers: h,
      data: { kind: 'entity', entity_type: 'document', entity_id: secondCode },
    }
  )
  expect(pin.status(), await pin.text()).toBe(201)
  const node = (await pin.json()) as { id: number; label: string }
  expect(node.label).toContain(SECOND_TITLE)

  const read = await request.get(`${BACKEND_URL}/api/boards/${BOARD_SLUG}`, {
    headers: o,
  })
  expect(read.status()).toBe(200)
  const readText = await read.text()
  expect(readText).not.toContain(SECOND_TITLE)
  const seen = JSON.parse(readText) as {
    can_edit: boolean
    nodes: { id: number; label: string; version: number }[]
  }
  expect(seen.can_edit).toBe(true)
  const mine = seen.nodes.find(n => n.id === node.id)!
  expect(mine.label).toBe(secondCode)

  const stale = await request.patch(
    `${BACKEND_URL}/api/boards/${BOARD_SLUG}/nodes/${node.id}`,
    { headers: o, data: { x: 5, version: mine.version + 99 } }
  )
  expect(stale.status()).toBe(409)
  const staleText = await stale.text()
  expect(staleText).not.toContain(SECOND_TITLE)
  const current = (
    JSON.parse(staleText) as { detail: { current: { label: string } } }
  ).detail.current
  expect(current.label).toBe(mine.label)
  record('10_board_mask', {
    create_board: b.status(),
    pin: pin.status(),
    outsider_read: read.status(),
    outsider_label_is_code: true,
    stale_patch: stale.status(),
    stale_body_has_title: false,
  })
})
