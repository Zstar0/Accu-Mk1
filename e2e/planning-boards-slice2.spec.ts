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
 * Also covers the activity feed, search, a live SSE stream subscription, and that
 * revoking group membership immediately hides the flag on the next request and stream.
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

/** Poll `check` until it returns true or `timeoutMs` elapses. */
async function pollUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return check()
}

interface StreamHandle {
  text: () => string
  close: () => void
}

interface ParsedFrame {
  event: string
  data: Record<string, unknown>
}

/**
 * Parse complete SSE frames out of a raw stream buffer: split on blank
 * lines, skip comment-only blocks (`: connected`, `: keepalive`), and
 * JSON-parse each block's `data:` line. The server writes `json.dumps`
 * output with a space after every colon, so callers must never match on
 * a `"key":value` substring of the raw buffer - only on parsed fields.
 * A block with no parseable `data:` line is skipped, since a partial
 * trailing frame is expected while the stream is still open.
 */
function framesOf(buffer: string): ParsedFrame[] {
  const frames: ParsedFrame[] = []
  for (const block of buffer.split(/\r?\n\r?\n/)) {
    let event = ''
    // A frame's JSON body can be split across multiple `data:` lines (SSE
    // spec); join them the same way src/lib/flag-stream.ts's parseFrame
    // does instead of letting a second `data:` line overwrite the first.
    const dataLines: string[] = []
    for (const raw of block.split(/\r?\n/)) {
      if (!raw || raw.startsWith(':')) continue
      if (raw.startsWith('event:')) event = raw.slice(6).trim()
      else if (raw.startsWith('data:')) dataLines.push(raw.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    try {
      frames.push({
        event,
        data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
      })
    } catch {
      continue
    }
  }
  return frames
}

/**
 * Open a raw SSE read against /api/flags/stream (the fetch-reader shape from
 * src/lib/flag-stream.ts, not EventSource, since we need the bearer header).
 * Reads chunks into a string buffer in the background; the caller polls
 * `text()` and calls `close()` to abort the underlying fetch. `label`
 * (e.g. `'member'`, `'outsider'`) tags the diagnostic console lines emitted
 * for the response status and each chunk, so a `--reporter=list` run shows
 * per-stream timing without ever printing chunk contents.
 */
async function openStream(token: string, label: string): Promise<StreamHandle> {
  const controller = new AbortController()
  const opened = Date.now()
  let buffer = ''
  fetch(`${BACKEND_URL}/api/flags/stream`, {
    headers: bearer(token),
    signal: controller.signal,
  })
    .then(async response => {
      console.log(
        `[sse:${label}] status ${response.status} at +${Date.now() - opened}ms`
      )
      if (!response.body) return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        console.log(
          `[sse:${label}] chunk at +${Date.now() - opened}ms, ${value.byteLength}B`
        )
      }
    })
    .catch((err: unknown) => {
      const name = (err as { name?: string } | undefined)?.name
      if (name === 'AbortError') return // expected: close() aborted the read
      console.log(`[sse:${label}] reader error: ${name ?? 'unknown'}`)
    })
  return { text: () => buffer, close: () => controller.abort() }
}

let admin = ''
let memberTok = ''
let outsiderTok = ''
let memberEmail = ''
let outsiderEmail = ''
let flagId = 0
let boardSlug = ''
let frameId = 0
let gid = 0
let memberId = 0
let outsiderId = 0

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
  memberId = members.find(u => u.email === memberEmail)!.id
  const g = await request.post(`${BACKEND_URL}/api/groups`, {
    headers: h,
    data: { slug: `exec-${RUN}`, name: 'Exec' },
  })
  expect(g.status()).toBe(201)
  gid = ((await g.json()) as { id: number }).id
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
  outsiderId = (
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

test('activity, search and the live stream follow visibility', async ({
  request,
}) => {
  // GET /api/flags/activity is relevance-scoped on top of visibility
  // (service._relevant_flag_ids): a user's feed only carries events on
  // flags they raised, are assigned, watch, or were mentioned in. The
  // member is none of those for the secret flag yet, so make them a
  // watcher first - do not "simplify" this away, the activity assertions
  // below have nothing to find without it. The outsider must be rejected
  // from watching the same flag, same as assign.
  const watchMember = await request.post(
    `${BACKEND_URL}/api/flags/${flagId}/watchers`,
    { headers: bearer(admin), data: { user_id: memberId } }
  )
  expect(watchMember.status(), await watchMember.text()).toBe(201)
  const watchOutsider = await request.post(
    `${BACKEND_URL}/api/flags/${flagId}/watchers`,
    { headers: bearer(admin), data: { user_id: outsiderId } }
  )
  expect(watchOutsider.status()).toBe(400)

  const memberStream = await openStream(memberTok, 'member')
  const outsiderStream = await openStream(outsiderTok, 'outsider')
  const hasCommentFrame = (text: string) =>
    framesOf(text).some(
      f => f.event === 'commented' && f.data.flag_id === flagId
    )
  // Everything between open and close must be wrapped so a failed
  // assertion in here (e.g. the comment POST) still closes both
  // connections instead of leaking a live stream against the shared stack.
  try {
    await pollUntil(() => memberStream.text().includes(': connected'), 5_000)
    await pollUntil(() => outsiderStream.text().includes(': connected'), 5_000)

    const comment = await request.post(
      `${BACKEND_URL}/api/flags/${flagId}/comments`,
      {
        headers: bearer(admin),
        data: { body: `Secret comment (${RUN})` },
      }
    )
    expect(comment.status(), await comment.text()).toBe(201)

    await pollUntil(() => hasCommentFrame(memberStream.text()), 8_000)
    await new Promise(resolve => setTimeout(resolve, 1_500))
  } finally {
    memberStream.close()
    outsiderStream.close()
  }

  const memberText = memberStream.text()
  const outsiderText = outsiderStream.text()
  const memberFrames = framesOf(memberText)
  const memberGotComment = memberFrames.some(
    f => f.event === 'commented' && f.data.flag_id === flagId
  )
  const outsiderGotComment = hasCommentFrame(outsiderText)

  expect(
    memberGotComment,
    `member frames: ${memberFrames
      .map(f => `${f.event}:${f.data.flag_id}`)
      .join(',')} (buffer ${memberText.length}B)`
  ).toBe(true)
  expect(memberText).not.toContain('"audience"')
  expect(outsiderText).not.toContain('"audience"')
  expect(outsiderGotComment).toBe(false)

  const outsiderActivity = (await (
    await request.get(`${BACKEND_URL}/api/flags/activity`, {
      headers: bearer(outsiderTok),
    })
  ).json()) as { items: { flag: { title: string } }[] }
  const memberActivity = (await (
    await request.get(`${BACKEND_URL}/api/flags/activity`, {
      headers: bearer(memberTok),
    })
  ).json()) as { items: { flag: { title: string } }[] }
  const outsiderHasActivity = outsiderActivity.items.some(
    item => item.flag.title === TITLE
  )
  const memberHasActivity = memberActivity.items.some(
    item => item.flag.title === TITLE
  )
  // The outsider is never relevant to this flag (not the raiser, not
  // assigned, not a watcher - see the rejected watch above - and never
  // mentioned), so this proves nothing leaks. The visibility clause itself
  // is proven by the revocation test's activity_after_revocation check,
  // where the member IS a stale watcher yet still gets nothing back.
  expect(outsiderHasActivity).toBe(false)
  expect(memberHasActivity).toBe(true)

  const q = encodeURIComponent('Secret plan')
  const outsiderSearch = (await (
    await request.get(`${BACKEND_URL}/api/flags/search?q=${q}`, {
      headers: bearer(outsiderTok),
    })
  ).json()) as { flag_id: number; title: string }[]
  const memberSearch = (await (
    await request.get(`${BACKEND_URL}/api/flags/search?q=${q}`, {
      headers: bearer(memberTok),
    })
  ).json()) as { flag_id: number; title: string }[]
  const outsiderHasSearchHit = outsiderSearch.some(
    hit => hit.flag_id === flagId
  )
  const memberHasSearchHit = memberSearch.some(hit => hit.flag_id === flagId)
  expect(outsiderHasSearchHit).toBe(false)
  expect(memberHasSearchHit).toBe(true)

  record('outsider_m1', {
    activity: outsiderHasActivity,
    search: outsiderHasSearchHit ? 'visible' : 'hidden',
    sse: outsiderGotComment ? 'event received' : 'silent',
  })
  record('member_m1', {
    activity: memberHasActivity,
    search: memberHasSearchHit ? 'visible' : 'hidden',
    sse: memberGotComment ? 'event received' : 'silent',
  })
})

test('revocation: the member loses the flag on the next request and on a new stream', async ({
  request,
}) => {
  // The member is also a stale watcher now (added in the previous test)
  // despite leaving the group - a stale watcher row must not resurface the
  // flag anywhere, including the activity feed.
  expect(
    (
      await request.put(`${BACKEND_URL}/api/groups/${gid}/members`, {
        headers: bearer(admin),
        data: { user_ids: [] },
      })
    ).status()
  ).toBe(200)

  const m = bearer(memberTok)
  const flagStatus = (
    await request.get(`${BACKEND_URL}/api/flags/${flagId}`, { headers: m })
  ).status()
  const memberList = (await (
    await request.get(`${BACKEND_URL}/api/flags?tab=all_open`, {
      headers: m,
    })
  ).json()) as { title: string }[]
  const inAllOpen = memberList.map(f => f.title).includes(TITLE)
  const boardStatus = (
    await request.get(`${BACKEND_URL}/api/boards/${boardSlug}`, {
      headers: m,
    })
  ).status()
  expect(flagStatus).toBe(404)
  expect(inAllOpen).toBe(false)
  expect(boardStatus).toBe(404)

  const memberActivityAfter = (await (
    await request.get(`${BACKEND_URL}/api/flags/activity`, { headers: m })
  ).json()) as { items: { flag: { title: string } }[] }
  const activityAfterRevocation = memberActivityAfter.items.some(
    item => item.flag.title === TITLE
  )
  expect(activityAfterRevocation).toBe(false)

  const newStream = await openStream(memberTok, 'member-after-revocation')
  try {
    await pollUntil(() => newStream.text().includes(': connected'), 5_000)
    const comment = await request.post(
      `${BACKEND_URL}/api/flags/${flagId}/comments`,
      {
        headers: bearer(admin),
        data: { body: `After revocation (${RUN})` },
      }
    )
    expect(comment.status(), await comment.text()).toBe(201)
    await new Promise(resolve => setTimeout(resolve, 4_000))
  } finally {
    newStream.close()
  }
  const newStreamHasFlag = framesOf(newStream.text()).some(
    f => f.event === 'commented' && f.data.flag_id === flagId
  )
  expect(newStreamHasFlag).toBe(false)

  record('revoked_member', {
    flag: flagStatus,
    in_all_open: inAllOpen,
    board: boardStatus,
    activity_after_revocation: activityAfterRevocation,
    new_stream: newStreamHasFlag ? 'event received' : 'silent',
  })
})
