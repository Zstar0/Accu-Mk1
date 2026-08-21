import { describe, it, expect, vi, beforeEach } from 'vitest'
import { downloadMethodAttachment } from '@/lib/api'
import { useAuthStore } from '@/store/auth-store'

// R-P3-4 (methods controlled documents, fix round 2): the method-attachment
// download route is Bearer-gated like every other method-attachment
// endpoint. A token-in-query fallback is explicitly rejected by the
// controller ruling — it leaks into server logs and browser history — so
// this pins the real security behavior at the api layer: the request is
// authenticated via the Authorization header, never via the URL, and the
// blob object URL is revoked once the download has actually fired. UI-level
// wiring (the Download button calling this with the right args) is covered
// separately in method-lifecycle-ui.test.tsx; this file is the api-layer
// pin, mirroring attachment-fetch-path.test.ts's mocked-fetch style.
describe('downloadMethodAttachment is authenticated, never token-in-query', () => {
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
  let anchorClickMock: ReturnType<typeof vi.fn>
  let anchorRemoveMock: ReturnType<typeof vi.fn>
  let callOrder: string[]

  beforeEach(() => {
    vi.restoreAllMocks()
    useAuthStore.setState({ token: 'jwt-test-token' })

    callOrder = []
    createObjectURLMock = vi.fn(() => 'blob:mock-url')
    revokeObjectURLMock = vi.fn(() => {
      callOrder.push('revoke')
    })
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: createObjectURLMock,
        revokeObjectURL: revokeObjectURLMock,
      })
    )

    // jsdom anchor-click is fine to stub — a real <a> click would log a
    // "Not implemented: navigation" warning, and we care about *what* was
    // set on the anchor and *when* click fired, not jsdom's nav plumbing.
    anchorClickMock = vi.fn(() => {
      callOrder.push('click')
    })
    anchorRemoveMock = vi.fn()
    // A real jsdom-backed <a> (not a plain object) — document.body.appendChild
    // requires an actual Node, and jsdom's real HTMLAnchorElement.click()
    // would log a "Not implemented: navigation" warning for a real href, so
    // the click/remove methods are overridden on the instance to observe
    // calls without touching browser location.
    const realCreateElement = document.createElement.bind(document)
    const realAnchor = realCreateElement('a') as HTMLAnchorElement
    realAnchor.click = anchorClickMock as unknown as () => void
    realAnchor.remove = anchorRemoveMock as unknown as () => void
    vi.spyOn(document, 'createElement').mockImplementation(
      (tagName: string, options?: ElementCreationOptions) => {
        if (tagName === 'a') return realAnchor
        return realCreateElement(tagName, options)
      }
    )
  })

  const okBlobResponse = () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
  })

  it('fetches with the Authorization header and no token/credentials in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)

    await downloadMethodAttachment(7, 42, 'sop.pdf')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]

    // (a) no token/query credentials in the URL
    expect(url).toContain('/hplc/methods/7/attachments/42/download')
    expect(url).not.toContain('token=')
    expect(url).not.toContain('?')

    // (b) the request init carries the Authorization header from
    // getBearerHeaders()
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jwt-test-token')
  })

  it('triggers a download-attribute anchor click, then revokes the object URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)

    await downloadMethodAttachment(7, 42, 'sop.pdf')

    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(anchorClickMock).toHaveBeenCalledTimes(1)
    expect(anchorRemoveMock).toHaveBeenCalledTimes(1)

    // (c) revoked only after the click actually fired
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url')
    expect(callOrder).toEqual(['click', 'revoke'])
  })

  it('throws on a non-ok response and never triggers a save', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', fetchMock)

    await expect(downloadMethodAttachment(7, 42, 'sop.pdf')).rejects.toThrow()
    expect(createObjectURLMock).not.toHaveBeenCalled()
    expect(anchorClickMock).not.toHaveBeenCalled()
  })
})
