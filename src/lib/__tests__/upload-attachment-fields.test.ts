import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadSenaiteAttachment } from '@/lib/api'

describe('uploadSenaiteAttachment native-lineage fields', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('appends native_kind and source_sample_id when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Attachment uploaded' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array([1, 2, 3])], 'vial.png', { type: 'image/png' })
    await uploadSenaiteAttachment('UID-1', file, 'Sample Image', 'vial_image', 'aP-0001-V1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(body.get('native_kind')).toBe('vial_image')
    expect(body.get('source_sample_id')).toBe('aP-0001-V1')
  })

  it('omits the fields entirely when not provided (backward compat)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Attachment uploaded' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array([1, 2, 3])], 'vial.png', { type: 'image/png' })
    await uploadSenaiteAttachment('UID-1', file, 'Sample Image')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(body.has('native_kind')).toBe(false)
    expect(body.has('source_sample_id')).toBe(false)
  })
})
