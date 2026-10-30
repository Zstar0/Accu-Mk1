// Paperclip-app acceptance: real Paperclip UI + server (throwaway instance in WSL, started
// by /tmp/accept-ag/pc-launch.sh on 127.0.0.1:8560) framing the real compiled Mk1 embed,
// backed by the real Mk1 FastAPI app on a fixture SQLite (mk1_fixture.py).
//
// REAL:    Paperclip UI (vite dev middleware) + routes + embedded Postgres; Paperclip agent
//          JWT path; Mk1 dist/embed.html + assets; Mk1 /auth/login + documents routes;
//          the mk1-publish-document helper.
// RELAY:   127.0.0.1:8560 on Windows -> WSL 127.0.0.1:8560, a byte pipe through wsl.exe
//          (WSL NAT does not forward loopback here). No HTTP parsing.
// COPIED:  /embed.html CSP header text taken from nginx.conf (envsubst emulated), and a
//          /api prefix strip like nginx's. Not packaged nginx.
// Run: copy wsl/* to /tmp/accept-ag/ in WSL (corepack enable --install-directory
// /tmp/accept-ag/bin pnpm once), `npm run build` with VITE_API_URL=/api, start
// `bash /tmp/accept-ag/env.sh bash /tmp/accept-ag/pc-launch.sh` in WSL, then
// `node e2e/paperclip-app/run.mjs`; afterwards `bash /tmp/accept-ag/stop.sh`.
// The Paperclip seed is server/scripts/accumk1-acceptance-seed.ts on its AccuMk1 branch.
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = process.env.APP_E2E_OUT || 'C:/tmp/mk1-paperclip-app-e2e'
fs.mkdirSync(OUT, { recursive: true })
const PAPERCLIP = 'http://localhost:8560'
const MK1 = 'http://127.0.0.1:8561'
const WSL_TMP = '//wsl.localhost/Ubuntu/tmp/accept-ag'
const NODE24 = '/home/forrest/.hermes/cache/scratch/node-v24.21.0-paperclip/extract/node-v24.21.0-linux-x64/bin/node'
const rand = n => crypto.randomBytes(n).toString('hex')
const AGENT_TOKEN = rand(24)
const READER_PASSWORD = rand(12)
const RUN_ID = crypto.randomUUID()
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const children = []
const servers = []

// --- Mk1 fixture backend (real main.app) on 8563
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk1-app-e2e-'))
const fixture = spawn('python', [path.join(import.meta.dirname, 'mk1_fixture.py')], {
  env: { ...process.env, MK1_FIXTURE_DIR: fixtureDir, JWT_SECRET: rand(32), MK1_READER_PASSWORD: READER_PASSWORD,
    MK1_DOCUMENT_AGENT_TOKENS: `paperclip-agent:${AGENT_TOKEN}:general+leadership` },
  stdio: ['ignore', fs.openSync(`${OUT}/mk1-fixture.log`, 'w'), fs.openSync(`${OUT}/mk1-fixture.err.log`, 'w')],
})
children.push(fixture)

// --- Mk1 origin on 8561: dist + embed CSP (copied text) + /api strip proxy to 8563
const nginx = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8')
const embedCsp = /location = \/embed\.html \{[\s\S]*?add_header Content-Security-Policy "([^"]+)"/
  .exec(nginx)[1].replace('${MK1_EMBED_FRAME_ANCESTORS}', PAPERCLIP)
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const mk1Api = []
const mk1 = http.createServer((req, res) => {
  const url = new URL(req.url, MK1)
  if (url.pathname.startsWith('/api/')) {
    mk1Api.push(`${req.method} ${url.pathname}`)
    const up = http.request({ host: '127.0.0.1', port: 8563, method: req.method, path: req.url.slice(4), headers: req.headers },
      r => { mk1Api.push(`  -> ${r.statusCode}`); res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    up.on('error', e => { mk1Api.push(`  -> 502 ${e}`); res.writeHead(502); res.end() })
    return req.pipe(up)
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname
  const p = path.join(ROOT, 'dist', file)
  if (!p.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(p)) { res.writeHead(404); return res.end() }
  const headers = { 'content-type': types[path.extname(p)] || 'application/octet-stream' }
  if (file === '/embed.html') Object.assign(headers, { 'content-security-policy': embedCsp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' })
  res.writeHead(200, headers)
  res.end(fs.readFileSync(p))
})

// --- Relay 127.0.0.1:8560 -> WSL 127.0.0.1:8560
const relay = net.createServer(sock => {
  const p = spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', NODE24, '/tmp/accept-ag/pipe.mjs'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  children.push(p)
  sock.pipe(p.stdin); p.stdout.pipe(sock)
  sock.on('error', () => p.kill()); sock.on('close', () => p.kill()); p.on('exit', () => sock.destroy())
})
const listen = (srv, port) => new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', r) })
await listen(mk1, 8561); servers.push(mk1)
await listen(relay, 8560); servers.push(relay)

const waitFor = async (url, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return r } catch { /* not up */ } await new Promise(r => setTimeout(r, 500)) }
  throw new Error(`timeout waiting for ${url}`)
}

let browser
try {
  await waitFor('http://127.0.0.1:8563/openapi.json', 90000)
  const health = await (await waitFor(`${PAPERCLIP}/api/health`)).json()
  check('Paperclip is the throwaway branch build', health.serverInfo?.git?.branchName === 'feat/accumk1-canonical-doc-slice' && health.deploymentMode === 'local_trusted', `${health.serverInfo?.git?.shortSha} ${health.deploymentMode}`)

  // --- Real helper: create the draft, repeat, and a restricted-space draft
  const html = path.join(fixtureDir, 'report.html')
  fs.writeFileSync(html, `<!doctype html><html><head><title>Synthetic quarterly report</title>
<style>body{font-family:Georgia,serif;margin:24px} h1{color:rgb(12,74,110);font-weight:700;border-bottom:3px solid rgb(14,165,233)}
.kpi{display:inline-block;padding:8px 14px;background:rgb(240,249,255);border-radius:8px;margin-right:8px}</style></head>
<body><h1>Synthetic quarterly report</h1><span class="kpi">Samples 128</span><span class="kpi">On time 97%</span>
<script>document.querySelector('h1').dataset.scriptRan='yes'</script></body></html>`)
  // async: this process also serves the 8561 proxy the helper talks to
  const helper = (file, extra = []) => new Promise(resolve => {
    const p = spawn('python', [path.join(ROOT, '.claude/skills/mk1-publish-document/scripts/publish_document.py'), file,
      '--category', 'ART', '--draft', '--author', 'Acceptance Requester', '--session', RUN_ID, '--paperclip-ref', ...extra],
    { env: { ...process.env, MK1_API_BASE_URL: `${MK1}/api`, MK1_DOCUMENT_AGENT_TOKEN: AGENT_TOKEN, ACCUMK1_INTERNAL_SERVICE_TOKEN: '' } })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d }); p.stderr.on('data', d => { stderr += d })
    p.on('close', status => resolve({ status, stdout, stderr }))
  })
  const lastJson = s => JSON.parse(s.trim().split('\n').filter(l => l.trim().startsWith('{')).pop() ?? s)
  const h1 = await helper(html, ['--title', 'Synthetic quarterly report'])
  fs.writeFileSync(`${OUT}/helper-create.txt`, `exit=${h1.status}\n${h1.stdout}\n${h1.stderr}`)
  const good = lastJson(h1.stdout)
  check('helper created a draft and printed the reference', h1.status === 0 && good.status === 'draft' && /^[0-9a-f]{64}$/.test(good.contentHash), `exit=${h1.status} ${good.code} r${good.revision}`)
  const h2 = await helper(html, ['--title', 'Synthetic quarterly report'])
  fs.writeFileSync(`${OUT}/helper-repeat.txt`, `exit=${h2.status}\n${h2.stdout}\n${h2.stderr}`)
  check('helper repeat mints nothing (first-attempt 409 => exit 4)', h2.status === 4, `exit=${h2.status}`)
  const html2 = path.join(fixtureDir, 'restricted.html')
  fs.writeFileSync(html2, '<!doctype html><html><head><title>Leadership plan</title><style>h1{color:red}</style></head><body><h1>Leadership plan</h1></body></html>')
  const h3 = await helper(html2, ['--title', 'Leadership plan', '--space', 'leadership'])
  fs.writeFileSync(`${OUT}/helper-restricted.txt`, `exit=${h3.status}\n${h3.stdout}\n${h3.stderr}`)
  const restricted = lastJson(h3.stdout)
  check('helper created a restricted-space draft', h3.status === 0 && restricted.spaceSlug === 'leadership', `exit=${h3.status}`)

  // --- Agent posts references into Paperclip (WSL seed script, real agent JWT)
  fs.writeFileSync(`${WSL_TMP}/refs.json`, JSON.stringify({ runId: RUN_ID, good, restricted }))
  const seed = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'bash', '/tmp/accept-ag/env.sh', 'bash', '/tmp/accept-ag/seed.sh'], { encoding: 'utf8' })
  const seedLog = fs.readFileSync(`${WSL_TMP}/seed.log`, 'utf8')
  fs.writeFileSync(`${OUT}/seed.log`, seedLog)
  if (!seedLog.includes('SEED_EXIT=0')) throw new Error(`seed failed: ${seedLog.slice(-2000)} ${seed.stderr}`)
  const s = JSON.parse(fs.readFileSync(`${WSL_TMP}/seed-out.json`, 'utf8'))
  fs.writeFileSync(`${OUT}/seed-out.json`, JSON.stringify(s, null, 2))
  check('agent JWT POST created the reference (201, attributed to the run)', s.posts.first.status === 201 && s.posts.first.createdByRunId === RUN_ID)
  check('agent repeat returned the same row (200)', s.posts.repeat.status === 200 && s.posts.repeat.id === s.posts.first.id)
  check('agent body run != token run refused (403)', s.posts.wrongRun.status === 403)
  check('exactly one stored row for the issue, no url/summary', s.issueARowsInDb.length === 1 && s.issueARowsInDb[0].url === null && s.issueARowsInDb[0].summary === null)

  // --- Browser: the real Paperclip issue page
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  const consoleLines = []
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`))
  const wpResponses = []
  page.on('response', async r => { if (/\/api\/issues\/[^/]+\/work-products/.test(r.url())) { try { wpResponses.push({ url: r.url(), status: r.status(), body: await r.json() }) } catch { /* not json */ } } })
  const embedFrame = () => page.frames().find(f => f.url().startsWith(`${MK1}/embed.html`))
  // Poll until the shell reaches `want` (20s) and return the last state seen: after a
  // submit the frame still reads `auth` until the login response lands.
  const state = async want => { let v = null; for (let i = 0; i < 80; i++) { const f = embedFrame(); v = (f && await f.locator('[data-embed-state]').first().getAttribute('data-embed-state', { timeout: 500 }).catch(() => null)) ?? v; if (v === want) return v; await page.waitForTimeout(250) } return v }
  // Streamlined UI: the task side panel opens Artifacts from its "+" tab launcher.
  const openArtifact = async (identifier, title) => {
    await page.goto(`${PAPERCLIP}/${s.prefix}/issues/${identifier}`)
    await page.getByText(title, { exact: true }).first().waitFor({ timeout: 30000 })
    let launcher, top = Infinity  // the pane-header "+", not the composer's
    for (const b of await page.locator('button[aria-label]').filter({ has: page.locator('svg.lucide-plus') }).all()) {
      const box = await b.boundingBox(); if (box && box.y < top) { top = box.y; launcher = b }
    }
    await launcher.click()
    await page.getByRole('option', { name: /Artifacts/ }).first().click()
    const rows = page.locator('[data-testid=accumk1-document-row]')
    await rows.first().waitFor({ timeout: 15000 })
    const count = await rows.count()
    await rows.first().locator('button[aria-expanded]').click()
    await page.waitForTimeout(500)
    return count
  }
  const shot = async n => { await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: false }); return `${OUT}/${n}.png` }

  const countA = await openArtifact(s.issues.A.identifier, good.title)
  check('Artifacts tab shows exactly one AccuMk1 row after the repeat', countA === 1, String(countA))
  const listed = wpResponses.find(r => Array.isArray(r.body))
  check('row comes from the live Paperclip API (same app)', listed && listed.body.some(w => w.id === s.posts.first.id), listed?.url)
  const iframe = page.locator('[data-testid=accumk1-document-row] iframe')
  const attrs = await iframe.evaluate(e => ({ src: e.getAttribute('src'), sandbox: e.getAttribute('sandbox'), referrerpolicy: e.getAttribute('referrerpolicy') }))
  check('frame src is the configured Mk1 origin with the pinned hash fragment', attrs.src === `${MK1}/embed.html#id=${good.documentId}&code=${good.code}&rev=${good.revision}&sha=${good.contentHash}` || (attrs.src.startsWith(`${MK1}/embed.html#`) && attrs.src.includes(good.contentHash)), attrs.src)
  check('frame sandbox/referrer as specified', attrs.sandbox === 'allow-scripts allow-same-origin allow-forms' && attrs.referrerpolicy === 'no-referrer', JSON.stringify(attrs))
  check('cross-site frame starts signed out', (await state('auth')) === 'auth', await shot('01-paperclip-artifact-signin'))
  const f = embedFrame()
  await f.fill('input[name=email]', 'reader@example.test')
  await f.fill('input[name=password]', READER_PASSWORD)
  await f.click('button[type=submit]')
  check('in-frame Mk1 login renders the pinned revision', (await state('ready')) === 'ready')
  const inner = embedFrame().childFrames()[0]
  // srcdoc parses after the shell flips to ready; give the inline script its turn (a stripped
  // script still fails below)
  await inner.locator('h1[data-script-ran="yes"]').waitFor({ timeout: 5000 }).catch(() => {})
  const style = await inner.locator('h1').evaluate(e => { const c = getComputedStyle(e); return { color: c.color, weight: c.fontWeight, script: e.dataset.scriptRan || 'no' } })
  check('styled document rendered inside the sandbox', style.color === 'rgb(12, 74, 110)' && style.weight === '700' && style.script === 'yes', JSON.stringify(style))
  check('draft badge shown', (await embedFrame().locator('[data-embed-status="draft"]').count()) === 1)
  const shellText = await embedFrame().locator('body').innerText()
  check('revision and code shown by the shell', shellText.includes(good.code) && shellText.includes(String(good.revision)), shellText.slice(0, 200).replace(/\s+/g, ' '))
  await shot('02-paperclip-artifact-rendered')

  await openArtifact(s.issues.B.identifier, good.title)
  check('stale pin (wrong hash) fails closed', (await state('mismatch')) === 'mismatch', await shot('03-stale-pin'))
  check('stale pin shows no document frame', embedFrame().childFrames().length === 0)
  await openArtifact(s.issues.C.identifier, restricted.title)
  check('reader without a grant sees restricted, not the document', (await state('unavailable')) === 'unavailable', await shot('04-denied-reader'))
  check('denied reader gets no document frame', embedFrame().childFrames().length === 0)
  fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'))
} catch (e) {
  check('run completed without exception', false, String(e?.stack || e))
  const pg = browser?.contexts()[0]?.pages()[0]
  await pg?.screenshot({ path: `${OUT}/99-failure.png` }).catch(() => {})
  if (pg) fs.writeFileSync(`${OUT}/99-failure-dom.json`, JSON.stringify(await pg.evaluate(() => ({
    tabs: [...document.querySelectorAll('[role=tab]')].map(e => e.outerHTML.slice(0, 300)),
    artifactish: [...document.querySelectorAll('button,a,[role]')].filter(e => /artifact/i.test(e.textContent + (e.getAttribute('aria-label') || ''))).map(e => e.outerHTML.slice(0, 300)),
    rows: document.querySelectorAll('[data-testid=accumk1-document-row]').length,
  })).catch(e => String(e)), null, 2))
} finally {
  fs.writeFileSync(`${OUT}/mk1-api-requests.json`, JSON.stringify(mk1Api, null, 2))
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ when: new Date().toISOString(), runId: RUN_ID, results }, null, 2))
  await browser?.close()
  for (const c of children) { try { c.kill() } catch { /* gone */ } }
  spawnSync('taskkill', ['/PID', String(fixture.pid), '/T', '/F'])
  for (const srv of servers) srv.close()
  fs.rmSync(fixtureDir, { recursive: true, force: true })
  const failed = results.filter(r => !r.ok).length
  console.log(`${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
