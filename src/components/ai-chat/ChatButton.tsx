/**
 * The floating button that opens the AI chat panel. Renders nothing until the
 * user may use at least one provider, so the feature stays dark until an admin
 * enables one for them.
 *
 * `MainWindow` raises the toaster by this button's footprint (16px gap, 40px
 * button, 16px gap = 72px) while it shows, so toasts never cover it.
 */

import { useEffect, useRef } from 'react'
import { Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { hasPendingApproval, isRunning, useAiChatStore } from './chat-store'
import { useAiProviders } from './use-ai-chat-glue'

/** Stable DOM id, as `FLAGS_BUTTON_ID` is for the flags button. */
export const CHAT_BUTTON_ID = 'ai-chat-button'

export function ChatButton() {
  const visible = useAiProviders().length > 0
  const open = useAiChatStore(s => s.open)
  const running = useAiChatStore(isRunning)
  const pending = useAiChatStore(hasPendingApproval)

  // Closing the panel hands focus back to where it was opened from.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) {
      document.getElementById(CHAT_BUTTON_ID)?.focus()
    }
    wasOpen.current = open
  }, [open])

  if (!visible) return null

  return (
    <>
      <Button
        id={CHAT_BUTTON_ID}
        size="icon-lg"
        aria-label="Open AI chat"
        aria-describedby="ai-chat-button-state"
        // The panel covers the button while open; hidden, it also leaves the
        // tab order and the accessibility tree.
        className={
          open
            ? 'invisible fixed right-4 bottom-4 z-40 rounded-full shadow-lg'
            : 'fixed right-4 bottom-4 z-40 rounded-full shadow-lg'
        }
        onClick={() => useAiChatStore.getState().setOpen(true)}
      >
        <MessageSquare className="size-5" aria-hidden="true" />
        {running && (
          <Loader2
            data-testid="ai-chat-running"
            aria-hidden="true"
            className="absolute -top-1 -left-1 size-4 animate-spin rounded-full bg-background text-primary motion-reduce:animate-none"
          />
        )}
        {pending && (
          <span
            data-testid="ai-chat-pending"
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-amber-500 ring-2 ring-background"
          />
        )}
      </Button>
      <span id="ai-chat-button-state" className="sr-only">
        {pending
          ? 'An approval is waiting'
          : running
            ? 'A reply is in progress'
            : ''}
      </span>
    </>
  )
}
