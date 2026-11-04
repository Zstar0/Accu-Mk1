import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseFrames } from '@/lib/flag-stream'
import type { AiChatEvent } from '@/lib/ai-chat-api'
import { acceptEvent, useAiChatStream } from '@/lib/ai-chat-stream'
import { getApiBaseUrl } from '@/lib/config'
import { useAuthStore } from '@/store/auth-store'

const chunk = (seq: number, text = 'hi'): AiChatEvent => ({
  seq,
  type: 'message_chunk',
  chat_id: 1,
  turn_id: 't',
  text,
})
const resync = (seq: number): AiChatEvent => ({
  seq,
  type: 'resync',
  chat_id: null,
  turn_id: null,
})
const frame = (e: AiChatEvent) =>
  `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

describe('parseFrames with an ai-chat payload', () => {
  it('parses an ai-chat frame with the generic parseFrames', () => {
    const { events, rest } = parseFrames<AiChatEvent>(
      'id: 5\nevent: message_chunk\ndata: {"seq":5,"type":"message_chunk","chat_id":1,"turn_id":"t","text":"hi"}\n\n: keepalive\n\npart'
    )
    expect(events).toEqual([
      { seq: 5, type: 'message_chunk', chat_id: 1, turn_id: 't', text: 'hi' },
    ])
    expect(rest).toBe('part')
  })
})

describe('acceptEvent', () => {
  it('drops replays and accepts newer events', () => {
    expect(acceptEvent(5, chunk(5))).toBe(false)
    expect(acceptEvent(5, chunk(4))).toBe(false)
    expect(acceptEvent(5, chunk(6))).toBe(true)
  })

  it('accepts anything before the first event', () => {
    expect(acceptEvent(null, chunk(1))).toBe(true)
  })

  it('accepts a resync whose seq is below the last seen one', () => {
    // The hub stamps resync with its newest seq, which is lower than the
    // client's id when the server clock stepped back.
    expect(acceptEvent(10, resync(3))).toBe(true)
  })
})

describe('useAiChatStream', () => {
  const enc = new TextEncoder()

  /** A response whose body the test feeds by hand. */
  function openStream() {
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c
      },
    })
    return {
      response: { ok: true, status: 200, body } as unknown as Response,
      push: (text: string) => ctl.enqueue(enc.encode(text)),
      end: () => ctl.close(),
    }
  }
  const failure = (status: number) =>
    ({ ok: false, status, body: null }) as unknown as Response

  const fetchMock = vi.fn<typeof fetch>()
  const headersOf = (call: number) =>
    (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>
  /** Let pending reads and promise chains settle, plus any timer due within `ms`. */
  const settle = (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    useAuthStore.setState({ token: 'tok-123' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    useAuthStore.setState({ token: null })
  })

  it('fires onConnected on the first bytes, not on the response', async () => {
    const s = openStream()
    fetchMock.mockResolvedValueOnce(s.response)
    const onEvent = vi.fn()
    const onConnected = vi.fn()
    renderHook(() => useAiChatStream(true, onEvent, onConnected))
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${getApiBaseUrl()}/ai-chat/stream`
    )
    expect(headersOf(0)).toEqual({ Authorization: 'Bearer tok-123' })
    expect(onConnected).not.toHaveBeenCalled()

    s.push(': connected\n\n')
    await settle()
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()

    s.push(frame(chunk(10)))
    await settle()
    expect(onEvent.mock.calls.map(c => c[0].seq)).toEqual([10])
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it('reconnects with the last accepted seq and drops replayed events', async () => {
    const first = openStream()
    const second = openStream()
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
    const onEvent = vi.fn()
    const onConnected = vi.fn()
    renderHook(() => useAiChatStream(true, onEvent, onConnected))
    await settle()

    first.push(frame(chunk(10)) + frame(chunk(11)))
    await settle()
    first.end() // clean end of stream
    await settle(250)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(headersOf(0)).not.toHaveProperty('Last-Event-ID')
    expect(headersOf(1)['Last-Event-ID']).toBe('11')

    second.push(frame(chunk(11)) + frame(chunk(12)))
    await settle()
    expect(onEvent.mock.calls.map(c => c[0].seq)).toEqual([10, 11, 12])
    expect(onConnected).toHaveBeenCalledTimes(2) // once per connection
  })

  it('takes a resync below the last seq as the new reconnect id', async () => {
    const first = openStream()
    const second = openStream()
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
    const onEvent = vi.fn()
    renderHook(() => useAiChatStream(true, onEvent))
    await settle()

    first.push(frame(chunk(10)) + frame(resync(3)))
    await settle()
    first.end()
    await settle(250)

    expect(onEvent.mock.calls.map(c => c[0].type)).toEqual([
      'message_chunk',
      'resync',
    ])
    expect(headersOf(1)['Last-Event-ID']).toBe('3')
  })

  it.each([401, 403])('does not reconnect after a %i', async status => {
    fetchMock.mockResolvedValue(failure(status))
    const onEvent = vi.fn()
    renderHook(() => useAiChatStream(true, onEvent))
    await settle(120_000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('backs off 250 ms, then 500 ms, after other failures', async () => {
    fetchMock.mockResolvedValue(failure(502))
    renderHook(() => useAiChatStream(true, vi.fn()))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await settle(249)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await settle(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await settle(499)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await settle(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('caps the backoff at 30 s', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    renderHook(() => useAiChatStream(true, vi.fn()))
    // Retries land at 0.25, 0.75, 1.75, 3.75, 7.75, 15.75 and 31.75 s: eight
    // fetches. The next delay is 250 ms * 2^7 = 32 s, capped to 30 s.
    await settle(31_750)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    await settle(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    await settle(1)
    expect(fetchMock).toHaveBeenCalledTimes(9)
  })

  it('does not connect while disabled, and aborts when disabled', async () => {
    const s = openStream()
    fetchMock.mockResolvedValue(s.response)
    const { rerender } = renderHook(({ on }) => useAiChatStream(on, vi.fn()), {
      initialProps: { on: false },
    })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()

    rerender({ on: true })
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    rerender({ on: false })
    await settle(60_000)
    expect(signal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps one connection when the callbacks change identity', async () => {
    const s = openStream()
    fetchMock.mockResolvedValue(s.response)
    const seen: string[] = []
    const { rerender } = renderHook(
      ({ tag }) => useAiChatStream(true, () => seen.push(tag)),
      { initialProps: { tag: 'a' } }
    )
    await settle()
    rerender({ tag: 'b' })
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    s.push(frame(chunk(1)))
    await settle()
    expect(seen).toEqual(['b']) // the latest closure
  })
})
