/**
 * Application configuration constants.
 */

import { getServerUrl } from './api-profiles'

/**
 * Get the base URL for the API.
 * Uses the active profile's server URL, or falls back to localhost.
 */
export function getApiBaseUrl(): string {
  return getServerUrl()
}

/**
 * Legacy constant for backward compatibility.
 * @deprecated Use getApiBaseUrl() instead
 */
export const API_BASE_URL = 'http://127.0.0.1:8009'

