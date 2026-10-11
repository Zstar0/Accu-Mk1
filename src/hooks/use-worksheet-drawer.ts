import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listWorksheets,
  getWorksheet,
  updateWorksheet,
  removeWorksheetItem,
  completeWorksheet,
  reassignWorksheetItem,
  addGroupToWorksheet,
  reorderWorksheetItems,
  updateWorksheetItem,
  bulkWorksheetBenchTicks,
  applyWorksheetMethodInstrument,
  freezeWorksheetWells,
  unfreezeWorksheetWells,
  addWorksheetNote,
} from '@/lib/api'
import type {
  WorksheetListItem,
  AddToWorksheetPayload,
  WorksheetItemPatch,
  WorksheetWellFreeze,
  WorksheetUpdate,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { toast } from 'sonner'

const ITEM_UPDATE_KEY = ['worksheet-item-update'] as const

type WorksheetItemRow = WorksheetListItem['items'][number]

/** A tick moves the row's status exactly as the server does (complete once
 *  ran, in progress once made, else ready); other patches leave it alone. */
function withTickStatus(
  data: WorksheetItemPatch,
  item: WorksheetItemRow
): WorksheetItemRow {
  if (data.made === undefined && data.ran === undefined) return item
  return {
    ...item,
    prep_status: item.ran_at
      ? 'complete'
      : item.made_at
        ? 'in_progress'
        : 'ready',
  }
}

/** The worksheet page's cache entry (spec 2026-10-10 6.1). Under the
 *  'worksheets-list' prefix on purpose, like BenchRunLog's: every worksheet
 *  mutation already invalidates that prefix, so the page refreshes with the
 *  flyout. It holds GET /worksheets/{id}, the only read that carries the
 *  worksheet's endo method. */
export function worksheetPageKey(worksheetId: number) {
  return ['worksheets-list', 'page', worksheetId] as const
}

/** The cached item keys a PATCH writes: its own fields and, for a Made / Ran
 *  tick, the stamp, who stamped it and the status the tick moves. A refused
 *  PATCH rolls back only these, so another edit in flight on the same row
 *  (the 2 mL page's water, dilution and reading cells) keeps its value. */
function patchedItemKeys(data: WorksheetItemPatch): (keyof WorksheetItemRow)[] {
  return (Object.keys(data) as (keyof WorksheetItemPatch)[])
    .filter(k => data[k] !== undefined)
    .flatMap(k =>
      k === 'made'
        ? (['made_at', 'made_by_user_id', 'prep_status'] as const)
        : k === 'ran'
          ? (['ran_at', 'ran_by_user_id', 'prep_status'] as const)
          : [k]
    )
}

/** A PATCH's fields on a cached item, as the server will store them. */
export function mergeItemPatch(
  item: WorksheetItemRow,
  data: WorksheetItemPatch
): WorksheetItemRow {
  return withTickStatus(data, {
    ...item,
    ...(data.prep_status !== undefined
      ? { prep_status: data.prep_status }
      : {}),
    ...(data.instrument_uid !== undefined
      ? { instrument_uid: data.instrument_uid || null }
      : {}),
    ...(data.instrument_id !== undefined
      ? { instrument_id: data.instrument_id }
      : {}),
    ...(data.prep_weight_mg !== undefined
      ? { prep_weight_mg: data.prep_weight_mg }
      : {}),
    ...(data.prep_volume_ml !== undefined
      ? { prep_volume_ml: data.prep_volume_ml }
      : {}),
    ...(data.prep_target_mg_ml !== undefined
      ? { prep_target_mg_ml: data.prep_target_mg_ml }
      : {}),
    ...(data.made !== undefined
      ? {
          made_at: data.made
            ? (item.made_at ?? new Date().toISOString())
            : null,
        }
      : {}),
    ...(data.ran !== undefined
      ? {
          ran_at: data.ran ? (item.ran_at ?? new Date().toISOString()) : null,
        }
      : {}),
    ...(data.prep_dilution_factor !== undefined
      ? { prep_dilution_factor: data.prep_dilution_factor }
      : {}),
    // Endo worksheet v2 (spec 2026-10-10 3.7): the 2 mL prep inputs, the
    // row's own cartridge and the reading.
    ...(data.prep_form !== undefined ? { prep_form: data.prep_form } : {}),
    ...(data.prep_water_ml !== undefined
      ? { prep_water_ml: data.prep_water_ml }
      : {}),
    ...(data.prep_total_dilution !== undefined
      ? { prep_total_dilution: data.prep_total_dilution }
      : {}),
    ...(data.prep_steps !== undefined ? { prep_steps: data.prep_steps } : {}),
    ...(data.cartridge_type_id !== undefined
      ? { cartridge_type_id: data.cartridge_type_id }
      : {}),
    ...(data.result_reading !== undefined
      ? { result_reading: data.result_reading }
      : {}),
  })
}

export function useWorksheetDrawer() {
  const queryClient = useQueryClient()
  const activeWorksheetId = useUIStore(state => state.activeWorksheetId)

  const drawerOpen = useUIStore(state => state.worksheetDrawerOpen)

  const {
    data: worksheets = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    // OPEN worksheets only — same cache entry as SampleDetails' worksheet
    // chip, the inbox page, and WorksheetsListPage's default tab. Keep the
    // key literal in sync with those consumers. The unfiltered fetch served
    // the full history (1,166 worksheets / 4.2MB / 16.9s on prod 2026-08-27)
    // and was refetched after every mutation, which is why status changes
    // appeared to take a minute. Non-open worksheets (completed-tab click,
    // flag deep-link) resolve via the by-id fallback below.
    queryKey: ['worksheets-list', 'open'],
    queryFn: () => listWorksheets('open'),
    staleTime: 0,
    refetchInterval: drawerOpen ? 30_000 : false,
  })

  const openMatch: WorksheetListItem | undefined = worksheets.find(
    ws => ws.id === activeWorksheetId
  )

  // By-id fallback: the active worksheet isn't in the open list (completed,
  // or a stale deep-link). Only fires once the open list has answered, so a
  // normal open-worksheet drawer never pays the extra request.
  const { data: fallbackWorksheet, isLoading: isResolvingActive } = useQuery({
    queryKey: ['worksheet-by-id', activeWorksheetId],
    queryFn: () => getWorksheet(activeWorksheetId as number),
    enabled: activeWorksheetId != null && !isLoading && !openMatch,
    staleTime: 30_000,
  })

  const activeWorksheet: WorksheetListItem | undefined =
    openMatch ??
    (fallbackWorksheet && fallbackWorksheet.id === activeWorksheetId
      ? fallbackWorksheet
      : undefined)

  const openWorksheets = worksheets.filter(ws => ws.status === 'open')
  const totalOpenItems = openWorksheets.reduce(
    (sum, ws) => sum + ws.item_count,
    0
  )

  const updateMutation = useMutation({
    mutationFn: ({
      worksheetId,
      data,
    }: {
      worksheetId: number
      data: WorksheetUpdate
    }) => updateWorksheet(worksheetId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] }),
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  const removeMutation = useMutation({
    mutationFn: ({
      worksheetId,
      itemId,
    }: {
      worksheetId: number
      itemId: number
    }) => removeWorksheetItem(worksheetId, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      toast.success('Item removed — now back in inbox')
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Remove failed'),
  })

  const completeMutation = useMutation({
    mutationFn: (worksheetId: number) => completeWorksheet(worksheetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      toast.success('Worksheet completed')
      useUIStore.getState().closeWorksheetDrawer()
    },
    onError: err =>
      toast.error(
        err instanceof Error ? err.message : 'Failed to complete worksheet'
      ),
  })

  const reassignMutation = useMutation({
    mutationFn: ({
      worksheetId,
      itemId,
      targetWorksheetId,
    }: {
      worksheetId: number
      itemId: number
      targetWorksheetId: number
    }) => reassignWorksheetItem(worksheetId, itemId, targetWorksheetId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      const target = worksheets.find(
        ws => ws.id === variables.targetWorksheetId
      )
      toast.success(`Item moved to ${target?.title ?? 'worksheet'}`)
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Reassign failed'),
  })

  const updateItemMutation = useMutation({
    // Keyed so onSettled can tell whether it is the last tick of a burst.
    mutationKey: ITEM_UPDATE_KEY,
    mutationFn: ({
      worksheetId,
      itemId,
      data,
    }: {
      worksheetId: number
      itemId: number
      data: WorksheetItemPatch
    }) => updateWorksheetItem(worksheetId, itemId, data),
    // Optimistic: the prep-status Select (and instrument pickers) render
    // straight from this cache entry, so without this the control sits on
    // its old value until the refetch lands — the "status change takes a
    // minute" user report (2026-08-27). Rolled back on error.
    //
    // A bench sheet is keyed in after the run, so ticks arrive in bursts with
    // several PATCHes in flight against this one cache entry. Two rules keep
    // them from stomping each other: a failure rolls back ONLY its own row,
    // and only the keys it wrote (a whole-list snapshot predates its
    // neighbours and would revert rows, or cells, that succeeded), and the
    // list is refetched once, when the LAST tick
    // of the burst settles (a refetch mid-burst returns server state without
    // the ticks still in flight and wipes their checkmarks).
    onMutate: async ({ worksheetId, itemId, data }) => {
      const pageKey = worksheetPageKey(worksheetId)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['worksheets-list', 'open'] }),
        queryClient.cancelQueries({ queryKey: pageKey }),
      ])
      const previous = queryClient.getQueryData<WorksheetListItem[]>([
        'worksheets-list',
        'open',
      ])
      const page = queryClient.getQueryData<WorksheetListItem>(pageKey)
      const patched = (ws: WorksheetListItem): WorksheetListItem => ({
        ...ws,
        items: ws.items.map(it =>
          it.id !== itemId ? it : mergeItemPatch(it, data)
        ),
      })
      if (previous) {
        queryClient.setQueryData<WorksheetListItem[]>(
          ['worksheets-list', 'open'],
          previous.map(ws => (ws.id !== worksheetId ? ws : patched(ws)))
        )
      }
      // The worksheet page (endo) reads its own entry: patch it the same way.
      if (page)
        queryClient.setQueryData<WorksheetListItem>(pageKey, patched(page))
      // Each entry is rolled back from its own row: the page and the list are
      // separate reads and need not agree.
      const listRow = previous
        ?.find(ws => ws.id === worksheetId)
        ?.items.find(it => it.id === itemId)
      const pageRow = page?.items.find(it => it.id === itemId)
      return { listRow, pageRow }
    },
    onError: (err, { worksheetId, itemId, data }, context) => {
      const keys = patchedItemKeys(data)
      const restored = (
        ws: WorksheetListItem,
        before: WorksheetItemRow
      ): WorksheetListItem => ({
        ...ws,
        items: ws.items.map(it => {
          if (it.id !== itemId) return it
          const back: Partial<WorksheetItemRow> = {}
          for (const k of keys) Object.assign(back, { [k]: before[k] })
          return { ...it, ...back }
        }),
      })
      const listRow = context?.listRow
      if (listRow) {
        queryClient.setQueryData<WorksheetListItem[]>(
          ['worksheets-list', 'open'],
          list =>
            list?.map(ws =>
              ws.id !== worksheetId ? ws : restored(ws, listRow)
            )
        )
      }
      const pageRow = context?.pageRow
      if (pageRow) {
        queryClient.setQueryData<WorksheetListItem>(
          worksheetPageKey(worksheetId),
          ws => (ws ? restored(ws, pageRow) : ws)
        )
      }
      toast.error(err instanceof Error ? err.message : 'Update item failed')
    },
    onSettled: () => {
      // This mutation still counts as in flight here, so 1 means it is the last.
      if (queryClient.isMutating({ mutationKey: ITEM_UPDATE_KEY }) > 1) return
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      // A worksheet resolved by id (not in the open list) reads from here.
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
  })

  // Made / MCS down a whole run in one request: the sheet is worked on paper
  // and keyed in afterwards.
  const bulkTicksMutation = useMutation({
    mutationFn: ({
      worksheetId,
      data,
    }: {
      worksheetId: number
      data: { made?: boolean; ran?: boolean }
    }) => bulkWorksheetBenchTicks(worksheetId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] }),
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Tick all failed'),
  })

  // PCR plate map: the wells are pinned the moment the sheet leaves for the
  // bench (print or QuantStudio export). Unfreezing is a deliberate re-layout.
  const freezeWellsMutation = useMutation({
    mutationFn: ({
      worksheetId,
      wells,
    }: {
      worksheetId: number
      wells: WorksheetWellFreeze[]
    }) => freezeWorksheetWells(worksheetId, wells),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Freeze wells failed'),
  })

  const unfreezeWellsMutation = useMutation({
    mutationFn: (worksheetId: number) => unfreezeWorksheetWells(worksheetId),
    onSuccess: res => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
      toast.success(
        `Released ${res.cleared} well${res.cleared === 1 ? '' : 's'}`
      )
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Unfreeze wells failed'),
  })

  // Notes are an append-only log stamped by the server. No toast on error:
  // the note box keeps the typed text and says why beside it.
  const addNoteMutation = useMutation({
    mutationFn: ({ worksheetId, body }: { worksheetId: number; body: string }) =>
      addWorksheetNote(worksheetId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
  })

  const applyMethodInstrumentMutation = useMutation({
    mutationFn: ({
      worksheetId,
      data,
    }: {
      worksheetId: number
      data: { method_id: number; instrument_id: number; item_ids?: number[] }
    }) => applyWorksheetMethodInstrument(worksheetId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] }),
    onError: err =>
      toast.error(
        err instanceof Error ? err.message : 'Apply method/instrument failed'
      ),
  })

  const reorderMutation = useMutation({
    mutationFn: ({
      worksheetId,
      itemIds,
    }: {
      worksheetId: number
      itemIds: number[]
    }) => reorderWorksheetItems(worksheetId, itemIds),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] }),
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Reorder failed'),
  })

  const addItemMutation = useMutation({
    mutationFn: ({
      worksheetId,
      data,
    }: {
      worksheetId: number
      data: AddToWorksheetPayload
    }) => addGroupToWorksheet(worksheetId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Add failed'),
  })

  return {
    worksheets,
    openWorksheets,
    activeWorksheet,
    isResolvingActive,
    totalOpenItems,
    isLoading,
    isError,
    refetch,
    updateMutation,
    removeMutation,
    completeMutation,
    reassignMutation,
    updateItemMutation,
    bulkTicksMutation,
    freezeWellsMutation,
    unfreezeWellsMutation,
    addNoteMutation,
    applyMethodInstrumentMutation,
    reorderMutation,
    addItemMutation,
  }
}
