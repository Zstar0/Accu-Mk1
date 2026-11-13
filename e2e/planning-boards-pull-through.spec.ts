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
 * Planning boards: pull-through. A note inside a frame is dragged against the frame's right
 * edge. A short pull leaves it inside (the frame clamps it); a longer pull past POP_AT screen
 * pixels pops it out of the frame, and the drop persists parent_id null with the absolute spot.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ??
  'docs/superpowers/evidence/2026-10-13-planning-boards-pull-through'
const RUN = Date.now().toString(36).slice(-4)
const SLUG = `pull-${RUN}`
const VIEWPORT_KEY = `boards:viewport:${SLUG}`
const FRAME = { x: 40, y: 80, w: 460, h: 280 }
const POP_AT = 50

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
  parent_id: number | null
  x: number
  y: number
}
async function noteRow(request: APIRequestContext) {
  const r = await request.get(`${BACKEND_URL}/api/boards/${SLUG}`, {
    headers: bearer(await token(request)),
  })
  expect(r.ok(), await r.text()).toBeTruthy()
  const rows = ((await r.json()) as { nodes: NodeRow[] }).nodes
  const n = rows.find(x => x.id === noteId)
  if (!n) throw new Error(`note ${noteId} not on the board`)
  return n
}

/** Pin zoom 1 and pan 0 so screen pixels equal canvas units. */
async function open(page: Page) {
  await page.addInitScript(
    ({ key, vp }) => window.localStorage.setItem(key, JSON.stringify(vp)),
    { key: VIEWPORT_KEY, vp: { x: 0, y: 0, zoom: 1 } }
  )
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  await expect(page.locator('.react-flow__node-note').first()).toBeVisible({
    timeout: 30_000,
  })
}

/** Drag the note's centre to the right by `dx` screen pixels, in small steps, and release. */
async function pullRight(page: Page, dx: number) {
  const note = page.locator('.react-flow__node-note').first()
  const box = await note.boundingBox()
  if (!box) throw new Error('note not measured')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 8, cy, { steps: 2 })
  await page.mouse.move(cx + dx, cy, {
    steps: Math.max(10, Math.round(dx / 8)),
  })
  await page.waitForTimeout(150)
  await page.mouse.up()
  return box
}

/** Pixels from the note's right edge to the frame's right edge on screen. */
async function gapToEdge(page: Page) {
  const frame = await page
    .locator('.react-flow__node-frame')
    .first()
    .boundingBox()
  const note = await page
    .locator('.react-flow__node-note')
    .first()
    .boundingBox()
  if (!frame || !note) throw new Error('frame or note not measured')
  return frame.x + frame.width - (note.x + note.width)
}

let frameId = 0
let noteId = 0

test('seed: a frame with a note inside it', async ({ request }) => {
  const h = bearer(await token(request))
  const b = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: {
      slug: SLUG,
      name: `Pull-through (${RUN})`,
      kind: 'map',
      visibility: 'company',
    },
  })
  expect(b.status(), await b.text()).toBe(201)
  const nodes = `${BACKEND_URL}/api/boards/${SLUG}/nodes`
  const frame = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'frame',
      label: 'Marketing',
      ...FRAME,
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
      x: 120,
      y: 60,
      data: { markdown: 'Reagent lot, artwork, newsletter.' },
    },
  })
  expect(note.status(), await note.text()).toBe(201)
  noteId = ((await note.json()) as { id: number }).id
  record('seed', { frameId, noteId })
})

test('a short pull against the edge leaves the note inside the frame', async ({
  page,
  request,
}) => {
  await open(page)
  const gap = await gapToEdge(page)
  await pullRight(page, gap + POP_AT / 2)
  await expect
    .poll(async () => (await noteRow(request)).x, { timeout: 10_000 })
    .toBeGreaterThan(120)
  const row = await noteRow(request)
  expect(row.parent_id).toBe(frameId)
  // Still a relative position inside the frame: the frame clamped the body at its edge.
  expect(row.x).toBeLessThanOrEqual(FRAME.w)
  await shot(page, '01-short-pull-stays-inside.png')
  record('short_pull', { gap, pulled: gap + POP_AT / 2, row })
})

test('a longer pull pops the note out of the frame and persists the absolute spot', async ({
  page,
  request,
}) => {
  await open(page)
  const gap = await gapToEdge(page)
  const before = await noteRow(request)
  await pullRight(page, gap + POP_AT * 3)
  await expect
    .poll(async () => (await noteRow(request)).parent_id, { timeout: 10_000 })
    .toBeNull()
  const row = await noteRow(request)
  // Absolute now, and the note's centre sits past the frame's right edge.
  const noteBox = await page
    .locator('.react-flow__node-note')
    .first()
    .boundingBox()
  if (!noteBox) throw new Error('note not measured')
  expect(row.x + noteBox.width / 2).toBeGreaterThan(FRAME.x + FRAME.w)
  expect(row.y).toBeCloseTo(FRAME.y + before.y, 0)
  await shot(page, '02-popped-out.png')
  record('pull_through', { gap, pulled: gap + POP_AT * 3, before, after: row })
})
