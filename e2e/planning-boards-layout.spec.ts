import fs from 'node:fs'
import path from 'node:path'
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import { authenticate } from './fixtures/auth'

/**
 * Planning boards: org-chart tools on the canvas. Seeds an org board through the API (three
 * people scattered on the canvas, one reporting line), then drives the UI: draws a second
 * reporting line by dragging from the manager to the report, runs Layout and checks the
 * manager lands above both reports, undoes it from the toast, and retypes a line with the
 * kind picker.
 *
 * The board name is suffixed with a per-run token because the shared devbox stack keeps
 * boards from earlier runs.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ??
  'docs/superpowers/evidence/2026-09-30-planning-boards-layout'
const RUN = Date.now().toString(36).slice(-4)
const SLUG = `org-${RUN}`
const VIEWPORT_KEY = `boards:viewport:${SLUG}`

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1400, height: 900 } })

async function token(request: APIRequestContext) {
  const r = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD },
  })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { access_token: string }).access_token
}
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

interface NodeRow {
  id: number
  x: number
  y: number
}
interface EdgeRow {
  id: number
  source_id: number
  target_id: number
  kind: string
}

async function detail(request: APIRequestContext) {
  const r = await request.get(`${BACKEND_URL}/api/boards/${SLUG}`, {
    headers: bearer(await token(request)),
  })
  expect(r.ok(), await r.text()).toBeTruthy()
  return (await r.json()) as { nodes: NodeRow[]; edges: EdgeRow[] }
}
const xy = (rows: NodeRow[]) =>
  Object.fromEntries(rows.map(n => [n.id, { x: n.x, y: n.y }]))

/** Pin zoom and pan so handle coordinates are stable (see the slice 3 spec). */
async function open(page: Page) {
  await page.addInitScript(
    ({ key, vp }) => window.localStorage.setItem(key, JSON.stringify(vp)),
    { key: VIEWPORT_KEY, vp: { x: 0, y: 0, zoom: 1 } }
  )
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  await expect(page.locator('.react-flow__node-person').first()).toBeVisible({
    timeout: 30_000,
  })
}

let boss = 0
let reportA = 0
let reportB = 0
let bossUserId = 0
const SEED = [
  { x: 300, y: 60 },
  { x: 80, y: 300 },
  { x: 420, y: 220 },
]

test('seed an org board through the API', async ({ request }) => {
  const h = bearer(await token(request))
  const b = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: {
      slug: SLUG,
      name: `Org chart (${RUN})`,
      kind: 'org',
      visibility: 'company',
    },
  })
  expect(b.status(), await b.text()).toBe(201)

  const users = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as {
    id: number
    first_name?: string | null
    last_name?: string | null
  }[]
  expect(users.length).toBeGreaterThan(0)
  // The manager is a user with both names when the stack has one, so the person-card test
  // can tell the name line from the email line.
  const named = users.find(u => u.first_name && u.last_name) ?? users[0]
  const pick = [named, ...users.filter(u => u !== named)]
  const ids: number[] = []
  for (const [i, at] of SEED.entries()) {
    const r = await request.post(`${BACKEND_URL}/api/boards/${SLUG}/nodes`, {
      headers: h,
      data: {
        kind: 'person',
        label: `Person ${i + 1}`,
        ...at,
        data: { user_id: pick[i % pick.length]?.id },
      },
    })
    expect(r.status(), await r.text()).toBe(201)
    ids.push(((await r.json()) as { id: number }).id)
  }
  ;[boss, reportA, reportB] = ids as [number, number, number]
  bossUserId = named?.id ?? 0

  // Stored as "report reports_to manager".
  const e = await request.post(`${BACKEND_URL}/api/boards/${SLUG}/edges`, {
    headers: h,
    data: { source_id: reportA, target_id: boss, kind: 'reports_to' },
  })
  expect(e.status(), await e.text()).toBe(201)
  record('seed', { slug: SLUG, boss, reportA, reportB })
})

test('dragging from the manager to a report stores a reporting line', async ({
  page,
  request,
}) => {
  await open(page)
  const from = page.locator(
    `.react-flow__node[data-id="${boss}"] .react-flow__handle.source`
  )
  const to = page.locator(
    `.react-flow__node[data-id="${reportB}"] .react-flow__handle.target`
  )
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error('handles have no bounding box')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()

  await expect
    .poll(async () => (await detail(request)).edges.length, { timeout: 10_000 })
    .toBe(2)
  const edges = (await detail(request)).edges
  record('drawn_edge', edges)
  expect(edges).toContainEqual(
    expect.objectContaining({
      source_id: reportB,
      target_id: boss,
      kind: 'reports_to',
    })
  )
  await shot(page, '01-org-board-before-layout.png')
})

test('Layout puts the manager above the reports, and Undo puts everything back', async ({
  page,
  request,
}) => {
  const before = xy((await detail(request)).nodes)
  await open(page)
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await expect(page.getByText('Layout applied')).toBeVisible({
    timeout: 10_000,
  })

  const after = xy((await detail(request)).nodes)
  record('layout', { before, after })
  expect(after[boss]!.y).toBeLessThan(after[reportA]!.y)
  // Same rank: dagre aligns rank centres, and a card showing a title is a line taller.
  expect(Math.abs(after[reportA]!.y - after[reportB]!.y)).toBeLessThanOrEqual(
    20
  )
  expect(after[reportA]!.x).not.toBe(after[reportB]!.x)
  await shot(page, '02-org-board-after-layout.png')

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect
    .poll(async () => xy((await detail(request)).nodes), { timeout: 10_000 })
    .toEqual(before)
  record('layout_undone', true)

  // Leave the board laid out for the next test and for anyone opening it afterwards.
  await page.reload()
  await expect(page.locator('.react-flow__node-person').first()).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await expect(page.getByText('Layout applied')).toBeVisible({
    timeout: 10_000,
  })
})

test('the kind picker retypes a line and keeps it drawn the same way', async ({
  page,
  request,
}) => {
  await open(page)
  await page.locator('.react-flow__edge').first().click()
  const reportsTo = page.getByRole('radio', { name: 'Reports to' })
  await expect(reportsTo).toBeVisible({ timeout: 10_000 })
  await expect(reportsTo).toHaveAttribute('aria-checked', 'true')
  await shot(page, '03-edge-kind-picker.png')

  await page.getByRole('radio', { name: 'Related' }).click()
  // The new line is stored first, then the old one is removed.
  await expect
    .poll(async () => (await detail(request)).edges.map(e => e.kind).sort(), {
      timeout: 10_000,
    })
    .toEqual(['related', 'reports_to'])
  const edges = (await detail(request)).edges
  record('retyped_edges', edges)
  // Drawn manager to report, so a plain line is stored that way round.
  const related = edges.find(e => e.kind === 'related')
  expect(related?.source_id).toBe(boss)
  expect([reportA, reportB]).toContain(related?.target_id)
})

test('a person card shows the job title, and can show the email instead', async ({
  page,
  request,
}) => {
  const h = bearer(await token(request))
  const title = `Lab Director ${RUN}`
  const was = (await (
    await request.get(`${BACKEND_URL}/auth/users/${bossUserId}`, { headers: h })
  ).json()) as { title?: string | null }
  const r = await request.put(`${BACKEND_URL}/auth/users/${bossUserId}`, {
    headers: h,
    data: { title },
  })
  expect(r.status(), await r.text()).toBe(200)
  const users = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as {
    id: number
    email: string
    first_name?: string | null
    last_name?: string | null
    title: string | null
  }[]
  const bossUser = users.find(u => u.id === bossUserId)
  if (!bossUser) throw new Error('manager user not in the directory')
  expect(bossUser.title).toBe(title)
  // The name line falls back to the email on a user with no names (same rule as the app).
  const nameLine =
    [bossUser.first_name, bossUser.last_name].filter(Boolean).join(' ') ||
    bossUser.email
  record('person_name_line', { nameLine, email: bossUser.email })

  await open(page)
  const card = page.locator(`.react-flow__node[data-id="${boss}"]`)
  await expect(card).toContainText(title)
  await expect(card).toContainText(nameLine)
  if (nameLine !== bossUser.email)
    await expect(card).not.toContainText(bossUser.email)
  await shot(page, '04-person-card-title.png')

  // Select the card: the side panel offers Name / Email and the title switch.
  await card.click({ position: { x: 12, y: 12 } })
  await page.getByRole('radio', { name: 'Email' }).click()
  await expect(card).toContainText(bossUser.email, { timeout: 10_000 })
  if (nameLine !== bossUser.email)
    await expect(card).not.toContainText(nameLine, { timeout: 10_000 })
  await page.getByRole('switch', { name: 'Show title' }).click()
  await expect(card).not.toContainText(title, { timeout: 10_000 })
  const node = (await detail(request)).nodes.find(n => n.id === boss) as
    | (NodeRow & { data: Record<string, unknown> })
    | undefined
  record('person_display', node?.data)
  expect(node?.data).toEqual({
    user_id: bossUserId,
    show: 'email',
    show_title: false,
  })
  await shot(page, '05-person-card-email.png')

  // Leave the shared stack user as it was (empty string clears the title).
  const back = await request.put(`${BACKEND_URL}/auth/users/${bossUserId}`, {
    headers: h,
    data: { title: was.title ?? '' },
  })
  expect(back.status()).toBe(200)
})
