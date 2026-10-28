import { useState } from 'react'
import { HelpCircle, ListChecks, Plus } from 'lucide-react'
import type { ColumnSizingState } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FlagActivityFeed } from '@/components/flags/FlagActivityFeed'
import { FlagsFilterBar } from '@/components/flags/FlagsFilterBar'
import { RaiseFlagButton } from '@/components/flags/RaiseFlagButton'
import { useFlagFilter } from '@/components/flags/use-flag-filter'
import { TasksTable } from '@/components/tasks/TasksTable'
import { TASKS_TABS, type TasksTab } from '@/components/tasks/tasks-tabs'
import { useTaskList } from '@/components/tasks/use-task-list'
import {
  useTasksPageSettings,
  type TasksPageSettings,
} from '@/components/tasks/tasks-page-settings'

const EMPTY_COPY: Record<Exclude<TasksTab, 'activity'>, string> = {
  assigned: 'Nothing assigned to you.',
  raised: "You haven't raised any open tasks.",
  watching: "You're not watching any tasks.",
  all_open: 'No open tasks.',
  unread: "You're all caught up.",
}

const sameSizing = (a: ColumnSizingState, b: ColumnSizingState) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k])
}

/** Full-page version of the flags flyout: tabs, filters and a sortable,
 *  resizable table whose layout is saved to the user's account. */
export function TasksPage() {
  const { ready, settings, update } = useTasksPageSettings()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ListChecks className="h-5 w-5" /> Tasks
        </h1>
        <div className="flex items-center gap-1.5">
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
          <RaiseFlagButton
            trigger={
              <Button variant="outline" size="sm" className="h-7 gap-1.5">
                <Plus className="h-3.5 w-3.5" /> New task
              </Button>
            }
          />
        </div>
      </div>

      {ready ? (
        <TasksBody settings={settings} update={update} />
      ) : (
        <LoadingRows />
      )}
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <ListChecks className="mb-3 h-8 w-8 text-muted-foreground/30" />
      <p className="text-sm font-semibold">{text}</p>
    </div>
  )
}

/** Mounted once settings are loaded, so the list query starts on the saved tab. */
function TasksBody({
  settings,
  update,
}: {
  settings: TasksPageSettings
  update: ReturnType<typeof useTasksPageSettings>['update']
}) {
  const tab = settings.tab
  const isActivity = tab === 'activity'
  const isApiTab = !isActivity && tab !== 'unread'
  const [filter, setFilter] = useFlagFilter(tab, 'tasks')
  const {
    total,
    visibleFlags,
    searchMeta,
    isLoading,
    isError,
    refetch,
    searchPending,
    unreadIds,
    unreadCount,
    buckets,
  } = useTaskList(tab, filter)
  // Widths live here only during a drag; the saved settings own them otherwise.
  const [liveSizing, setLiveSizing] = useState<ColumnSizingState | null>(null)

  const dots: Partial<Record<TasksTab, boolean>> = {
    assigned: buckets.assigned,
    raised: buckets.raised,
    watching: buckets.watching,
    all_open: buckets.allOpen,
  }
  const loaded = !isLoading && !isError
  const filteredOut = total > 0 && visibleFlags.length === 0 && !searchPending

  return (
    <>
      <div className="border-b px-3 pt-2">
        <Tabs value={tab} onValueChange={v => update({ tab: v as TasksTab })}>
          <TabsList className="h-auto flex-wrap bg-transparent p-0">
            {TASKS_TABS.map(t => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="rounded-b-none border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                {t.label}
                {t.value === 'unread' && unreadCount > 0 && (
                  <span
                    className="ml-1 rounded-full px-1.5 text-[10px] font-semibold text-white"
                    style={{ backgroundColor: 'var(--flag-unread)' }}
                  >
                    {unreadCount}
                  </span>
                )}
                {dots[t.value] && (
                  <span
                    className="ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    style={{ backgroundColor: 'var(--flag-unread)' }}
                    aria-hidden
                  />
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {isApiTab && loaded && total > 0 && (
        <FlagsFilterBar
          value={filter}
          onChange={setFilter}
          showAssignee={tab !== 'assigned'}
        />
      )}

      {isActivity ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FlagActivityFeed />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loaded && total > 0 && (
            <div className="px-1 pb-1.5 text-[11px] text-muted-foreground">
              {visibleFlags.length} of {total}
              {searchPending && (
                <span className="ml-2 italic">searching comments…</span>
              )}
            </div>
          )}

          {isLoading && <LoadingRows />}

          {isError && (
            <div className="p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {"Couldn't load tasks."}
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

          {loaded && total === 0 && <EmptyState text={EMPTY_COPY[tab]} />}

          {filteredOut && <EmptyState text="No tasks match these filters." />}

          {loaded && visibleFlags.length > 0 && (
            <TasksTable
              flags={visibleFlags}
              unreadIds={unreadIds}
              searchMeta={searchMeta}
              sorting={settings.sorting}
              onSortingChange={sorting => update({ sorting })}
              columnSizing={liveSizing ?? settings.columnSizing}
              onColumnSizingChange={setLiveSizing}
              onColumnSizingCommit={sizing => {
                // A click on a handle without dragging commits unchanged widths.
                if (!sameSizing(sizing, settings.columnSizing)) {
                  update({ columnSizing: sizing })
                }
                setLiveSizing(null)
              }}
            />
          )}
        </div>
      )}
    </>
  )
}
