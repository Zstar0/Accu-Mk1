import { beforeEach, describe, expect, it } from 'vitest'
import type { AiChat, AiChatEvent, AiMessage } from '@/lib/ai-chat-api'
import {
  applyEvent,
  hasPendingApproval,
  isRunning,
  useAiChatStore,
  type ChatData,
} from '../chat-store'
import { currentPageContext, type PageContextSource } from '../page-context'

// ---- builders --------------------------------------------------------------

const NOW = '2026-11-03T12:00:00.000Z'

const emptyData = (): ChatData => ({
  chats: [],
  messages: {},
  live: {},
  approvals: {},
  needsRefetch: [],
})

type Ev<T extends AiChatEvent['type']> = Extract<AiChatEvent, { type: T }>
type Rest<T extends AiChatEvent['type']> = Omit<
  Ev<T>,
  'seq' | 'type' | 'chat_id' | 'turn_id'
> & { chat_id?: number; turn_id?: string }

let seq = 0
/** A turn event for chat 1, turn `t1` unless `rest` says otherwise. */
function ev<T extends Exclude<AiChatEvent['type'], 'resync'>>(
  type: T,
  rest: Rest<T>
): AiChatEvent {
  return {
    seq: ++seq,
    type,
    chat_id: 1,
    turn_id: 't1',
    ...rest,
  } as unknown as AiChatEvent
}
const resync = (): AiChatEvent => ({
  seq: ++seq,
  type: 'resync',
  chat_id: null,
  turn_id: null,
})
const started = (rest: { starting?: boolean; resuming?: boolean } = {}) =>
  ev('turn_started', { starting: false, resuming: false, ...rest })
const chunk = (
  text: string,
  rest: { chat_id?: number; turn_id?: string } = {}
) => ev('message_chunk', { text, ...rest })
const permission = (
  permission_id: string,
  rest: { chat_id?: number; can_allow?: boolean; hidden?: boolean } = {}
) =>
  ev('permission_requested', {
    permission_id,
    source: 'agent',
    title: 'Run ls',
    detail: 'ls -la',
    can_allow: true,
    hidden: false,
    agent: 'Nova',
    ...rest,
  })
const resolved = (permission_id: string, chat_id = 1) =>
  ev('permission_resolved', { permission_id, decision: 'allow', chat_id })
const ended = (message_seq: number | null, stop_reason = 'end_turn') =>
  ev('turn_ended', { stop_reason, message_seq })

const run = (data: ChatData, ...events: AiChatEvent[]) =>
  events.reduce((d, e) => applyEvent(d, e, NOW), data)

const message = (
  n: number,
  role = 'user',
  text = `m${n}`,
  id = n
): AiMessage => ({
  id,
  seq: n,
  role,
  text,
  meta: null,
  created_at: '2026-11-03T00:00:00Z',
})

const chatRow = (id: number, over: Partial<AiChat> = {}): AiChat => ({
  id,
  provider_id: 1,
  title: `Chat ${id}`,
  archived: false,
  created_at: '2026-11-03T00:00:00Z',
  updated_at: '2026-11-03T00:00:00Z',
  running_turn_id: null,
  pending_approvals: [],
  ...over,
})

const pending = (permission_id: string) => ({
  permission_id,
  source: 'agent',
  title: 'Run ls',
  detail: 'ls -la',
  can_allow: true,
  hidden: false,
})

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

// ---- the reducer -----------------------------------------------------------

describe('applyEvent', () => {
  it('streams chunks into the live turn', () => {
    let d = run(emptyData(), started({ starting: true }))
    expect(d.live[1]).toEqual({
      turnId: 't1',
      text: '',
      thought: '',
      tools: {},
      phase: 'starting',
    })

    d = run(d, chunk('Hel'), ev('thought_chunk', { text: 'hm' }), chunk('lo'))
    expect(d.live[1]).toMatchObject({
      text: 'Hello',
      thought: 'hm',
      phase: 'running',
    })
  })

  it.each([
    [true, false, 'starting'],
    [false, true, 'resuming'],
    [false, false, 'running'],
    [true, true, 'starting'],
  ])(
    'turn_started starting=%s resuming=%s is %s',
    (starting, resuming, phase) => {
      const d = run(emptyData(), started({ starting, resuming }))
      expect(d.live[1]?.phase).toBe(phase)
    }
  )

  it('a tool call also ends the starting phase', () => {
    const d = run(
      emptyData(),
      started({ starting: true }),
      ev('tool_call', { id: 'c1', title: 'ls', kind: 'execute', status: null })
    )
    expect(d.live[1]?.phase).toBe('running')
  })

  it('waiting phase while a card is open, running again after it resolves', () => {
    let d = run(emptyData(), started(), permission('p1'))
    expect(d.live[1]?.phase).toBe('waiting')
    // Exactly the PendingApproval fields and the chat: no seq, type or agent.
    expect(d.approvals).toEqual({ p1: { ...pending('p1'), chatId: 1 } })

    d = run(d, resolved('p1'))
    expect(d.approvals).toEqual({})
    expect(d.live[1]?.phase).toBe('running')
  })

  it('a card keeps whether it could show everything', () => {
    const d = run(
      emptyData(),
      started(),
      permission('p1', { can_allow: false, hidden: true })
    )
    expect(d.approvals.p1).toMatchObject({ can_allow: false, hidden: true })
  })

  it('a second card keeps the phase waiting after the first resolves', () => {
    let d = run(emptyData(), started(), permission('p1'), permission('p2'))
    d = run(d, resolved('p1'))
    expect(Object.keys(d.approvals)).toEqual(['p2'])
    expect(d.live[1]?.phase).toBe('waiting')

    d = run(d, resolved('p2'))
    expect(d.live[1]?.phase).toBe('running')
  })

  it('a card in another chat does not hold this chat in waiting', () => {
    let d = run(
      emptyData(),
      started(),
      permission('p1'),
      permission('other', { chat_id: 2 })
    )
    d = run(d, resolved('p1'))
    expect(d.live[1]?.phase).toBe('running')
    expect(Object.keys(d.approvals)).toEqual(['other'])
  })

  it('a chunk during a pending approval does not leave the waiting phase', () => {
    const d = run(emptyData(), started(), permission('p1'), chunk('still here'))
    expect(d.live[1]).toMatchObject({ text: 'still here', phase: 'waiting' })
  })

  it('resolving an unknown card with nothing live changes nothing', () => {
    const d = emptyData()
    expect(applyEvent(d, resolved('ghost'), NOW)).toBe(d)
  })

  it('a chunk with no live turn creates one (the page reloaded mid-turn)', () => {
    const d = run(emptyData(), chunk('tail'))
    expect(d.live[1]).toEqual({
      turnId: 't1',
      text: 'tail',
      thought: '',
      tools: {},
      phase: 'running',
    })
  })

  it('a turn created by a late event is waiting when the chat has a card', () => {
    const d = run(
      { ...emptyData(), approvals: { p1: { ...pending('p1'), chatId: 1 } } },
      chunk('tail')
    )
    expect(d.live[1]?.phase).toBe('waiting')
  })

  it('a card with no live turn creates one in waiting', () => {
    const d = run(emptyData(), permission('p1'))
    expect(d.live[1]?.phase).toBe('waiting')
    expect(Object.keys(d.approvals)).toEqual(['p1'])
  })

  it('an event of a newer turn starts that turn fresh instead of appending', () => {
    const d = run(
      emptyData(),
      started(),
      chunk('old'),
      chunk('new', { turn_id: 't2' })
    )
    expect(d.live[1]).toMatchObject({ turnId: 't2', text: 'new' })
  })

  it('upserts tool chips and merges only the fields an update carries', () => {
    let d = run(
      emptyData(),
      started(),
      ev('tool_call', {
        id: 'c1',
        title: 'ls',
        kind: 'execute',
        status: 'pending',
      })
    )
    d = run(
      d,
      ev('tool_call_update', { id: 'c1', status: 'completed', title: null })
    )
    expect(d.live[1]?.tools).toEqual({
      c1: { id: 'c1', title: 'ls', kind: 'execute', status: 'completed' },
    })

    d = run(
      d,
      ev('tool_call_update', { id: 'c1', status: null, title: 'ls -la' })
    )
    expect(d.live[1]?.tools.c1).toEqual({
      id: 'c1',
      title: 'ls -la',
      kind: 'execute',
      status: 'completed',
    })
  })

  it('an update for a tool the page never saw starts a chip with nulls', () => {
    const d = run(
      emptyData(),
      ev('tool_call_update', { id: 'c9', status: 'failed', title: null })
    )
    expect(d.live[1]?.tools).toEqual({
      c9: { id: 'c9', title: null, kind: null, status: 'failed' },
    })
  })

  it('turn_ended clears live state and marks the chat for refetch', () => {
    let d = run(emptyData(), started(), chunk('hi'))
    d = run(d, ended(null))
    expect(d.live).toEqual({})
    expect(d.needsRefetch).toEqual([1])

    // A second end for the same chat does not list it twice.
    d = run(d, chunk('x'), ended(null))
    expect(d.needsRefetch).toEqual([1])
  })

  it('turn_ended keeps the reply on screen as a provisional assistant row', () => {
    const loaded: ChatData = {
      ...emptyData(),
      messages: { 1: [message(1)] },
    }
    const d = run(
      loaded,
      started(),
      ev('tool_call', {
        id: 'c1',
        title: 'ls',
        kind: 'execute',
        status: 'pending',
      }),
      chunk('done'),
      ev('thought_chunk', { text: 'not stored' }),
      ended(2, 'end_turn')
    )
    expect(d.messages[1]).toEqual([
      message(1),
      {
        id: -2,
        seq: 2,
        role: 'assistant',
        text: 'done',
        // The backend stores a list of chips, so the provisional row has one.
        meta: {
          tools: [
            { id: 'c1', title: 'ls', kind: 'execute', status: 'pending' },
          ],
          stop_reason: 'end_turn',
        },
        created_at: NOW,
      },
    ])
  })

  it('turn_ended adds no provisional row when it cannot build a true one', () => {
    const loaded: ChatData = { ...emptyData(), messages: { 1: [message(1)] } }
    // nothing stored by the server
    expect(run(loaded, started(), chunk('x'), ended(null)).messages[1]).toEqual(
      [message(1)]
    )
    // messages never loaded: nothing to append to
    expect(run(emptyData(), started(), chunk('x'), ended(2)).messages).toEqual(
      {}
    )
    // no live turn: the text is unknown
    expect(run(loaded, ended(2)).messages[1]).toEqual([message(1)])
  })

  it('turn_ended adds no empty provisional row after a reload mid-turn', () => {
    // A reload seeds the live turn from the chat list: no text, and no chunk
    // has arrived since. An empty bubble must not show until the refetch lands.
    const loaded: ChatData = { ...emptyData(), messages: { 1: [message(1)] } }
    const d = run(loaded, started(), ended(2, 'end_turn'))
    expect(d.messages[1]).toEqual([message(1)])
    expect(d.live).toEqual({})
    expect(d.needsRefetch).toEqual([1])
  })

  it('turn_ended of another turn neither ends nor borrows the live turn', () => {
    const loaded: ChatData = { ...emptyData(), messages: { 1: [message(1)] } }
    const d = run(
      loaded,
      started(),
      chunk('turn two'),
      ev('turn_ended', {
        turn_id: 'old',
        stop_reason: 'end_turn',
        message_seq: 2,
      })
    )
    expect(d.live[1]).toMatchObject({ turnId: 't1', text: 'turn two' })
    expect(d.messages[1]).toEqual([message(1)])
    expect(d.needsRefetch).toEqual([1])
  })

  it('turn_ended does not displace a server row that holds the same seq', () => {
    const loaded: ChatData = {
      ...emptyData(),
      messages: { 1: [message(1), message(2, 'assistant', 'server', 40)] },
    }
    const d = run(loaded, started(), chunk('live'), ended(2))
    expect(d.messages[1]).toEqual([
      message(1),
      message(2, 'assistant', 'server', 40),
    ])
  })

  it('resync clears live turns and cards and marks loaded chats', () => {
    const d = run(
      {
        ...emptyData(),
        messages: { 3: [message(1)], 7: [] },
        needsRefetch: [3, 9],
      },
      started(),
      permission('p1'),
      resync()
    )
    expect(d.live).toEqual({})
    expect(d.approvals).toEqual({})
    // Numbers, not the string keys of `messages`; the earlier flag survives.
    expect(d.needsRefetch).toEqual([3, 9, 7])
    expect(d.messages).toEqual({ 3: [message(1)], 7: [] })
  })

  it('ignores an unknown event type', () => {
    const d = run(emptyData(), started())
    const odd = { seq: 99, type: 'something_new', chat_id: 1, turn_id: 't1' }
    expect(applyEvent(d, odd as unknown as AiChatEvent, NOW)).toBe(d)
  })

  it('an error event leaves the data alone (turn_ended follows it)', () => {
    const d = run(emptyData(), started())
    expect(
      applyEvent(d, ev('error', { code: 'agent_exited', message: 'gone' }), NOW)
    ).toBe(d)
  })

  describe('never throws and never mutates, for a chat it has not seen', () => {
    const everyEvent = (): AiChatEvent[] => [
      started({ starting: true }),
      chunk('a'),
      ev('thought_chunk', { text: 'b' }),
      ev('tool_call', { id: 'c1', title: 't', kind: null, status: null }),
      ev('tool_call_update', { id: 'c2', status: 'failed', title: null }),
      permission('p1'),
      resolved('p1'),
      resolved('never-seen'),
      ended(5),
      ended(null),
      ev('error', { code: 'agent_error', message: 'm' }),
      resync(),
      { seq: 1, type: 'x', chat_id: null, turn_id: null } as never,
    ]
    const populated = (): ChatData => ({
      chats: [chatRow(1)],
      messages: { 1: [message(1)] },
      live: {
        1: {
          turnId: 't1',
          text: 'a',
          thought: '',
          tools: { c1: { id: 'c1', title: 't', kind: null, status: null } },
          phase: 'waiting',
        },
      },
      approvals: { p1: { ...pending('p1'), chatId: 1 } },
      needsRefetch: [1],
    })

    it.each([
      ['empty data', emptyData],
      ['populated data', populated],
    ])('%s', (_name, make) => {
      for (const e of everyEvent()) {
        // A frozen input makes any write throw (ES modules are strict).
        const frozen = deepFreeze(make())
        const forChat9 = { ...e, chat_id: e.chat_id === null ? null : 9 }
        expect(() => applyEvent(frozen, e, NOW)).not.toThrow()
        expect(() =>
          applyEvent(frozen, forChat9 as AiChatEvent, NOW)
        ).not.toThrow()
      }
    })

    it('a tool id that is an Object.prototype name is just an id', () => {
      const d = run(
        emptyData(),
        ev('tool_call_update', { id: '__proto__', status: 'x', title: null }),
        ev('tool_call_update', { id: 'constructor', status: 'y', title: null })
      )
      expect(Object.keys(d.live[1]?.tools ?? {}).sort()).toEqual([
        '__proto__',
        'constructor',
      ])
      expect(({} as Record<string, unknown>).status).toBeUndefined()
    })
  })
})

// ---- the store -------------------------------------------------------------

describe('useAiChatStore', () => {
  beforeEach(() => {
    useAiChatStore.getState().reset()
  })

  const store = () => useAiChatStore.getState()

  it('starts closed with nothing selected', () => {
    expect(store()).toMatchObject({
      open: false,
      activeChatId: null,
      providerId: null,
      notice: null,
    })
  })

  it('setOpen, selectChat and setNotice set their field', () => {
    store().setOpen(true)
    store().selectChat(4)
    store().setNotice({ kind: 'busy', message: 'Nova is busy', chatId: 4 })
    expect(store()).toMatchObject({
      open: true,
      activeChatId: 4,
      notice: { kind: 'busy', message: 'Nova is busy', chatId: 4 },
    })
    store().selectChat(null)
    store().setNotice(null)
    expect(store()).toMatchObject({ activeChatId: null, notice: null })
  })

  it('setProviderId sets the provider', () => {
    store().setProviderId(3)
    expect(store().providerId).toBe(3)
    store().setProviderId(null)
    expect(store().providerId).toBeNull()
  })

  it('selectChat clears the notice, so it cannot sit on the wrong chat', () => {
    store().selectChat(1)
    store().setNotice({ kind: 'busy', message: 'b' })
    store().selectChat(2)
    expect(store().notice).toBeNull()
    store().setNotice({ kind: 'error', message: 'e', chatId: 2 })
    store().selectChat(null)
    expect(store().notice).toBeNull()
  })

  it('selectChat keeps a notice meant for the chat it selects', () => {
    store().selectChat(1)
    store().setNotice({ kind: 'busy', message: 'for 2', chatId: 2 })
    store().selectChat(2)
    expect(store().notice?.message).toBe('for 2')
    store().selectChat(1)
    expect(store().notice).toBeNull()
  })

  describe('the one notice slot', () => {
    const inView = { kind: 'busy', message: 'in view', chatId: 2 } as const
    const elsewhere = { kind: 'busy', message: 'elsewhere', chatId: 1 } as const

    it("raiseNotice keeps the active chat's notice over a background chat's", () => {
      store().selectChat(2)
      store().setNotice(inView)
      store().raiseNotice(elsewhere)
      expect(store().notice).toEqual(inView)
    })

    it('an event does too, whatever it raises', () => {
      store().selectChat(2)
      store().setNotice(inView)
      store().apply(ev('error', { code: 'agent_error', message: 'x' }))
      store().apply(ended(null, 'cancelled'))
      store().apply(ended(null, 'end_turn'))
      expect(store().notice).toEqual(inView)
    })

    it("the active chat's own notice always takes the slot", () => {
      store().selectChat(1)
      store().setNotice({ ...inView, chatId: 1 })
      store().raiseNotice(elsewhere)
      expect(store().notice).toEqual(elsewhere)
    })

    it('among background chats, the last one wins', () => {
      store().selectChat(9)
      store().raiseNotice(inView)
      store().raiseNotice(elsewhere)
      expect(store().notice).toEqual(elsewhere)
    })

    it('a background notice replaces one the reader cannot see', () => {
      store().selectChat(9)
      store().setNotice(inView)
      store().apply(ended(null, 'cancelled'))
      expect(store().notice?.chatId).toBe(1)
    })

    it('a notice with no chat is on show wherever the reader is', () => {
      store().selectChat(2)
      store().setNotice({ kind: 'busy', message: 'anywhere' })
      store().raiseNotice(elsewhere)
      expect(store().notice?.message).toBe('anywhere')
    })
  })

  describe('dismissApproval', () => {
    it('removes a stale card and nothing else', () => {
      store().apply(started())
      store().apply(permission('p1'))
      store().apply(permission('p2'))
      store().dismissApproval('p1')
      expect(Object.keys(store().approvals)).toEqual(['p2'])
      expect(store().live[1]?.phase).toBe('waiting')
    })

    it('puts a waiting turn back to running when its last card goes', () => {
      store().apply(started())
      store().apply(permission('p1'))
      store().dismissApproval('p1')
      expect(store().approvals).toEqual({})
      expect(store().live[1]?.phase).toBe('running')
    })

    it('leaves the state object alone for an unknown id', () => {
      store().apply(started())
      const before = store()
      store().dismissApproval('ghost')
      expect(store()).toBe(before)
    })
  })

  it('apply runs the reducer on the store', () => {
    store().apply(started())
    store().apply(chunk('hi'))
    expect(store().live[1]).toMatchObject({ text: 'hi', phase: 'running' })
    expect(isRunning(store())).toBe(true)
  })

  it('apply of an event that changes nothing leaves the state object alone', () => {
    store().apply(started())
    const before = store()
    store().apply({ seq: 9, type: 'zzz', chat_id: 1, turn_id: 't' } as never)
    store().apply(resolved('ghost'))
    expect(store()).toBe(before)
  })

  describe('notices', () => {
    it('maps agent_unreachable to unreachable and any other error to error', () => {
      store().apply(
        ev('error', { code: 'agent_unreachable', message: 'Nova is down' })
      )
      expect(store().notice).toEqual({
        kind: 'unreachable',
        message: 'Nova is down',
        chatId: 1,
      })

      store().apply(
        ev('error', {
          code: 'tools_check_failed',
          message: 'Tools check',
          chat_id: 2,
        })
      )
      expect(store().notice).toEqual({
        kind: 'error',
        message: 'Tools check',
        chatId: 2,
      })
    })

    it('maps a cancelled turn_ended to a Stopped. notice', () => {
      store().apply(started())
      store().apply(ended(null, 'cancelled'))
      expect(store().notice).toEqual({
        kind: 'cancelled',
        message: 'Stopped.',
        chatId: 1,
      })
      expect(store().live).toEqual({})
      expect(store().needsRefetch).toEqual([1])
    })

    it.each(['end_turn', 'max_tokens', 'something_new'])(
      'leaves the notice alone for a %s turn_ended that left a row',
      reason => {
        store().setNotice({ kind: 'busy', message: 'b' })
        store().apply(started())
        store().apply(ended(2, reason))
        expect(store().notice).toEqual({ kind: 'busy', message: 'b' })
      }
    )

    it.each(['end_turn', 'refusal', 'max_tokens', 'max_turn_requests'])(
      'says so when a %s turn ends with no row, without the new chat advice',
      reason => {
        store().apply(started())
        store().apply(ended(null, reason), 'Nova')
        expect(store().notice).toEqual({
          // Not `error`: the banner would append "Try a new chat."
          kind: 'busy',
          message: 'Nova ended without a reply.',
          chatId: 1,
        })
      }
    )

    it('names no agent it was not told', () => {
      store().apply(ended(null, 'end_turn'))
      expect(store().notice?.message).toBe('The agent ended without a reply.')
    })

    it.each([
      ['agent_exited', 'error', 'Nova stopped unexpectedly.'],
      ['agent_unreachable', 'unreachable', 'Could not reach Nova.'],
    ] as const)(
      'keeps what the %s error said when its turn ends with no row',
      (code, kind, message) => {
        store().apply(ev('error', { code, message }))
        store().apply(ended(null, 'error'), 'Nova')
        expect(store().notice).toEqual({ kind, message, chatId: 1 })
      }
    )

    it('raises it when the error notice on show is for another chat', () => {
      store().apply(
        ev('error', { code: 'agent_error', message: 'x', chat_id: 2 })
      )
      store().apply(ended(null, 'end_turn'), 'Nova')
      expect(store().notice).toMatchObject({
        message: 'Nova ended without a reply.',
        chatId: 1,
      })
    })
  })

  describe('setChats', () => {
    it('keeps a card that came from an event and adds one from a row', () => {
      store().apply(permission('from-event'))
      store().setChats([
        chatRow(1, { pending_approvals: [pending('from-row')] }),
        chatRow(2, { pending_approvals: [pending('other-chat')] }),
      ])
      expect(store().approvals).toEqual({
        'from-event': {
          ...pending('p'),
          permission_id: 'from-event',
          chatId: 1,
        },
        'from-row': { ...pending('p'), permission_id: 'from-row', chatId: 1 },
        'other-chat': {
          ...pending('p'),
          permission_id: 'other-chat',
          chatId: 2,
        },
      })
      expect(store().chats.map(c => c.id)).toEqual([1, 2])
    })

    it('clears the active chat when it has left the list', () => {
      store().selectChat(5)
      store().setChats([chatRow(1), chatRow(2)])
      expect(store().activeChatId).toBeNull()
    })

    it('keeps the active chat while it is in the list', () => {
      store().selectChat(2)
      store().setChats([chatRow(1), chatRow(2)])
      expect(store().activeChatId).toBe(2)
    })

    it('leaves a missing selection alone', () => {
      store().setChats([chatRow(1)])
      expect(store().activeChatId).toBeNull()
    })

    it('never removes a card a stale list no longer holds', () => {
      store().apply(permission('p1'))
      store().setChats([chatRow(1)])
      expect(Object.keys(store().approvals)).toEqual(['p1'])
    })

    it('seeds a live turn for a running chat, waiting when it has a card', () => {
      store().setChats([
        chatRow(1, {
          running_turn_id: 'r1',
          pending_approvals: [pending('p1')],
        }),
        chatRow(2, { running_turn_id: 'r2' }),
        chatRow(3),
      ])
      const empty = { text: '', thought: '', tools: {} }
      expect(store().live).toEqual({
        1: { turnId: 'r1', phase: 'waiting', ...empty },
        2: { turnId: 'r2', phase: 'running', ...empty },
      })
    })

    it('does not replace a live turn it already has, and does not end one', () => {
      store().apply(started())
      store().apply(chunk('streaming'))
      store().setChats([chatRow(1, { running_turn_id: 'other' }), chatRow(2)])
      expect(store().live[1]).toMatchObject({ turnId: 't1', text: 'streaming' })

      // A row with no running turn is not proof the turn ended.
      store().setChats([chatRow(1)])
      expect(store().live[1]).toMatchObject({ turnId: 't1', text: 'streaming' })
    })

    it('a chunk after a reload continues the seeded turn instead of replacing it', () => {
      store().setChats([chatRow(1, { running_turn_id: 't1' })])
      store().apply(chunk('rest'))
      expect(store().live[1]).toMatchObject({ turnId: 't1', text: 'rest' })
    })
  })

  describe('setMessages', () => {
    it('stores rows ordered by seq', () => {
      store().setMessages(1, [message(2), message(1)])
      expect(store().messages[1]?.map(m => m.seq)).toEqual([1, 2])
    })

    it('replaces the provisional row without duplicating', () => {
      store().setMessages(1, [message(1)])
      store().apply(started())
      store().apply(chunk('done'))
      store().apply(ended(2))
      expect(store().messages[1]?.map(m => m.id)).toEqual([1, -2])
      expect(store().needsRefetch).toEqual([1])
      expect(
        Number.isFinite(Date.parse(store().messages[1]?.[1]?.created_at ?? ''))
      ).toBe(true)

      store().setMessages(1, [message(1), message(2, 'assistant', 'done', 41)])
      expect(store().messages[1]).toEqual([
        message(1),
        message(2, 'assistant', 'done', 41),
      ])
    })

    it('an older response does not drop a newer row', () => {
      store().setMessages(1, [message(1), message(2), message(3)])
      store().setMessages(1, [message(1), message(2)])
      expect(store().messages[1]?.map(m => m.seq)).toEqual([1, 2, 3])
    })

    it('the server row wins over a stored row with the same seq', () => {
      store().setMessages(1, [message(1, 'user', 'old')])
      store().setMessages(1, [message(1, 'user', 'new')])
      expect(store().messages[1]).toEqual([message(1, 'user', 'new')])
    })

    it('does not touch needsRefetch (the glue clears it)', () => {
      store().apply(started())
      store().apply(ended(null))
      store().setMessages(1, [message(1)])
      expect(store().needsRefetch).toEqual([1])
    })
  })

  it('clearLive removes one chat live turn and nothing else', () => {
    store().apply(started())
    store().apply(chunk('a', { chat_id: 2, turn_id: 't2' }))
    store().apply(permission('p1'))
    store().clearLive(1)
    expect(Object.keys(store().live)).toEqual(['2'])
    expect(Object.keys(store().approvals)).toEqual(['p1'])
    store().clearLive(77)
    expect(Object.keys(store().live)).toEqual(['2'])
  })

  it('clearRefetch drops the listed chats from needsRefetch', () => {
    useAiChatStore.setState({ needsRefetch: [1, 2, 3] })
    store().clearRefetch([1, 3, 99])
    expect(store().needsRefetch).toEqual([2])
  })

  describe('reset', () => {
    const isData = (v: unknown) => typeof v !== 'function'

    it('restores every field to the starting state', () => {
      const initial = useAiChatStore.getInitialState()
      // Fill every field with something other than its starting value.
      store().apply(
        ev('turn_ended', {
          chat_id: 2,
          turn_id: 't2',
          stop_reason: 'end_turn',
          message_seq: null,
        })
      )
      store().setChats([chatRow(1)])
      store().setMessages(1, [message(1)])
      store().apply(started())
      store().apply(permission('p1'))
      store().setOpen(true)
      store().selectChat(1)
      useAiChatStore.setState({ providerId: 3 })
      store().setNotice({ kind: 'error', message: 'x', chatId: 1 })

      // The fill above must cover every data field, including ones added later.
      const filled = store()
      for (const key of Object.keys(initial) as (keyof typeof initial)[]) {
        if (isData(initial[key])) {
          expect(filled[key], `${key} was not filled`).not.toEqual(initial[key])
        }
      }

      store().reset()
      expect(store()).toEqual(initial)
      expect(store()).toMatchObject({
        chats: [],
        messages: {},
        live: {},
        approvals: {},
        needsRefetch: [],
        open: false,
        activeChatId: null,
        providerId: null,
        notice: null,
      })
    })

    it('a setChats after reset does not bring back an old card or turn', () => {
      store().apply(started())
      store().apply(permission('old'))
      store().reset()
      store().setChats([chatRow(1), chatRow(2, { running_turn_id: 'r2' })])
      expect(store().approvals).toEqual({})
      expect(Object.keys(store().live)).toEqual(['2'])
      expect(store().live[2]).toMatchObject({ turnId: 'r2', phase: 'running' })
    })

    it('the store keeps working after a reset', () => {
      store().apply(started())
      store().reset()
      store().apply(started())
      store().apply(chunk('again'))
      expect(store().live[1]).toMatchObject({ text: 'again' })
    })
  })

  it('hasPendingApproval and isRunning read the data', () => {
    expect(hasPendingApproval(store())).toBe(false)
    expect(isRunning(store())).toBe(false)
    store().apply(started())
    expect(isRunning(store())).toBe(true)
    expect(hasPendingApproval(store())).toBe(false)
    store().apply(permission('p1'))
    expect(hasPendingApproval(store())).toBe(true)
    store().apply(resolved('p1'))
    store().apply(ended(null))
    expect(isRunning(store())).toBe(false)
    expect(hasPendingApproval(store())).toBe(false)
  })
})

// ---- the page context ------------------------------------------------------

describe('currentPageContext', () => {
  const ui = (over: Partial<PageContextSource> = {}): PageContextSource => ({
    activeSection: 'dashboard',
    activeSubSection: 'orders',
    sampleDetailsTargetId: null,
    orderExplorerTargetOrderId: null,
    customerDetailTargetId: null,
    documentViewerTargetId: null,
    worksheetPageId: null,
    ...over,
  })

  it('picks the sample target', () => {
    expect(
      currentPageContext(
        ui({
          activeSection: 'senaite',
          activeSubSection: 'sample-details',
          sampleDetailsTargetId: 'P-0091',
        })
      )
    ).toEqual({
      section: 'senaite',
      subsection: 'sample-details',
      target_kind: 'sample',
      target_id: 'P-0091',
    })
  })

  it('has no target keys when nothing is open', () => {
    expect(currentPageContext(ui())).toEqual({
      section: 'dashboard',
      subsection: 'orders',
    })
    expect(Object.keys(currentPageContext(ui()))).toEqual([
      'section',
      'subsection',
    ])
  })

  // Each target is sent on the subsection `buildHash` pairs it with.
  it.each([
    [
      'sample',
      'senaite',
      'sample-details',
      { sampleDetailsTargetId: 'P-0091' },
      'P-0091',
    ],
    [
      'order',
      'accumark-tools',
      'order-explorer',
      { orderExplorerTargetOrderId: '5521' },
      '5521',
    ],
    [
      'customer',
      'accumark-tools',
      'customer-detail',
      { customerDetailTargetId: 42 },
      '42',
    ],
    ['document', 'reports', 'documents', { documentViewerTargetId: 12 }, '12'],
    ['worksheet', 'hplc-analysis', 'worksheet', { worksheetPageId: 7 }, '7'],
  ] as const)(
    'sends the %s target on its own page, ids as strings',
    (kind, activeSection, activeSubSection, target, id) => {
      expect(
        currentPageContext(ui({ activeSection, activeSubSection, ...target }))
      ).toEqual({
        section: activeSection,
        subsection: activeSubSection,
        target_kind: kind,
        target_id: id,
      })
    }
  )

  it('0 is an id, not "no target"', () => {
    expect(
      currentPageContext(
        ui({
          activeSection: 'accumark-tools',
          activeSubSection: 'customer-detail',
          customerDetailTargetId: 0,
        })
      )
    ).toMatchObject({ target_kind: 'customer', target_id: '0' })
  })

  it('treats an undefined id (a store that never set it) as no target', () => {
    const open = currentPageContext(
      ui({
        activeSection: 'accumark-tools',
        activeSubSection: 'customer-detail',
        customerDetailTargetId: undefined as unknown as null,
      })
    )
    expect(open).toEqual({
      section: 'accumark-tools',
      subsection: 'customer-detail',
    })
  })

  it('sends no target for a sticky id left over from another page', () => {
    // `sampleDetailsTargetId` outlives the sample page; Reports is not it.
    const stale = currentPageContext(
      ui({
        activeSection: 'reports',
        activeSubSection: 'dashboard',
        sampleDetailsTargetId: 'P-1234',
      })
    )
    expect(stale).toEqual({ section: 'reports', subsection: 'dashboard' })
    expect(Object.keys(stale)).toEqual(['section', 'subsection'])

    // Same for every other target: set, but the user is elsewhere.
    expect(
      currentPageContext(
        ui({
          sampleDetailsTargetId: 'P-1',
          orderExplorerTargetOrderId: '9',
          customerDetailTargetId: 3,
          documentViewerTargetId: 4,
          worksheetPageId: 5,
        })
      )
    ).toEqual({ section: 'dashboard', subsection: 'orders' })
  })

  it('sends only the target of the page the user is on', () => {
    const all = {
      sampleDetailsTargetId: 'P-1',
      orderExplorerTargetOrderId: '9',
      customerDetailTargetId: 3,
      documentViewerTargetId: 4,
      worksheetPageId: 5,
    }
    expect(
      currentPageContext(
        ui({ ...all, activeSection: 'reports', activeSubSection: 'documents' })
      )
    ).toMatchObject({ target_kind: 'document', target_id: '4' })
    expect(
      currentPageContext(
        ui({
          ...all,
          activeSection: 'accumark-tools',
          activeSubSection: 'order-explorer',
        })
      )
    ).toMatchObject({ target_kind: 'order', target_id: '9' })
  })
})
