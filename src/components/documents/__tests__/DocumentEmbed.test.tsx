import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'
import {
  DocumentEmbed,
  EMBED_FRAME_CSP,
  buildEmbedSrcDoc,
  parseEmbedRef,
} from '../DocumentEmbed'

const HTML =
  '<!doctype html><html><head><title>t</title></head><body><h1>Report</h1></body></html>'
let SHA = ''
const hex = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
    ),
    b => b.toString(16).padStart(2, '0')
  ).join('')

const doc = (over = {}) => ({
  id: 12,
  code: 'ART-0003',
  revision: 2,
  status: 'draft',
  title: 'Q3 report',
  content_sha256: SHA,
  revisions: [{ revision: 1 }, { revision: 2 }],
  ...over,
})
const hash = () => `#id=12&code=ART-0003&rev=2&sha=${SHA}`

function mockApi(
  detail: unknown,
  opts: { status?: number; content?: string } = {}
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization
      expect(auth).toBe('Bearer jwt-in-frame-store')
      expect(url).not.toContain('jwt-in-frame-store')
      if (opts.status)
        return new Response('{"detail":"Document not found"}', {
          status: opts.status,
        })
      if (url.endsWith('/content'))
        return new Response(opts.content ?? HTML, { status: 200 })
      return new Response(JSON.stringify(detail), { status: 200 })
    })
  )
}

beforeEach(async () => {
  SHA = await hex(HTML)
  useAuthStore.setState({ token: 'jwt-in-frame-store' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ token: null })
})

describe('parseEmbedRef', () => {
  it('accepts only an integer id, Mk1 code, positive revision and bare sha256 hex', () => {
    expect(
      parseEmbedRef(`#id=12&code=ART-0003&rev=2&sha=${'a'.repeat(64)}`)
    ).toEqual({
      id: 12,
      code: 'ART-0003',
      rev: 2,
      sha: 'a'.repeat(64),
    })
    for (const bad of [
      '#id=mk1-doc-42&code=ART-0003&rev=2&sha=' + 'a'.repeat(64),
      '#id=12&code=ART-0003&rev=0&sha=' + 'a'.repeat(64),
      '#id=12&code=ART-0003&rev=2&sha=abc',
      '',
    ]) {
      expect(parseEmbedRef(bad)).toBeNull()
    }
  })
})

describe('buildEmbedSrcDoc', () => {
  it('puts the no-network CSP first in head and stamps the theme', () => {
    const out = buildEmbedSrcDoc(HTML, 'light')
    expect(out).toMatch(
      /^<!doctype html><html data-theme="light"><head><meta http-equiv="Content-Security-Policy"/
    )
    expect(EMBED_FRAME_CSP).toContain("connect-src 'none'")
    expect(EMBED_FRAME_CSP).toContain("form-action 'none'")
    expect(EMBED_FRAME_CSP).not.toMatch(/script-src[^;]*(https?:|\*)/)
  })
})

describe('DocumentEmbed', () => {
  it('asks for an in-frame sign-in when there is no token, without fetching', () => {
    useAuthStore.setState({ token: null })
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    render(<DocumentEmbed hash={hash()} />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(f).not.toHaveBeenCalled()
  })

  it('renders the pinned revision in a script-only sandbox with draft label', async () => {
    mockApi(doc())
    const { container } = render(<DocumentEmbed hash={hash()} />)
    await waitFor(() =>
      expect(container.querySelector('iframe')).not.toBeNull()
    )
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Report</h1>')
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
    expect(
      container.querySelector('[data-embed-status="draft"]')
    ).not.toBeNull()
  })

  it.each([
    ['stale revision', doc({ revision: 3 })],
    ['other code', doc({ code: 'ART-0004' })],
    ['other hash', doc({ content_sha256: 'b'.repeat(64) })],
  ])('refuses a %s', async (_l, detail) => {
    mockApi(detail)
    const { container } = render(<DocumentEmbed hash={hash()} />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-embed-state="mismatch"]')
      ).not.toBeNull()
    )
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('refuses bytes that do not hash to the pinned sha', async () => {
    mockApi(doc(), { content: HTML + '<!--tampered-->' })
    const { container } = render(<DocumentEmbed hash={hash()} />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-embed-state="mismatch"]')
      ).not.toBeNull()
    )
  })

  it('shows restricted for 404 (hidden or missing) and sign-in after 401 (revoked)', async () => {
    mockApi(null, { status: 404 })
    const a = render(<DocumentEmbed hash={hash()} />)
    await waitFor(() =>
      expect(
        a.container.querySelector('[data-embed-state="unavailable"]')
      ).not.toBeNull()
    )
    a.unmount()
    mockApi(null, { status: 401 })
    render(<DocumentEmbed hash={hash()} />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sign in' })
      ).toBeInTheDocument()
    )
    expect(useAuthStore.getState().token).toBeNull()
  })
})
