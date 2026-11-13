import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/ai-chat-api'
import { CrmError } from '@/lib/api-crm'
import { getApiBaseUrl } from '@/lib/config'
import { useAuthStore } from '@/store/auth-store'

const fetchMock = vi.fn<typeof fetch>()
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? []
  return {
    url: String(url).replace(getApiBaseUrl(), ''),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => ok({}))
  vi.stubGlobal('fetch', fetchMock)
  useAuthStore.setState({ token: 'tok-123' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ token: null })
})

describe('ai-chat requests', () => {
  it.each([
    ['listProviders', () => api.listProviders(), 'GET', '/ai-chat/providers'],
    ['listChats', () => api.listChats(), 'GET', '/ai-chat/chats'],
    [
      'createChat',
      () => api.createChat(7),
      'POST',
      '/ai-chat/chats',
      { provider_id: 7 },
    ],
    [
      'getMessages',
      () => api.getMessages(3),
      'GET',
      '/ai-chat/chats/3/messages',
    ],
    [
      'getMessages after_seq',
      () => api.getMessages(3, 0),
      'GET',
      '/ai-chat/chats/3/messages?after_seq=0',
    ],
    [
      'patchChat',
      () => api.patchChat(3, { archived: true }),
      'PATCH',
      '/ai-chat/chats/3',
      { archived: true },
    ],
    [
      'sendPrompt',
      () =>
        api.sendPrompt(3, 'hello', {
          section: 'lims',
          subsection: 'samples',
          target_kind: 'sample',
          target_id: 'P-1',
        }),
      'POST',
      '/ai-chat/chats/3/prompt',
      {
        text: 'hello',
        page_context: {
          section: 'lims',
          subsection: 'samples',
          target_kind: 'sample',
          target_id: 'P-1',
        },
      },
    ],
    [
      'sendPrompt without a page',
      () => api.sendPrompt(3, 'hello', null),
      'POST',
      '/ai-chat/chats/3/prompt',
      { text: 'hello', page_context: null },
    ],
    ['cancelTurn', () => api.cancelTurn(3), 'POST', '/ai-chat/chats/3/cancel'],
    [
      'decidePermission',
      () => api.decidePermission(3, 'perm/1 x', 'deny'),
      'POST',
      '/ai-chat/chats/3/permissions/perm%2F1%20x',
      { decision: 'deny' },
    ],
    [
      'listAcpProviders',
      () => api.listAcpProviders(),
      'GET',
      '/admin/acp-providers',
    ],
    [
      'createAcpProvider',
      () => api.createAcpProvider({ slug: 'jarvis', ssh_port: 22 }),
      'POST',
      '/admin/acp-providers',
      { slug: 'jarvis', ssh_port: 22 },
    ],
    [
      'updateAcpProvider',
      () => api.updateAcpProvider(2, { enabled: true }),
      'PUT',
      '/admin/acp-providers/2',
      { enabled: true },
    ],
    [
      'generateAcpKey',
      () => api.generateAcpKey(2),
      'POST',
      '/admin/acp-providers/2/key',
    ],
    [
      'testAcpProvider',
      () => api.testAcpProvider(2),
      'POST',
      '/admin/acp-providers/2/test',
    ],
  ] as [string, () => Promise<unknown>, string, string, unknown?][])(
    '%s',
    async (_name, call, method, url, body) => {
      await call()
      const sent = lastCall()
      expect(sent.url).toBe(url)
      expect(sent.method).toBe(method)
      expect(sent.body).toEqual(body)
      expect(sent.headers['Authorization']).toBe('Bearer tok-123')
      // A JSON content type goes with a body, and only with one.
      expect(sent.headers['Content-Type']).toBe(
        body === undefined ? undefined : 'application/json'
      )
    }
  )

  it('carries the error code as CrmError', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ detail: { code: 'turn_running' } }, 409)
    )
    await expect(api.sendPrompt(3, 'hi', null)).rejects.toMatchObject({
      status: 409,
      code: 'turn_running',
    })
  })

  it('has no code on FastAPI validation errors', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ detail: [{ loc: ['body'], msg: 'bad' }] }, 422)
    )
    await expect(api.createChat(1)).rejects.toMatchObject({
      status: 422,
      code: null,
    })
  })
})

describe('deleteAcpProvider', () => {
  it('resolves on a 204 with no body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(api.deleteAcpProvider(2)).resolves.toBeUndefined()
    const sent = lastCall()
    expect(sent.url).toBe('/admin/acp-providers/2')
    expect(sent.method).toBe('DELETE')
  })

  it('still rejects with the code on a 409', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ detail: { code: 'provider_in_use' } }, 409)
    )
    const err = await api.deleteAcpProvider(2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CrmError)
    expect(err).toMatchObject({ status: 409, code: 'provider_in_use' })
  })

  it('still rejects on a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.deleteAcpProvider(2)).rejects.toThrow('Failed to fetch')
  })
})
