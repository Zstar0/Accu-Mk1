import type { VialRoleRow, Department } from '@/lib/api'

/**
 * S1 roles-as-data: the closed color-name vocabulary for vial-role display.
 * Names — not class strings — live in the DB (vial_roles.color,
 * departments.color); every class string here is a static literal so
 * Tailwind v4 sees them at build time. Superset of the department palette
 * (service-group-colors.ts) plus the legacy role tints.
 */
export const ROLE_COLOR_NAMES = [
  'green',
  'orange',
  'purple',
  'sky',
  'slate',
  'amber',
  'blue',
  'emerald',
  'red',
  'violet',
  'zinc',
  'rose',
] as const
export type RoleColorName = (typeof ROLE_COLOR_NAMES)[number]

const isRoleColorName = (v: string | null | undefined): v is RoleColorName =>
  !!v && (ROLE_COLOR_NAMES as readonly string[]).includes(v)

/** Pill/badge classes: background + text + border, light & dark. */
export const ROLE_COLOR_BADGE: Record<RoleColorName, string> = {
  green:
    'bg-green-500/15 text-green-700 border-green-500/40 dark:text-green-300',
  orange:
    'bg-orange-500/15 text-orange-700 border-orange-500/40 dark:text-orange-300',
  purple:
    'bg-purple-500/15 text-purple-700 border-purple-500/40 dark:text-purple-300',
  sky: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300',
  slate:
    'bg-slate-500/15 text-slate-700 border-slate-500/40 dark:text-slate-300',
  amber:
    'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300',
  blue: 'bg-blue-500/15 text-blue-700 border-blue-500/40 dark:text-blue-300',
  emerald:
    'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300',
  red: 'bg-red-500/15 text-red-700 border-red-500/40 dark:text-red-300',
  violet:
    'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300',
  zinc: 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300',
  rose: 'bg-rose-500/15 text-rose-700 border-rose-500/40 dark:text-rose-300',
}

/** Solid-tint chip for dark surfaces (Receive Wizard drag chips). */
export const ROLE_COLOR_CHIP: Record<RoleColorName, string> = {
  green: 'bg-green-400/25 text-green-300',
  orange: 'bg-orange-400/25 text-orange-300',
  purple: 'bg-purple-400/25 text-purple-300',
  sky: 'bg-sky-400/25 text-sky-300',
  slate: 'bg-slate-400/25 text-slate-300',
  amber: 'bg-amber-400/25 text-amber-300',
  blue: 'bg-blue-400/25 text-blue-300',
  emerald: 'bg-emerald-400/25 text-emerald-300',
  red: 'bg-red-400/25 text-red-300',
  violet: 'bg-violet-400/25 text-violet-300',
  zinc: 'bg-zinc-400/25 text-zinc-300',
  rose: 'bg-rose-400/25 text-rose-300',
}

/** Text-only classes (titles, vial labels), light & dark. */
export const ROLE_COLOR_TEXT: Record<RoleColorName, string> = {
  green: 'text-green-700 dark:text-green-300',
  orange: 'text-orange-700 dark:text-orange-300',
  purple: 'text-purple-700 dark:text-purple-300',
  sky: 'text-sky-700 dark:text-sky-300',
  slate: 'text-slate-700 dark:text-slate-300',
  amber: 'text-amber-700 dark:text-amber-300',
  blue: 'text-blue-700 dark:text-blue-300',
  emerald: 'text-emerald-700 dark:text-emerald-300',
  red: 'text-red-700 dark:text-red-300',
  violet: 'text-violet-700 dark:text-violet-300',
  zinc: 'text-zinc-700 dark:text-zinc-300',
  rose: 'text-rose-700 dark:text-rose-300',
}

const findRole = (code: string, roles?: VialRoleRow[]) =>
  roles?.find(r => r.code === code)

/** color → department color → neutral zinc (S1 fallback chain). */
export function resolveRoleColor(
  role: VialRoleRow | undefined,
  departments?: Department[]
): RoleColorName {
  if (isRoleColorName(role?.color)) return role.color
  const dept =
    role?.department_id != null
      ? departments?.find(d => d.id === role.department_id)
      : undefined
  if (isRoleColorName(dept?.color)) return dept.color
  return 'zinc'
}

/** Catalog short form, falling back to the uppercased code so a novel
 *  role never renders blank (the AssignStep/BoxStep idiom, now shared). */
export function roleShortLabel(code: string, roles?: VialRoleRow[]): string {
  return findRole(code, roles)?.short_label || code.toUpperCase()
}

export function roleFullLabel(code: string, roles?: VialRoleRow[]): string {
  return findRole(code, roles)?.label || code.toUpperCase()
}

/** Single glyph (SenaiteDashboard convention — MUST stay one char or
 *  adjacent-span surfaces read doubled, the "HM HM" fix). */
export function roleGlyph(code: string, roles?: VialRoleRow[]): string {
  const row = findRole(code, roles)
  return (row?.badge_glyph || roleShortLabel(code, roles).charAt(0)).charAt(0)
}

export function roleColorForCode(
  code: string | null | undefined,
  roles?: VialRoleRow[],
  departments?: Department[]
): RoleColorName {
  if (!code) return 'amber'
  return resolveRoleColor(findRole(code, roles), departments)
}
