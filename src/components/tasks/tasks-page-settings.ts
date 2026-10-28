/**
 * The Tasks page's account-saved layout: last tab, sort and column widths.
 *
 * The TanStack Query cache is the source of truth, not component state: the
 * page remounts on every visit (`navigationKey`), and a remount must show the
 * layout the user just left. `update` writes the cache at once and saves to
 * the server 500 ms after the last change. The cache key carries the user id:
 * the query client outlives a logout, and the next user must not see (or
 * save) the previous user's layout.
 */
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnSizingState, SortingState } from '@tanstack/react-table'
import { toast } from 'sonner'
import { getUiSetting, putUiSetting } from '@/lib/ui-settings-api'
import { logger } from '@/lib/logger'
import { useAuthStore } from '@/store/auth-store'
import {
  DEFAULT_TASKS_TAB,
  TASKS_TABS,
  type TasksTab,
} from '@/components/tasks/tasks-tabs'

export const TASK_COLUMN_LIMITS = {
  item: { size: 150, min: 90, max: 400 },
  type: { size: 110, min: 80, max: 300 },
  title: { size: 360, min: 160, max: 900 },
  assignee: { size: 150, min: 90, max: 400 },
  status: { size: 120, min: 90, max: 300 },
  due: { size: 100, min: 80, max: 300 },
  last_activity: { size: 140, min: 110, max: 400 },
  created: { size: 140, min: 110, max: 400 },
} satisfies Record<string, { size: number; min: number; max: number }>

export type TaskColumnId = keyof typeof TASK_COLUMN_LIMITS

export interface TasksPageSettings {
  v: 1
  tab: TasksTab
  sorting: SortingState
  columnSizing: ColumnSizingState
}

export const DEFAULT_TASKS_SETTINGS: TasksPageSettings = {
  v: 1,
  tab: DEFAULT_TASKS_TAB,
  sorting: [],
  columnSizing: {},
}

const SAVE_DELAY_MS = 500
const SAVE_FAILED = "Couldn't save your table settings"

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

// hasOwn, not `in`: a saved `constructor` id must not match Object.prototype.
function isColumnId(id: unknown): id is TaskColumnId {
  return typeof id === 'string' && Object.hasOwn(TASK_COLUMN_LIMITS, id)
}

/** A saved value never breaks the page: anything malformed becomes the default. */
export function parseTasksSettings(raw: unknown): TasksPageSettings {
  if (!isPlainObject(raw)) return DEFAULT_TASKS_SETTINGS

  const tab =
    TASKS_TABS.find(t => t.value === raw.tab)?.value ?? DEFAULT_TASKS_TAB

  const first: unknown = Array.isArray(raw.sorting) ? raw.sorting[0] : undefined
  const sorting: SortingState =
    isPlainObject(first) &&
    isColumnId(first.id) &&
    typeof first.desc === 'boolean'
      ? [{ id: first.id, desc: first.desc }]
      : []

  const columnSizing: ColumnSizingState = {}
  if (isPlainObject(raw.columnSizing)) {
    for (const [id, width] of Object.entries(raw.columnSizing)) {
      if (!isColumnId(id)) continue
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
        continue
      const { min, max } = TASK_COLUMN_LIMITS[id]
      columnSizing[id] = Math.min(max, Math.max(min, width))
    }
  }

  return { v: 1, tab, sorting, columnSizing }
}

interface PendingSave {
  timer: ReturnType<typeof setTimeout> | null
  value: TasksPageSettings | null
}

function flushSave(save: PendingSave) {
  if (save.timer) clearTimeout(save.timer)
  save.timer = null
  const value = save.value
  save.value = null
  if (!value) return
  putUiSetting('tasks.page', { ...value }).catch((error: unknown) => {
    logger.error('Failed to save Tasks page settings', { error })
    // A fixed id: repeated failures replace one toast instead of stacking.
    toast.error(SAVE_FAILED, { id: 'tasks-settings-save' })
  })
}

export function useTasksPageSettings(): {
  ready: boolean
  settings: TasksPageSettings
  update: (patch: Partial<Omit<TasksPageSettings, 'v'>>) => void
} {
  const queryClient = useQueryClient()
  const userId = useAuthStore(s => s.user?.id ?? null)
  const queryKey = ['ui-settings', userId, 'tasks.page'] as const
  const query = useQuery({
    queryKey,
    queryFn: () => getUiSetting('tasks.page'),
    staleTime: Infinity,
  })
  const save = useRef<PendingSave>({ timer: null, value: null })

  // A pending save still goes out when the user leaves the page.
  useEffect(() => {
    const pending = save.current
    return () => flushSave(pending)
  }, [])

  const update = (patch: Partial<Omit<TasksPageSettings, 'v'>>) => {
    // Merge from the cache, not render-time settings: two calls in one tick
    // (a sort and a resize) must both land.
    const current = parseTasksSettings(queryClient.getQueryData(queryKey))
    const merged = parseTasksSettings({ ...current, ...patch })
    queryClient.setQueryData(queryKey, merged)
    const pending = save.current
    pending.value = merged
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => flushSave(pending), SAVE_DELAY_MS)
  }

  return {
    // Failure means defaults, so the page is ready either way.
    ready: !query.isPending,
    settings: parseTasksSettings(query.data),
    update,
  }
}
