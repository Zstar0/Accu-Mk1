import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface ClickUpUserMapping {
  clickup_user_id: string
  accumk1_user_id: string | null
  clickup_username: string
  clickup_email: string | null
  auto_matched: boolean
}

export function useUnmappedClickupUsers() {
  return useQuery({
    queryKey: ['clickup-users', 'unmapped'],
    queryFn: () =>
      apiFetch<ClickUpUserMapping[]>('/api/admin/clickup-users/unmapped'),
  })
}

export function useMapClickupUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: {
      clickupUserId: string
      accumk1UserId: string
    }) => {
      return apiFetch<{ ok: boolean }>(
        `/api/admin/clickup-users/${args.clickupUserId}/map`,
        {
          method: 'POST',
          body: JSON.stringify({ accumk1_user_id: args.accumk1UserId }),
        }
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clickup-users'] })
    },
  })
}
