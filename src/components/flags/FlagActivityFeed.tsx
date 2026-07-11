import { useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useFlagActivity } from '@/hooks/use-flags'
import { FlagActivityRow } from '@/components/flags/FlagActivityRow'
import {
  filterActivity,
  type ActivityChip,
} from '@/components/flags/flag-activity'

const CHIPS: { key: ActivityChip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'forme', label: 'For me' },
  { key: 'actor', label: 'My actions' },
  { key: 'mine', label: 'My flags' },
  { key: 'watching', label: 'Watching' },
  { key: 'mentioned', label: 'Mentions' },
]

/** Infinite-scroll activity feed. An IntersectionObserver sentinel auto-loads
 *  the next keyset page; a manual "Load more" button is the accessible fallback
 *  (and the path used where IntersectionObserver is unavailable, e.g. jsdom).
 *  Personalization chips narrow the concatenated pages client-side. */
export function FlagActivityFeed() {
  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useFlagActivity()

  const [chip, setChip] = useState<ActivityChip>(
    () => (localStorage.getItem('flags:activityChip') as ActivityChip) || 'all'
  )
  const pick = (c: ActivityChip) => {
    setChip(c)
    try {
      localStorage.setItem('flags:activityChip', c)
    } catch {
      /* quota/SSR — session-only */
    }
  }

  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage()
      }
    })
    io.observe(node)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const items = data?.pages.flatMap(p => p.items) ?? []
  const visible = filterActivity(items, chip)

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-muted-foreground">Couldn’t load activity.</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="mt-2 text-xs font-semibold text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <Activity className="mb-3 h-8 w-8 text-muted-foreground/30" />
        <p className="text-sm font-semibold">No activity yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Actions on your flags will show up here.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1 px-3 py-2">
        {CHIPS.map(c => (
          <button
            key={c.key}
            type="button"
            onClick={() => pick(c.key)}
            aria-pressed={chip === c.key}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              chip === c.key
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="p-1">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <Activity className="mb-3 h-8 w-8 text-muted-foreground/30" />
            <p className="text-sm font-semibold">No activity for this filter</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try a different filter above.
            </p>
          </div>
        ) : (
          visible.map(item => <FlagActivityRow key={item.id} item={item} />)
        )}
        <div ref={sentinel} />
        {hasNextPage && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default FlagActivityFeed
