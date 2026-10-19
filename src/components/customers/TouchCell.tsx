import { ArrowDownLeft, ArrowUpRight, Mail, Phone } from 'lucide-react'
import type { CrmTouch, SupportTouch } from '@/lib/api'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type Touch = CrmTouch | SupportTouch

const REASONS: Record<string, string> = {
  not_configured: 'Not configured for this account',
  unavailable: 'Source unavailable right now',
  unknown_customer: 'Customer not found in the source',
}

const DAY_MS = 86_400_000

function shortDate(iso: string, tz: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  })
}

function age(iso: string, now: Date) {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS)
  return days < 1 ? 'today' : `${days} d`
}

const SECTION = 'border-t border-primary-foreground/20 pt-1.5'

/** Pure hover-card body: props in, markup out. */
export function TouchCard({
  kind,
  touch,
}: {
  kind: 'crm' | 'support'
  touch: Touch
}) {
  const reason = touch.reason ? (REASONS[touch.reason] ?? touch.reason) : null
  return (
    <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
      <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
        {kind === 'crm' ? 'Last CRM touch' : 'Last support touch'}
      </div>
      {touch.state === 'unavailable' && <div>{reason ?? 'Unavailable'}</div>}
      {touch.state === 'none' && <div>No touch on record</div>}
      {touch.state === 'ok' && kind === 'crm' && (
        <>
          <div>{(touch as CrmTouch).who}</div>
          <div>{touch.title}</div>
          <div className={SECTION}>{(touch as CrmTouch).preview}</div>
          <div>{(touch as CrmTouch).lead_name}</div>
        </>
      )}
      {touch.state === 'ok' && kind === 'support' && (
        <>
          <div>{touch.title}</div>
          <div>Status: {(touch as SupportTouch).status ?? 'unknown'}</div>
          {(touch as SupportTouch).waiting_since && (
            <div>
              Waiting since{' '}
              {(touch as SupportTouch).waiting_since?.slice(0, 10)}
            </div>
          )}
          <div className={SECTION}>
            Open threads: {(touch as SupportTouch).open_count ?? 0}
          </div>
        </>
      )}
      {touch.stale && <div className={SECTION}>Showing cached data</div>}
    </div>
  )
}

export function TouchCell({
  kind,
  touch,
  tz,
  now,
  onOpen,
}: {
  kind: 'crm' | 'support'
  touch: Touch | null | undefined
  tz: string
  now?: Date
  onOpen: () => void
}) {
  if (touch === undefined) {
    return (
      <span
        aria-busy="true"
        aria-label="Loading"
        className="animate-pulse text-muted-foreground"
      >
        -
      </span>
    )
  }
  if (touch === null || touch.state === 'none') {
    return <span className="text-muted-foreground">none</span>
  }
  if (touch.state === 'unavailable') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="text-muted-foreground">
            n/a
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs p-0">
          <TouchCard kind={kind} touch={touch} />
        </TooltipContent>
      </Tooltip>
    )
  }

  const crmTouch = kind === 'crm' ? (touch as CrmTouch) : null
  const sup = kind === 'support' ? (touch as SupportTouch) : null
  const chip =
    sup && (sup.status === 'open' || sup.waiting_since)
      ? sup.waiting_since
        ? 'waiting'
        : 'open'
      : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:underline"
          onClick={e => {
            e.stopPropagation()
            onOpen()
          }}
          onKeyDown={e => {
            // Enter must not bubble to the row's own Enter handler.
            if (e.key === 'Enter') e.stopPropagation()
          }}
        >
          {crmTouch?.direction === 'inbound' && (
            <ArrowDownLeft className="size-3" aria-label="inbound" />
          )}
          {crmTouch?.direction === 'outbound' && (
            <ArrowUpRight className="size-3" aria-label="outbound" />
          )}
          {crmTouch?.type === 'email' && (
            <Mail className="size-3" aria-label="email" />
          )}
          {crmTouch?.type === 'call' && (
            <Phone className="size-3" aria-label="call" />
          )}
          <span>{touch.at ? shortDate(touch.at, tz) : ''}</span>
          <span className="text-muted-foreground">
            {touch.at ? age(touch.at, now ?? new Date()) : ''}
          </span>
          {chip && (
            <span
              className={cn(
                'rounded-full px-2 text-xs font-semibold',
                chip === 'waiting'
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
              )}
            >
              {chip}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs p-0">
        <TouchCard kind={kind} touch={touch} />
      </TooltipContent>
    </Tooltip>
  )
}
