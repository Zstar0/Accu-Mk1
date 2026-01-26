/**
 * API Profile management for desktop app.
 * Stores multiple server URL + API key combinations in localStorage.
 */

const STORAGE_KEY = 'accu_mk1_api_profiles'
const OLD_API_KEY_STORAGE_KEY = 'accu_mk1_api_key'

/**
 * API Profile - a saved server + key combination.
 */
export interface ApiProfile {
  id: string
  name: string
  serverUrl: string
  apiKey: string
  wordpressUrl: string
}

/**
 * Storage state for API profiles.
 */
interface ApiProfilesState {
  profiles: ApiProfile[]
  activeProfileId: string | null
}

/**
 * Default profiles to start with.
 */
const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: 'local',
    name: 'Local Development',
    serverUrl: 'http://127.0.0.1:8009',
    apiKey: '',
    wordpressUrl: 'https://accumarklabs.local',
  },
  {
    id: 'production',
    name: 'Production',
    serverUrl: 'https://api.accumarklabs.com',
    apiKey: '',
    wordpressUrl: 'https://accumarklabs.com',
  },
]

/**
 * Custom event name for profile changes.
 */
export const API_PROFILE_CHANGED_EVENT = 'accu-mk1-api-profile-changed'

/**
 * Get the stored profiles state.
 */
function getState(): ApiProfilesState {
  if (typeof window === 'undefined') {
    return { profiles: DEFAULT_PROFILES, activeProfileId: 'local' }
  }
  
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) {
    // Check for migration from old API key
    const oldKey = localStorage.getItem(OLD_API_KEY_STORAGE_KEY)
    if (oldKey) {
      // Create migrated profile
      const migratedProfile: ApiProfile = {
        id: 'migrated',
        name: 'Migrated',
        serverUrl: 'http://127.0.0.1:8009',
        apiKey: oldKey,
        wordpressUrl: 'https://accumarklabs.local',
      }
      const state: ApiProfilesState = {
        profiles: [migratedProfile, ...DEFAULT_PROFILES],
        activeProfileId: 'migrated',
      }
      saveState(state)
      localStorage.removeItem(OLD_API_KEY_STORAGE_KEY)
      return state
    }
    
    // Return defaults with local as active
    return { profiles: DEFAULT_PROFILES, activeProfileId: 'local' }
  }
  
  try {
    return JSON.parse(stored) as ApiProfilesState
  } catch {
    return { profiles: DEFAULT_PROFILES, activeProfileId: 'local' }
  }
}

/**
 * Save the profiles state.
 */
function saveState(state: ApiProfilesState): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  window.dispatchEvent(new CustomEvent(API_PROFILE_CHANGED_EVENT, { 
    detail: { activeProfileId: state.activeProfileId } 
  }))
}

/**
 * Get all saved profiles.
 */
export function getProfiles(): ApiProfile[] {
  return getState().profiles
}

/**
 * Get the currently active profile.
 */
export function getActiveProfile(): ApiProfile | null {
  const state = getState()
  if (!state.activeProfileId) return null
  return state.profiles.find(p => p.id === state.activeProfileId) ?? null
}

/**
 * Get the active profile ID.
 */
export function getActiveProfileId(): string | null {
  return getState().activeProfileId
}

/**
 * Set the active profile by ID.
 */
export function setActiveProfileId(profileId: string): void {
  const state = getState()
  const profile = state.profiles.find(p => p.id === profileId)
  if (!profile) return
  
  state.activeProfileId = profileId
  saveState(state)
}

/**
 * Add a new profile.
 */
export function addProfile(profile: Omit<ApiProfile, 'id'>): ApiProfile {
  const state = getState()
  const newProfile: ApiProfile = {
    ...profile,
    id: `profile_${Date.now()}`,
  }
  state.profiles.push(newProfile)
  saveState(state)
  return newProfile
}

/**
 * Update an existing profile.
 */
export function updateProfile(profileId: string, updates: Partial<Omit<ApiProfile, 'id'>>): void {
  const state = getState()
  const index = state.profiles.findIndex(p => p.id === profileId)
  if (index === -1) return
  
  const existingProfile = state.profiles[index]
  if (!existingProfile) return
  
  state.profiles[index] = {
    id: existingProfile.id,
    name: updates.name ?? existingProfile.name,
    serverUrl: updates.serverUrl ?? existingProfile.serverUrl,
    apiKey: updates.apiKey ?? existingProfile.apiKey,
    wordpressUrl: updates.wordpressUrl ?? existingProfile.wordpressUrl,
  }
  saveState(state)
}

/**
 * Delete a profile.
 */
export function deleteProfile(profileId: string): void {
  const state = getState()
  state.profiles = state.profiles.filter(p => p.id !== profileId)
  
  // If we deleted the active profile, switch to first available
  if (state.activeProfileId === profileId) {
    state.activeProfileId = state.profiles[0]?.id ?? null
  }
  
  saveState(state)
}

/**
 * Check if an API key is configured for the active profile.
 */
export function hasApiKey(): boolean {
  const profile = getActiveProfile()
  return profile !== null && profile.apiKey.length > 0
}

/**
 * Get the API key from the active profile.
 */
export function getApiKey(): string | null {
  const profile = getActiveProfile()
  return profile?.apiKey ?? null
}

/**
 * Get the server URL from the active profile.
 */
export function getServerUrl(): string {
  const profile = getActiveProfile()
  return profile?.serverUrl ?? 'http://127.0.0.1:8009'
}
