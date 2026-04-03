import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listWorksheets,
  updateWorksheet,
  removeWorksheetItem,
  completeWorksheet,
  reassignWorksheetItem,
  addGroupToWorksheet,
  reorderWorksheetItems,
  updateWorksheetItem,
} from '@/lib/api'
import type { WorksheetListItem } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { toast } from 'sonner'

export function useWorksheetDrawer() {
  const queryClient = useQueryClient()
  const activeWorksheetId = useUIStore(state => state.activeWorksheetId)

  const drawerOpen = useUIStore(state => state.worksheetDrawerOpen)

  const { data: worksheets = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['worksheets'],
    queryFn: () => listWorksheets(),
    staleTime: 0,
    refetchInterval: drawerOpen ? 30_000 : false,
  })

  const activeWorksheet: WorksheetListItem | undefined = worksheets.find(
    ws => ws.id === activeWorksheetId
  )

  const openWorksheets = worksheets.filter(ws => ws.status === 'open')
  const totalOpenItems = openWorksheets.reduce((sum, ws) => sum + ws.item_count, 0)

  const updateMutation = useMutation({
    mutationFn: ({
      worksheetId,
      data,
    }: {
      worksheetId: number
      data: { title?: string; assigned_analyst?: number; notes?: string }
    }) => updateWorksheet(worksheetId, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['worksheets'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  const removeMutation = useMutation({
    mutationFn: ({
      worksheetId,
      sampleUid,
      serviceGroupId,
    }: {
      worksheetId: number
      sampleUid: string
      serviceGroupId: number
    }) => removeWorksheetItem(worksheetId, sampleUid, serviceGroupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      toast.success('Item removed — now back in inbox')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Remove failed'),
  })

  const completeMutation = useMutation({
    mutationFn: (worksheetId: number) => completeWorksheet(worksheetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets'] })
      toast.success('Worksheet completed')
      useUIStore.getState().closeWorksheetDrawer()
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to complete worksheet'),
  })

  const reassignMutation = useMutation({
    mutationFn: ({
      worksheetId,
      sampleUid,
      serviceGroupId,
      targetWorksheetId,
    }: {
      worksheetId: number
      sampleUid: string
      serviceGroupId: number
      targetWorksheetId: number
    }) => reassignWorksheetItem(worksheetId, sampleUid, serviceGroupId, targetWorksheetId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['worksheets'] })
      const target = worksheets.find(ws => ws.id === variables.targetWorksheetId)
      toast.success(`Item moved to ${target?.title ?? 'worksheet'}`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Reassign failed'),
  })

  const updateItemMutation = useMutation({
    mutationFn: ({
      worksheetId,
      itemId,
      data,
    }: {
      worksheetId: number
      itemId: number
      data: { instrument_uid?: string }
    }) => updateWorksheetItem(worksheetId, itemId, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['worksheets'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Update item failed'),
  })

  const reorderMutation = useMutation({
    mutationFn: ({
      worksheetId,
      itemIds,
    }: {
      worksheetId: number
      itemIds: number[]
    }) => reorderWorksheetItems(worksheetId, itemIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['worksheets'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Reorder failed'),
  })

  const addItemMutation = useMutation({
    mutationFn: ({
      worksheetId,
      data,
    }: {
      worksheetId: number
      data: { sample_uid: string; sample_id: string; service_group_id: number; analyses?: { title: string; keyword?: string | null; peptide_name?: string | null; method?: string | null }[] }
    }) => addGroupToWorksheet(worksheetId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Add failed'),
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
    reorderMutation,
    addItemMutation,
  }
}
