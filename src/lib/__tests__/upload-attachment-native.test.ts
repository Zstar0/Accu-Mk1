import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadChromatogramNative, uploadNativeAttachment } from '@/lib/api'

describe('uploadChromatogramNative', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('POSTs to the native chromatogram route with sample_id as a query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'ok', filename: 'x.csv', size_bytes: 12 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await uploadChromatogramNative(42, 'aP-0001')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain('/hplc/analyses/42/chromatogram-native')
    expect(url).toContain('sample_id=aP-0001')
    expect(init.method).toBe('POST')
    expect(result.success).toBe(true)
  })

  it('never hits the SENAITE chromatogram-to-senaite route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'ok' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await uploadChromatogramNative(1, 'aP-0001')

    const [url] = fetchMock.mock.calls[0]!
    expect(String(url)).not.toContain('chromatogram-to-senaite')
  })

  it('throws with the server detail on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: 'native_born_use_native_route' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadChromatogramNative(1, 'aP-0001')).rejects.toThrow(
      'native_born_use_native_route'
    )
  })
})

describe('uploadNativeAttachment', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('POSTs multipart to /wizard/samples/{sampleId}/attachments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Attachment uploaded' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array([1, 2, 3])], 'vial.png', { type: 'image/png' })
    await uploadNativeAttachment('aP-0001', file, 'Sample Image', 'vial_image', 'aP-0001-V1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain('/wizard/samples/aP-0001/attachments')
    expect(String(url)).not.toContain('/wizard/senaite/')
    const body = init.body as FormData
    expect(body.get('attachment_type')).toBe('Sample Image')
    expect(body.get('native_kind')).toBe('vial_image')
    expect(body.get('source_sample_id')).toBe('aP-0001-V1')
  })

  it('omits optional fields when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Attachment uploaded' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array([1, 2, 3])], 'vial.png', { type: 'image/png' })
    await uploadNativeAttachment('aP-0001', file, 'HPLC Graph')

    const body = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(body.has('native_kind')).toBe(false)
    expect(body.has('source_sample_id')).toBe(false)
  })
})
