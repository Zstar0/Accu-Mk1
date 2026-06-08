/**
 * Display-name rule for users — mirrors backend/users_display.py.
 * "First Last" when both set; the single name when one set; email otherwise.
 */
export interface NameUser {
  first_name?: string | null
  last_name?: string | null
  email: string
}

export function displayName(u: NameUser): string {
  const first = (u.first_name ?? '').trim()
  const last = (u.last_name ?? '').trim()
  const full = [first, last].filter(Boolean).join(' ')
  return full || u.email
}

/** Local-part of an email (before '@'), for fallback when no name is known. */
export function shortEmail(email: string): string {
  if (!email) return ''
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/**
 * Resolve an email to a display name via a directory map (email → display name).
 * Falls back to the email's local-part when the email isn't in the directory
 * (deleted accounts, legacy events).
 */
export function resolveUserName(email: string, directory: Map<string, string>): string {
  if (!email) return ''
  return directory.get(email) ?? shortEmail(email)
}
