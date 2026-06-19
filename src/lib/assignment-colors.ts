/**
 * Official Accumark assignment-role colour scheme (the lab "SAMPLE LEGEND").
 *
 *   HPLC  → green        ENDO → orange
 *   PCR   → purple       EXTRA → light blue (sky)
 *
 * Single source of truth for every place that paints an assignment role:
 * inbox/worksheet vial cards, the Receive Wizard assign step, the Manage
 * Sub Samples overlay, the SENAITE dashboard, and the analysis-row vial
 * labels. Previously this palette was copy-pasted inline in 6+ components
 * (each flagged "dedup is a tracked fast-follow") — they now import from here.
 *
 * Role keys are the stored `assignment_role` values. `ster` is the PCR /
 * sterility bucket (legend label "PCR").
 */

// Explicit known keys so static access (`.hplc`) is `string`, while dynamic
// access (`[role]`) stays `string | undefined` under noUncheckedIndexedAccess.
interface RoleClassMap {
  hplc: string
  endo: string
  ster: string
  xtra: string
  unassigned: string
  [role: string]: string | undefined
}
type RoleChipMap = Omit<RoleClassMap, 'unassigned'> & { [role: string]: string | undefined }

/** Pill/badge classes: background + text + border, light & dark. */
export const ROLE_BADGE_CLASS: RoleClassMap = {
  hplc: 'bg-green-500/15 text-green-700 border-green-500/40 dark:text-green-300',
  endo: 'bg-orange-500/15 text-orange-700 border-orange-500/40 dark:text-orange-300',
  ster: 'bg-purple-500/15 text-purple-700 border-purple-500/40 dark:text-purple-300',
  xtra: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300',
  unassigned: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300',
}

/** Solid-tint chip for dark surfaces (e.g. the Receive Wizard drag chips):
 *  subtle background + light text, no border. */
export const ROLE_CHIP_CLASS: RoleChipMap = {
  hplc: 'bg-green-400/25 text-green-300',
  endo: 'bg-orange-400/25 text-orange-300',
  ster: 'bg-purple-400/25 text-purple-300',
  xtra: 'bg-sky-400/25 text-sky-300',
}

/** Text-only classes (titles, vial labels), light & dark. */
export const ROLE_TEXT_CLASS: RoleClassMap = {
  hplc: 'text-green-700 dark:text-green-300',
  endo: 'text-orange-700 dark:text-orange-300',
  ster: 'text-purple-700 dark:text-purple-300',
  xtra: 'text-sky-700 dark:text-sky-300',
  unassigned: 'text-amber-700 dark:text-amber-300',
}

/**
 * Resolve a role to its badge/text classes, falling back to the neutral
 * `xtra` styling for unknown roles so callers never render an empty string.
 */
export function roleBadgeClass(role?: string | null): string {
  return ROLE_BADGE_CLASS[(role ?? '').toLowerCase()] ?? ROLE_BADGE_CLASS.xtra
}

export function roleTextClass(role?: string | null): string {
  return ROLE_TEXT_CLASS[(role ?? '').toLowerCase()] ?? ROLE_TEXT_CLASS.xtra
}
