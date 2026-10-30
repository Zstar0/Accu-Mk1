import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  apiFetch,
  API_BASE_URL: () => 'http://api',
  getBearerHeaders: (ct?: string) =>
    ct
      ? { Authorization: 'Bearer t', 'Content-Type': ct }
      : { Authorization: 'Bearer t' },
}))

describe('api-document-comments', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('lists by revision id with a status filter', async () => {
    const { listDocumentComments } = await import('@/lib/api-document-comments')
    apiFetch.mockResolvedValue({ items: [] })
    await listDocumentComments(7, 'all')
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/documents/7/comments?status=all'
    )
  })

  it('create surfaces the server detail on a 400', async () => {
    const { createDocumentComment } =
      await import('@/lib/api-document-comments')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'quote not found in ART-0001 r1: "x"' }),
    })
    await expect(
      createDocumentComment(7, { body: 'b', anchor: { originalText: 'x' } })
    ).rejects.toThrow('quote not found in ART-0001 r1: "x"')
  })

  it('delete uses a raw DELETE (apiFetch would try to parse the 204 body)', async () => {
    const { deleteDocumentComment } =
      await import('@/lib/api-document-comments')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
    })
    await deleteDocumentComment(9)
    expect(fetch).toHaveBeenCalledWith(
      'http://api/api/documents/comments/9',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('uploads an attachment as multipart field "file"', async () => {
    const { addDocumentCommentAttachment } =
      await import('@/lib/api-document-comments')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 3 }),
    })
    await addDocumentCommentAttachment(
      7,
      new Blob([new Uint8Array([1])]),
      'shot.png'
    )
    const calls = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as any
    const [url, init] = calls[0]
    expect(url).toBe('http://api/api/documents/7/comment-attachments')
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob)
  })
})
