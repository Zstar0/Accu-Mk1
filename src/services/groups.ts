/** TanStack Query hooks for user groups. Mirrors services/documents.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getWorksheetUsers } from '@/lib/api'
import {
  createGroup,
  deleteGroup,
  getGroupMembers,
  listGroups,
  listMyGroups,
  replaceGroupMembers,
  updateGroup,
  type GroupCreate,
  type GroupUpdate,
} from '@/lib/api-groups'

export const groupKeys = {
  all: ['groups'] as const,
  list: (includeInactive: boolean) =>
    ['groups', 'list', includeInactive] as const,
  mine: ['groups', 'mine'] as const,
  members: (id: number) => ['groups', 'members', id] as const,
  directory: ['groups', 'directory'] as const,
}

export function useGroups(includeInactive = false) {
  return useQuery({
    queryKey: groupKeys.list(includeInactive),
    queryFn: () => listGroups(includeInactive),
    staleTime: 60_000,
  })
}

export function useMyGroups() {
  return useQuery({
    queryKey: groupKeys.mine,
    queryFn: listMyGroups,
    staleTime: 60_000,
  })
}

/** Active users for the members picker; the same directory the worksheets UI uses. */
export function useDirectoryUsers() {
  return useQuery({
    queryKey: groupKeys.directory,
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60_000,
  })
}

export function useGroupMembers(id: number | null) {
  return useQuery({
    queryKey: groupKeys.members(id ?? -1),
    queryFn: () => getGroupMembers(id as number),
    enabled: id != null,
  })
}

function invalidateGroups(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: groupKeys.all })
}

export function useCreateGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: GroupCreate) => createGroup(data),
    onSuccess: () => {
      invalidateGroups(qc)
      toast.success('Group created')
    },
    onError: (e: Error) =>
      toast.error(
        /failed: 409/.test(e.message) ? 'That slug is taken' : e.message
      ),
  })
}

export function useUpdateGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: GroupUpdate }) =>
      updateGroup(id, data),
    onSuccess: () => {
      invalidateGroups(qc)
      toast.success('Group updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteGroup(id),
    onSuccess: () => {
      invalidateGroups(qc)
      toast.success('Group deleted')
    },
    onError: (e: Error) => {
      if (/failed: 409/.test(e.message)) {
        toast.error(
          'Group still has members or board grants; deactivate it instead'
        )
        return
      }
      toast.error(e.message)
    },
  })
}

export function useReplaceGroupMembers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, userIds }: { id: number; userIds: number[] }) =>
      replaceGroupMembers(id, userIds),
    onSuccess: (_ids, { id }) => {
      qc.invalidateQueries({ queryKey: groupKeys.members(id) })
      invalidateGroups(qc)
      toast.success('Members saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
