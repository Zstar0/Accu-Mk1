/** TanStack Query hooks for the per-user Slack DM prefs. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSlackPrefs,
  putSlackPrefs,
  testSlackDm,
  type SlackDmPrefsUpdate,
} from '@/lib/slack-prefs-api'

const KEY = ['slack-prefs'] as const

export function useSlackPrefs() {
  return useQuery({ queryKey: KEY, queryFn: getSlackPrefs })
}

export function useUpdateSlackPrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SlackDmPrefsUpdate) => putSlackPrefs(body),
    onSuccess: data => qc.setQueryData(KEY, data),
  })
}

export function useTestSlackDm() {
  return useMutation({ mutationFn: testSlackDm })
}
