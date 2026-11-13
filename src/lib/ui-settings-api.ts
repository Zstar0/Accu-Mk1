/**
 * Per-user UI settings (`/api/ui-settings/{key}`). The server allowlists the
 * keys; widen `UiSettingKey` when the backend allowlist grows.
 */

import { apiFetch } from './api'

export type UiSettingKey = 'tasks.page'

interface UiSettingResponse {
  key: string
  value: Record<string, unknown> | null
}

/** The saved value, or null when the user never saved this key. */
export async function getUiSetting(
  key: UiSettingKey
): Promise<Record<string, unknown> | null> {
  const res = await apiFetch<UiSettingResponse>(`/api/ui-settings/${key}`)
  return res.value
}

export async function putUiSetting(
  key: UiSettingKey,
  value: Record<string, unknown>
): Promise<void> {
  await apiFetch<UiSettingResponse>(`/api/ui-settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}
