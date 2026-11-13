// Real i18n resources, so the assertions below read the English copy.
import '@/i18n/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import type { AiMessage } from '@/lib/ai-chat-api'
import { useAiChatStore } from '../chat-store'
import { ChatMessages } from '../ChatMessages'

import type * as Api from '@/lib/ai-chat-api'

vi.mock('@/lib/ai-chat-api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  decidePermission: vi.fn(),
}))

const row = (
  seq: number,
  role: string,
  text: string,
  meta: AiMessage['meta'] = null
): AiMessage => ({
  id: seq,
  seq,
  role,
  text,
  meta,
  created_at: '2026-11-03T00:00:00Z',
})

const fill = (rows: AiMessage[], chatId = 1) =>
  act(() => useAiChatStore.getState().setMessages(chatId, rows))

beforeEach(() => {
  act(() => useAiChatStore.getState().reset())
})

describe('ChatMessages', () => {
  it('renders a user message as plain text', () => {
    fill([row(1, 'user', '<b>not bold</b> & more')])
    const { container } = render(<ChatMessages chatId={1} />)
    expect(screen.getByText('<b>not bold</b> & more')).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })

  it('renders assistant text as markdown', () => {
    fill([
      row(
        1,
        'assistant',
        'Use **ls**:\n\n- one\n- two\n\n`code` and [a link](https://example.com)'
      ),
    ])
    const { container } = render(<ChatMessages chatId={1} />)
    expect(container.querySelector('strong')?.textContent).toBe('ls')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('code')?.textContent).toBe('code')
  })

  it('shows a link as text with its full destination, never as a clickable anchor', () => {
    fill([
      row(
        1,
        'assistant',
        '[Open the report](https://evil.example/?d=secret) or https://example.com/x'
      ),
    ])
    const { container } = render(<ChatMessages chatId={1} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain(
      'Open the report (https://evil.example/?d=secret)'
    )
    // A bare URL appears once.
    expect(container.textContent?.match(/example\.com\/x/g)).toHaveLength(1)
  })

  it('does the same for the text of a turn that is still streaming', () => {
    act(() => {
      useAiChatStore.getState().apply({
        seq: 1,
        type: 'message_chunk',
        chat_id: 1,
        turn_id: 't1',
        text: 'See [here](https://evil.example/?d=secret)',
      })
    })
    const { container } = render(<ChatMessages chatId={1} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain(
      'here (https://evil.example/?d=secret)'
    )
  })

  it('lets nothing active through from assistant text', () => {
    fill([
      row(
        1,
        'assistant',
        [
          '<img src=x onerror="window.__pwned = 1">',
          '<script>window.__pwned = 2</script>',
          '![remote](https://evil.example/p.png)',
          '[click](javascript:window.__pwned=3)',
          '{attachment:9}',
        ].join('\n\n')
      ),
    ])
    const { container } = render(<ChatMessages chatId={1} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    // No image can load: DOMPurify's allowlist has no `src`.
    for (const img of container.querySelectorAll('img')) {
      expect(img).not.toHaveAttribute('src')
    }
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('shows a tool chip from a stored assistant row', () => {
    fill([
      row(1, 'assistant', 'done', {
        tools: [
          {
            id: 'c1',
            title: 'Read /etc/hosts',
            kind: 'read',
            status: 'completed',
          },
          { id: 'c2', title: null, kind: 'execute', status: 'failed' },
        ],
        stop_reason: 'end_turn',
      }),
    ])
    render(<ChatMessages chatId={1} />)
    expect(screen.getByText('Read /etc/hosts')).toBeInTheDocument()
    // A chip with no title falls back to its kind.
    expect(screen.getByText('execute')).toBeInTheDocument()
  })

  it('survives a malformed tools list', () => {
    fill([row(1, 'assistant', 'ok', { tools: 'nope' })])
    fill([row(2, 'assistant', 'ok too', { tools: [null, 3, { id: 5 }] })])
    render(<ChatMessages chatId={1} />)
    expect(screen.getByText('ok')).toBeInTheDocument()
    expect(screen.getByText('ok too')).toBeInTheDocument()
  })

  describe('history permission rows', () => {
    it('shows the decision', () => {
      fill([
        row(1, 'permission', 'Run ls', {
          title: 'Run ls',
          detail: 'ls',
          permission_id: 'p1',
          decision: 'deny',
        }),
      ])
      render(<ChatMessages chatId={1} />)
      expect(screen.getByText('Run ls')).toBeInTheDocument()
      expect(screen.getByText('Denied')).toBeInTheDocument()
    })

    it('renders a null decision as "No decision recorded", never as a live card', () => {
      fill([
        row(1, 'permission', 'Run ls', {
          title: 'Run ls',
          detail: 'ls',
          permission_id: 'p1',
          decision: null,
        }),
      ])
      render(<ChatMessages chatId={1} />)
      expect(screen.getByText('No decision recorded')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    })

    describe('with a live card for it', () => {
      const undecided = row(1, 'permission', 'Run ls', {
        permission_id: 'p1',
        decision: null,
      })
      const card = (permission_id: string) =>
        act(() =>
          useAiChatStore.setState({
            approvals: {
              [permission_id]: {
                permission_id,
                source: 'agent',
                title: 'The card',
                detail: '',
                can_allow: true,
                hidden: false,
                chatId: 1,
              },
            },
          })
        )

      it('says it is waiting, and only the card has buttons', () => {
        fill([undecided])
        card('p1')
        render(<ChatMessages chatId={1} />)
        expect(
          screen.getByText('Waiting for your decision.')
        ).toBeInTheDocument()
        expect(screen.queryByText('No decision recorded')).toBeNull()
        expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1)
      })

      it('goes back when the card goes', () => {
        fill([undecided])
        card('p1')
        render(<ChatMessages chatId={1} />)
        act(() => useAiChatStore.setState({ approvals: {} }))
        expect(screen.getByText('No decision recorded')).toBeInTheDocument()
      })

      it("is not fooled by another row's card", () => {
        fill([undecided])
        card('p2')
        render(<ChatMessages chatId={1} />)
        expect(screen.getByText('No decision recorded')).toBeInTheDocument()
      })

      it('a decision on the row wins', () => {
        fill([
          { ...undecided, meta: { permission_id: 'p1', decision: 'deny' } },
        ])
        card('p1')
        render(<ChatMessages chatId={1} />)
        expect(screen.getByText('Denied')).toBeInTheDocument()
      })
    })
  })

  describe('how a stored reply ended', () => {
    const LINES = [
      ['max_tokens', 'This reply was cut off at the length limit.'],
      [
        'max_turn_requests',
        'The agent stopped at its step limit, so this reply may be incomplete.',
      ],
      ['refusal', 'The agent declined to continue.'],
      ['agent_exited', 'This reply may be incomplete.'],
      ['something_new', 'This reply may be incomplete.'],
      // A name an object has anyway must not find what the object has.
      ['constructor', 'This reply may be incomplete.'],
    ]
    const ANY_LINE = /cut off|step limit|declined to continue|may be incomplete/

    it.each(LINES)('%s shows a line under the reply', (stop_reason, line) => {
      fill([row(1, 'assistant', 'partial', { stop_reason })])
      const { container } = render(<ChatMessages chatId={1} />)
      const note = screen.getByText(line as string)
      expect(note.tagName).toBe('P')
      expect(container.querySelector('strong, a, b, script, img')).toBeNull()
      // Under the reply, not in it.
      expect(note.previousElementSibling?.textContent).toContain('partial')
    })

    it.each(['end_turn', 'cancelled'])('%s shows no line', stop_reason => {
      fill([row(1, 'assistant', 'done', { stop_reason })])
      const { container } = render(<ChatMessages chatId={1} />)
      expect(container.textContent).not.toMatch(ANY_LINE)
    })

    it('a row with no stop reason shows no line', () => {
      fill([row(1, 'assistant', 'old', null), row(2, 'assistant', 'odd', {})])
      const { container } = render(<ChatMessages chatId={1} />)
      expect(container.textContent).not.toMatch(ANY_LINE)
    })

    it('a row with only tool chips still shows it', () => {
      fill([row(1, 'assistant', '', { stop_reason: 'max_turn_requests' })])
      render(<ChatMessages chatId={1} />)
      expect(
        screen.getByText(
          'The agent stopped at its step limit, so this reply may be incomplete.'
        )
      ).toBeInTheDocument()
    })

    it('the row standing in for the reply until the refetch lands shows it too', () => {
      fill([row(1, 'user', 'hi')])
      act(() => {
        const s = useAiChatStore.getState()
        s.apply({
          seq: 1,
          type: 'message_chunk',
          chat_id: 1,
          turn_id: 't1',
          text: 'cut sho',
        })
        s.apply({
          seq: 2,
          type: 'turn_ended',
          chat_id: 1,
          turn_id: 't1',
          stop_reason: 'max_tokens',
          message_seq: 2,
        })
      })
      render(<ChatMessages chatId={1} />)
      expect(
        screen.getByText('This reply was cut off at the length limit.')
      ).toBeInTheDocument()
    })
  })

  describe('the live turn', () => {
    const start = () =>
      act(() => {
        const s = useAiChatStore.getState()
        s.apply({
          seq: 1,
          type: 'turn_started',
          chat_id: 1,
          turn_id: 't1',
          starting: false,
          resuming: false,
        })
      })

    it('shows streamed text as markdown, tool chips, and a collapsed Thinking row', () => {
      fill([row(1, 'user', 'hi')])
      start()
      act(() => {
        const s = useAiChatStore.getState()
        s.apply({
          seq: 2,
          type: 'thought_chunk',
          chat_id: 1,
          turn_id: 't1',
          text: 'pondering the ls',
        })
        s.apply({
          seq: 3,
          type: 'tool_call',
          chat_id: 1,
          turn_id: 't1',
          id: 'c1',
          title: 'Run ls',
          kind: 'execute',
          status: 'in_progress',
        })
        s.apply({
          seq: 4,
          type: 'message_chunk',
          chat_id: 1,
          turn_id: 't1',
          text: 'Here is **it**',
        })
      })
      const { container } = render(<ChatMessages chatId={1} />)

      expect(container.querySelector('strong')?.textContent).toBe('it')
      expect(screen.getByText('Run ls')).toBeInTheDocument()
      const details = container.querySelector('details')
      expect(details).not.toBeNull()
      expect(details).not.toHaveAttribute('open')
      expect(
        within(details as HTMLElement).getByText('Thinking')
      ).toBeInTheDocument()
      expect(details?.textContent).toContain('pondering the ls')
    })

    it('renders a live approval card from `approvals`', () => {
      start()
      act(() => {
        useAiChatStore.getState().apply({
          seq: 2,
          type: 'permission_requested',
          chat_id: 1,
          turn_id: 't1',
          permission_id: 'p1',
          source: 'agent',
          title: 'Run rm',
          detail: 'rm -rf /tmp/x',
          can_allow: true,
          hidden: false,
          agent: 'Nova',
        })
      })
      render(<ChatMessages chatId={1} />)
      expect(screen.getByText('Run rm')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Allow once' })
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })

    it("shows only this chat's cards", () => {
      act(() => {
        useAiChatStore.setState({
          approvals: {
            p9: {
              permission_id: 'p9',
              source: 'agent',
              title: 'Other chat card',
              detail: '',
              can_allow: true,
              hidden: false,
              chatId: 2,
            },
          },
        })
      })
      render(<ChatMessages chatId={1} />)
      expect(screen.queryByText('Other chat card')).toBeNull()
    })
  })

  describe('scrolling', () => {
    /** jsdom has no layout: give the scroller a geometry and record scrollTop. */
    function geometry(scroller: HTMLElement, top: number) {
      let scrollTop = top
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get: () => 1000,
      })
      Object.defineProperty(scroller, 'clientHeight', {
        configurable: true,
        get: () => 400,
      })
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v
        },
      })
      return () => scrollTop
    }
    const chunk = (text: string) =>
      act(() => {
        useAiChatStore.getState().apply({
          seq: Math.floor(Math.random() * 1e9),
          type: 'message_chunk',
          chat_id: 1,
          turn_id: 't1',
          text,
        })
      })

    it('follows new text when the reader is at the bottom', () => {
      fill([row(1, 'user', 'hi')])
      render(<ChatMessages chatId={1} />)
      const scroller = screen.getByTestId('chat-scroll')
      const top = geometry(scroller, 590) // 1000 - 590 - 400 = 10 from the bottom
      act(() => {
        scroller.dispatchEvent(new Event('scroll'))
      })
      chunk('more')
      expect(top()).toBe(1000)
    })

    it('does not yank a reader who scrolled up', () => {
      fill([row(1, 'user', 'hi')])
      render(<ChatMessages chatId={1} />)
      const scroller = screen.getByTestId('chat-scroll')
      const top = geometry(scroller, 100)
      act(() => {
        scroller.dispatchEvent(new Event('scroll'))
      })
      chunk('more')
      expect(top()).toBe(100)
    })

    describe('when the scroller changes size', () => {
      // A notice or a taller composer shrinks the scroller and fires no scroll
      // event: the observer's callback is the only thing that sees it.
      let resize: () => void = vi.fn()
      const disconnect = vi.fn()
      beforeEach(() => {
        disconnect.mockClear()
        vi.stubGlobal(
          'ResizeObserver',
          class {
            constructor(callback: ResizeObserverCallback) {
              resize = () => callback([], this as unknown as ResizeObserver)
            }
            observe = vi.fn()
            unobserve = vi.fn()
            disconnect = disconnect
          }
        )
      })
      afterEach(() => {
        vi.unstubAllGlobals()
      })

      it('keeps the end in view when the reader was at the bottom', () => {
        fill([row(1, 'user', 'hi')])
        render(<ChatMessages chatId={1} />)
        const scroller = screen.getByTestId('chat-scroll')
        const top = geometry(scroller, 590)
        act(() => {
          scroller.dispatchEvent(new Event('scroll'))
        })
        act(() => resize())
        expect(top()).toBe(1000)
      })

      it('leaves a reader who scrolled up where they are', () => {
        fill([row(1, 'user', 'hi')])
        render(<ChatMessages chatId={1} />)
        const scroller = screen.getByTestId('chat-scroll')
        const top = geometry(scroller, 100)
        act(() => {
          scroller.dispatchEvent(new Event('scroll'))
        })
        act(() => resize())
        expect(top()).toBe(100)
      })

      it('stops observing on unmount', () => {
        fill([row(1, 'user', 'hi')])
        const { unmount } = render(<ChatMessages chatId={1} />)
        expect(disconnect).not.toHaveBeenCalled()
        unmount()
        expect(disconnect).toHaveBeenCalledTimes(1)
      })
    })
  })
})
