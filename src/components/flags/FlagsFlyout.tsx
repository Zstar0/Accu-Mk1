import { useEffect, useState } from 'react'
import { Flag, HelpCircle, List, Plus, Table2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useUIStore } from '@/store/ui-store'
import { useAuthStore } from '@/store/auth-store'
import {
  useFlagsList,
  useEntityFlags,
  useFlagUnread,
  useFlagSearch,
} from '@/hooks/use-flags'
import { useFlagUnseen } from '@/components/flags/use-flag-unseen'
import { unreadBuckets } from '@/components/flags/unread-buckets'
import type { FlagTab, FlagResponse } from '@/lib/flags-api'
import { FlagCard } from '@/components/flags/FlagCard'
import { FlagTable } from '@/components/flags/FlagTable'
import { FlagThread } from '@/components/flags/FlagThread'
import { FlagActivityFeed } from '@/components/flags/FlagActivityFeed'
import { FlagsFilterBar } from '@/components/flags/FlagsFilterBar'
import {
  useFlagViewMode,
  type FlagViewMode,
} from '@/components/flags/use-flag-view-mode'
import {
  RaiseFlagButton,
  type FlagCandidate,
} from '@/components/flags/RaiseFlagButton'
import { entityLabel } from '@/components/flags/flag-entity'
import { filterFlags } from '@/components/flags/flag-filter'
import { useFlagFilter } from '@/components/flags/use-flag-filter'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import {
  mergeSearchHits,
  type FlagSearchMeta,
} from '@/components/flags/flag-search'

/** The flyout's tab axis. Four map 1:1 to the API's `FlagTab`; `activity` (event
 *  feed) and `unread` (unread flags) are FE-only tabs. */
type FlyoutTab = FlagTab | 'activity' | 'unread'

/** Shared empty map for the non-search branch (avoids a new Map() per render). */
const EMPTY_SEARCH_META = new Map<number, FlagSearchMeta>()

const TABS: { value: FlyoutTab; label: string }[] = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'raised', label: 'Raised by me' },
  { value: 'watching', label: 'Watching' },
  { value: 'all_open', label: 'All open' },
  { value: 'unread', label: 'Unread' },
  { value: 'activity', label: 'Activity' },
]

const VIEW_OPTIONS = [
  { mode: 'list' as const, Icon: List, label: 'List view' },
  { mode: 'table' as const, Icon: Table2, label: 'Table view' },
]

/** Compact segmented control (stacked list ⇄ aligned table) — flyout header. */
function ViewToggle({
  mode,
  onChange,
}: {
  mode: FlagViewMode
  onChange: (mode: FlagViewMode) => void
}) {
  return (
    <div
      role="group"
      aria-label="Flag view"
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
    >
      {VIEW_OPTIONS.map(({ mode: m, Icon, label }) => (
        <button
          key={m}
          type="button"
          aria-label={label}
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded transition-colors',
            mode === m
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  )
}

/** Small header link to the static Flags guide (mirrors the SOP-guide links
 *  in the Receive Wizard / Worksheets Inbox headers). New-tab anchor — no
 *  modal, so no z-index conflict with the flyout Sheet. */
function GuideLink() {
  return (
    <a
      href="/guides/flags-system-guide.html"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      title="Open the Flags guide in a new tab"
    >
      <HelpCircle className="size-3.5" aria-hidden="true" />
      Guide
    </a>
  )
}

/**
 * Full-height right slide-over for the Flag System — mirrors WorksheetDrawer
 * (uses ui/sheet). Three modes: a selected thread (FlagThread), an
 * entity-filtered list (driven by an EntityFlagButton with >1 flag), or the
 * four triage tabs. Visual target: flyout-form.html.
 */
export function FlagsFlyout() {
  const open = useUIStore(state => state.flagsFlyoutOpen)
  const threadId = useUIStore(state => state.flagsThreadId)
  const entityFilter = useUIStore(state => state.flagsEntityFilter)
  const samplesFilter = useUIStore(state => state.flagsSamplesFilter)
  // Multi-flag affordances: "the page you're on" — the top of the registered
  // entity stack. Drives the context-aware Add Flag (hidden when empty).
  const activeEntity = useUIStore(
    state => state.activeFlagEntityStack.at(-1) ?? null
  )
  const me = useAuthStore(state => state.user?.id ?? null)
  const [tab, setTab] = useState<FlyoutTab>('assigned')
  // FE-only tabs: Activity renders the event feed; Unread lists unread flags.
  const isActivity = tab === 'activity'
  const isUnread = tab === 'unread'
  // Per-tab triage filters, persisted in localStorage (personal tabs default
  // to All-Open). Keyed on the active tab; switching tabs restores its filter.
  const [filter, setFilter] = useFlagFilter(tab)
  // Persisted display style (stacked list vs. aligned table).
  const [viewMode, setViewMode] = useFlagViewMode()
  // Flags the user was just pinged about (snapshot captured when this flyout
  // opened) — their rows pulse so what's new stands out. Set is memoized by the
  // React Compiler off `justOpened`.
  const justOpened = useFlagUnseen(state => state.justOpened)
  const highlightIds = new Set(justOpened)

  // On the open that acknowledged pings, jump to the tab holding the newest one
  // so its row pulse is actually on screen. Driven by a store subscription (not
  // a setState in an effect body — matches the glue's glow-clear pattern) so it
  // stays off the render path; `justOpenedTab` only transitions to a value on
  // the acknowledging open, so this never fights a manual tab click afterward.
  useEffect(() => {
    return useFlagUnseen.subscribe((s, prev) => {
      if (s.justOpenedTab && s.justOpenedTab !== prev.justOpenedTab) {
        setTab(s.justOpenedTab)
      }
    })
  }, [])

  // Activity/Unread aren't real API tabs — hold a valid FlagTab so the query
  // stays well-formed; the result is ignored (the feed/unread list renders).
  const tabQuery = useFlagsList(
    isActivity || isUnread ? 'assigned' : (tab as FlagTab)
  )
  const entityQuery = useEntityFlags(entityFilter?.type, entityFilter?.id, {
    includeDescendants: entityFilter?.includeDescendants ?? false,
  })
  // Order/samples scope filters the page-wide all_open list client-side. Same
  // query key the indicators already loaded, so TanStack Query dedupes it.
  const allOpenQuery = useFlagsList('all_open')
  // Unread flags drive the left-bar markers (all tabs), the tab dots, and the
  // Unread tab's list. One query, three views.
  const unreadQuery = useFlagUnread()
  const unreadFlags = unreadQuery.data ?? []
  const unreadIds = new Set(unreadFlags.map(f => f.id))
  const buckets = unreadBuckets(unreadFlags, me)

  const filtering = entityFilter != null
  const samplesScope = !entityFilter && samplesFilter != null
  const scoped = filtering || samplesScope

  let flags: FlagResponse[] | undefined
  let isLoading: boolean
  let isError: boolean
  let refetch: () => void
  if (filtering) {
    ;({ data: flags, isLoading, isError, refetch } = entityQuery)
  } else if (samplesScope) {
    const ids = new Set(samplesFilter.sampleIds)
    flags = (allOpenQuery.data ?? []).filter(f => {
      const sid =
        f.entity?.sample_id ?? (f.entity_type === 'sample' ? f.entity_id : null)
      return sid != null && ids.has(sid)
    })
    isLoading = allOpenQuery.isLoading
    isError = allOpenQuery.isError
    refetch = allOpenQuery.refetch
  } else if (isUnread) {
    flags = unreadFlags
    isLoading = unreadQuery.isLoading
    isError = unreadQuery.isError
    refetch = unreadQuery.refetch
  } else {
    ;({ data: flags, isLoading, isError, refetch } = tabQuery)
  }

  const activeTabLabel = TABS.find(t => t.value === tab)?.label ?? 'Flags'
  // Prefer the server-resolved label from a returned flag; fall back to the
  // opaque "Vial 42" form when the list is empty / unresolved.
  const entityLabelText = entityFilter
    ? (flags?.find(f => f.entity?.label)?.entity?.label ??
      entityLabel(entityFilter.type, entityFilter.id))
    : ''
  // The label shown in scoped headers/empty-state ("on {label}").
  const scopedLabel = filtering ? entityLabelText : (samplesFilter?.label ?? '')
  // Order-scope create targets — each sample the order spans.
  const sampleCandidates: FlagCandidate[] = samplesFilter
    ? samplesFilter.sampleIds.map(id => ({
        entityType: 'sample',
        entityId: id,
        label: id,
      }))
    : []

  // Client-side triage filters layered on the fetched list (no API change).
  const total = flags?.length ?? 0
  const clientVisible = flags ? filterFlags(flags, filter) : []

  // Comment search: the instant client filter above stays untouched; for a
  // 3+ char query (debounced) we ALSO fetch comment/title matches server-side
  // and merge in the ones the client dropped (comment-only hits). Search is
  // tab-agnostic server-side; mergeSearchHits intersects with this tab's list.
  const liveText = filter.text.trim()
  const debouncedText = useDebouncedValue(liveText, 300)
  const searchActive = liveText.length >= 3 && debouncedText.length >= 3
  const searchQuery = useFlagSearch(searchActive ? debouncedText : '')
  const hits = searchQuery.data ?? []

  const { flags: visibleFlags, searchMeta } = searchActive
    ? mergeSearchHits(flags ?? [], clientVisible, hits)
    : { flags: clientVisible, searchMeta: EMPTY_SEARCH_META }

  const hasFlags = total > 0
  // Don't flash "no matches" while a comment query is still in flight — a
  // comment-only query has clientVisible === [] until the hits land.
  const searchPending = searchActive && searchQuery.isFetching
  const filteredOut = hasFlags && visibleFlags.length === 0 && !searchPending

  return (
    <Sheet
      open={open}
      onOpenChange={isOpen => {
        if (!isOpen) {
          useUIStore.getState().closeFlagsFlyout()
        }
      }}
    >
      <SheetContent
        side="right"
        className="flex w-[880px] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[880px]"
      >
        <SheetTitle className="sr-only">Flags</SheetTitle>
        {threadId != null ? (
          <FlagThread flagId={threadId} tabLabel={activeTabLabel} />
        ) : (
          <>
            {/* Header */}
            {scoped ? (
              <div className="flex items-center justify-between gap-2 border-b py-3 pl-4 pr-12">
                <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
                  <Flag className="h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {filtering
                      ? `Flags on ${scopedLabel}`
                      : `Flags · ${scopedLabel}`}
                  </span>
                </h2>
                <div className="flex shrink-0 items-center gap-1.5">
                  <GuideLink />
                  <ViewToggle mode={viewMode} onChange={setViewMode} />
                  {filtering ? (
                    <RaiseFlagButton
                      entityType={entityFilter.type}
                      entityId={entityFilter.id}
                      variant="compact"
                    />
                  ) : (
                    <RaiseFlagButton
                      candidates={sampleCandidates}
                      variant="compact"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      filtering
                        ? useUIStore.getState().clearFlagsEntityFilter()
                        : useUIStore.getState().clearFlagsSamplesFilter()
                    }
                    aria-label={
                      filtering ? 'Clear entity filter' : 'Clear order filter'
                    }
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b py-3 pl-4 pr-12">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Flag className="h-4 w-4" /> Flags
                  </h2>
                  <div className="flex items-center gap-1.5">
                    <GuideLink />
                    {!isActivity && (
                      <ViewToggle mode={viewMode} onChange={setViewMode} />
                    )}
                    {/* Add Flag: targets the entity page the user is on when
                        there is one; otherwise composes a General task (Phase 2
                        — always visible now that general tasks exist). */}
                    <RaiseFlagButton
                      {...(activeEntity
                        ? {
                            entityType: activeEntity.type,
                            entityId: activeEntity.id,
                            targetLabel: activeEntity.label,
                          }
                        : {})}
                      trigger={
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5"
                          title={
                            activeEntity
                              ? `Add flag on ${activeEntity.label}`
                              : 'Add a flag or general task'
                          }
                        >
                          <Plus className="h-3.5 w-3.5" /> Add Flag
                        </Button>
                      }
                    />
                  </div>
                </div>

                {/* Tabs */}
                <div className="border-b px-3 pt-2">
                  <Tabs value={tab} onValueChange={v => setTab(v as FlyoutTab)}>
                    <TabsList className="h-auto flex-wrap bg-transparent p-0">
                      {TABS.map(t => {
                        const dot =
                          t.value === 'assigned'
                            ? buckets.assigned
                            : t.value === 'raised'
                              ? buckets.raised
                              : t.value === 'watching'
                                ? buckets.watching
                                : t.value === 'all_open'
                                  ? buckets.allOpen
                                  : false
                        return (
                          <TabsTrigger
                            key={t.value}
                            value={t.value}
                            className="rounded-b-none border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                          >
                            {t.label}
                            {t.value === 'unread' && unreadFlags.length > 0 && (
                              <span
                                className="ml-1 rounded-full px-1.5 text-[10px] font-semibold text-white"
                                style={{
                                  backgroundColor: 'var(--flag-unread)',
                                }}
                              >
                                {unreadFlags.length}
                              </span>
                            )}
                            {t.value !== 'unread' && dot && (
                              <span
                                className="ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                                style={{
                                  backgroundColor: 'var(--flag-unread)',
                                }}
                                aria-hidden
                              />
                            )}
                          </TabsTrigger>
                        )
                      })}
                    </TabsList>
                  </Tabs>
                </div>
              </>
            )}

            {/* Filter bar — shown whenever there are flags to triage (not on
                Activity or Unread). */}
            {!isActivity && !isUnread && !isLoading && !isError && hasFlags && (
              <FlagsFilterBar
                value={filter}
                onChange={setFilter}
                showAssignee={tab !== 'assigned'}
              />
            )}

            {/* List — or the Activity feed on that tab. */}
            {isActivity ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <FlagActivityFeed />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {!isLoading && !isError && hasFlags && (
                  <div className="px-1 pb-1.5 text-[11px] text-muted-foreground">
                    {visibleFlags.length} of {total}
                    {searchPending && (
                      <span className="ml-2 italic">searching comments…</span>
                    )}
                  </div>
                )}

                {isLoading && (
                  <div className="space-y-2 p-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                )}

                {isError && (
                  <div className="p-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      Couldn’t load flags.
                    </p>
                    <button
                      type="button"
                      onClick={() => refetch()}
                      className="mt-2 text-xs font-semibold text-primary hover:underline"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {!isLoading &&
                  !isError &&
                  flags &&
                  flags.length === 0 &&
                  (scoped ? (
                    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                      <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
                      <p className="text-sm font-semibold">No flags yet</p>
                      <p className="mt-1 mb-3 text-xs text-muted-foreground">
                        No flags on {scopedLabel} yet — raise one.
                      </p>
                      {filtering ? (
                        <RaiseFlagButton
                          entityType={entityFilter.type}
                          entityId={entityFilter.id}
                        />
                      ) : (
                        <RaiseFlagButton candidates={sampleCandidates} />
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                      <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
                      <p className="text-sm font-semibold">No flags here</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tab === 'assigned'
                          ? 'Nothing is assigned to you right now.'
                          : 'This tab is empty.'}
                      </p>
                    </div>
                  ))}

                {filteredOut && (
                  <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                    <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm font-semibold">No matching flags</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      No flags match these filters — adjust them.
                    </p>
                  </div>
                )}

                {!isLoading &&
                  !isError &&
                  visibleFlags.length > 0 &&
                  (viewMode === 'table' ? (
                    <FlagTable
                      flags={visibleFlags}
                      highlightIds={highlightIds}
                      unreadIds={unreadIds}
                      searchMeta={searchMeta}
                    />
                  ) : (
                    visibleFlags.map(flag => (
                      <FlagCard
                        key={flag.id}
                        flag={flag}
                        highlight={highlightIds.has(flag.id)}
                        unread={unreadIds.has(flag.id)}
                        search={searchMeta.get(flag.id)}
                      />
                    ))
                  ))}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default FlagsFlyout
