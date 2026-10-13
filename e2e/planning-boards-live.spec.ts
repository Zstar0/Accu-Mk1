import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import { authenticate } from './fixtures/auth'

/**
 * Planning boards, slice 4 PR A: flags on the board. Seeds a company board (a frame with a
 * note inside, a loose person, a document item when the stack has one) and four flags (a
 * blocker on the note, an overdue task on the frame, a task on the board itself, and a
 * resolved task on the note), then checks the board flags endpoint, the frame pills, the
 * attention dock and its Locate, raising a flag on the board (an outsider on a restricted board
 * gets the same 403 as a missing board) and the open-flag count on the board card.
 *
 * Every seeded name carries a per-run suffix because the shared devbox stack keeps boards
 * from earlier runs.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ??
  'docs/superpowers/evidence/2026-10-12-planning-boards-live'
const RUN = Date.now().toString(36).slice(-4)
const SLUG = `live-${RUN}`
const BOARD_NAME = `Live flags (${RUN})`
const VIEWPORT_KEY = `boards:viewport:${SLUG}`
const T_BLOCKER = `Reagent lot on hold (${RUN})`
const T_OVERDUE = `Campaign brief overdue (${RUN})`
const T_BOARD = `Board review (${RUN})`
const T_RESOLVED = `Old note task (${RUN})`

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1400, height: 900 } })

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
const token = (request: APIRequestContext) =>
  login(request, process.env.E2E_EMAIL!, process.env.E2E_PASSWORD!)
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

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

/** Pin zoom and pan so the frame and its pills sit in view (see the layout spec). */
async function open(page: Page) {
  await page.addInitScript(
    ({ key, vp }) => window.localStorage.setItem(key, JSON.stringify(vp)),
    { key: VIEWPORT_KEY, vp: { x: 0, y: 0, zoom: 1 } }
  )
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  await expect(page.locator('.react-flow__node-frame').first()).toBeVisible({
    timeout: 30_000,
  })
}

let boardId = 0
let frameId = 0
let noteId = 0
const flagIds: Record<string, number> = {}

async function raise(
  request: APIRequestContext,
  h: Record<string, string>,
  data: Record<string, unknown>
) {
  const r = await request.post(`${BACKEND_URL}/api/flags`, { headers: h, data })
  expect(r.status(), await r.text()).toBe(201)
  return ((await r.json()) as { id: number }).id
}

test('seed: board, frame, note, person, entity and four flags', async ({
  request,
}) => {
  const h = bearer(await token(request))
  const b = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: { slug: SLUG, name: BOARD_NAME, kind: 'map', visibility: 'company' },
  })
  expect(b.status(), await b.text()).toBe(201)
  boardId = ((await b.json()) as { id: number }).id
  const nodes = `${BACKEND_URL}/api/boards/${SLUG}/nodes`

  const frame = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'frame',
      label: 'Marketing',
      x: 40,
      y: 80,
      w: 460,
      h: 280,
      data: { color: 'purple' },
    },
  })
  expect(frame.status(), await frame.text()).toBe(201)
  frameId = ((await frame.json()) as { id: number }).id

  const note = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'note',
      label: 'Launch checklist',
      parent_id: frameId,
      x: 200,
      y: 60,
      data: { markdown: 'Reagent lot, artwork, newsletter.' },
    },
  })
  expect(note.status(), await note.text()).toBe(201)
  noteId = ((await note.json()) as { id: number }).id

  const users = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as {
    id: number
    first_name?: string | null
    last_name?: string | null
  }[]
  expect(users.length).toBeGreaterThan(0)
  const named = users.find(u => u.first_name && u.last_name) ?? users[0]!
  const person = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'person',
      label: 'Owner',
      x: 620,
      y: 120,
      data: { user_id: named.id },
    },
  })
  expect(person.status(), await person.text()).toBe(201)

  const docs = (await (
    await request.get(`${BACKEND_URL}/api/documents?page_size=1`, {
      headers: h,
    })
  ).json()) as { items?: { code: string }[] }
  const code = docs.items?.[0]?.code
  let entityId: number | null = null
  if (code) {
    const entity = await request.post(nodes, {
      headers: h,
      data: {
        kind: 'entity',
        entity_type: 'document',
        entity_id: code,
        x: 620,
        y: 300,
        data: {},
      },
    })
    expect(entity.status(), await entity.text()).toBe(201)
    entityId = ((await entity.json()) as { id: number }).id
  }

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
  flagIds.blocker = await raise(request, h, {
    entity_type: 'board_node',
    entity_id: String(noteId),
    type: 'blocker',
    title: T_BLOCKER,
  })
  flagIds.overdue = await raise(request, h, {
    entity_type: 'board_node',
    entity_id: String(frameId),
    type: 'task',
    title: T_OVERDUE,
    due_at: twoDaysAgo,
  })
  flagIds.board = await raise(request, h, {
    entity_type: 'board',
    entity_id: String(boardId),
    type: 'task',
    title: T_BOARD,
  })
  flagIds.resolved = await raise(request, h, {
    entity_type: 'board_node',
    entity_id: String(noteId),
    type: 'task',
    title: T_RESOLVED,
  })
  const st = await request.post(
    `${BACKEND_URL}/api/flags/${flagIds.resolved}/status`,
    { headers: h, data: { to_status: 'resolved' } }
  )
  expect(st.ok(), await st.text()).toBeTruthy()

  record('seed', {
    slug: SLUG,
    board_id: boardId,
    frame_id: frameId,
    note_id: noteId,
    person_user_id: named.id,
    entity_id: entityId,
    document_code: code ?? null,
    flags: flagIds,
  })
})

test('endpoint: board flags lists the three open ones, and the board row counts them', async ({
  request,
}) => {
  const h = bearer(await token(request))
  const r = await request.get(`${BACKEND_URL}/api/boards/${SLUG}/flags`, {
    headers: h,
  })
  expect(r.ok(), await r.text()).toBeTruthy()
  const ids = ((await r.json()) as { id: number }[]).map(f => f.id).sort()
  expect(ids).toEqual(
    [flagIds.blocker!, flagIds.overdue!, flagIds.board!].sort()
  )

  const list = await request.get(`${BACKEND_URL}/api/boards`, { headers: h })
  expect(list.ok()).toBeTruthy()
  const row = (
    (await list.json()) as { slug: string; open_flag_count: number }[]
  ).find(x => x.slug === SLUG)
  record('endpoint', { flag_ids: ids, open_flag_count: row?.open_flag_count })
  expect(row?.open_flag_count).toBe(3)
})

test('pills: the frame shows 1 blocking and 1 open', async ({ page }) => {
  await open(page)
  const frame = page.locator(`.react-flow__node[data-id="${frameId}"]`)
  await expect(frame.getByTestId('frame-pill-blocking')).toHaveText(
    /1 blocking/,
    { timeout: 15_000 }
  )
  await expect(frame.getByTestId('frame-pill-open')).toHaveText(/1 open/)
  record('pills', {
    blocking: await frame.getByTestId('frame-pill-blocking').innerText(),
    open: await frame.getByTestId('frame-pill-open').innerText(),
  })
  await shot(page, '01-frame-pills.png')
})

test('dock: overdue task above the blocker, no board task, Locate selects the frame', async ({
  page,
}) => {
  await open(page)
  const trigger = page.getByRole('button', { name: 'Needs attention (2)' })
  await expect(trigger).toBeVisible({ timeout: 15_000 })
  const panel = trigger.locator(
    'xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]'
  )
  const overdue = panel.getByText(T_OVERDUE, { exact: true })
  const blocker = panel.getByText(T_BLOCKER, { exact: true })
  await expect(overdue).toBeVisible()
  await expect(blocker).toBeVisible()
  const a = await overdue.boundingBox()
  const b = await blocker.boundingBox()
  if (!a || !b) throw new Error('dock rows have no bounding box')
  expect(a.y).toBeLessThan(b.y)
  await expect(panel.getByText(T_BOARD, { exact: true })).toHaveCount(0)
  record('dock', { overdue_y: a.y, blocker_y: b.y })
  await shot(page, '02-attention-dock.png')

  await panel.getByRole('button', { name: 'Locate' }).first().click()
  await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.locator(`#node-label-${frameId}`)).toHaveValue('Marketing')
})

test('raise on the board: editors see the button; outsiders on a restricted board are refused like a missing board', async ({
  page,
  request,
}) => {
  await open(page)
  await expect(
    page.getByRole('button', { name: /raise a flag/i }).first()
  ).toBeVisible({ timeout: 15_000 })

  const admin = bearer(await token(request))
  const editorEmail = `e2e-live-editor-${RUN}@accumark.local`
  const outsiderEmail = `e2e-live-outsider-${RUN}@accumark.local`
  const pw = randomBytes(12).toString('base64url')
  for (const email of [editorEmail, outsiderEmail]) {
    const r = await request.post(`${BACKEND_URL}/auth/users`, {
      headers: admin,
      data: { email, password: pw, role: 'standard' },
    })
    expect([200, 201]).toContain(r.status())
  }
  const dir = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: admin })
  ).json()) as { id: number; email: string }[]
  const editorId = dir.find(u => u.email === editorEmail)!.id
  const g = await request.post(`${BACKEND_URL}/api/groups`, {
    headers: admin,
    data: { slug: `live-${RUN}`, name: `Live editors (${RUN})` },
  })
  expect(g.status(), await g.text()).toBe(201)
  const gid = ((await g.json()) as { id: number }).id
  const m = await request.put(`${BACKEND_URL}/api/groups/${gid}/members`, {
    headers: admin,
    data: { user_ids: [editorId] },
  })
  expect(m.status()).toBe(200)
  const rSlug = `live-restricted-${RUN}`
  const rb = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: admin,
    data: {
      slug: rSlug,
      name: `Live restricted (${RUN})`,
      kind: 'map',
      visibility: 'restricted',
    },
  })
  expect(rb.status(), await rb.text()).toBe(201)
  const rId = ((await rb.json()) as { id: number }).id
  const gr = await request.put(`${BACKEND_URL}/api/boards/${rSlug}/grants`, {
    headers: admin,
    data: [{ group_id: gid, can_edit: true }],
  })
  expect(gr.status()).toBe(200)

  const body = {
    entity_type: 'board',
    entity_id: String(rId),
    type: 'task',
    title: `Restricted board task (${RUN})`,
  }
  const outsiderTok = bearer(await login(request, outsiderEmail, pw))
  const outsider = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: outsiderTok,
    data: body,
  })
  // A board id that does not exist: the outsider must get the same answer, so the
  // refusal never confirms the restricted board exists.
  const missing = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: outsiderTok,
    data: { ...body, entity_id: '999999999' },
  })
  const editor = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: bearer(await login(request, editorEmail, pw)),
    data: body,
  })
  record('raise_on_board', {
    restricted_slug: rSlug,
    outsider_status: outsider.status(),
    missing_board_status: missing.status(),
    editor_status: editor.status(),
  })
  // The flags create route refuses an invisible anchor with 403, the same status as a
  // missing one (flags.service create_flag: can_raise False -> PermissionDeniedError).
  expect(outsider.status()).toBe(403)
  expect(missing.status()).toBe(outsider.status())
  expect(editor.status(), await editor.text()).toBe(201)
})

test('board card: the overview shows 3 open flags', async ({ page }) => {
  await authenticate(page)
  await page.goto('/#boards/overview')
  const card = page
    .locator('div.rounded-lg.border')
    .filter({ has: page.getByText(BOARD_NAME, { exact: true }) })
    .last()
  await expect(card.getByText('3 open flags', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await card.scrollIntoViewIfNeeded()
  record('board_card', { text: await card.innerText() })
  await shot(page, '03-board-card-count.png')
})
