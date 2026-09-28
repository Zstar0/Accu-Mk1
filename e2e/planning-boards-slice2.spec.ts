import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

/**
 * Planning boards, slice 2: a flag on a restricted board is invisible outside the board's
 * groups, across the API and the flag flyout. Creates its own group, two standard users
 * (member, outsider), a restricted board, a frame and a flag, all suffixed per run.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS =
  process.env.E2E_SHOTS_DIR ??
  'docs/superpowers/evidence/2026-09-27-planning-boards-slice2'
const RUN = Date.now().toString(36).slice(-4)
const TITLE = `Secret plan (${RUN})`
const TOKEN_KEY = 'accu_mk1_auth_token'
const USER_KEY = 'accu_mk1_auth_user'

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

// The auth-store (src/store/auth-store.ts) hydrates `user`/`token` from these two
// localStorage keys at module load, the same mechanism e2e/fixtures/auth.ts already
// relies on for slice 1. App.tsx then renders nothing (isLoading stays true) until its
// mount effect resolves fetchCurrentUser() (GET /auth/me) with the real bearer token,
// which overwrites `user` with the full AuthUser row from the backend. So the seeded
// object below only needs to satisfy `persisted.user !== null` and the AuthUser shape
// for type completeness; the real values that end up rendered come from /auth/me. If
// this ever stops hydrating, fall back to driving the login form directly the way
// e2e/fixtures/auth.ts's comment describes as the alternative.
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

let admin = ''
let memberTok = ''
let outsiderTok = ''
let memberEmail = ''
let outsiderEmail = ''
let flagId = 0
let boardSlug = ''
let frameId = 0

test('setup: group, member, outsider, restricted board, frame, flag', async ({
  request,
}) => {
  admin = await login(
    request,
    process.env.E2E_EMAIL!,
    process.env.E2E_PASSWORD!
  )
  const h = bearer(admin)
  memberEmail = `e2e-member-${RUN}@accumark.local`
  outsiderEmail = `e2e-outsider-${RUN}@accumark.local`
  const pw = randomBytes(12).toString('base64url')
  for (const email of [memberEmail, outsiderEmail]) {
    const r = await request.post(`${BACKEND_URL}/auth/users`, {
      headers: h,
      data: { email, password: pw, role: 'standard' },
    })
    expect([200, 201]).toContain(r.status())
  }
  const members = (await (
    await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })
  ).json()) as { id: number; email: string }[]
  const memberId = members.find(u => u.email === memberEmail)!.id
  const g = await request.post(`${BACKEND_URL}/api/groups`, {
    headers: h,
    data: { slug: `exec-${RUN}`, name: 'Exec' },
  })
  expect(g.status()).toBe(201)
  const gid = ((await g.json()) as { id: number }).id
  expect(
    (
      await request.put(`${BACKEND_URL}/api/groups/${gid}/members`, {
        headers: h,
        data: { user_ids: [memberId] },
      })
    ).status()
  ).toBe(200)
  boardSlug = `exec-board-${RUN}`
  const b = await request.post(`${BACKEND_URL}/api/boards`, {
    headers: h,
    data: {
      slug: boardSlug,
      name: 'Exec board',
      kind: 'map',
      visibility: 'restricted',
    },
  })
  expect(b.status(), await b.text()).toBe(201)
  record('restricted_board_created', true)
  expect(
    (
      await request.put(`${BACKEND_URL}/api/boards/${boardSlug}/grants`, {
        headers: h,
        data: [{ group_id: gid, can_edit: true }],
      })
    ).status()
  ).toBe(200)
  const f = await request.post(`${BACKEND_URL}/api/boards/${boardSlug}/nodes`, {
    headers: h,
    data: {
      kind: 'frame',
      label: 'Compensation review',
      x: 40,
      y: 40,
      w: 400,
      h: 240,
      data: { color: 'red' },
    },
  })
  expect(f.status()).toBe(201)
  frameId = ((await f.json()) as { id: number }).id
  const fl = await request.post(`${BACKEND_URL}/api/flags`, {
    headers: h,
    data: {
      entity_type: 'board_node',
      entity_id: String(frameId),
      type: 'task',
      title: TITLE,
    },
  })
  expect(fl.status(), await fl.text()).toBe(201)
  flagId = ((await fl.json()) as { id: number }).id
  memberTok = await login(request, memberEmail, pw)
  outsiderTok = await login(request, outsiderEmail, pw)
})

test('API: the outsider cannot see the board or the flag; the member can', async ({
  request,
}) => {
  const o = bearer(outsiderTok)
  const m = bearer(memberTok)
  expect(
    (
      await request.get(`${BACKEND_URL}/api/boards/${boardSlug}`, {
        headers: o,
      })
    ).status()
  ).toBe(404)
  expect(
    (
      await request.get(`${BACKEND_URL}/api/boards/${boardSlug}`, {
        headers: m,
      })
    ).status()
  ).toBe(200)
  const hidden = await request.get(`${BACKEND_URL}/api/flags/${flagId}`, {
    headers: o,
  })
  const missing = await request.get(`${BACKEND_URL}/api/flags/999999999`, {
    headers: o,
  })
  expect(hidden.status()).toBe(404)
  expect(missing.status()).toBe(404)
  expect(
    (
      await request.get(`${BACKEND_URL}/api/flags/${flagId}`, { headers: m })
    ).status()
  ).toBe(200)
  const oList = (await (
    await request.get(`${BACKEND_URL}/api/flags?tab=all_open`, { headers: o })
  ).json()) as { title: string }[]
  const mList = (await (
    await request.get(`${BACKEND_URL}/api/flags?tab=all_open`, { headers: m })
  ).json()) as { title: string }[]
  expect(oList.map(f => f.title)).not.toContain(TITLE)
  expect(mList.map(f => f.title)).toContain(TITLE)
  const oSearch = (await (
    await request.get(
      `${BACKEND_URL}/api/flags/entity-search?entity_type=board_node&q=Compensation`,
      { headers: o }
    )
  ).json()) as { entity_id: string; label: string }[]
  expect(oSearch.some(hit => hit.entity_id === String(frameId))).toBe(false)
  expect(oSearch.some(hit => hit.label.includes('Compensation'))).toBe(false)
  const mSearch = (await (
    await request.get(
      `${BACKEND_URL}/api/flags/entity-search?entity_type=board_node&q=Compensation`,
      { headers: m }
    )
  ).json()) as { entity_id: string; label: string }[]
  expect(mSearch.some(hit => hit.entity_id === String(frameId))).toBe(true)
  const outsiderId = (
    (await (
      await request.get(`${BACKEND_URL}/worksheets/users`, {
        headers: bearer(admin),
      })
    ).json()) as { id: number; email: string }[]
  ).find(u => u.email === outsiderEmail)!.id
  const assign = await request.post(
    `${BACKEND_URL}/api/flags/${flagId}/assign`,
    { headers: bearer(admin), data: { assignee_id: outsiderId } }
  )
  expect(assign.status()).toBe(400)
  record('outsider', {
    board: 404,
    flag: 404,
    in_all_open: false,
    entity_search: 'hidden',
    assign: 400,
  })
  record('member', {
    board: 200,
    flag: 200,
    in_all_open: true,
    entity_search: 'visible',
  })
})

test('flyout: the member sees the flag, the outsider does not', async ({
  browser,
}) => {
  const mCtx = await browser.newContext()
  const mPage = await mCtx.newPage()
  await asUser(mPage, memberTok, memberEmail, 'standard')
  await mPage.goto('/')
  await mPage.locator('#flags-header-button').click()
  await mPage.getByRole('tab', { name: 'All open' }).click()
  await expect(mPage.getByText(TITLE)).toBeVisible({ timeout: 15_000 })
  await shot(mPage, '01-member-sees-restricted-flag.png')
  await mCtx.close()

  const oCtx = await browser.newContext()
  const oPage = await oCtx.newPage()
  await asUser(oPage, outsiderTok, outsiderEmail, 'standard')
  await oPage.goto('/')
  await oPage.locator('#flags-header-button').click()
  await oPage.getByRole('tab', { name: 'All open' }).click()
  await expect(oPage.getByRole('tab', { name: 'All open' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await oPage.waitForTimeout(1500)
  await expect(oPage.getByText(TITLE)).toHaveCount(0)
  await shot(oPage, '02-outsider-does-not-see-restricted-flag.png')
  await oCtx.close()
})
