/** TanStack Query hooks for planning boards. Mirrors services/groups.ts. One place handles 409. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAuthStore } from '@/store/auth-store'
import {
  boardsForEntity,
  createBoard,
  createEdge,
  createNode,
  deleteBoard,
  deleteEdge,
  deleteNode,
  getBoard,
  isStale,
  listBoards,
  patchBoard,
  patchEdge,
  patchNode,
  patchPositions,
  replaceGrants,
  type BoardCreate,
  type BoardPatch,
  type EdgeCreate,
  type EdgePatch,
  type NodeCreate,
  type NodePatch,
  type PositionItem,
} from '@/lib/api-boards'

export const boardKeys = {
  all: ['boards'] as const,
  list: ['boards', 'list'] as const,
  detail: (slug: string) => ['boards', 'detail', slug] as const,
  forEntity: (type: string, id: string) =>
    ['boards', 'for-entity', type, id] as const,
}

export function useBoards() {
  return useQuery({
    queryKey: boardKeys.list,
    queryFn: listBoards,
    staleTime: 30_000,
  })
}

/** Sidebar gate (spec §8.1): admins always, everyone else when at least one board is visible. */
export function useBoardsNavVisible(): boolean {
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const boards = useBoards()
  return isAdmin || (boards.data?.length ?? 0) > 0
}

export function useBoard(slug: string | null) {
  return useQuery({
    queryKey: boardKeys.detail(slug ?? ''),
    queryFn: () => getBoard(slug as string),
    enabled: slug != null,
    staleTime: 10_000,
  })
}

export function useBoardsForEntity(type: string | null, id: string | null) {
  return useQuery({
    queryKey: boardKeys.forEntity(type ?? '', id ?? ''),
    queryFn: () => boardsForEntity(type as string, id as string),
    enabled: type != null && id != null,
    staleTime: 30_000,
  })
}

function useBoardMutation<TArgs, TOut>(
  slug: string | null,
  fn: (args: TArgs) => Promise<TOut>,
  successMessage?: string
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (slug) qc.invalidateQueries({ queryKey: boardKeys.detail(slug) })
      qc.invalidateQueries({ queryKey: boardKeys.list })
      if (successMessage) toast.success(successMessage)
    },
    onError: (e: Error) => {
      if (isStale(e)) {
        if (slug) qc.invalidateQueries({ queryKey: boardKeys.detail(slug) })
        toast.error('Board changed elsewhere, reloaded')
        return
      }
      toast.error(e.message)
    },
  })
}

export function useCreateBoard() {
  return useBoardMutation<BoardCreate, unknown>(
    null,
    createBoard,
    'Board created'
  )
}
export function usePatchBoard(slug: string) {
  return useBoardMutation<BoardPatch, unknown>(
    slug,
    data => patchBoard(slug, data),
    'Board updated'
  )
}
export function useDeleteBoard() {
  return useBoardMutation<string, unknown>(null, deleteBoard, 'Board deleted')
}
export function useReplaceGrants(slug: string) {
  return useBoardMutation<{ group_id: number; can_edit: boolean }[], unknown>(
    slug,
    grants => replaceGrants(slug, grants),
    'Sharing updated'
  )
}
export function useCreateNode(slug: string) {
  return useBoardMutation<NodeCreate, unknown>(slug, data =>
    createNode(slug, data)
  )
}
export function usePatchNode(slug: string) {
  return useBoardMutation<{ id: number; data: NodePatch }, unknown>(
    slug,
    ({ id, data }) => patchNode(slug, id, data)
  )
}
export function usePatchPositions(slug: string) {
  return useBoardMutation<PositionItem[], unknown>(slug, items =>
    patchPositions(slug, items)
  )
}
export function useDeleteNode(slug: string) {
  return useBoardMutation<number, unknown>(slug, id => deleteNode(slug, id))
}
export function useCreateEdge(slug: string) {
  return useBoardMutation<EdgeCreate, unknown>(slug, data =>
    createEdge(slug, data)
  )
}
export function usePatchEdge(slug: string) {
  return useBoardMutation<{ id: number; data: EdgePatch }, unknown>(
    slug,
    ({ id, data }) => patchEdge(slug, id, data)
  )
}
export function useDeleteEdge(slug: string) {
  return useBoardMutation<number, unknown>(slug, id => deleteEdge(slug, id))
}
