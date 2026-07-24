import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchSenaiteAttachmentUrl, fetchSenaiteAttachmentText } from '@/lib/api'

// UAT catch (PB-0075, registry-stack drive): a freshly captured native
// attachment has only its mk1att:<id> uid — building the senaite proxy URL
// from the uid 404s. The helpers must prefer the payload's download_url
// (native route in mk1 mode, proxy in senaite mode) and fall back to the
// uid-built proxy URL only when no download_url is supplied.
describe('attachment fetch path honors download_url', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock') }))
  })

  const okBlobResponse = () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1])]),
    text: async () => 't,v\n0,1',
  })

  it('mk1att uid + native download_url fetches the native route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)

    await fetchSenaiteAttachmentUrl('mk1att:85', '/registry/sample/PB-0075/attachments/85/download')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/registry/sample/PB-0075/attachments/85/download')
    expect(url).not.toContain('/wizard/senaite/attachment/')
  })

  it('falls back to the uid-built proxy URL without a download_url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)

    await fetchSenaiteAttachmentUrl('senaite-uid-abc123')

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/wizard/senaite/attachment/senaite-uid-abc123')
  })

  it('text variant routes the same way (chromatogram CSV via native route)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBlobResponse())
    vi.stubGlobal('fetch', fetchMock)

    await fetchSenaiteAttachmentText('mk1att:86', '/registry/sample/PB-0075/attachments/86/download')

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/registry/sample/PB-0075/attachments/86/download')
  })
})
