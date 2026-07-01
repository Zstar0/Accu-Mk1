import { useState } from 'react'
import { Flag, Plus, X } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useUIStore } from '@/store/ui-store'
import { useFlagsList, useEntityFlags } from '@/hooks/use-flags'
import type { FlagTab, FlagResponse } from '@/lib/flags-api'
import { FlagCard } from '@/components/flags/FlagCard'
import { FlagThread } from '@/components/flags/FlagThread'
import { FlagsFilterBar } from '@/components/flags/FlagsFilterBar'
import {
  RaiseFlagButton,
  type FlagCandidate,
} from '@/components/flags/RaiseFlagButton'
import { entityLabel } from '@/components/flags/flag-entity'
import {
  filterFlags,
  EMPTY_FLAG_FILTER,
  type FlagFilterState,
} from '@/components/flags/flag-filter'

const TABS: { value: FlagTab; label: string }[] = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'raised', label: 'Raised by me' },
  { value: 'watching', label: 'Watching' },
  { value: 'all_open', label: 'All open' },
]

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
  const [tab, setTab] = useState<FlagTab>('assigned')
  // Ephemeral triage filters, local to the flyout — reset when it closes.
  const [filter, setFilter] = useState<FlagFilterState>(EMPTY_FLAG_FILTER)

  const tabQuery = useFlagsList(tab)
  const entityQuery = useEntityFlags(entityFilter?.type, entityFilter?.id, {
    includeDescendants: entityFilter?.includeDescendants ?? false,
  })
  // Order/samples scope filters the page-wide all_open list client-side. Same
  // query key the indicators already loaded, so TanStack Query dedupes it.
  const allOpenQuery = useFlagsList('all_open')

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
  const visibleFlags = flags ? filterFlags(flags, filter) : []
  const hasFlags = total > 0
  const filteredOut = hasFlags && visibleFlags.length === 0

  return (
    <Sheet
      open={open}
      onOpenChange={isOpen => {
        if (!isOpen) {
          setFilter(EMPTY_FLAG_FILTER)
          useUIStore.getState().closeFlagsFlyout()
        }
      }}
    >
      <SheetContent
        side="right"
        className="flex w-[440px] flex-col gap-0 p-0 sm:max-w-[440px]"
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
                <div className="flex shrink-0 items-center gap-1">
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
                  <RaiseFlagButton
                    trigger={
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5"
                      >
                        <Plus className="h-3.5 w-3.5" /> Add Flag
                      </Button>
                    }
                  />
                </div>

                {/* Tabs */}
                <div className="border-b px-3 pt-2">
                  <Tabs value={tab} onValueChange={v => setTab(v as FlagTab)}>
                    <TabsList className="h-auto flex-wrap bg-transparent p-0">
                      {TABS.map(t => (
                        <TabsTrigger
                          key={t.value}
                          value={t.value}
                          className="rounded-b-none border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                        >
                          {t.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
              </>
            )}

            {/* Filter bar — shown whenever there are flags to triage. */}
            {!isLoading && !isError && hasFlags && (
              <FlagsFilterBar value={filter} onChange={setFilter} />
            )}

            {/* List */}
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {!isLoading && !isError && hasFlags && (
                <div className="px-1 pb-1.5 text-[11px] text-muted-foreground">
                  {visibleFlags.length} of {total}
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
                visibleFlags.map(flag => (
                  <FlagCard key={flag.id} flag={flag} />
                ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default FlagsFlyout
