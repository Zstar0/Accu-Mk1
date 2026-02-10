import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export interface AuthUser {
  id: number
  email: string
  role: string
  is_active: boolean
  created_at: string
}

interface AuthState {
  user: AuthUser | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean

  setAuth: (token: string, user: AuthUser) => void
  clearAuth: () => void
  setLoading: (loading: boolean) => void
  updateUser: (user: AuthUser) => void
}

const TOKEN_KEY = 'accu_mk1_auth_token'
const USER_KEY = 'accu_mk1_auth_user'

function loadPersistedAuth(): { token: string | null; user: AuthUser | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const userJson = localStorage.getItem(USER_KEY)
    const user = userJson ? (JSON.parse(userJson) as AuthUser) : null
    return { token, user }
  } catch {
    return { token: null, user: null }
  }
}

const persisted = loadPersistedAuth()

export const useAuthStore = create<AuthState>()(
  devtools(
    set => ({
      user: persisted.user,
      token: persisted.token,
      isAuthenticated: persisted.token !== null && persisted.user !== null,
      isLoading: true,

      setAuth: (token, user) => {
        localStorage.setItem(TOKEN_KEY, token)
        localStorage.setItem(USER_KEY, JSON.stringify(user))
        set(
          { token, user, isAuthenticated: true, isLoading: false },
          undefined,
          'setAuth'
        )
      },

      clearAuth: () => {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
        set(
          { token: null, user: null, isAuthenticated: false, isLoading: false },
          undefined,
          'clearAuth'
        )
      },

      setLoading: loading =>
        set({ isLoading: loading }, undefined, 'setLoading'),

      updateUser: user => {
        localStorage.setItem(USER_KEY, JSON.stringify(user))
        set({ user }, undefined, 'updateUser')
      },
    }),
    { name: 'auth-store' }
  )
)

export function getAuthToken(): string | null {
  return useAuthStore.getState().token
}

export function isAdmin(): boolean {
  return useAuthStore.getState().user?.role === 'admin'
}
