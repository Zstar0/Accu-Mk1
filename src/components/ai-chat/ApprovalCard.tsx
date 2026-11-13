/**
 * One approval the agent is waiting on. The title and detail come from the
 * agent, so both render as plain text.
 *
 * The card never says what was decided. A 200 only means the server accepted
 * the answer: Stop can still turn it into `cancelled`. So after a send the
 * buttons stay off and the card says "Sent." until `permission_resolved`
 * removes it. A stale card (expired, or decided elsewhere) gets Dismiss,
 * because no event will come for it.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CrmError } from '@/lib/api-crm'
import { decidePermission } from '@/lib/ai-chat-api'
import {
  useAiChatStore,
  type ApprovalCard as ApprovalCardData,
} from './chat-store'

type Status = 'idle' | 'sending' | 'sent' | 'expired' | 'decided' | 'failed'

const NOTE: Partial<Record<Status, string>> = {
  sent: 'aiChat.approval.sent',
  expired: 'aiChat.approval.expired',
  decided: 'aiChat.approval.decided',
  failed: 'aiChat.approval.failed',
}

/** What a rejected answer means for the card. */
function statusAfterError(e: unknown): Status {
  if (e instanceof CrmError) {
    if (e.status === 404) return 'expired'
    if (e.status === 409 && e.code === 'permission_decided') return 'decided'
  }
  // `allow_not_offered` and every other failure: nothing was decided.
  return 'failed'
}

export function ApprovalCard({ card }: { card: ApprovalCardData }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<Status>('idle')
  const locked = status !== 'idle' && status !== 'failed'
  const stale = status === 'expired' || status === 'decided'

  async function send(decision: 'allow' | 'deny') {
    setStatus('sending')
    try {
      await decidePermission(card.chatId, card.permission_id, decision)
      setStatus('sent')
    } catch (e) {
      setStatus(statusAfterError(e))
    }
  }

  const note = NOTE[status]

  return (
    <div
      role="group"
      aria-label={t('aiChat.approval.title')}
      className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <ShieldQuestion className="size-3.5" aria-hidden="true" />
        {t('aiChat.approval.title')}
      </div>
      {/* Both scroll in place, so a long command cannot push the buttons away. */}
      <p
        tabIndex={0}
        className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-medium"
      >
        {card.title}
      </p>
      {card.detail !== '' && (
        <pre
          tabIndex={0}
          className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs"
        >
          {card.detail}
        </pre>
      )}
      {card.hidden && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('aiChat.approval.hidden')}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {card.can_allow && (
          <Button
            size="sm"
            disabled={locked}
            onClick={() => void send('allow')}
          >
            {t('aiChat.approval.allowOnce')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => void send('deny')}
        >
          {t('aiChat.approval.deny')}
        </Button>
        {note !== undefined && (
          <span role="status" className="text-xs text-muted-foreground">
            {t(note)}
          </span>
        )}
        {stale && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              useAiChatStore.getState().dismissApproval(card.permission_id)
            }
          >
            {t('aiChat.dismiss')}
          </Button>
        )}
      </div>
    </div>
  )
}
