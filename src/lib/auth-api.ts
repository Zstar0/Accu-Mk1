/**
 * Auth API client for JWT-based authentication.
 */

import { getApiBaseUrl } from './config'
import { useAuthStore, type AuthUser } from '@/store/auth-store'
export type { AuthUser } from '@/store/auth-store'

const API_BASE_URL = () => getApiBaseUrl()

export interface LoginResponse {
  access_token: string
  token_type: string
  user: AuthUser
}

export interface UserCreateInput {
  email: string
  password: string
  role?: string
}

export interface UserUpdateInput {
  email?: string
  role?: string
  is_active?: boolean
}

export interface PasswordChangeInput {
  current_password: string
  new_password: string
}

export interface PasswordResetResponse {
  message: string
  temporary_password: string
}

function getAuthHeaders(): HeadersInit {
  const token = useAuthStore.getState().token
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

async function handleAuthError(response: Response): Promise<never> {
  if (response.status === 401) {
    useAuthStore.getState().clearAuth()
    throw new Error('Session expired. Please log in again.')
  }
  const body = await response.json().catch(() => null)
  throw new Error(body?.detail || `Request failed: ${response.status}`)
}

export async function login(
  email: string,
  password: string
): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE_URL()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail || 'Invalid credentials')
  }
  const data: LoginResponse = await response.json()
  useAuthStore.getState().setAuth(data.access_token, data.user)
  return data
}

export function logout(): void {
  useAuthStore.getState().clearAuth()
}

export async function fetchCurrentUser(): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL()}/auth/me`, {
    headers: getAuthHeaders(),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
  const user: AuthUser = await response.json()
  useAuthStore.getState().updateUser(user)
  return user
}

export async function changePassword(
  data: PasswordChangeInput
): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/auth/change-password`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
}

// --- Admin endpoints ---

export async function listUsers(): Promise<AuthUser[]> {
  const response = await fetch(`${API_BASE_URL()}/auth/users`, {
    headers: getAuthHeaders(),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
  return response.json()
}

export async function createUser(data: UserCreateInput): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL()}/auth/users`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
  return response.json()
}

export async function updateUser(
  userId: number,
  data: UserUpdateInput
): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL()}/auth/users/${userId}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    await handleAuthError(response)
  }
  return response.json()
}

export async function resetUserPassword(
  userId: number
): Promise<PasswordResetResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/auth/users/${userId}/reset-password`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
    }
  )
  if (!response.ok) {
    await handleAuthError(response)
  }
  return response.json()
}
