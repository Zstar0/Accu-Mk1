/**
 * SampleActivityLog
 *
 * Terminal-styled activity timeline for a sample.
 * Renders as a right-side Sheet with the same dark console aesthetic
 * used by the HPLC debug overlay.
 */

import { useState, useEffect, useRef } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { X, RefreshCw } from 'lucide-react'
import { getSampleActivity, type SampleActivityEvent } from '@/lib/api'
import { getWordpressUrl } from '@/lib/api-profiles'

// ─── Color mapping (matches DebugConsole palette) ────────────────────────────

type EventLevel = 'info' | 'dim' | 'warn' | 'success' | 'error' | 'accent'

const levelColor: Record<EventLevel, string> = {
  info:    'text-zinc-300',
  dim:     'text-zinc-600',
  warn:    'text-amber-400',
  success: 'text-emerald-400',
  error:   'text-red-400',
  accent:  'text-cyan-300',
}

function eventToLevel(event: string): EventLevel {
  switch (event) {
    case 'coa_published':     return 'success'
    case 'coa_superseded':    return 'warn'
    case 'hplc_analysis':     return 'accent'
    case 'prep_completed':    return 'success'
    case 'status_change':     return 'info'
    case 'coa_generated':     return 'info'
    case 'prep_started':      return 'info'
    case 'prep_record_created': return 'info'
    case 'added_to_worksheet': return 'info'
    default:                  return 'dim'
  }
}

function eventIcon(event: string): string {
  switch (event) {
    case 'status_change':       return '\u25cf' // ●
    case 'coa_published':       return '\u2714' // ✔
    case 'coa_generated':       return '\u25a0' // ■
    case 'coa_superseded':      return '\u25cb' // ○
    case 'hplc_analysis':       return '\u25b8' // ▸
    case 'prep_started':        return '\u25b6' // ▶
    case 'prep_completed':      return '\u2714' // ✔
    case 'prep_record_created': return '\u2022' // •
    case 'added_to_worksheet':  return '\u002b' // +
    default:                    return '\u2022' // •
  }
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '                   '
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function accuverifyUrl(code: string): string {
  return `${getWordpressUrl()}/accuverify/?accuverify_code=${encodeURIComponent(code)}`
}

/** Extract the short username from an email (before @) */
function shortUser(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

// ─── Detail line builder (returns ReactNode[] for mixed text + links) ────────

function DetailLine({ event }: { event: SampleActivityEvent }) {
  const d = event.details
  const parts: React.ReactNode[] = []

  switch (event.event) {
    case 'hplc_analysis': {
      if (d.purity != null) parts.push(`purity=${Number(d.purity).toFixed(2)}%`)
      if (d.processed_by) parts.push(<UserTag key="u" email={d.processed_by as string} />)
      break
    }
    case 'prep_record_created': {
      if (d.prep_id) parts.push(`prep=${d.prep_id}`)
      if (d.status) parts.push(`status=${d.status}`)
      if (d.by) parts.push(<UserTag key="u" email={d.by as string} />)
      break
    }
    case 'added_to_worksheet': {
      if (d.worksheet_title) parts.push(`ws=${d.worksheet_title}`)
      if (d.analyst) parts.push(<span key="a">analyst=<UserTag email={d.analyst as string} /></span>)
      else if (d.created_by) parts.push(<span key="c">by <UserTag email={d.created_by as string} /></span>)
      break
    }
    case 'coa_generated':
    case 'coa_published':
    case 'coa_superseded':
      // verification code rendered inline on the main line, not here
      break
    case 'status_change': {
      if (d.wp_notified) parts.push('wp_notified=true')
      break
    }
    default:
      break
  }

  if (parts.length === 0) return null

  return (
    <div className="font-mono text-[11px] leading-snug text-zinc-600 whitespace-pre-wrap ps-[21ch]">
      {'  '}{parts.map((p, i) => (
        <span key={i}>{i > 0 ? '  ' : ''}{p}</span>
      ))}
    </div>
  )
}

function UserTag({ email }: { email: string }) {
  const name = shortUser(email)
  return (
    <span className="text-violet-400/80" title={email}>
      @{name}
    </span>
  )
}

function VerificationLink({ code }: { code: string }) {
  return (
    <a
      href={accuverifyUrl(code)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-500/80 hover:text-emerald-400 underline underline-offset-2 decoration-emerald-500/30 hover:decoration-emerald-400/60 transition-colors"
      title={`Verify COA: ${code}`}
    >
      {code}
    </a>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  sampleId: string
}

export function SampleActivityLog({ open, onClose, sampleId }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [events, setEvents] = useState<SampleActivityEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await getSampleActivity(sampleId)
      setEvents(res.events)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && sampleId) load()
  }, [open, sampleId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [events])

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-[600px] sm:max-w-[600px] p-0 border-l-0 bg-transparent [&>button]:hidden"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Activity Log — {sampleId}</SheetTitle>
        </SheetHeader>

        <div className="m-3 flex flex-1 h-[calc(100%-24px)] flex-col rounded-lg overflow-hidden border border-zinc-800/80 shadow-2xl shadow-black/90">
          {/* Title bar */}
          <div className="bg-zinc-900 border-b border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex gap-1.5 shrink-0">
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              </div>
              <span className="text-[11px] text-zinc-500 font-mono truncate">
                <span className="text-zinc-600">$</span> accumark activity-log --sample {sampleId}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={load}
                disabled={loading}
                className="text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-30"
              >
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={onClose}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Log body */}
          <div
            ref={scrollRef}
            className="bg-[#0d0d0d] px-3 py-3 space-y-0 flex-1 overflow-y-auto"
          >
            {loading && events.length === 0 && (
              <div className="flex items-center gap-2 py-8 justify-center">
                <Spinner className="size-3" />
                <span className="font-mono text-[11px] text-zinc-600">loading events...</span>
              </div>
            )}

            {error && (
              <div className="font-mono text-[11px] text-red-400 py-2">
                error: {error}
              </div>
            )}

            {!loading && !error && events.length === 0 && (
              <div className="font-mono text-[11px] text-zinc-600 py-4 text-center">
                no activity found for {sampleId}
              </div>
            )}

            {events.map((ev, i) => {
              const level = eventToLevel(ev.event)
              const icon = eventIcon(ev.event)
              const ts = formatTimestamp(ev.timestamp)
              const isFirst = i === 0
              const prevDate = i > 0 ? formatTimestamp(events[i - 1]!.timestamp).slice(0, 10) : null
              const curDate = ts.slice(0, 10)
              const showDateSep = i > 0 && curDate !== prevDate

              const isCoa = ev.event === 'coa_generated' || ev.event === 'coa_published' || ev.event === 'coa_superseded'
              const vcode = isCoa ? (ev.details.verification_code as string | undefined) : undefined

              return (
                <div key={i}>
                  {showDateSep && (
                    <div className="font-mono text-[13px] text-zinc-700 py-1.5 mt-1">
                      {'─'.repeat(3)} {curDate} {'─'.repeat(34)}
                    </div>
                  )}
                  {isFirst && (
                    <div className="font-mono text-[13px] text-zinc-700 pb-1.5">
                      {'─'.repeat(3)} {curDate} {'─'.repeat(34)}
                    </div>
                  )}
                  <div className={cn(
                    'font-mono text-[13px] leading-relaxed whitespace-pre-wrap',
                    levelColor[level],
                  )}>
                    <span className="text-zinc-700">{ts}</span>
                    {'  '}
                    <span className={levelColor[level]}>{icon}</span>
                    {'  '}
                    {ev.label}
                    {vcode && (
                      <>{'  '}<VerificationLink code={vcode} /></>
                    )}
                  </div>
                  <DetailLine event={ev} />
                </div>
              )
            })}

            {events.length > 0 && (
              <div className="font-mono text-[10px] text-zinc-700 pt-2">
                {'─'.repeat(50)}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="bg-[#0a0a0a] border-t border-zinc-900 px-3 py-2 font-mono text-[10px] flex items-center justify-between shrink-0">
            <span className="text-emerald-500/70">
              {events.length} events
            </span>
            <span className="text-zinc-700">
              {events.length > 0
                ? `${events.filter(e => new Set(['hplc_analysis', 'coa_published', 'status_change']).has(e.event)).length} key actions`
                : 'esc to close'}
            </span>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
