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
 * Planning boards, slice 1 (spec docs/superpowers/specs/2026-09-26-planning-boards-design.md).
 *
 * Real-stack E2E: drives the Groups settings pane in a browser, exercises the
 * boards API with an admin bearer, raises a flag on a board frame and checks it
 * renders in the flag flyout with the board label, and proves the non-admin
 * paths (403 on group writes, 404 on an unknown board) plus that a restricted
 * board now creates (201) with RESTRICTED_BOARDS_ENABLED on.
 *
 * Screenshots land in E2E_SHOTS_DIR (default
 * docs/superpowers/evidence/2026-09-27-planning-boards-slice1) so a PR can
 * embed them. Every created record carries a per-run suffix, so re-runs never
 * collide.
 *
 * Env: E2E_BASE_URL, E2E_BACKEND_URL, E2E_EMAIL, E2E_PASSWORD (see e2e/README.md).
 */

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ??
  'docs/superpowers/evidence/2026-09-27-planning-boards-slice1'
const RUN = Date.now().toString(36).slice(-4)
const GROUP_SLUG = `exec-${RUN}`
const BOARD_SLUG = `org-${RUN}`
const FLAG_TITLE = `Plan Q4 campaign (${RUN})`

test.describe.configure({ mode: 'serial' })

type Json = Record<string, unknown>

async function login(
  request: APIRequestContext,
  email: string,
  password: string
): Promise<string> {
  const r = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { email, password },
  })
  expect(r.ok(), `login ${email}: ${r.status()}`).toBeTruthy()
  return ((await r.json()) as { access_token: string }).access_token
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (!email || !password)
    throw new Error('E2E_EMAIL and E2E_PASSWORD are required')
  return login(request, email, password)
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false })
}

const summary: Json = { run: RUN, group: GROUP_SLUG, board: BOARD_SLUG }
function record(key: string, value: unknown) {
  summary[key] = value
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(
    path.join(SHOTS, 'api-summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  )
}

test('Settings > Groups: admin creates a group and saves members', async ({
  page,
}) => {
  await authenticate(page)
  await page.goto('/#settings/groups')
  await expect(page.getByRole('heading', { name: 'User groups' })).toBeVisible({
    timeout: 30_000,
  })

  await page.getByLabel('Slug').fill(GROUP_SLUG)
  await page.getByLabel('Name', { exact: true }).fill('Executive team')
  await page.getByRole('button', { name: 'Add group' }).click()

  const row = page.locator('div.px-3.py-2', { hasText: GROUP_SLUG })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.getByText('0 members')).toBeVisible()
  await shot(page, '01-groups-pane-group-created.png')

  await row.getByRole('button', { name: 'Members' }).click()
  const me = row.getByRole('checkbox', { name: /stackdev/i })
  await expect(me).toBeVisible({ timeout: 10_000 })
  await me.check()
  await row.getByRole('button', { name: 'Save members' }).click()
  await expect(row.getByText('1 member', { exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await expect(
    row.getByText('Stream visibility changes apply when the app reconnects.')
  ).toBeVisible()
  await shot(page, '02-groups-pane-members-saved.png')
})

test('Boards API: company board with frame, note, link and edge; guards hold', async ({
  request,
}) => {
  const h = bearer(await adminToken(request))

  let r = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: {
      slug: BOARD_SLUG,
      name: 'Company map',
      kind: 'map',
      visibility: 'company',
    },
  })
  expect(r.status(), await r.text()).toBe(201)

  r = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: { slug: `exec-board-${RUN}`, name: 'Exec', visibility: 'restricted' },
  })
  expect(r.status(), await r.text()).toBe(201)
  record('restricted_board_created', true)

  const nodes = `${BACKEND_URL}/api/boards/${BOARD_SLUG}/nodes`
  r = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'frame',
      label: 'Marketing',
      x: 100,
      y: 80,
      w: 420,
      h: 260,
      data: { color: 'purple' },
    },
  })
  expect(r.status(), await r.text()).toBe(201)
  const frame = (await r.json()) as { id: number; version: number }
  record('frame_id', frame.id)

  r = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'note',
      label: 'Q4 priorities',
      parent_id: frame.id,
      x: 20,
      y: 60,
      data: {
        markdown: 'AccuVerify COA indexing is the SEO play. Patent first.',
      },
    },
  })
  expect(r.status(), await r.text()).toBe(201)

  r = await request.post(nodes, {
    headers: h,
    data: {
      kind: 'link',
      label: 'accumarklabs.com',
      x: 600,
      y: 100,
      data: { url: 'https://accumarklabs.com' },
    },
  })
  expect(r.status(), await r.text()).toBe(201)
  const link = (await r.json()) as { id: number; version: number }

  r = await request.post(nodes, {
    headers: h,
    data: { kind: 'link', label: 'bad', data: { url: 'javascript:alert(1)' } },
  })
  expect(r.status()).toBe(400)
  record('javascript_url_refused', true)

  r = await request.post(`${BACKEND_URL}/api/boards/${BOARD_SLUG}/edges`, {
    headers: h,
    data: { source_id: link.id, target_id: frame.id, kind: 'related' },
  })
  expect(r.status(), await r.text()).toBe(201)

  r = await request.patch(`${nodes}/positions`, {
    headers: h,
    data: [{ id: link.id, x: 1, y: 1, version: 99 }],
  })
  expect(r.status()).toBe(409)
  const stale = (await r.json()) as { detail: { stale_ids: number[] } }
  expect(stale.detail.stale_ids).toEqual([link.id])
  record('stale_positions_batch_rejected', true)

  r = await request.get(`${BACKEND_URL}/api/boards/${BOARD_SLUG}`, {
    headers: h,
  })
  expect(r.status()).toBe(200)
  const detail = (await r.json()) as {
    nodes: unknown[]
    edges: unknown[]
    can_edit: boolean
    node_count: number
  }
  expect(detail.nodes).toHaveLength(3)
  expect(detail.edges).toHaveLength(1)
  expect(detail.can_edit).toBe(true)
  record('board_detail', {
    nodes: detail.nodes.length,
    edges: detail.edges.length,
  })

  const groups = (await (
    await request.get(`${BACKEND_URL}/api/groups`, { headers: h })
  ).json()) as { id: number; slug: string }[]
  const group = groups.find(g => g.slug === GROUP_SLUG)
  expect(group, 'group from the UI test exists').toBeTruthy()
  r = await request.put(`${BACKEND_URL}/api/boards/${BOARD_SLUG}/grants`, {
    headers: h,
    data: [{ group_id: group!.id, can_edit: true }],
  })
  expect(r.status(), await r.text()).toBe(200)
  expect(((await r.json()) as { group_slug: string }[])[0]?.group_slug).toBe(
    GROUP_SLUG
  )
  record('grant_to_group', GROUP_SLUG)
})

test('OpenAPI lists the boards and groups routes; board detail renders from the API', async ({
  page,
  request,
}) => {
  // Swagger UI cannot render the backend's very large OpenAPI document in
  // headless Chromium within a reasonable budget, so the routers are proven
  // from /openapi.json and the real board detail is shown in the app itself.
  const spec = (await (
    await request.get(`${BACKEND_URL}/openapi.json`)
  ).json()) as {
    paths: Record<string, Record<string, { tags?: string[] }>>
  }
  const newPaths = Object.keys(spec.paths)
    .filter(p => p.startsWith('/api/boards') || p.startsWith('/api/groups'))
    .sort()
  expect(newPaths).toEqual([
    '/api/boards',
    '/api/boards/for-entity',
    '/api/boards/{slug}',
    '/api/boards/{slug}/edges',
    '/api/boards/{slug}/edges/{edge_id}',
    '/api/boards/{slug}/grants',
    '/api/boards/{slug}/nodes',
    '/api/boards/{slug}/nodes/positions',
    '/api/boards/{slug}/nodes/{node_id}',
    '/api/groups',
    '/api/groups/mine',
    '/api/groups/{group_id}',
    '/api/groups/{group_id}/members',
  ])
  record('openapi_paths', newPaths)

  await authenticate(page)
  await page.goto('/')
  await expect(page.locator('#flags-header-button')).toBeVisible({
    timeout: 30_000,
  })
  const rendered = await page.evaluate(async (slug: string) => {
    const token = window.localStorage.getItem('accu_mk1_auth_token')
    // A mounted dev stack serves the SPA behind a vite proxy that strips one
    // `/api` (the app's own client sends `/api/api/...` there); a baked image
    // serves the backend at `/api/...`. Try the proxied form first.
    let res: Response | null = null
    for (const url of [`/api/api/boards/${slug}`, `/api/boards/${slug}`]) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status !== 404) break
    }
    const body = await res!.json()
    const pre = document.createElement('pre')
    pre.id = 'e2e-board-detail'
    pre.style.cssText =
      'position:fixed;inset:24px;z-index:99999;overflow:auto;background:#0b1020;color:#e6edf3;' +
      'padding:16px;border-radius:12px;font:13px/1.4 ui-monospace,monospace;white-space:pre-wrap'
    pre.textContent =
      `GET /api/boards/${slug}  ->  HTTP ${res!.status}\n\n` +
      JSON.stringify(body, null, 2)
    document.body.appendChild(pre)
    return {
      status: res!.status,
      nodes: body.nodes?.length,
      edges: body.edges?.length,
    }
  }, BOARD_SLUG)
  expect(rendered.status).toBe(200)
  expect(rendered.nodes).toBe(3)
  expect(rendered.edges).toBe(1)
  await expect(page.locator('#e2e-board-detail')).toBeVisible()
  await shot(page, '03-board-detail-from-api.png')
})

test('A flag raised on a board frame shows in the flyout with the board label', async ({
  page,
  request,
}) => {
  const h = bearer(await adminToken(request))
  const detail = (await (
    await request.get(`${BACKEND_URL}/api/boards/${BOARD_SLUG}`, { headers: h })
  ).json()) as { nodes: { id: number; kind: string }[] }
  const frame = detail.nodes.find(n => n.kind === 'frame')
  expect(frame).toBeTruthy()

  const r = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: h,
    data: {
      entity_type: 'board_node',
      entity_id: String(frame!.id),
      type: 'task',
      title: FLAG_TITLE,
    },
  })
  expect(r.status(), await r.text()).toBe(201)
  const flag = (await r.json()) as { id: number; entity?: { label?: string } }
  expect(flag.entity?.label).toBe('Company map > Marketing')
  record('board_node_flag', { id: flag.id, label: flag.entity?.label })

  await authenticate(page)
  await page.goto('/')
  await page.locator('#flags-header-button').click()
  await page.getByRole('tab', { name: 'All open' }).click()
  await expect(page.getByText(FLAG_TITLE)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Company map > Marketing').first()).toBeVisible()
  await shot(page, '04-board-node-flag-in-flyout.png')
})

test('Non-admin: group writes 403, company board visible, node write 403, unknown board 404', async ({
  request,
}) => {
  const admin = bearer(await adminToken(request))
  const email = `e2e-standard-${RUN}@accumark.local`
  const password = randomBytes(12).toString('base64url')
  const created = await request.post(`${BACKEND_URL}/auth/users`, {
    headers: admin,
    data: { email, password, role: 'standard' },
  })
  expect([200, 201], `create standard user: ${created.status()}`).toContain(
    created.status()
  )

  const std = bearer(await login(request, email, password))

  let r = await request.post(`${BACKEND_URL}/api/groups`, {
    headers: std,
    data: { slug: `nope-${RUN}`, name: 'Nope' },
  })
  expect(r.status()).toBe(403)

  r = await request.get(`${BACKEND_URL}/api/boards`, { headers: std })
  expect(r.status()).toBe(200)
  const visible = (await r.json()) as { slug: string; can_edit: boolean }[]
  const mine = visible.find(b => b.slug === BOARD_SLUG)
  expect(mine, 'company board is visible to every active user').toBeTruthy()
  expect(mine!.can_edit).toBe(false)

  r = await request.post(`${BACKEND_URL}/api/boards/${BOARD_SLUG}/nodes`, {
    headers: std,
    data: { kind: 'text', label: 'viewer cannot write' },
  })
  expect(r.status()).toBe(403)

  r = await request.get(`${BACKEND_URL}/api/boards/does-not-exist-${RUN}`, {
    headers: std,
  })
  expect(r.status()).toBe(404)

  r = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: std,
    data: { slug: `std-${RUN}`, name: 'Std' },
  })
  expect(r.status()).toBe(403)
  record('non_admin_guards', {
    groups_post: 403,
    node_post: 403,
    unknown_board: 404,
    board_post: 403,
  })
})
