/**
 * Per-user Slack DM notification preferences (spec 2026-07-02).
 * Thin apiFetch wrappers over /api/slack-prefs.
 */
import { apiFetch } from './api'

export interface SlackDmPrefs {
  enabled: boolean
  slack_member_id: string | null
  /** WHO the link resolved to (Slack display name) — mapping confidence. */
  slack_display_name: string | null
  linked: boolean
  notify_assigned: boolean
  notify_mentioned: boolean
  notify_raised_activity: boolean
  notify_watching_activity: boolean
  notify_status_changes: boolean
  /** Morning digest opt-in + lab-local hour (0–23). */
  digest_enabled: boolean
  digest_hour: number
}

export type SlackDmPrefsUpdate = Partial<Omit<SlackDmPrefs, 'linked'>>

export interface SlackTestResult {
  ok: boolean
  detail: string | null
}

export const getSlackPrefs = () => apiFetch<SlackDmPrefs>('/api/slack-prefs')

export const putSlackPrefs = (body: SlackDmPrefsUpdate) =>
  apiFetch<SlackDmPrefs>('/api/slack-prefs', {
    method: 'PUT',
    body: JSON.stringify(body),
  })

export const testSlackDm = () =>
  apiFetch<SlackTestResult>('/api/slack-prefs/test', { method: 'POST' })
