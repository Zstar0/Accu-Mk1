/**
 * Application configuration constants.
 */

import { getServerUrl } from './api-profiles'

/**
 * Get the base URL for the API.
 * Uses env-var default with optional admin session override.
 */
export function getApiBaseUrl(): string {
  return getServerUrl()
}
