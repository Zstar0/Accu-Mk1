import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CrmError, type CrmItem } from '@/lib/api-crm'
import type { SupportThread } from '@/lib/api-support'
import {
  getReviewRun,
  getReviews,
  startReview,
  type Review,
  type ReviewCitation,
  type ReviewItem,
  type ReviewRun,
} from '@/lib/api-ai-review'
import { useUIStore } from '@/store/ui-store'
import { SupportThreadPanel } from './SupportThreadPanel'
import { CrmActivityPanel } from './CrmActivityPanel'

const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'
const SENTIMENT = [
  'Very negative',
  'Negative',
  'Neutral',
  'Positive',
  'Very positive',
]
const SENTIMENT_STYLE = [
  'bg-red-500/15 text-red-600 dark:text-red-400',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-muted text-muted-foreground',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-emerald-500/25 text-emerald-700 dark:text-emerald-300',
]
const SECTIONS: { key: keyof Omit<Review, 'sentiment'>; label: string }[] = [
  { key: 'open_issues', label: 'Open issues' },
  { key: 'shortfalls', label: 'Where we fell short' },
  { key: 'strengths', label: 'Strengths' },
  { key: 'next_steps', label: 'Next steps' },
]
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`
const age = (iso: string | null) => {
  if (!iso) return ''
  const m = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  )
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} days ago`
}
const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    : ''

export function CustomerAiReviewCard({ customerKey }: { customerKey: string }) {
  const qc = useQueryClient()
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const navigateToOrderExplorer = useUIStore(
    state => state.navigateToOrderExplorer
  )
  const [expanded, setExpanded] = useState(false)
  const [showLookups, setShowLookups] = useState(false)
  const [viewRunId, setViewRunId] = useState<number | null>(null)
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [openThread, setOpenThread] = useState<SupportThread | null>(null)
  const [openCrm, setOpenCrm] = useState<CrmItem | null>(null)

  const reviews = useQuery({
    queryKey: ['ai-review', customerKey],
    queryFn: () => getReviews(customerKey),
    retry: false,
  })
  const latest = reviews.data?.latest ?? null
  const runningId =
    activeRunId ?? (latest?.status === 'running' ? latest.run_id : null)
  const running = useQuery({
    queryKey: ['ai-review', 'run', runningId],
    queryFn: () => getReviewRun(runningId as number),
    enabled: runningId !== null,
    refetchInterval: q =>
      q.state.data?.status === 'running' || !q.state.data ? 2000 : false,
  })
  const finishedRunId =
    running.data && running.data.status !== 'running'
      ? running.data.run_id
      : null
  useEffect(() => {
    // Once per finished run: reload latest + history (activeRunId may keep pointing at the
    // finished run; isRunning reads the run's own status, so nothing needs resetting).
    if (finishedRunId === null) return
    void qc.invalidateQueries({ queryKey: ['ai-review', customerKey] })
  }, [finishedRunId, customerKey, qc])
  const lastGoodId =
    viewRunId ??
    (latest?.status === 'done'
      ? latest.run_id
      : (reviews.data?.history.find(h => h.status === 'done')?.run_id ?? null))
  const shown = useQuery({
    queryKey: ['ai-review', 'run', 'view', lastGoodId],
    queryFn: () =>
      latest && latest.run_id === lastGoodId
        ? Promise.resolve(latest)
        : getReviewRun(lastGoodId as number),
    enabled: lastGoodId !== null,
  })
  const start = useMutation({
    mutationFn: () => startReview(customerKey),
    onSuccess: r => {
      setActiveRunId(r.run_id)
      void qc.invalidateQueries({ queryKey: ['ai-review', customerKey] })
    },
  })

  const openCitation = (c: ReviewCitation) => {
    if (c.kind === 'ticket' && c.thread)
      setOpenThread(c.thread as SupportThread)
    else if (c.kind === 'crm' && c.item) setOpenCrm(c.item)
    else if (c.kind === 'sample') navigateToSample(c.id)
    else if (c.kind === 'order' && c.order_id)
      navigateToOrderExplorer(c.order_id)
  }
  const chips = (cs: ReviewCitation[]) =>
    cs.map(c => (
      <button
        key={`${c.kind}:${c.id}`}
        type="button"
        onClick={() => openCitation(c)}
        className="ml-1 rounded-full bg-sky-500/15 px-2 text-[10px] text-sky-600 hover:underline dark:text-sky-300"
      >
        {c.label}
      </button>
    ))

  const isRunning =
    runningId !== null && (!running.data || running.data.status === 'running')
  const runView: ReviewRun | undefined = shown.data
  const review = runView?.review ?? null
  const notConfigured =
    start.error instanceof CrmError &&
    start.error.code === 'review_not_configured'

  return (
    <section className={cn(CARD, 'mt-4')} aria-label="AI review">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-500" />
        <h2 className="text-sm font-medium">AI review</h2>
        {review && (
          <>
            <span
              className={cn(
                'rounded-full px-2 text-xs font-medium',
                SENTIMENT_STYLE[review.sentiment.score + 2]
              )}
            >
              {SENTIMENT[review.sentiment.score + 2]} · {review.sentiment.trend}
            </span>
            <span className="text-xs text-muted-foreground">
              {plural(review.open_issues.length, 'open issue', 'open issues')} ·{' '}
              {review.shortfalls.length} where we fell short · Generated{' '}
              {day(runView?.created_at ?? null)} ·{' '}
              {age(runView?.created_at ?? null)}
            </span>
          </>
        )}
        {!review && !isRunning && reviews.data && (
          <span className="text-xs text-muted-foreground">
            No AI review yet
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {reviews.data && reviews.data.history.length > 1 && (
            <select
              aria-label="Previous reviews"
              className="rounded border bg-background px-1 text-xs"
              value={lastGoodId ?? ''}
              onChange={e => setViewRunId(Number(e.target.value))}
            >
              {reviews.data.history
                .filter(h => h.status === 'done')
                .map(h => (
                  <option key={h.run_id} value={h.run_id}>
                    {day(h.created_at)} · {h.sentiment_score ?? '?'}
                  </option>
                ))}
            </select>
          )}
          {review && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(x => !x)}
            >
              {expanded ? 'Hide details' : 'Show details'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={isRunning || start.isPending}
            onClick={() => start.mutate()}
          >
            {isRunning ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            {review ? 'Regenerate' : 'Generate review'}
          </Button>
        </div>
      </div>

      {notConfigured && (
        <p className="mt-2 text-sm text-muted-foreground">
          AI review not configured: ANTHROPIC_API_KEY is not set on the server.
        </p>
      )}
      {start.error && !notConfigured && (
        <p className="mt-2 text-sm text-red-500">Could not start a review.</p>
      )}
      {latest &&
        (latest.status === 'failed' || latest.status === 'interrupted') &&
        !isRunning && (
          <p className="mt-2 text-sm text-red-500">
            Last run{' '}
            {latest.status === 'interrupted'
              ? 'was interrupted'
              : `failed: ${latest.error ?? 'unknown error'}`}
            .
          </p>
        )}
      {isRunning && running.data && (
        <ol className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {running.data.steps.map((s, i) => (
            <li key={i}>{s.label}</li>
          ))}
          <li className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Working (
            {age(running.data.created_at)})
          </li>
        </ol>
      )}

      {review && expanded && runView && (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <p>
            {review.sentiment.reason}
            {review.sentiment.unsupported ? (
              <span className="ml-1 text-xs text-amber-500">(unsupported)</span>
            ) : (
              chips(review.sentiment.citations)
            )}
          </p>
          {SECTIONS.map(sec => (
            <div key={sec.key}>
              <h3 className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                {sec.label}
              </h3>
              {(review[sec.key] as ReviewItem[]).length === 0 ? (
                <p className="text-xs text-muted-foreground">None found.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {(review[sec.key] as ReviewItem[]).map((it, i) => (
                    <li key={i}>
                      {it.text}
                      {chips(it.citations)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div className="text-xs text-muted-foreground">
            {runView.model} ·{' '}
            {plural(runView.tool_call_count, 'lookup', 'lookups')} · $
            {runView.cost_usd.toFixed(2)}
            <Button
              variant="link"
              size="sm"
              onClick={() => setShowLookups(x => !x)}
            >
              {showLookups ? 'Hide lookups' : 'Show lookups'}
            </Button>
          </div>
          {showLookups && (
            <ul aria-label="Lookups" className="text-xs text-muted-foreground">
              {runView.tool_calls.map((t, i) => (
                <li key={i}>
                  {t.tool} {JSON.stringify(t.args)}
                  {t.ok ? '' : ' (error)'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <SupportThreadPanel
        customerKey={customerKey}
        thread={openThread}
        onClose={() => setOpenThread(null)}
      />
      <CrmActivityPanel
        customerKey={customerKey}
        item={openCrm}
        onClose={() => setOpenCrm(null)}
      />
    </section>
  )
}
