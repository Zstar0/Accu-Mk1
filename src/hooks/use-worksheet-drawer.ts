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
  applyWorksheetMethodInstrument,
} from '@/lib/api'
import type { WorksheetListItem, AddToWorksheetPayload } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { toast } from 'sonner'

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
  const { data: fallbackWorksheet } = useQuery({
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
      data: { title?: string; assigned_analyst?: number; notes?: string }
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
    mutationFn: ({
      worksheetId,
      itemId,
      data,
    }: {
      worksheetId: number
      itemId: number
      data: {
        instrument_uid?: string
        prep_status?: string
        instrument_id?: number | null
      }
    }) => updateWorksheetItem(worksheetId, itemId, data),
    // Optimistic: the prep-status Select (and instrument pickers) render
    // straight from this cache entry, so without this the control sits on
    // its old value until the refetch lands — the "status change takes a
    // minute" user report (2026-08-27). Rolled back on error.
    onMutate: async ({ worksheetId, itemId, data }) => {
      await queryClient.cancelQueries({ queryKey: ['worksheets-list', 'open'] })
      const previous = queryClient.getQueryData<WorksheetListItem[]>([
        'worksheets-list',
        'open',
      ])
      if (previous) {
        queryClient.setQueryData<WorksheetListItem[]>(
          ['worksheets-list', 'open'],
          previous.map(ws =>
            ws.id !== worksheetId
              ? ws
              : {
                  ...ws,
                  items: ws.items.map(it =>
                    it.id !== itemId
                      ? it
                      : {
                          ...it,
                          ...(data.prep_status !== undefined
                            ? { prep_status: data.prep_status }
                            : {}),
                          ...(data.instrument_uid !== undefined
                            ? { instrument_uid: data.instrument_uid || null }
                            : {}),
                          ...(data.instrument_id !== undefined
                            ? { instrument_id: data.instrument_id }
                            : {}),
                        }
                  ),
                }
          )
        )
      }
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['worksheets-list', 'open'], context.previous)
      }
      toast.error(err instanceof Error ? err.message : 'Update item failed')
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] }),
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
    totalOpenItems,
    isLoading,
    isError,
    refetch,
    updateMutation,
    removeMutation,
    completeMutation,
    reassignMutation,
    updateItemMutation,
    applyMethodInstrumentMutation,
    reorderMutation,
    addItemMutation,
  }
}
