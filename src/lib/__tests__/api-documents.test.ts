import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  apiFetch,
  API_BASE_URL: () => 'http://api',
  getBearerHeaders: () => ({ Authorization: 'Bearer t' }),
}))

describe('api-documents replaceDraftContent', () => {
  beforeEach(() => apiFetch.mockReset().mockResolvedValue({ id: 7 }))

  it('sends expected_sha256 for the optimistic-concurrency check', async () => {
    const { replaceDraftContent } = await import('@/lib/api-documents')
    await replaceDraftContent(7, '<p>x</p>', 'abc123')
    expect(apiFetch).toHaveBeenCalledWith('/api/documents/7/content', {
      method: 'PUT',
      body: JSON.stringify({ html: '<p>x</p>', expected_sha256: 'abc123' }),
    })
  })

  it('omits it when the caller has no hash', async () => {
    const { replaceDraftContent } = await import('@/lib/api-documents')
    await replaceDraftContent(7, '<p>x</p>')
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body)).toEqual({
      html: '<p>x</p>',
    })
  })
})
