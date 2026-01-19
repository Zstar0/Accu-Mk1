/**
 * API Key management for desktop app authentication.
 * Stores the API key in localStorage and provides utilities for managing it.
 */

const API_KEY_STORAGE_KEY = 'accu_mk1_api_key'

/**
 * Custom event name for API key changes.
 * Listen for this event to react to API key updates.
 */
export const API_KEY_CHANGED_EVENT = 'accu-mk1-api-key-changed'

/**
 * Get the stored API key.
 */
export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(API_KEY_STORAGE_KEY)
}

/**
 * Save the API key to storage.
 * Dispatches a custom event to notify listeners of the change.
 */
export function setApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(API_KEY_STORAGE_KEY, apiKey)
  // Dispatch event to notify listeners
  window.dispatchEvent(new CustomEvent(API_KEY_CHANGED_EVENT, { detail: { hasKey: true } }))
}

/**
 * Clear the stored API key.
 * Dispatches a custom event to notify listeners of the change.
 */
export function clearApiKey(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(API_KEY_STORAGE_KEY)
  // Dispatch event to notify listeners
  window.dispatchEvent(new CustomEvent(API_KEY_CHANGED_EVENT, { detail: { hasKey: false } }))
}

/**
 * Check if an API key is configured.
 */
export function hasApiKey(): boolean {
  const key = getApiKey()
  return key !== null && key.length > 0
}

/**
 * Validate API key format (basic check).
 * Expected format: ak_xxxxx... (starts with ak_)
 */
export function isValidApiKeyFormat(apiKey: string): boolean {
  return apiKey.startsWith('ak_') && apiKey.length >= 10
}

