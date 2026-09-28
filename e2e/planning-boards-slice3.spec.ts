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
 * Planning boards, slice 3: the canvas. Seeds a board through the API (a frame with a note
 * inside it, a link, a person, and a document entity if the library has one), then drives
 * the UI: opens the boards page, opens the board, selects the frame, sees its flags, adds a
 * text node via the palette, drags it, reloads and sees it where it was dropped, follows a
 * board_node flag's deep link from the flags flyout, and resizes the frame from its grip.
 *
 * The board name and flag title are suffixed with a per-run token because the shared devbox
 * stack accumulates many boards/flags named the same thing across runs, so every board-list
 * and flyout locator below matches on the suffixed string, never the bare name. Node labels
 * inside the canvas itself ("Marketing", "Q4 priorities", "Heading") are not suffixed and do
 * not need to be: the canvas only ever renders this run's own board, since every navigation
 * here targets this run's `SLUG`.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ??
  'docs/superpowers/evidence/2026-09-27-planning-boards-slice3'
const RUN = Date.now().toString(36).slice(-4)
const SLUG = `map-${RUN}`
const BOARD_NAME = `Company map (${RUN})`
const VIEWPORT_KEY = `boards:viewport:${SLUG}`

test.describe.configure({ mode: 'serial' })

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

/**
 * Pin the canvas viewport to a known zoom/pan before the board first mounts, so every
 * pixel read from `boundingBox()` (drag and resize assertions) maps to the same flow
 * coordinates before and after a `page.reload()`. Without this, the very first mount
 * has no saved viewport and xyflow's `fitView` picks a zoom based on the current node
 * extents, which shifts once a node has moved or a frame has grown, making a raw
 * pixel-delta comparison meaningless. `addInitScript` re-applies on every new document,
 * and localStorage persists across the SPA's client-side navigations within one page.
 */
async function pinViewport(page: Page) {
  await page.addInitScript(
    ({ key, vp }) => window.localStorage.setItem(key, JSON.stringify(vp)),
    { key: VIEWPORT_KEY, vp: { x: 0, y: 0, zoom: 1 } }
  )
}

let frameId = 0
let flagTitle = ''

test('seed a company map through the API', async ({ request }) => {
  const h = bearer(await token(request))
  const b = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: { slug: SLUG, name: BOARD_NAME, kind: 'map', visibility: 'company' },
  })
  expect(b.status(), await b.text()).toBe(201)

  const nodes = `${BACKEND_URL}/api/boards/${SLUG}/nodes`
  const frame = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'frame',
      label: 'Marketing',
      x: 60,
      y: 60,
      w: 460,
      h: 280,
      data: { color: 'purple' },
    },
  })
  expect(frame.status(), await frame.text()).toBe(201)
  frameId = ((await frame.json()) as { id: number }).id

  // x: 200 (not the palette's default drop offset of 20) so the note's 240px-wide box
  // does not overlap the fixed (120, 120) drop point the "Add" palette uses for new
  // root-level nodes, and the drag test drops a text node right there.
  const note = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'note',
      label: 'Q4 priorities',
      parent_id: frameId,
      x: 200,
      y: 60,
      data: {
        markdown:
          'AccuVerify COA indexing is the SEO play.\n\n- Patent first\n- Newsletter consent live',
      },
    },
  })
  expect(note.status(), await note.text()).toBe(201)
  const noteId = ((await note.json()) as { id: number }).id

  const link = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'link',
      label: 'accumarklabs.com',
      x: 620,
      y: 80,
      data: { url: 'https://accumarklabs.com' },
    },
  })
  expect(link.status(), await link.text()).toBe(201)
  const linkId = ((await link.json()) as { id: number }).id

  const users = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as { id: number }[]
  const person = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'person',
      label: 'Me',
      x: 620,
      y: 200,
      data: { user_id: users[0]!.id },
    },
  })
  expect(person.status(), await person.text()).toBe(201)
  const personId = ((await person.json()) as { id: number }).id

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

  flagTitle = `Plan Q4 campaign (${RUN})`
  const fl = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: h,
    data: {
      entity_type: 'board_node',
      entity_id: String(frameId),
      type: 'task',
      title: flagTitle,
    },
  })
  expect(fl.status(), await fl.text()).toBe(201)

  record('seed', {
    slug: SLUG,
    board_name: BOARD_NAME,
    frame_id: frameId,
    note_id: noteId,
    link_id: linkId,
    person_id: personId,
    document_entity_id: entityId,
    document_code: code ?? null,
    flag_title: flagTitle,
  })
})

test('boards page lists the board and opens the canvas', async ({ page }) => {
  await pinViewport(page)
  await authenticate(page)
  await page.goto('/#boards/overview')
  // Scoped to the board-card container (BoardsPage.tsx's `rounded-lg border` card), not a
  // bare `div` filter: the shared stack has many boards, and an unscoped `div` filter
  // matches every ancestor up to the page root, so `.first()` would resolve to whichever
  // card happens to render first in the DOM, not necessarily this run's board.
  const card = page
    .locator('div.rounded-lg.border')
    .filter({ hasText: BOARD_NAME })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.scrollIntoViewIfNeeded()
  await shot(page, '01-boards-list.png')
  await card.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.locator('.react-flow__node-frame')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText('Marketing')).toBeVisible()
  await expect(page.getByText('Q4 priorities')).toBeVisible()
  await shot(page, '02-canvas-company-map.png')
})

test('selecting the frame shows its flags in the side panel', async ({
  page,
}) => {
  await pinViewport(page)
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  const frame = page.locator('.react-flow__node-frame').first()
  await expect(frame).toBeVisible({ timeout: 30_000 })
  await frame.click({ position: { x: 20, y: 12 } })
  await expect(page.getByText(flagTitle)).toBeVisible({ timeout: 15_000 })
  // The side panel's flag button is the "compact" RaiseFlagButton variant, whose
  // accessible name is "Raise a flag" (aria-label), not "Raise flag".
  await expect(page.getByRole('button', { name: 'Raise a flag' })).toBeVisible()
  await shot(page, '03-side-panel-frame-flags.png')
})

test('add a text node from the palette, drag it, reload, it stays', async ({
  page,
}) => {
  await pinViewport(page)
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  await expect(page.locator('.react-flow__node-frame').first()).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('option', { name: 'Text', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 })

  const text = page.locator('.react-flow__node-text', { hasText: 'Heading' })
  await expect(text).toBeVisible({ timeout: 10_000 })
  const before = await text.boundingBox()
  if (!before) throw new Error('text node has no bounding box')
  // Drag from the node's centre, not its top-left corner. xyflow's own drag handling
  // reads the pointer position relative to where the pointer grabbed the node, so a
  // corner-anchored move computes a different delta than a centre-anchored one, and
  // only the centre-to-centre delta matches the (dx, dy) we assert against below.
  const startX = before.x + before.width / 2
  const startY = before.y + before.height / 2
  const dx = 260
  const dy = 180
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  await page.reload()
  await expect(page.locator('.react-flow__node-frame').first()).toBeVisible({
    timeout: 30_000,
  })
  const afterLocator = page.locator('.react-flow__node-text', {
    hasText: 'Heading',
  })
  await expect(afterLocator).toBeVisible({ timeout: 30_000 })
  const after = await afterLocator.boundingBox()
  if (!after) throw new Error('text node has no bounding box after reload')
  const gotDx = after.x + after.width / 2 - startX
  const gotDy = after.y + after.height / 2 - startY
  expect(Math.abs(gotDx - dx)).toBeLessThan(40)
  expect(Math.abs(gotDy - dy)).toBeLessThan(40)
  await shot(page, '04-dragged-text-node-persisted.png')
  record('drag_delta', {
    expected: { dx, dy },
    measured: { dx: gotDx, dy: gotDy },
  })
})

test('a board_node flag deep-links to the board with the node selected', async ({
  page,
}) => {
  await pinViewport(page)
  await authenticate(page)
  await page.goto('/')
  await page.locator('#flags-header-button').click()
  await page.getByRole('tab', { name: 'All open' }).click()

  // FlagThread.tsx (opened by clicking a flyout row) has NO navigation control for a
  // board_node anchor: its header button is gated on entityMeta(entityType).canDeepLink,
  // and ENTITY_META.board_node.canDeepLink is hard-coded false (flag-entity.ts). That
  // gate is a documented slice-4 gap, see the report.
  //
  // The flyout ROW itself is a separate, working path: FlagTable's (and FlagCard's)
  // entity chip uses flagCanNavigate(), which reads the server-resolved
  // flag.entity.deep_link. The backend's board_node seam (backend/boards/flag_entity.py
  // register_board_node -> _ctx) always includes deep_link: {kind: "board_node",
  // id: "<slug>:<node id>"} in that context, so the chip is expected to be enabled here.
  // The flyout defaults to table view (flags:viewMode has no localStorage entry on a
  // fresh context, and use-flag-view-mode.ts's DEFAULT_MODE is 'table'), so the row is
  // a [role="row"] from FlagTable, not a FlagCard.
  const row = page.locator('[role="row"]').filter({ hasText: flagTitle })
  await expect(row).toBeVisible({ timeout: 15_000 })
  const openChip = row.locator('button[title^="Open "]')
  // Hard assertion, not a soft/conditional check: if the seam ever stops resolving
  // deep_link for board_node, this must fail loudly rather than silently falling back.
  await expect(openChip).toBeEnabled({ timeout: 10_000 })
  await openChip.click()

  const selected = page.locator('.react-flow__node.selected')
  await expect(selected).toBeVisible({ timeout: 30_000 })
  await expect(selected).toContainText('Marketing')
  await expect(page.getByText(flagTitle)).toBeVisible({ timeout: 15_000 })
  await shot(page, '05-deep-link-from-flag.png')
  record('deep_link_path', 'flyout_entity_chip')
})

test('resize the frame from its grip, reload, it persists', async ({
  page,
}) => {
  await pinViewport(page)
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  const frame = page.locator('.react-flow__node-frame').first()
  await expect(frame).toBeVisible({ timeout: 30_000 })
  // Click the title corner, not the centre (and no separate hover() first): the seeded
  // "Q4 priorities" note sits inside the frame and covers its centre, so a centre-aimed
  // hover/click never resolves against the frame itself. Same spot test 3 uses.
  await frame.click({ position: { x: 20, y: 12 } })

  const before = await frame.boundingBox()
  if (!before) throw new Error('frame has no bounding box')
  const grip = frame.locator('.react-flow__resize-control')
  await expect(grip).toBeVisible({ timeout: 10_000 })
  const gripBox = await grip.boundingBox()
  if (!gripBox) throw new Error('resize grip has no bounding box')
  const startX = gripBox.x + gripBox.width / 2
  const startY = gripBox.y + gripBox.height / 2
  const dw = 80
  const dh = 60
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dw, startY + dh, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  await page.reload()

  const afterFrame = page.locator('.react-flow__node-frame').first()
  await expect(afterFrame).toBeVisible({ timeout: 30_000 })
  const after = await afterFrame.boundingBox()
  if (!after) throw new Error('frame has no bounding box after reload')
  const gotDw = after.width - before.width
  const gotDh = after.height - before.height
  expect(Math.abs(gotDw - dw)).toBeLessThan(40)
  expect(Math.abs(gotDh - dh)).toBeLessThan(40)
  await shot(page, '06-frame-resized-persisted.png')
  record('resize_delta', {
    expected: { dw, dh },
    measured: { dw: gotDw, dh: gotDh },
  })
})
