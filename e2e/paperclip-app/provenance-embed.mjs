// Mk1-only browser check of revision provenance in the compiled embed (dev only).
// REAL: dist/embed.html + assets, the Mk1 FastAPI app (mk1_fixture.py: /auth/login, documents
// routes, service, access, storage on a throwaway SQLite), the mk1-publish-document helper.
// COPIED: the /embed.html CSP text from nginx.conf and nginx's /api strip, as in run.mjs.
// NOT here: Paperclip. It only frames /embed.html, which run.mjs proves end to end.
// Run: `VITE_API_URL=/api npm run build`, then `MK1_PY=<backend venv python> node e2e/paperclip-app/provenance-embed.mjs`.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = process.env.APP_E2E_OUT || 'C:/tmp/mk1-provenance-embed-e2e'
const PY = process.env.MK1_PY || 'python'
fs.mkdirSync(OUT, { recursive: true })
const MK1 = 'http://127.0.0.1:8571'
const rand = n => crypto.randomBytes(n).toString('hex')
const AGENT_TOKEN = rand(24)
const READER_PASSWORD = rand(12)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk1-prov-e2e-'))
const fixture = spawn(PY, [path.join(import.meta.dirname, 'mk1_fixture.py')], {
  env: {
    ...process.env,
    MK1_FIXTURE_DIR: fixtureDir,
    JWT_SECRET: rand(32),
    MK1_READER_PASSWORD: READER_PASSWORD,
    MK1_DOCUMENT_AGENT_TOKENS: `jarvis:${AGENT_TOKEN}:general+leadership`,
  },
  stdio: [
    'ignore',
    fs.openSync(`${OUT}/mk1-fixture.log`, 'w'),
    fs.openSync(`${OUT}/mk1-fixture.err.log`, 'w'),
  ],
})
const nginx = fs.readFileSync(path.join(ROOT, 'nginx.conf'), 'utf8')
const embedCsp =
  /location = \/embed\.html \{[\s\S]*?add_header Content-Security-Policy "([^"]+)"/
    .exec(nginx)[1]
    .replace('${MK1_EMBED_FRAME_ANCESTORS}', "'none'")
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
  const headers = {
    'content-type': types[path.extname(p)] || 'application/octet-stream',
  }
  if (file === '/embed.html')
    Object.assign(headers, {
      'content-security-policy': embedCsp,
      'x-content-type-options': 'nosniff',
    })
  res.writeHead(200, headers)
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
const helper = (file, extra) =>
  new Promise(resolve => {
    const p = spawn(
      PY,
      [
        path.join(
          ROOT,
          '.claude/skills/mk1-publish-document/scripts/publish_document.py'
        ),
        file,
        '--category',
        'ART',
        '--draft',
        '--author',
        'Acceptance Requester',
        '--session',
        'run-accept-1',
        '--paperclip-ref',
        ...extra,
      ],
      {
        env: {
          ...process.env,
          MK1_API_BASE_URL: `${MK1}/api`,
          MK1_DOCUMENT_AGENT_TOKEN: AGENT_TOKEN,
          ACCUMK1_INTERNAL_SERVICE_TOKEN: '',
        },
      }
    )
    let stdout = ''
    p.stdout.on('data', d => {
      stdout += d
    })
    p.on('close', status => resolve({ status, stdout }))
  })

let browser, page
const console_ = []
try {
  await waitFor('http://127.0.0.1:8563/openapi.json')
  const html = path.join(fixtureDir, 'report.html')
  fs.writeFileSync(
    html,
    '<!doctype html><html><head><title>Synthetic report</title></head><body><main><h1>Synthetic report</h1><p class="lede">Provenance check.</p></main></body></html>'
  )
  const h = await helper(html, [
    '--title',
    'Synthetic report',
    '--source-system',
    'paperclip',
    '--source-record-type',
    'issue',
    '--source-record-id',
    '6f1c2a9e-0b7d-4c1e-9a55-3f2d8e7b1c00',
    '--source-record-label',
    'ACC-999',
    '--source-run',
    'run-accept-1',
  ])
  const ref = JSON.parse(h.stdout.trim().split('\n').pop())
  check(
    'helper created a draft with reported source provenance',
    h.status === 0 && ref.status === 'draft',
    `exit=${h.status} ${ref.code} r${ref.revision}`
  )
  check(
    'paperclip reference carries no provenance keys',
    !('provenance' in ref) && Object.keys(ref).length === 9
  )

  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  page.on('console', m => console_.push(`${m.type()}: ${m.text()}`))
  await page.goto(
    `${MK1}/embed.html#id=${ref.documentId}&code=${ref.code}&rev=${ref.revision}&sha=${ref.contentHash}`
  )
  await page.fill('input[name=email]', 'reader@example.test')
  await page.fill('input[name=password]', READER_PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('[data-embed-state="ready"]', { timeout: 20000 })
  check('embed reached ready for the pinned revision', true)
  check(
    'draft badge is shown',
    (await page.locator('[data-embed-status="draft"]').count()) === 1
  )
  await page.click('[data-provenance] summary')
  const text = await page.locator('[data-provenance]').innerText()
  fs.writeFileSync(`${OUT}/provenance.txt`, text)
  for (const want of [
    'Acceptance Requester [supplied, not verified]',
    'jarvis [authenticated agent]',
    'Paperclip [reported, not verified]',
    'issue · ACC-999 · 6f1c2a9e-0b7d-4c1e-9a55-3f2d8e7b1c00',
    'run-accept-1',
  ])
    check(`provenance shows "${want}"`, text.includes(want))
  check(
    'provenance has no links',
    (await page.locator('[data-provenance] a').count()) === 0
  )
  const box = await page.locator('iframe').boundingBox()
  const h1 = await page
    .frameLocator('iframe')
    .locator('h1')
    .innerText({ timeout: 10000 })
    .catch(e => `ERR ${e}`.split('\n')[0])
  check(
    'document frame renders below the provenance block',
    h1 === 'Synthetic report' && box?.height > 300,
    `h1=${JSON.stringify(h1)} frame=${Math.round(box?.width)}x${Math.round(box?.height)}`
  )
  await page.screenshot({ path: `${OUT}/provenance-embed.png` })
  // The full viewer, same origin here, so the embed's sign-in carries over.
  await page.goto(`${MK1}/#reports/documents?id=${ref.documentId}`)
  await page.locator('[data-provenance] summary').click({ timeout: 30000 })
  const vtext = await page.locator('[data-provenance]').innerText()
  check(
    'full viewer shows the same revision provenance',
    vtext.includes('jarvis [authenticated agent]') &&
      vtext.includes('Paperclip [reported, not verified]')
  )
  await page.screenshot({ path: `${OUT}/provenance-viewer.png` })
  fs.writeFileSync(`${OUT}/console.log`, console_.join('\n'))
} catch (e) {
  check('run completed', false, String(e).split('\n')[0])
  if (page) {
    const states = await page
      .locator('[data-embed-state]')
      .evaluateAll(n => n.map(x => x.getAttribute('data-embed-state')))
      .catch(() => [])
    check('embed state at failure', false, JSON.stringify(states))
    await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {})
  }
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
