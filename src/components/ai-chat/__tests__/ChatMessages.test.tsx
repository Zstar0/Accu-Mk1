import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  })
})
