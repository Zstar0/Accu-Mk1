import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DocumentViewer } from '@/components/documents/DocumentViewer'
import { cn } from '@/lib/utils'
import { CrmError } from '@/lib/api-crm'
import {
  getReviewRun,
  getReviews,
  startReview,
  type ReviewRun,
} from '@/lib/api-ai-review'

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

/** AI review tab: a summary bar plus the review document (Documents library) embedded. */
export function CustomerAiReviewTab({ customerKey }: { customerKey: string }) {
  const qc = useQueryClient()
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [viewDocId, setViewDocId] = useState<number | null>(null)

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
    // Once per finished run: reload latest + history (isRunning reads the run's own
    // status, so activeRunId needs no reset).
    if (finishedRunId === null) return
    void qc.invalidateQueries({ queryKey: ['ai-review', customerKey] })
  }, [finishedRunId, customerKey, qc])
  const lastGoodId =
    latest?.status === 'done'
      ? latest.run_id
      : (reviews.data?.history.find(h => h.status === 'done')?.run_id ?? null)
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
      setViewDocId(null)
      void qc.invalidateQueries({ queryKey: ['ai-review', customerKey] })
    },
  })

  const isRunning =
    runningId !== null && (!running.data || running.data.status === 'running')
  const runView: ReviewRun | undefined = shown.data
  const review = runView?.review ?? null
  const docId = runView?.document_id ?? null
  const notConfigured =
    start.error instanceof CrmError &&
    start.error.code === 'review_not_configured'

  return (
    <section aria-label="AI review" className="flex flex-col gap-3">
      <div className="rounded-lg border border-border/50 bg-card/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500" />
          {review ? (
            <>
              <span
                className={cn(
                  'rounded-full px-2 text-xs font-medium',
                  SENTIMENT_STYLE[review.sentiment.score + 2]
                )}
              >
                {SENTIMENT[review.sentiment.score + 2]} ·{' '}
                {review.sentiment.trend}
              </span>
              <span className="text-xs text-muted-foreground">
                {plural(review.open_issues.length, 'open issue', 'open issues')}{' '}
                · {review.shortfalls.length} where we fell short · Generated{' '}
                {day(runView?.created_at ?? null)} ·{' '}
                {age(runView?.created_at ?? null)}
              </span>
            </>
          ) : (
            !isRunning &&
            reviews.data && (
              <span className="text-sm text-muted-foreground">
                No AI review yet
              </span>
            )
          )}
          <div className="ml-auto flex items-center gap-2">
            {docId !== null && (
              <a
                href={`#reports/documents?id=${docId}`}
                className="flex items-center gap-1 text-xs text-sky-600 hover:underline dark:text-sky-300"
              >
                <ExternalLink className="h-3 w-3" />
                Open in Documents
              </a>
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
        {review?.headline && (
          <p className="mt-2 line-clamp-2 text-sm">{review.headline}</p>
        )}
        {runView && (
          <p className="mt-1 text-xs text-muted-foreground">
            {runView.model} ·{' '}
            {plural(runView.tool_call_count, 'lookup', 'lookups')} · $
            {runView.cost_usd.toFixed(2)}
          </p>
        )}
        {notConfigured && (
          <p className="mt-2 text-sm text-muted-foreground">
            AI review not configured: ANTHROPIC_API_KEY is not set on the
            server.
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
              <Loader2 className="h-3 w-3 animate-spin" /> Working · started{' '}
              {age(running.data.created_at)}
            </li>
          </ol>
        )}
      </div>

      {review && docId === null && (
        <p className="text-sm text-muted-foreground">
          No review document yet: Regenerate to create one.
          {runView?.document_error ? ` (${runView.document_error})` : ''}
        </p>
      )}
      {docId !== null && (
        <div className="h-[75vh] overflow-hidden rounded-lg border">
          <DocumentViewer
            id={viewDocId ?? docId}
            embedded
            onNavigate={setViewDocId}
          />
        </div>
      )}
    </section>
  )
}
