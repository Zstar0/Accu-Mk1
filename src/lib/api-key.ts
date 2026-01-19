/**
 * API Key management for desktop app authentication.
 * Stores the API key in localStorage and provides utilities for managing it.
 */

const API_KEY_STORAGE_KEY = 'accu_mk1_api_key'

/**
 * Get the stored API key.
 */
export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(API_KEY_STORAGE_KEY)
}

/**
 * Save the API key to storage.
 */
export function setApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(API_KEY_STORAGE_KEY, apiKey)
}

/**
 * Clear the stored API key.
 */
export function clearApiKey(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(API_KEY_STORAGE_KEY)
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
