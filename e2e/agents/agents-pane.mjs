// Browser check of Settings > Agents in the compiled app (dev only).
// REAL: dist/ (index.html + assets), the Mk1 FastAPI app (mk1_fixture.py: /auth/login, /admin/agents,
// the agent-key auth path and documents routes on a throwaway SQLite).
// COPIED: nginx's /api strip, as in e2e/paperclip-app/provenance-embed.mjs.
// The key is read from the create/rotate RESPONSES in Node, never from the page, never logged or written.
// Screenshots are taken only with the one-time key panel closed and no `mk1a.` text on the page.
// Run: `VITE_API_URL=/api npm run build` (PowerShell), then
// `MK1_PY=<backend venv python> node e2e/agents/agents-pane.mjs`; copy results.json + the two PNGs
// from APP_E2E_OUT into docs/superpowers/e2e/.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = process.env.APP_E2E_OUT || 'C:/tmp/mk1-agents-pane-e2e'
const PY = process.env.MK1_PY || 'python'
fs.mkdirSync(OUT, { recursive: true })
const MK1 = 'http://127.0.0.1:8571'
const API = 'http://127.0.0.1:8563'
const rand = n => crypto.randomBytes(n).toString('hex')
const ADMIN_PASSWORD = rand(12)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk1-agents-e2e-'))
const fixture = spawn(
  PY,
  [path.join(ROOT, 'e2e/paperclip-app/mk1_fixture.py')],
  {
    env: {
      ...process.env,
      MK1_FIXTURE_DIR: fixtureDir,
      JWT_SECRET: rand(32),
      MK1_READER_PASSWORD: rand(12),
      MK1_DOCUMENT_AGENT_TOKENS: `jarvis:${rand(24)}:general`,
      MK1_FIXTURE_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
    stdio: [
      'ignore',
      fs.openSync(`${OUT}/mk1-fixture.log`, 'w'),
      fs.openSync(`${OUT}/mk1-fixture.err.log`, 'w'),
    ],
  }
)
const types = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}
const mk1 = http.createServer((req, res) => {
  const url = new URL(req.url, MK1)
  if (url.pathname.startsWith('/api/')) {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: 8563,
        method: req.method,
        path: req.url.slice(4),
        headers: req.headers,
      },
      r => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      }
    )
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    return req.pipe(up)
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname
  const p = path.join(ROOT, 'dist', file)
  if (!p.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(p)) {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, {
    'content-type': types[path.extname(p)] || 'application/octet-stream',
  })
  res.end(fs.readFileSync(p))
})
await new Promise((r, j) => {
  mk1.once('error', j)
  mk1.listen(8571, '127.0.0.1', r)
})

const waitFor = async (url, ms = 90000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return r
    } catch {
      /* not up */
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timeout waiting for ${url}`)
}
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}
// Status only: the key goes in the header and nowhere else.
const asAgent = async (key, p) =>
  (await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${key}` } }))
    .status
const keyResponse = (page, suffix) =>
  page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().endsWith(suffix)
  )

let browser, page
const console_ = []
try {
  await waitFor(`${API}/openapi.json`)
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', m => console_.push(`${m.type()}: ${m.text()}`))
  page.on('response', r => {
    if (r.status() >= 500)
      console_.push(`http ${r.status()}: ${new URL(r.url()).pathname}`)
  })
  const panel = page.locator('[data-testid="agent-key-once"]')
  const noKeyOnPage = async () =>
    (await panel.count()) === 0 && !(await page.content()).includes('mk1a.')

  await page.goto(`${MK1}/#settings/agents`)
  await page.fill('#email', 'admin@example.test')
  await page.fill('#password', ADMIN_PASSWORD)
  await page.click('button[type=submit]')
  await page
    .getByRole('button', { name: 'Create agent' })
    .waitFor({ timeout: 30000 })
  check('admin signed in and Settings > Agents is open', true)

  await page.fill('#agent-username', 'devon')
  await page.fill('#agent-display', 'Devon')
  const created = keyResponse(page, '/api/admin/agents')
  await page.getByRole('button', { name: 'Create agent' }).click()
  const cr = await created
  const createKey = (await cr.json()).key
  check(
    'create returned 201 with a devon key',
    cr.status() === 201 && createKey?.startsWith('mk1a.devon.'),
    `status=${cr.status()}`
  )
  await panel.waitFor({ timeout: 10000 })
  check(
    'one-time panel shows LABMGR_MK1_AGENT_NAME=devon',
    (await panel
      .locator('pre', { hasText: 'LABMGR_MK1_AGENT_NAME=devon' })
      .count()) === 1
  )
  check(
    'one-time panel shows the issued key (matched in the page, not read out)',
    (await panel
      .locator('pre', { hasText: `LABMGR_MK1_AGENT_KEY=${createKey}` })
      .count()) === 1
  )

  // Before any rotate: the create key works on an allowed route, is refused elsewhere.
  check(
    'create key authenticates GET /api/documents',
    (await asAgent(createKey, '/api/documents')) === 200
  )
  const me = await asAgent(createKey, '/auth/me')
  check('create key is refused on GET /auth/me', me === 403, `status=${me}`)

  await panel.getByRole('button', { name: 'Done' }).click()
  check(
    'Done closes the panel and no mk1a. text remains',
    await until(noKeyOnPage)
  )

  const lab = page.getByRole('switch', { name: 'Lab tools for Devon' })
  const coa = page.getByRole('switch', { name: 'COA publishing for Devon' })
  check('COA publishing starts disabled', await coa.isDisabled())
  const patched = page.waitForResponse(
    r =>
      r.request().method() === 'PATCH' && r.url().includes('/api/admin/agents/')
  )
  await lab.click()
  const pr = await patched
  check(
    'Lab tools turns on (PATCH 200)',
    pr.status() === 200 &&
      (await until(
        async () => (await lab.getAttribute('aria-checked')) === 'true'
      )),
    `status=${pr.status()}`
  )
  check('COA publishing becomes enabled', await until(() => coa.isEnabled()))
  if (await noKeyOnPage())
    await page.screenshot({
      path: `${OUT}/agents-created.png`,
      animations: 'disabled',
    })

  let dialog = ''
  page.once('dialog', d => {
    dialog = d.message()
    d.accept()
  })
  const rotated = keyResponse(page, '/rotate-key')
  await page.getByRole('button', { name: 'Rotate key for Devon' }).click()
  const rr = await rotated
  const newKey = (await rr.json()).key
  check(
    'rotate asked to confirm and returned a new key',
    dialog.startsWith("Rotate Devon's key?") &&
      rr.status() === 200 &&
      newKey?.startsWith('mk1a.devon.') &&
      newKey !== createKey,
    `status=${rr.status()}`
  )
  await panel.waitFor({ timeout: 10000 })
  check(
    'panel reopens with the rotated key only',
    (await panel.locator('pre', { hasText: newKey }).count()) === 1 &&
      !(await page.content()).includes(createKey)
  )
  const oldStatus = await asAgent(createKey, '/api/documents')
  check(
    'old key stops on the next request',
    oldStatus === 401,
    `status=${oldStatus}`
  )
  check(
    'rotated key authenticates GET /api/documents',
    (await asAgent(newKey, '/api/documents')) === 200
  )
  await panel.getByRole('button', { name: 'Done' }).click()
  const clean = await until(noKeyOnPage)
  check('Done closes the rotated panel and no mk1a. text remains', clean)
  if (clean)
    await page.screenshot({
      path: `${OUT}/agents-rotated.png`,
      animations: 'disabled',
    })
  check(
    'two screenshots written with the panel closed',
    ['agents-created.png', 'agents-rotated.png'].every(f =>
      fs.existsSync(`${OUT}/${f}`)
    )
  )
  fs.writeFileSync(`${OUT}/console.log`, console_.join('\n'))
} catch (e) {
  // Redacted: a hasText selector quoted in the error can carry a key.
  check(
    'run completed',
    false,
    String(e)
      .split('\n')[0]
      .replace(/mk1a\.\S+/g, 'mk1a.[redacted]')
  )
  if (page)
    await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {})
  fs.writeFileSync(`${OUT}/console.log`, console_.join('\n'))
} finally {
  await browser?.close()
  mk1.close()
  fixture.kill()
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2))
  const failed = results.filter(r => !r.ok).length
  console.log(`${results.length - failed}/${results.length} passed`)
  process.exitCode = failed ? 1 : 0
}
