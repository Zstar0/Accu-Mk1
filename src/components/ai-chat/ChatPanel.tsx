/**
 * The slide-out chat panel. Non-modal: the page behind it stays usable, so
 * there is no overlay and no focus trap. It is portaled to `body` because the
 * flags flyout shows that a transformed ancestor traps `position: fixed`, and
 * `MainWindow` is not a place to rely on.
 *
 * Stacking: z-40, under Radix dialogs and the flags flyout (z-50).
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, History, Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AiProvider } from '@/lib/ai-chat-api'
import { useAiChatStore, type LivePhase } from './chat-store'
import { ChatComposer, COMPOSER_ID } from './ChatComposer'
import { ChatMessages } from './ChatMessages'
import {
  loadMessages,
  useActiveProvider,
  useAiProviders,
} from './use-ai-chat-glue'

function statusText(phase: LivePhase | undefined, agent: string): string {
  switch (phase) {
    case 'starting':
      return `Starting ${agent}...`
    case 'resuming':
      return 'Resuming...'
    case 'running':
      return 'Working...'
    case 'waiting':
      return `${agent} is waiting for your approval`
    default:
      return ''
  }
}

const focusComposer = () => document.getElementById(COMPOSER_ID)?.focus()

export function ChatPanel() {
  const providers = useAiProviders()
  const agent = useActiveProvider()
  const open = useAiChatStore(s => s.open)
  const chats = useAiChatStore(s => s.chats)
  const approvals = useAiChatStore(s => s.approvals)
  const activeChatId = useAiChatStore(s => s.activeChatId)
  const loaded = useAiChatStore(s =>
    s.activeChatId === null ? true : s.messages[s.activeChatId] !== undefined
  )
  const phase = useAiChatStore(s =>
    s.activeChatId === null ? undefined : s.live[s.activeChatId]?.phase
  )

  // Opening shows the provider's most recent chat, once. After that the reader
  // decides: New chat clears the selection and nothing may put it back.
  const settled = useRef(false)
  useEffect(() => {
    if (!open) {
      settled.current = false
      return
    }
    if (settled.current) return
    if (activeChatId !== null) {
      settled.current = true
      return
    }
    const latest =
      agent === null ? undefined : chats.find(c => c.provider_id === agent.id)
    if (latest !== undefined) {
      settled.current = true
      useAiChatStore.getState().selectChat(latest.id)
    }
  }, [open, activeChatId, chats, agent])

  useEffect(() => {
    if (open) focusComposer()
  }, [open])

  // Fetch the transcript of a chat the panel has not loaded. A failure is shown
  // with a Retry, once per chat.
  const [failedChat, setFailedChat] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open || activeChatId === null || loaded) return
    let current = true
    void loadMessages(activeChatId).then(ok => {
      if (current && !ok) setFailedChat(activeChatId)
    })
    return () => {
      current = false
    }
  }, [open, activeChatId, loaded, attempt])

  if (providers.length === 0 || agent === null) return null

  const name = agent.display_name
  const agentId = agent.id
  // Chats with an approval waiting, marked in the recent-chats menu.
  const holdingCards = new Set(
    Object.values(approvals).map(card => card.chatId)
  )
  const close = () => useAiChatStore.getState().setOpen(false)

  function newChat() {
    settled.current = true
    // The new chat is with the agent of the one left (a toast may have opened a
    // second provider's chat, and `providerId` is still unset).
    useAiChatStore.getState().setProviderId(agentId)
    useAiChatStore.getState().selectChat(null)
    focusComposer()
  }

  function pickProvider(id: number) {
    const store = useAiChatStore.getState()
    settled.current = true
    store.setProviderId(id)
    store.selectChat(chats.find(c => c.provider_id === id)?.id ?? null)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Esc inside a menu belongs to the menu: it is portaled elsewhere in the
    // DOM and has already handled the key.
    if (
      e.key === 'Escape' &&
      !e.defaultPrevented &&
      e.currentTarget.contains(e.target as Node)
    ) {
      close()
    }
  }

  let body: ReactNode
  if (activeChatId === null) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        <p>Ask {name} about the page you are on.</p>
      </div>
    )
  } else {
    // The messages always render: an approval card is live data and must not
    // wait for, or be lost to, a transcript that is slow or failed to load.
    body = (
      <>
        {!loaded && (
          <div className="flex shrink-0 items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            {failedChat === activeChatId ? (
              <>
                <span>Could not load this chat.</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setFailedChat(null)
                    setAttempt(n => n + 1)
                  }}
                >
                  Retry
                </Button>
              </>
            ) : (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-label="Loading"
              />
            )}
          </div>
        )}
        <ChatMessages chatId={activeChatId} />
      </>
    )
  }

  const panel = (
    <div
      role="complementary"
      aria-label="AI chat"
      // Closed, the panel sits off screen; `inert` keeps it out of the tab
      // order and the accessibility tree.
      inert={!open}
      aria-hidden={!open}
      onKeyDown={onKeyDown}
      className={cn(
        // ponytail: top-8 is the title bar (h-8). In a dev stack the 24px
        // StackBanner sits above it and the panel overlaps that much of the
        // title bar; read the banner height if that ever matters.
        'fixed top-8 right-0 bottom-0 z-40 flex flex-col border-l bg-background shadow-xl',
        // Keep in step with `PANEL_WIDTH` in `use-ai-chat-glue.ts`: the toaster
        // is moved left by this width while the panel is open. Tailwind needs
        // the literal here, so the two cannot share one constant.
        'w-[clamp(360px,35vw,720px)] max-w-[100vw]',
        'transition-transform duration-200 motion-reduce:transition-none',
        open ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      <header className="flex items-center gap-1 border-b px-3 py-2">
        {providers.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Choose agent"
                className="min-w-0 gap-1 px-2"
              >
                <span className="truncate text-sm font-semibold">{name}</span>
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Agent</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(agent.id)}
                onValueChange={v => pickProvider(Number(v))}
              >
                {providers.map((p: AiProvider) => (
                  <DropdownMenuRadioItem key={p.id} value={String(p.id)}>
                    {p.display_name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">
            {name}
          </h2>
        )}
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Recent chats">
                <History className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-64">
              {chats.length === 0 ? (
                <DropdownMenuItem disabled>No chats yet</DropdownMenuItem>
              ) : (
                chats.map(chat => (
                  <DropdownMenuItem
                    key={chat.id}
                    onSelect={() => {
                      const store = useAiChatStore.getState()
                      settled.current = true
                      store.setProviderId(chat.provider_id)
                      store.selectChat(chat.id)
                    }}
                  >
                    <span className="truncate">
                      {chat.title || 'Untitled chat'}
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                      {providers.length > 1 &&
                        (providers.find(p => p.id === chat.provider_id)
                          ?.display_name ??
                          '')}
                      {holdingCards.has(chat.id) && (
                        <>
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-amber-500"
                          />
                          <span className="sr-only">Approval waiting</span>
                        </>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            aria-label="New chat"
            onClick={newChat}
          >
            <Plus className="size-4" aria-hidden="true" />
            New chat
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close AI chat"
            onClick={close}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div
        role="status"
        aria-live="polite"
        aria-label="Chat status"
        className="px-3 text-xs text-muted-foreground"
      >
        {statusText(phase, name)}
      </div>

      {body}

      <ChatComposer />

      <p className="border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        {`Chats are processed and stored by ${name} on Accumark's bot server.`}
      </p>
    </div>
  )

  return createPortal(panel, document.body)
}
