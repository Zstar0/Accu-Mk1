import { useState } from 'react'
import { Flag } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useUIStore } from '@/store/ui-store'
import { useFlagsList } from '@/hooks/use-flags'
import type { FlagTab } from '@/lib/flags-api'
import { FlagCard } from '@/components/flags/FlagCard'
import { FlagThread } from '@/components/flags/FlagThread'
import { RaiseFlagButton } from '@/components/flags/RaiseFlagButton'

const TABS: { value: FlagTab; label: string }[] = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'raised', label: 'Raised by me' },
  { value: 'watching', label: 'Watching' },
  { value: 'all_open', label: 'All open' },
]

/**
 * Full-height right slide-over for the Flag System — mirrors WorksheetDrawer
 * (uses ui/sheet). Four triage tabs of flag cards; when a thread is selected it
 * swaps the list for the full FlagThread view. Visual target: flyout-form.html.
 */
export function FlagsFlyout() {
  const open = useUIStore(state => state.flagsFlyoutOpen)
  const threadId = useUIStore(state => state.flagsThreadId)
  const [tab, setTab] = useState<FlagTab>('assigned')

  const { data: flags, isLoading, isError, refetch } = useFlagsList(tab)
  const activeTabLabel = TABS.find(t => t.value === tab)?.label ?? 'Flags'

  return (
    <Sheet
      open={open}
      onOpenChange={isOpen => {
        if (!isOpen) useUIStore.getState().closeFlagsFlyout()
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
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Flag className="h-4 w-4" /> Flags
              </h2>
              <RaiseFlagButton variant="compact" />
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

            {/* List */}
            <div className="min-h-0 flex-1 overflow-auto p-2">
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

              {!isLoading && !isError && flags && flags.length === 0 && (
                <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                  <Flag className="mb-3 h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm font-semibold">No flags here</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tab === 'assigned'
                      ? 'Nothing is assigned to you right now.'
                      : 'This tab is empty.'}
                  </p>
                </div>
              )}

              {!isLoading &&
                !isError &&
                flags?.map(flag => <FlagCard key={flag.id} flag={flag} />)}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default FlagsFlyout
