import { useState, useEffect, useRef, Fragment, type ReactNode } from 'react'
import { Activity, ArrowDownUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Database, HelpCircle, Layers, Lock, MoreHorizontal, Pencil, Wrench, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { SenaiteAnalysis, InboxPriority, ParentPromotionInfo } from '@/lib/api'
import { setAnalysisMethodInstrument, promoteAnalyses, getMethods } from '@/lib/api'
import { SetMethodInstrumentDialog } from '@/components/senaite/SetMethodInstrumentDialog'
import type { VialAssignment } from '@/lib/vial-assignment'
import { ROLE_COLOR_TEXT, roleColorForCode } from '@/lib/role-display'
import { useVialRoles, type VialRoleRow } from '@/services/vial-roles'
import { useDepartments, type Department } from '@/services/departments'
import { PromotedFromBadge } from '@/components/senaite/PromotedFromBadge'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import { AnalysisSlaCell } from '@/components/senaite/AnalysisSlaCell'
import { formatNumericResult } from '@/components/senaite/senaite-utils'
import { useAnalysisEditing, type UseAnalysisEditingReturn } from '@/hooks/use-analysis-editing'
import { useAnalysisTransition, type UseAnalysisTransitionReturn } from '@/hooks/use-analysis-transition'
import { useBulkAnalysisTransition } from '@/hooks/use-bulk-analysis-transition'
import { useSidebar } from '@/components/ui/sidebar'
import { useUIStore } from '@/store/ui-store'

// --- Status styling constants ---

export const STATUS_COLORS: Record<string, string> = {
  verified:
    'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/20',
  promoted:
    'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
  published:
    'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/20',
  to_be_verified:
    'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/15 dark:text-orange-400 dark:border-orange-500/20',
  // Native parent-verification (Task 9): parent-tier row awaiting Verify on
  // the Accu-Mk1 Analyses card. Same "awaiting sign-off" meaning and styling
  // as to_be_verified, kept as a distinct review_state on the backend.
  parent_to_verify:
    'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/15 dark:text-orange-400 dark:border-orange-500/20',
  sample_received:
    'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/20',
  sample_due:
    'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/20',
  sample_registered:
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20',
  unassigned:
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20',
  assigned:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
  retracted:
    'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-500 dark:border-zinc-500/20',
  rejected:
    'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
  registered:
    'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-400 dark:border-sky-500/20',
  waiting_for_addon_results:
    'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-400 dark:border-indigo-500/20',
  ready_for_review:
    'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/20',
  // Matches `promoted` (teal) — both are terminal "done" states; sharing the
  // colour keeps the table from reading as two different outcomes.
  variance_verified:
    'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
}

export const STATUS_LABELS: Record<string, string> = {
  verified: 'Verified',
  promoted: 'Promoted',
  published: 'Published',
  to_be_verified: 'To Verify',
  parent_to_verify: 'To Verify',
  sample_received: 'Received',
  sample_due: 'Due',
  sample_registered: 'Registered',
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  retracted: 'Retracted',
  rejected: 'Rejected',
  registered: 'Registered',
  waiting_for_addon_results: 'Waiting Addon',
  ready_for_review: 'Ready for Review',
  variance_verified: 'Verified — Variance',
}

/**
 * Title-text color when an analysis matches the viewing sample's vial-assignment
 * role (i.e. is in the primaryAnalysisUids set). Same palette family as the
 * role badges elsewhere in the app — keeps the visual language consistent.
 * S1 roles-as-data: resolved from the vial_roles catalog, not a hardcoded map.
 */
function primaryTitleColorClass(
  role: string,
  roles: VialRoleRow[] | undefined,
  departments: Department[] | undefined
): string {
  return ROLE_COLOR_TEXT[roleColorForCode(role, roles, departments)]
}

/** Row-level tint: colored left border + subtle background, inspired by SENAITE. */
const ROW_STATUS_STYLE: Record<string, string> = {
  verified:
    'border-l-2 border-l-blue-500 bg-blue-50/60 dark:bg-blue-500/[0.06]',
  promoted:
    'border-l-2 border-l-teal-500 bg-teal-50/60 dark:bg-teal-500/[0.06]',
  published:
    'border-l-2 border-l-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/[0.06]',
  to_be_verified:
    'border-l-2 border-l-cyan-400 bg-cyan-50/60 dark:bg-cyan-400/[0.06]',
  unassigned:
    'border-l-2 border-l-zinc-300 dark:border-l-zinc-600',
  assigned:
    'border-l-2 border-l-zinc-300 dark:border-l-zinc-600',
  retracted:
    'border-l-2 border-l-orange-400 bg-zinc-100/60 dark:bg-zinc-500/[0.06] italic text-muted-foreground',
  rejected:
    'border-l-2 border-l-zinc-400 bg-zinc-100/60 dark:bg-zinc-500/[0.06]',
  invalid:
    'border-l-2 border-l-orange-600 bg-orange-50/60 dark:bg-orange-500/[0.06]',
  cancelled:
    'border-l-2 border-l-zinc-900 bg-zinc-100/60 dark:border-l-zinc-400 dark:bg-zinc-500/[0.06]',
}

/** States where an analysis result cell is editable. */
const EDITABLE_STATES = new Set<string | null>(['unassigned', 'assigned', null])

// Mk1 vial-tier rows stay editable through to_be_verified: a result that's
// been entered but not yet promoted or variance-verified can still be
// corrected in place (the backend allows a submit self-edit). SENAITE-backed
// rows keep the stricter set — SENAITE locks a submitted result until it's
// retracted. Promoted / variance_verified / verified / terminal stay locked.
const MK1_EDITABLE_STATES = new Set<string | null>([
  'unassigned', 'assigned', 'to_be_verified', null,
])

export function isResultEditable(a: { uid?: string | null; review_state: string | null }): boolean {
  if (!a.uid) return false
  return a.uid.startsWith('mk1:')
    ? MK1_EDITABLE_STATES.has(a.review_state)
    : EDITABLE_STATES.has(a.review_state)
}

// Task 7 (methods bench-stamping): client-side mirror of the backend's
// STAMPABLE_STATES (backend/lims_analyses/service.py) — the exact set of
// review_states where PATCH .../method-instrument succeeds instead of
// 409ing with state_locked. Deliberately narrower than MK1_EDITABLE_STATES
// above (which also allows a null review_state for result-cell editing;
// the backend guard does not) — gates the SetMethodInstrumentDialog's
// Wrench row action.
const STAMPABLE_STATES = new Set<string | null>(['unassigned', 'assigned', 'to_be_verified'])

/** True when a native (mk1:) row is in a state where the method/instrument
 *  PATCH endpoint will accept a stamp instead of 409ing. */
function canSetMethodInstrument(a: { uid?: string | null; review_state: string | null }): boolean {
  return !!a.uid && a.uid.startsWith('mk1:') && STAMPABLE_STATES.has(a.review_state)
}

/** Parses an mk1 int-as-string method/instrument uid, guarding against a
 *  non-numeric value (defeats the dialog's default-preselection fallback
 *  rather than shipping a NaN through to the PATCH body). */
function toIntOrNull(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/** Maps review_state to valid transition action names. */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  unassigned: ['submit', 'reject'],
  assigned: ['submit', 'reject'],
  to_be_verified: ['retest', 'verify', 'retract', 'reject'],
  // A promoted sub-sample row is locked from the sub side: its result is already
  // rolled up to the parent. Corrections must start at the PARENT (retest there
  // cascades back down to the vial). Retesting from the sub while the parent line
  // is still verified dead-ends on the SENAITE write-back ("Not allowed to set
  // 'Remarks'", HTTP 401). The parent→sub cascade still retests promoted sources
  // server-side (cascade_parent_retest_to_sources) — that path is unaffected;
  // only the user-facing row/bulk option is removed.
  promoted: [],
  // Native parent second sign-off surfaced by the read-flip main table
  // (registry source, seam fix 2026-08-20): the canonical parent row
  // awaiting Verify. Verify routes through the generic mk1 transition
  // endpoint (the same call the Accu-Mk1 card's parent-native policy
  // makes); the backend tees SENAITE-origin services' sign-off to the AR
  // line, fail-closed. Retest is deliberately absent here — the generic
  // endpoint tier-blocks parent retest; that verb lives on the card, which
  // owns the destructive confirm + cascade.
  parent_to_verify: ['verify'],
  // Retest-aware promote: a verified row can be retested (vial tier in Mk1;
  // SENAITE allows it on parent lines too).
  verified: ['retest'],
  // A variance replicate signed off by a tech. Retest is safe — these rows
  // never touched the parent, so there is no SENAITE lock to collide with
  // (unlike `promoted`).
  variance_verified: ['retest'],
}

const TRANSITION_LABELS: Record<string, string> = {
  submit: 'Submit',
  retest: 'Retest',
  verify: 'Verify',
  retract: 'Retract',
  reject: 'Reject',
  variance_verify: 'Verify (Variance)',
}

/** Test-only re-export — keeps the table private to this module otherwise. */
export const ALLOWED_TRANSITIONS_TEST_EXPORT = ALLOWED_TRANSITIONS

const DESTRUCTIVE_TRANSITIONS = new Set(['retract', 'reject'])

// --- Bulk-overlay redesign: promote-aware gating helpers (exported for tests) ---

/** Native (mk1:) row awaiting vial-tier sign-off — the kind-agnostic base
 *  shared by isPromotable and visibleRowTransitions (verify stays hidden on
 *  ALL native awaiting rows; the variance path uses Verify (Variance)). */
function isNativeAwaitingSignoff(a: SenaiteAnalysis): boolean {
  return (
    !!a.uid &&
    a.uid.startsWith('mk1:') &&
    a.review_state === 'to_be_verified' &&
    a.promoted_to_parent_id == null
  )
}

/** Phase-4b promotable discriminator, lifted so row + bulk logic share it.
 *  Kind-aware: a vial assigned to a variance bucket is never promotable —
 *  its sign-off path is variance_verify (re-assign to core to promote). */
export function isPromotable(a: SenaiteAnalysis, vialKind?: string | null): boolean {
  if (vialKind === 'variance') return false
  return isNativeAwaitingSignoff(a)
}

/** Task 10: the "promoted, native, mk1-origin" seam — additive alongside
 *  ALLOWED_TRANSITIONS (not baked into it), so a row's default-policy
 *  behavior is byte-identical on every page that doesn't opt in via the
 *  onPromotedNativeRetest prop. A promoted, mk1: vial-tier row whose
 *  backing service is ITSELF mk1-origin (no SENAITE AR line exists for it)
 *  can retest directly from the vial — the up-cascade mirror of the
 *  parent-native card's onParentRetest. That retest un-verifies the
 *  parent-tier promotion, so the caller routes it through a dedicated
 *  warning confirm (PromotedSourceRetestDialog) rather than the generic
 *  transition endpoint. `retested` excludes a row that's already been
 *  retested once — apply_transition's retest branch never flips
 *  review_state off 'promoted', so without this a retested row would keep
 *  offering an action the backend's own idempotency guard 409s on (source
 *  retest is not repeatable from the same row; see vial_source_retest's
 *  guard 3 in backend/lims_analyses/service.py). */
export function isPromotedSourceRetestEligible(a: SenaiteAnalysis): boolean {
  return (
    a.review_state === 'promoted' &&
    !!a.uid?.startsWith('mk1:') &&
    a.service_origin === 'mk1' &&
    !a.retested
  )
}

/** Task 10 fix round 1: which "How to correct a promoted result" tooltip
 *  copy a row shows, and whether it renders at all. Pulled out of the JSX
 *  ternary into a pure function so the 3-way branch is directly testable —
 *  Radix Tooltip's content only mounts on open (hover/focus), and this
 *  repo has no established, reliable pattern for driving that under jsdom.
 *  'retracted-parent': seam active, row not currently linked to a live
 *  parent (isPromoted false) — can ONLY mean this row's own promotion
 *  parent was retracted/rejected (a row reaches 'promoted' review_state
 *  only by having been promoted once). 'seam-active': seam active AND
 *  currently linked (normal case). 'default': isPromoted, seam inactive —
 *  the pre-Task-10 copy, byte-identical. null: neither — no tooltip. */
export type PromotedRowTooltipCopy = 'retracted-parent' | 'seam-active' | 'default'

export function promotedRowTooltipCopy(
  isPromoted: boolean,
  promotedSourceRetestSeam: boolean
): PromotedRowTooltipCopy | null {
  if (!isPromoted && !promotedSourceRetestSeam) return null
  if (!isPromoted && promotedSourceRetestSeam) return 'retracted-parent'
  if (promotedSourceRetestSeam) return 'seam-active'
  return 'default'
}

/** Verify (Variance) is offered on a native, unpromoted, to_be_verified row
 *  whose host vial is assigned to a variance bucket (assignment_kind =
 *  'variance', set at check-in). Deliberately NOT gated on isLockedByParent
 *  or the parent variance lock: variance sign-off never touches the parent.
 *  Backend gate is authoritative (fail closed); this only controls visibility. */
export function canVarianceVerify(
  a: SenaiteAnalysis,
  vialKind: string | null | undefined,
): boolean {
  if (!a.uid || !a.uid.startsWith('mk1:')) return false
  if (a.review_state !== 'to_be_verified') return false
  if (a.promoted_to_parent_id != null) return false
  return vialKind === 'variance'
}

/** True when a row is a MEMBER of a variance series — native (mk1:) sub-row
 *  hosted on a variance-bucket vial. State-INDEPENDENT (unlike
 *  canVarianceVerify, which also requires to_be_verified & not-promoted).
 *  Drives the membership chip. */
export function isVarianceMember(
  a: SenaiteAnalysis,
  vialKind: string | null | undefined,
): boolean {
  if (!a.uid || !a.uid.startsWith('mk1:')) return false
  return vialKind === 'variance'
}

/** Whether to render the membership chip on a row: a variance member, EXCEPT on
 *  rows that already self-describe as variance — promoted (became the canonical
 *  line) and variance_verified ("Verified — Variance" badge). */
export function showVarianceChip(
  a: SenaiteAnalysis,
  vialKind: string | null | undefined,
): boolean {
  if (!isVarianceMember(a, vialKind)) return false
  if (isPromoted(a) || a.review_state === 'promoted') return false
  if (a.review_state === 'variance_verified') return false
  return true
}

/** True when a vial row has already been promoted to a parent-tier row. */
export function isPromoted(a: SenaiteAnalysis): boolean {
  return a.promoted_to_parent_id != null
}

/**
 * True when the parent SENAITE AR's analysis line for this row's keyword is
 * already 'verified'. A verified parent line is immutable — no corrections
 * can start from the vial; they must start from the parent (retest there
 * cascades down). The states map is optional so existing callers that don't
 * have parent context are unaffected.
 */
export function isLockedByParent(
  a: SenaiteAnalysis,
  parentLineStates?: Record<string, string>,
): boolean {
  if (!parentLineStates) return false
  return parentLineStates[a.keyword ?? ''] === 'verified'
}

/** Row-menu transitions: submit needs a result; verify is hidden when Promote
 *  is the correct action (promotable native vial rows dead-end on verify), and
 *  also hidden once the row has already been promoted to a parent.
 *  When parentLineStates is provided and the parent's line is verified, all
 *  transitions are hidden (locked row). */
export function visibleRowTransitions(
  a: SenaiteAnalysis,
  parentLineStates?: Record<string, string>,
): string[] {
  if (!a.uid || !a.review_state) return []
  if (isLockedByParent(a, parentLineStates)) return []
  return (ALLOWED_TRANSITIONS[a.review_state] ?? []).filter(
    t => (t !== 'submit' || !!a.result) && !(t === 'verify' && (isNativeAwaitingSignoff(a) || isPromoted(a))),
  )
}

export type AnalysisVerbPolicy = 'default' | 'parent-native'

/** Policy-aware row verbs. 'parent-native' (the native parent analyses card)
 *  offers retest on a 'verified' row (routed via onParentRetest — the
 *  generic transition endpoint tier-blocks parent retest; the card calls
 *  the dedicated parent-retest route and owns the destructive confirm) and,
 *  on a 'parent_to_verify' row awaiting sign-off, both verify and retest —
 *  verify is non-destructive and routes through the generic transition
 *  endpoint directly. Everything else is display-only. */
export function visibleRowTransitionsForPolicy(
  a: SenaiteAnalysis,
  policy: AnalysisVerbPolicy,
  parentLineStates?: Record<string, string>,
): string[] {
  if (policy === 'parent-native') {
    if (!a.uid) return []
    if (a.review_state === 'parent_to_verify') return ['verify', 'retest']
    return a.review_state === 'verified' ? ['retest'] : []
  }
  return visibleRowTransitions(a, parentLineStates)
}

const BULK_TRANSITIONS = ['submit', 'retest', 'verify', 'retract', 'reject'] as const
export type BulkTransition = (typeof BULK_TRANSITIONS)[number]

/** Policy-aware bulk actions. 'parent-native' reduces the toolbar to bulk
 *  retest over an all-verified selection, or bulk verify over an
 *  all-parent_to_verify selection; promote/variance never show. Mixed
 *  selections (any other combination, including a mix of the two states)
 *  offer nothing — same "simplest safe rule" as the default policy's
 *  locked-row handling. */
export function deriveBulkActionsForPolicy(
  selected: SenaiteAnalysis[],
  policy: AnalysisVerbPolicy,
  parentLineStates?: Record<string, string>,
  vialKind?: string | null,
): { actions: BulkTransition[]; showPromote: boolean; showVarianceVerify: boolean } {
  if (policy === 'parent-native') {
    const allVerified =
      selected.length > 0 && selected.every(a => a.review_state === 'verified')
    const allToVerify =
      selected.length > 0 && selected.every(a => a.review_state === 'parent_to_verify')
    const actions: BulkTransition[] = allVerified ? ['retest'] : allToVerify ? ['verify'] : []
    return { actions, showPromote: false, showVarianceVerify: false }
  }
  return deriveBulkActions(selected, parentLineStates, vialKind)
}

/** Bulk toolbar actions: intersection of allowed transitions, except verify is
 *  suppressed when ANY selected row is promotable OR already promoted; Promote
 *  shows when ALL selected rows are promotable (not yet promoted).
 *  When parentLineStates is provided, any locked row causes retest/retract/
 *  reject/promote to be dropped from the bulk action set (simplest safe rule). */
export function deriveBulkActions(
  selected: SenaiteAnalysis[],
  parentLineStates?: Record<string, string>,
  vialKind?: string | null,
): {
  actions: BulkTransition[]
  showPromote: boolean
  showVarianceVerify: boolean
} {
  const anyLocked = selected.some(a => isLockedByParent(a, parentLineStates))
  // Plain bulk verify stays suppressed for ALL native awaiting rows (kind-
  // agnostic): core rows promote, variance rows variance-verify.
  const anyPromotableOrPromoted = selected.some(a => isNativeAwaitingSignoff(a) || isPromoted(a))
  const LOCKED_DROP = new Set<BulkTransition>(['retest', 'retract', 'reject'])
  const actions = BULK_TRANSITIONS.filter(
    t =>
      selected.length > 0 &&
      !(t === 'verify' && anyPromotableOrPromoted) &&
      !(anyLocked && (LOCKED_DROP.has(t) || t === 'verify')) &&
      selected.every(
        a =>
          a.review_state !== null &&
          a.review_state !== undefined &&
          (ALLOWED_TRANSITIONS[a.review_state] ?? []).includes(t) &&
          (t !== 'submit' || !!a.result),
      ),
  )
  const showPromote =
    !anyLocked && selected.length > 0 && selected.every(a => isPromotable(a, vialKind))
  const showVarianceVerify =
    selected.length > 0 &&
    selected.every(a => canVarianceVerify(a, vialKind))
  return { actions, showPromote, showVarianceVerify }
}

/**
 * Returns the note string to append to the bulk destructive confirm dialog when
 * the selection includes promoted rows, or null when no rows are promoted.
 * Exported for unit-testing the exact message text.
 */
export function promotedDestructiveNote(selected: SenaiteAnalysis[]): string | null {
  const n = selected.filter(a => a.promoted_to_parent_id != null).length
  if (n === 0) return null
  return `${n} selected ${n === 1 ? 'analysis was' : 'analyses were'} promoted to the parent — the parent keeps its promoted value.`
}

/** Reasons bulk promote cannot proceed (empty array = good to go). */
export function deriveBulkPromoteBlockers(selected: SenaiteAnalysis[]): string[] {
  const blockers: string[] = []
  const missing = selected.filter(a => !a.result)
  if (missing.length > 0) {
    blockers.push(
      `${missing.length} selected ${missing.length === 1 ? 'analysis has' : 'analyses have'} no result value`,
    )
  }
  const noKeyword = selected.filter(a => !a.keyword)
  if (noKeyword.length > 0) {
    blockers.push(
      `${noKeyword.length} selected ${noKeyword.length === 1 ? 'analysis has' : 'analyses have'} no keyword`,
    )
  }
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const a of selected) {
    const k = a.keyword
    if (!k) continue
    if (seen.has(k)) dups.add(k)
    seen.add(k)
  }
  if (dups.size > 0) {
    blockers.push(
      `Duplicate keywords selected (${[...dups].join(', ')}) — one parent row per keyword; use the row menu Promote to merge multiple vials`,
    )
  }
  return blockers
}

// --- Shared components ---

export function StatusBadge({ state, promotable = false, varianceReady = false }: { state: string; promotable?: boolean; varianceReady?: boolean }) {
  const color =
    STATUS_COLORS[state] ??
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20'
  // Sub-sample rows can't self-verify — to_be_verified there means "awaiting
  // promotion" ("Ready to Promote") or, on a variance replicate where promote
  // is no longer the path, "awaiting variance sign-off" ("Ready to Verify").
  const label =
    state === 'to_be_verified' && varianceReady
      ? 'Ready to Verify'
      : promotable && state === 'to_be_verified'
        ? 'Ready to Promote'
        : STATUS_LABELS[state] ?? state.replace(/_/g, ' ')
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${color}`}
    >
      {label}
    </span>
  )
}

/** Small membership chip marking a row as part of a variance series. Visually
 *  distinct from the colored status badges (sky outline, echoing the AssignStep
 *  variance annotation). Gate visibility with showVarianceChip(). */
export function VarianceChip() {
  return (
    <span
      title="Replicate in a variance series — signed off via Verify (Variance), never promoted."
      className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-400 dark:border-sky-500/20"
    >
      Variance
    </span>
  )
}

// --- Local helpers ---

function TabButton({
  active,
  children,
  onClick,
  count,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
  count?: number
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? 'bg-muted text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[11px] ${
            active ? 'bg-background/50 text-foreground' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '\u2014'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Replace "Analyte N" prefix with the mapped peptide name when available. */
/**
 * Marks analysis line items served from a Mk1 lims_analyses row (uid prefixed
 * "mk1:") versus a legacy SENAITE analysis (32-char hex uid). A transition-era
 * cue while both data sources coexist; renders nothing for SENAITE rows.
 */
export function Mk1NativeBadge({ uid }: { uid?: string | null }) {
  if (!uid?.startsWith('mk1:')) return null
  return (
    <span title="Stored in Accu-Mk1 (no SENAITE record)" className="inline-flex shrink-0">
      <Database size={10} className="text-muted-foreground/60" aria-label="Stored in Accu-Mk1" />
    </span>
  )
}

export function formatAnalysisTitle(title: string, nameMap: Map<number, string>): { display: string; original: string } {
  const match = title.match(/^Analyte\s+(\d)\s*(.*)/i)
  if (match?.[1]) {
    const slot = parseInt(match[1], 10)
    const suffix = match[2] ?? '' // e.g. "- Purity" or "- Quantity"
    const peptideName = nameMap.get(slot)
    if (peptideName) {
      return { display: `${peptideName} ${suffix}`.trim(), original: title }
    }
  }
  return { display: title, original: title }
}

// --- Retest chain grouping ---

type AnalysisGroup = {
  current: SenaiteAnalysis   // most recent — the COA value
  history: SenaiteAnalysis[] // superseded older entries, oldest first
}

/** Group analyses by title so retest chains collapse under their most recent entry. */
function groupAnalysesByTitle(analyses: SenaiteAnalysis[]): AnalysisGroup[] {
  const groups = new Map<string, SenaiteAnalysis[]>()
  for (const a of analyses) {
    if (!groups.has(a.title)) groups.set(a.title, [])
    groups.get(a.title)!.push(a)
  }
  return Array.from(groups.values()).map(rows => ({
    current: rows[rows.length - 1]!,
    history: rows.slice(0, -1),
  }))
}

// --- Inline edit cell ---

/** Resolves the display label for a result value, mapping through result_options if present. */
function resolveResultLabel(result: string | null, options: SenaiteAnalysis['result_options']): string | null {
  if (!result) return null
  if (options.length > 0) {
    return options.find(o => o.value === result)?.label ?? result
  }
  // Numeric free-text path: trim over-precise promoted values to 2 dp for
  // display only (the stored value and the edit draft stay full precision).
  return formatNumericResult(result)
}

/** Maps stored identity result values to human-readable labels. */
function resolveIdentityLabel(result: string | null, conformsValue: string): string | null {
  if (!result) return null
  if (result === conformsValue) return 'Conforms'
  if (result === 'Does_Not_Conform') return 'Does Not Conform'
  return result
}

function EditableResultCell({
  analysis,
  editing,
  conformsValue = null,
  readOnly = false,
}: {
  analysis: SenaiteAnalysis
  editing: UseAnalysisEditingReturn
  conformsValue?: string | null
  /** Render the static value, never the editor (reserved for the future
   *  hard-lock on container-parent rows — SENAITE-elimination arc). */
  readOnly?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const isEditing = !readOnly && editing.editingUid === analysis.uid
  const canEdit = !readOnly && isResultEditable(analysis)
  // autoEdit: always show input when there's no result yet (no click needed)
  const autoEdit = canEdit && !analysis.result && !isEditing
  const [autoValue, setAutoValue] = useState('')
  const options = analysis.result_options ?? []
  const hasOptions = options.length > 0
  const isNumeric = analysis.result_type === 'numeric'
  const displayLabel = conformsValue
    ? resolveIdentityLabel(analysis.result, conformsValue)
    : resolveResultLabel(analysis.result, options)

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (isEditing) {
      if (hasOptions && selectRef.current) {
        selectRef.current.focus()
      } else if (!hasOptions && inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    }
  }, [isEditing, hasOptions])

  // Save on blur unless the cancel button received focus.
  // If draft is empty: save (to clear) when there was a prior value, otherwise just cancel.
  const handleBlur = (e: React.FocusEvent) => {
    if ((e.relatedTarget as HTMLElement)?.dataset.cancel) return
    if (!analysis.uid || editing.isSaving) return
    if (editing.draft.trim() || analysis.result) {
      void editing.save(analysis.uid)
    } else {
      editing.cancelEditing()
    }
  }

  // autoEdit mode: inline input always visible when no result yet
  if (autoEdit) {
    const handleAutoSave = () => {
      if (analysis.uid && autoValue.trim()) void editing.save(analysis.uid, autoValue.trim())
    }
    const handleAutoKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); handleAutoSave() }
      if (e.key === 'Escape') { e.preventDefault(); setAutoValue('') }
    }
    const autoInputClass = "h-7 text-sm px-2 py-0 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring shrink-0"
    return (
      <td className="py-1.5 px-3">
        <div className="flex items-center gap-1.5">
          {conformsValue ? (
            <select
              value={autoValue}
              onChange={e => { setAutoValue(e.target.value); if (e.target.value && analysis.uid) void editing.save(analysis.uid, e.target.value) }}
              disabled={editing.isSaving}
              className={autoInputClass}
              aria-label={`Select result for ${analysis.title}`}
            >
              <option value="">— Select —</option>
              <option value={conformsValue}>Conforms</option>
              <option value="Does_Not_Conform">Does Not Conform</option>
            </select>
          ) : hasOptions ? (
            <select
              value={autoValue}
              onChange={e => { setAutoValue(e.target.value); if (e.target.value && analysis.uid) void editing.save(analysis.uid, e.target.value) }}
              disabled={editing.isSaving}
              className={autoInputClass}
              aria-label={`Select result for ${analysis.title}`}
            >
              <option value="">— Select —</option>
              {options.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : (
            <Input
              ref={inputRef}
              type={isNumeric ? 'number' : 'text'}
              step={isNumeric ? 'any' : undefined}
              value={autoValue}
              onChange={e => setAutoValue(e.target.value)}
              onKeyDown={handleAutoKeyDown}
              onBlur={handleAutoSave}
              disabled={editing.isSaving}
              className="h-7 text-sm font-mono px-2 py-1 w-28 shrink-0"
              placeholder="—"
              aria-label={`Edit result for ${analysis.title}`}
            />
          )}
          {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
            <span className="text-xs text-muted-foreground shrink-0">{analysis.unit}</span>
          )}
          {autoValue && (
            <button
              onClick={() => setAutoValue('')}
              className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:bg-muted transition-colors cursor-pointer shrink-0"
              aria-label="Clear"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </td>
    )
  }

  // Editing mode: identity dropdown, options dropdown, or free-text input
  if (isEditing) {
    return (
      <td className="py-1.5 px-3">
        <div className="flex items-center gap-1.5">
          {conformsValue ? (
            <select
              ref={selectRef}
              value={editing.draft}
              onChange={e => editing.setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); editing.cancelEditing() }
                if (e.key === 'Enter') { e.preventDefault(); if (analysis.uid) void editing.save(analysis.uid) }
              }}
              onBlur={handleBlur}
              disabled={editing.isSaving}
              className="h-7 text-sm px-2 py-0 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring shrink-0"
              aria-label={`Select result for ${analysis.title}`}
            >
              <option value="">— Select —</option>
              <option value={conformsValue}>Conforms</option>
              <option value="Does_Not_Conform">Does Not Conform</option>
            </select>
          ) : hasOptions ? (
            <select
              ref={selectRef}
              value={editing.draft}
              onChange={e => editing.setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); editing.cancelEditing() }
                if (e.key === 'Enter') { e.preventDefault(); if (analysis.uid) void editing.save(analysis.uid) }
              }}
              onBlur={handleBlur}
              disabled={editing.isSaving}
              className="h-7 text-sm px-2 py-0 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring shrink-0"
              aria-label={`Select result for ${analysis.title}`}
            >
              <option value="">— Select —</option>
              {options.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : (
            <Input
              ref={inputRef}
              type={isNumeric ? 'number' : 'text'}
              step={isNumeric ? 'any' : undefined}
              value={editing.draft}
              onChange={e => editing.setDraft(e.target.value)}
              onKeyDown={e => { if (analysis.uid) editing.handleKeyDown(e, analysis.uid) }}
              onBlur={handleBlur}
              disabled={editing.isSaving}
              className="h-7 text-sm font-mono px-2 py-1 w-28 shrink-0"
              aria-label={`Edit result for ${analysis.title}`}
            />
          )}
          {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
            <span className="text-xs text-muted-foreground shrink-0">{analysis.unit}</span>
          )}
          <button
            onClick={() => { if (analysis.uid) void editing.save(analysis.uid) }}
            disabled={editing.isSaving}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            aria-label="Save"
          >
            {editing.isSaving ? <Spinner className="size-3.5" /> : <Check size={14} />}
          </button>
          <button
            data-cancel
            onClick={() => {
              editing.setDraft('')
              // Re-focus input so subsequent blur correctly triggers save/cancel
              setTimeout(() => {
                selectRef.current?.focus() ?? inputRef.current?.focus()
              }, 0)
            }}
            disabled={editing.isSaving}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            aria-label="Clear"
          >
            <X size={14} />
          </button>
        </div>
      </td>
    )
  }

  // Display mode: editable (clickable) or read-only
  if (canEdit) {
    return (
      <td className="py-2.5 px-3">
        <button
          onClick={() => { if (analysis.uid) editing.startEditing(analysis.uid, analysis.result) }}
          className="group inline-flex items-center gap-1.5 cursor-pointer rounded-md px-1 -mx-1 py-0.5 -my-0.5 hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Edit result for ${analysis.title}`}
        >
          <span
            className={`text-sm ${hasOptions ? '' : 'font-mono'} ${displayLabel ? 'text-foreground' : 'text-muted-foreground italic'}`}
          >
            {displayLabel || 'Pending'}
          </span>
          <Pencil
            size={12}
            className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0"
          />
        </button>
        {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
          <span className="text-xs text-muted-foreground ml-1.5">{analysis.unit}</span>
        )}
      </td>
    )
  }

  // Read-only (verified, to_be_verified, etc.)
  return (
    <td className="py-2.5 px-3">
      <span
        className={`text-sm ${hasOptions ? '' : 'font-mono'} ${displayLabel ? 'text-foreground' : 'text-muted-foreground italic'}`}
      >
        {displayLabel || 'Pending'}
      </span>
      {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
        <span className="text-xs text-muted-foreground ml-1.5">{analysis.unit}</span>
      )}
    </td>
  )
}

// --- Editable method/instrument select cell ---

function EditableSelectCell({
  analysis,
  field,
  onSaved,
  mk1Override = null,
  mk1OverrideEditable = false,
  readOnly = false,
}: {
  analysis: SenaiteAnalysis
  field: 'method' | 'instrument'
  onSaved?: (uid: string | null, title: string | null) => void
  mk1Override?: SenaiteAnalysis | null
  mk1OverrideEditable?: boolean
  /** Render the static value, never the editor (reserved for the future
   *  hard-lock on container-parent rows — SENAITE-elimination arc). */
  readOnly?: boolean
}) {
  const ov = mk1Override
  const options = ov
    ? (field === 'method' ? (ov.method_options ?? []) : (ov.instrument_options ?? []))
    : (field === 'method' ? (analysis.method_options ?? []) : (analysis.instrument_options ?? []))
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const selectRef = useRef<HTMLSelectElement>(null)

  const senaiteValue = field === 'method' ? analysis.method : analysis.instrument
  const ovValue = ov ? (field === 'method' ? ov.method : ov.instrument) : null
  const ovUid = ov ? (field === 'method' ? ov.method_uid : ov.instrument_uid) : null
  const writeUid = ov ? ov.uid : analysis.uid
  const canEdit = !readOnly && (ov
    ? (mk1OverrideEditable && !!ov.uid && EDITABLE_STATES.has(ov.review_state))
    : isResultEditable(analysis))
  // Single-match override (one definitive vial — editable OR verified/locked) →
  // show that vial's true (possibly empty) value, so display, editor preselection,
  // and write target all agree and a verified vial shows its real Mk1 method/
  // instrument read-only. Multi-vial (no single vial) or no override → SENAITE value.
  const currentValue = ov ? (mk1OverrideEditable ? ovValue : senaiteValue) : senaiteValue
  const currentUid = ov ? ovUid : (field === 'method' ? analysis.method_uid : analysis.instrument_uid)

  useEffect(() => {
    if (isEditing && selectRef.current) {
      selectRef.current.focus()
    }
  }, [isEditing])

  function startEditing() {
    setDraft(currentUid ?? '')
    setIsEditing(true)
  }

  function cancelEditing() {
    setIsEditing(false)
  }

  async function handleSave() {
    if (!writeUid) return
    setIsSaving(true)
    try {
      const selectedUid = draft || null
      const response = await setAnalysisMethodInstrument(
        writeUid,
        field === 'method' ? selectedUid : null,
        field === 'instrument' ? selectedUid : null,
      )
      if (!response.success) {
        toast.error(`Failed to update ${field}`, { description: response.message })
        return
      }
      const selectedTitle = options.find(o => o.uid === draft)?.title ?? null
      onSaved?.(selectedUid, selectedTitle)
      toast.success(`${field === 'method' ? 'Method' : 'Instrument'} updated`)
      setIsEditing(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      toast.error(`Failed to update ${field}`, { description: msg })
    } finally {
      setIsSaving(false)
    }
  }

  if (isEditing) {
    return (
      <td className="py-1.5 px-3">
        <div className="flex items-center gap-1.5">
          <select
            ref={selectRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); cancelEditing() }
              if (e.key === 'Enter') { e.preventDefault(); void handleSave() }
            }}
            disabled={isSaving}
            className="h-7 text-xs px-2 py-0 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring shrink-0 max-w-40"
            aria-label={`Select ${field}`}
          >
            <option value="">— None —</option>
            {options.map(opt => (
              <option key={opt.uid} value={opt.uid}>{opt.title}</option>
            ))}
          </select>
          <button
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            aria-label="Save"
          >
            {isSaving ? <Spinner className="size-3.5" /> : <Check size={14} />}
          </button>
          <button
            onClick={cancelEditing}
            disabled={isSaving}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </div>
      </td>
    )
  }

  if (canEdit) {
    return (
      <td className="py-2.5 px-3">
        <button
          onClick={startEditing}
          className="group inline-flex items-center gap-1.5 cursor-pointer rounded-md px-1 -mx-1 py-0.5 -my-0.5 hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Edit ${field} for ${analysis.title}`}
        >
          <span className={`text-xs ${currentValue ? 'text-muted-foreground' : 'text-muted-foreground/50 italic'}`}>
            {currentValue || '\u2014'}
          </span>
          <Pencil
            size={11}
            className="text-muted-foreground/30 group-hover:text-muted-foreground transition-colors shrink-0"
          />
        </button>
      </td>
    )
  }

  return (
    <td className="py-2.5 px-3 text-xs text-muted-foreground">
      {currentValue || '\u2014'}
    </td>
  )
}

// --- History row (superseded retest entry) ---

function HistoryRow({
  analysis,
  analyteNameMap,
}: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
}) {
  const { display, original } = formatAnalysisTitle(analysis.title, analyteNameMap)
  const wasRenamed = display !== original
  const conformsValue = /Identity\s*\(HPLC\)/i.test(display)
    ? (display.match(/^(.+?)\s*[-–]\s*Identity\s*\(HPLC\)/i)?.[1]?.trim() ?? null)
    : null
  const resultLabel = conformsValue
    ? resolveIdentityLabel(analysis.result, conformsValue)
    : resolveResultLabel(analysis.result, analysis.result_options ?? [])
  return (
    <tr className="border-b border-border/20 bg-muted/10">
      <td className="py-1.5 px-3" />
      <td className="py-1.5 px-3 pl-7">
        <span className="text-xs text-muted-foreground/70" title={wasRenamed ? original : undefined}>
          {display}
          {wasRenamed && (
            <span className="ml-1 text-[10px]">
              ({original.match(/^Analyte\s+\d/i)?.[0]})
            </span>
          )}
        </span>
      </td>
      <td className="py-1.5 px-3">
        <span className="text-xs font-mono text-muted-foreground/60 line-through">
          {resultLabel || '\u2014'}
        </span>
        {analysis.unit && analysis.unit.toLowerCase() !== 'text' && (
          <span className="text-xs text-muted-foreground/50 ml-1">{analysis.unit}</span>
        )}
      </td>
      <td className="py-1.5 px-3 text-center">
        {analysis.retested ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100/50 text-amber-600/70 dark:bg-amber-500/10 dark:text-amber-500/70">
            Yes
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/50">No</span>
        )}
      </td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60">{analysis.method || '\u2014'}</td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60">{analysis.instrument || '\u2014'}</td>
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60">{analysis.analyst || '\u2014'}</td>
      <td className="py-1.5 px-3">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-zinc-100 text-zinc-400 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:border-zinc-700">
          Superseded
        </span>
      </td>
      <td className="py-1.5 px-3" />
      <td className="py-1.5 px-3 text-xs text-muted-foreground/60 whitespace-nowrap">
        {formatDate(analysis.captured)}
      </td>
      <td className="py-1.5 px-3" />
    </tr>
  )
}

// --- Phase 4b: Promote dialog ---

function PromoteDialog({
  analysis,
  open,
  onOpenChange,
  onPromoted,
}: {
  analysis: SenaiteAnalysis
  open: boolean
  onOpenChange: (open: boolean) => void
  onPromoted: () => void
}) {
  const [resultValue, setResultValue] = useState(analysis.result ?? '')
  const [pending, setPending] = useState(false)

  // Reset the field when the dialog reopens for a different row
  useEffect(() => {
    if (open) setResultValue(analysis.result ?? '')
  }, [open, analysis.result])

  const handle = async () => {
    if (!analysis.uid?.startsWith('mk1:')) return
    if (!resultValue) {
      toast.error('Result value is required')
      return
    }
    const limsId = parseInt(analysis.uid.slice('mk1:'.length), 10)
    setPending(true)
    try {
      await promoteAnalyses({
        keyword: analysis.keyword ?? '',
        result_value: resultValue,
        result_unit: analysis.unit ?? null,
        method_id: analysis.method_uid ? parseInt(analysis.method_uid, 10) : null,
        instrument_id: analysis.instrument_uid ? parseInt(analysis.instrument_uid, 10) : null,
        sources: [{ analysis_id: limsId, contribution_kind: 'chosen' }],
        reason: 'Single-vial promote from AnalysisTable',
      })
      toast.success('Promoted to parent')
      onOpenChange(false)
      onPromoted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote {analysis.keyword} to parent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Create a parent-tier verified row for <code>{analysis.keyword}</code> with the
            chosen value. The vial-tier row moves to <code>promoted</code>; an audit
            row records the promotion. To undo, retract the parent row.
          </p>
          <label className="text-sm font-medium block">
            Result value
            <input
              type="text"
              value={resultValue}
              onChange={(e) => setResultValue(e.target.value)}
              className="mt-1 w-full px-2 py-1 border rounded bg-background text-sm font-mono"
              autoFocus
            />
          </label>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={handle} disabled={pending || !resultValue}>
              {pending ? 'Promoting…' : 'Promote'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Bulk promote: read-only confirm dialog, sequential execution ---

export function BulkPromoteDialog({
  analyses,
  open,
  onOpenChange,
  onPromoted,
}: {
  analyses: SenaiteAnalysis[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPromoted: () => void
}) {
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const blockers = deriveBulkPromoteBlockers(analyses)
  const pending = progress !== null

  const handle = async () => {
    setProgress({ current: 0, total: analyses.length })
    let failed = 0
    let promoted = 0
    try {
      for (let i = 0; i < analyses.length; i++) {
        const a = analyses[i]!
        setProgress({ current: i + 1, total: analyses.length })
        if (!a.uid?.startsWith('mk1:') || !a.result) continue
        const limsId = parseInt(a.uid.slice('mk1:'.length), 10)
        try {
          await promoteAnalyses({
            keyword: a.keyword ?? '',
            result_value: a.result,
            result_unit: a.unit ?? null,
            method_id: a.method_uid ? parseInt(a.method_uid, 10) : null,
            instrument_id: a.instrument_uid ? parseInt(a.instrument_uid, 10) : null,
            sources: [{ analysis_id: limsId, contribution_kind: 'chosen' }],
            reason: 'Bulk promote from AnalysisTable',
          })
          promoted++
        } catch (e) {
          failed++
          toast.error(`${a.keyword ?? a.title}: ${(e as Error).message}`)
        }
      }
    } finally {
      setProgress(null)
    }
    if (failed === 0 && promoted === analyses.length) toast.success(`Promoted ${promoted} to parent`)
    else toast.warning(`Promoted ${promoted} of ${analyses.length}; ${failed} failed`)
    onOpenChange(false)
    onPromoted()
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!pending) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote {analyses.length} analyses to parent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Each row creates a parent-tier verified row with the vial&apos;s current value. Vial-tier
            rows move to <code>promoted</code>; audit rows record each promotion. To undo,
            retract the parent row.
          </p>
          <table className="w-full text-sm">
            <tbody>
              {analyses.map(a => (
                <tr key={a.uid} className="border-b border-border/50">
                  <td className="py-1.5 pr-3 font-medium">{a.keyword ?? a.title}</td>
                  <td className="py-1.5 font-mono">{a.result ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {blockers.map(b => (
            <p key={b} className="text-sm text-destructive">{b}</p>
          ))}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={handle} disabled={pending || blockers.length > 0}>
              {pending && progress
                ? `Promoting ${progress.current}/${progress.total}…`
                : `Promote ${analyses.length} to parent`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Analysis row ---

function AnalysisRow({
  analysis,
  analyteNameMap,
  vialRoles,
  departments,
  editing,
  transition,
  selectedUids,
  onToggleSelection,
  isBulkProcessing,
  historyCount,
  isHistoryExpanded,
  onToggleHistory,
  onMethodInstrumentSaved,
  onPromoted,
  slaSnapshot,
  isSlaLoading,
  isSlaError,
  isSlaPublished,
  slaPriority,
  primaryAnalysisUids,
  primaryRole,
  promotionsByKeyword,
  vialAssignmentByKeyword,
  onVialMethodInstrumentSaved,
  parentLineStates,
  vialKind,
  resultsReadOnly = false,
  verbPolicy = 'default',
  onParentRetest,
  onPromotedNativeRetest,
}: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
  /** S1 roles-as-data: threaded from AnalysisTable's single useVialRoles()/
   *  useDepartments() call — role-colored title text + vial-chip text below. */
  vialRoles?: VialRoleRow[]
  departments?: Department[]
  editing: UseAnalysisEditingReturn
  transition: UseAnalysisTransitionReturn
  selectedUids: Set<string>
  onToggleSelection: (uid: string) => void
  isBulkProcessing: boolean
  historyCount?: number
  isHistoryExpanded?: boolean
  onToggleHistory?: () => void
  onMethodInstrumentSaved?: (uid: string, field: 'method' | 'instrument', newUid: string | null, newTitle: string | null) => void
  onPromoted?: () => void
  slaSnapshot: SampleSlaSnapshot | null
  isSlaLoading: boolean
  isSlaError: boolean
  isSlaPublished: boolean
  slaPriority: InboxPriority | null
  primaryAnalysisUids?: Set<string>
  primaryRole?: string | null
  promotionsByKeyword?: Map<string, ParentPromotionInfo>
  vialAssignmentByKeyword?: Map<string, VialAssignment>
  onVialMethodInstrumentSaved?: () => void
  parentLineStates?: Record<string, string>
  /** The host vial's assignment_kind ('core' | 'variance' | null). Drives the
   *  promote-vs-variance-verify affordance split and the membership chip. */
  vialKind?: string | null
  /** Suppress the result editor — render the static value only. */
  resultsReadOnly?: boolean
  /** Verb policy — see AnalysisTableProps.verbPolicy. */
  verbPolicy?: AnalysisVerbPolicy
  /** parent-native only: row retest requested — open the card's confirm. */
  onParentRetest?: (analysis: SenaiteAnalysis) => void
  /** Task 10: default-policy only. When provided, a promoted, native
   *  (mk1:), mk1-origin row offers Retest routed through this callback
   *  instead of the (empty) ALLOWED_TRANSITIONS['promoted'] set — see
   *  isPromotedSourceRetestEligible. Omitted (every existing surface) →
   *  byte-identical to today. */
  onPromotedNativeRetest?: (analysis: SenaiteAnalysis) => void
}) {
  const rowTint = ROW_STATUS_STYLE[analysis.review_state ?? ''] ?? ''
  const { display, original } = formatAnalysisTitle(analysis.title, analyteNameMap)
  const wasRenamed = display !== original
  const conformsValue = /Identity\s*\(HPLC\)/i.test(display)
    ? (display.match(/^(.+?)\s*[-–]\s*Identity\s*\(HPLC\)/i)?.[1]?.trim() ?? null)
    : null
  // Phase 4b promote affordance — see isPromotable; verify is hidden on
  // promotable rows via visibleRowTransitions.
  const locked = isLockedByParent(analysis, parentLineStates)
  // Task 10 seam: deliberately bypasses isLockedByParent/parentLineStates —
  // that map encodes the SENAITE AR line's state (see its own docstring),
  // which is meaningless for a promoted row whose backing service is
  // mk1-origin and so has no SENAITE AR line to lock against in the first
  // place. verbPolicy is excluded defensively (SampleDetails only ever
  // passes onPromotedNativeRetest on the default-policy sub-sample
  // instance, never the parent-native card), so the parent-native policy
  // path can't reach this even if that wiring changed.
  const promotedSourceRetestSeam =
    verbPolicy !== 'parent-native' &&
    !!onPromotedNativeRetest &&
    isPromotedSourceRetestEligible(analysis)
  const allowedTransitions = promotedSourceRetestSeam
    ? ['retest']
    : visibleRowTransitionsForPolicy(analysis, verbPolicy, parentLineStates)
  const canPromote = verbPolicy !== 'parent-native' && isPromotable(analysis, vialKind) && !locked
  const canVarVerify = verbPolicy !== 'parent-native' && canVarianceVerify(analysis, vialKind)
  const isPromoted = analysis.promoted_to_parent_id != null
  const tooltipCopy = promotedRowTooltipCopy(isPromoted, promotedSourceRetestSeam)
  const vialAssign = analysis.keyword ? vialAssignmentByKeyword?.get(analysis.keyword) : undefined
  const vialOverlay = vialAssign?.matches[0]?.mk1Analysis ?? null
  const vialOverlayEditable = vialAssign?.editable ?? false
  const [promoteOpen, setPromoteOpen] = useState(false)
  // Task 7 (methods bench-stamping): the Wrench row action's dialog.
  // serviceId is resolved on open — preferring the row's own
  // analysis_service_id FK (fix round 1, R-P2-3) when the backend supplied
  // it; only falling back to a keyword scan of active methods'
  // services[].keyword when it's absent (see openMethodDialog below).
  // Excluded
  // for verbPolicy 'parent-native' — that policy's whole point is
  // display-only rows outside its own verify/retest verbs (mirrors how
  // canPromote/canVarVerify above are excluded), even though a parent-tier
  // row can sit in a state STAMPABLE_STATES would otherwise allow.
  const showSetMethodInstrument =
    verbPolicy !== 'parent-native' && canSetMethodInstrument(analysis)
  const [methodDialogOpen, setMethodDialogOpen] = useState(false)
  const [methodDialogServiceId, setMethodDialogServiceId] = useState<number | null>(null)
  async function openMethodDialog() {
    // Fix round 1 (R-P2-3, controller ruling): prefer the row's own FK when
    // the backend supplied it — no fetch needed, and no ambiguity. Only
    // fall back to the keyword scan when analysis_service_id is absent
    // (older cached rows, or a non-mk1 origin somehow reaching here), and
    // scope that scan to ACTIVE methods only — keywords are not unique
    // across service origins (the migration pattern produces exactly that
    // collision), so scanning inactive/superseded methods too widens the
    // chance of resolving the wrong service.
    if (analysis.analysis_service_id != null) {
      setMethodDialogServiceId(analysis.analysis_service_id)
      setMethodDialogOpen(true)
      return
    }
    let serviceId: number | null = null
    try {
      const methods = await getMethods()
      for (const m of methods) {
        if (!m.active) continue
        const link = m.services.find(s => s.keyword === analysis.keyword)
        if (link) {
          serviceId = link.analysis_service_id
          break
        }
      }
    } catch {
      // Leave serviceId null — the dialog renders its own
      // "no active methods cover this service" empty state.
    }
    setMethodDialogServiceId(serviceId)
    setMethodDialogOpen(true)
  }
  const queryClient = useQueryClient()
  const isPending = !!analysis.uid && transition.pendingUids.has(analysis.uid)
  // Highlight the title text when this analysis is one of the "primary"
  // analyses for the sample's vial-assignment role (e.g. ENDO analyses on
  // the endo sub-sample, HPLC analyses on the parent / hplc sub).
  const isPrimary =
    !!analysis.uid && !!primaryAnalysisUids?.has(analysis.uid)
  const primaryTitleClass = isPrimary && primaryRole
    ? primaryTitleColorClass(primaryRole, vialRoles, departments)
    : ''

  return (
    <tr className={`border-b border-border/50 hover:bg-muted/30 transition-colors ${rowTint}`}>
      <td className="py-2.5 px-3">
        {analysis.uid && (
          <Checkbox
            checked={selectedUids.has(analysis.uid)}
            onCheckedChange={() => { if (analysis.uid) onToggleSelection(analysis.uid) }}
            disabled={isBulkProcessing}
            aria-label={`Select ${analysis.title}`}
          />
        )}
      </td>
      <td className="py-2.5 px-3 text-sm text-foreground font-medium">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            title={wasRenamed ? original : undefined}
            className={isPrimary ? `font-semibold ${primaryTitleClass}` : ''}
          >
            {display}
            {wasRenamed && (
              <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                ({original.match(/^Analyte\s+\d/i)?.[0]})
              </span>
            )}
          </span>
          <Mk1NativeBadge uid={analysis.uid} />
          <PromotedFromBadge promotion={analysis.keyword ? promotionsByKeyword?.get(analysis.keyword) : undefined} />
          {vialAssign && vialAssign.matches.filter(m => {
            // The "from <vial>" promotion badge above already names the
            // source vial — drop its duplicate assignment chip and keep
            // only the OTHER vials (e.g. the variance replicate).
            const promo = analysis.keyword ? promotionsByKeyword?.get(analysis.keyword) : undefined
            return !promo?.sources?.some(s => s.sample_id === m.vialSampleId)
          }).map(m => {
            // Key each overlay vial by ITS OWN assignment_kind (carried on the
            // match) — a parent page mixes core and variance vials, so each
            // vial speaks for itself. No entitlement lookup: kind is explicit.
            // Colour EVERY variance-assigned vial (state-independent) — a vial
            // assigned to the variance bucket reads as variance whether or not
            // its replicate is signed off yet. A Lock icon marks vials locked
            // into the variance set (in_variance_set && the set is locked).
            const vialIsVariance = isVarianceMember(m.mk1Analysis, m.assignmentKind)
            const vialLocked = !!m.varianceLocked
            return (
              <button
                key={m.vialSampleId}
                type="button"
                onClick={e => { e.stopPropagation(); useUIStore.getState().navigateToSample(m.vialSampleId) }}
                className={`inline-flex items-center gap-0.5 text-[10px] underline underline-offset-2 shrink-0 hover:opacity-80 ${ROLE_COLOR_TEXT[roleColorForCode(m.assignmentRole, vialRoles, departments)]}`}
                title={
                  vialLocked
                    ? `Variance replicate, locked into the set — ${m.vialSampleId}`
                    : vialIsVariance
                      ? `Variance replicate — ${m.vialSampleId}`
                      : `Assigned to ${m.vialSampleId}`
                }
              >
                {/* Variance stays marked by the blue Layers icon; the vial label
                    itself now carries its assignment-role colour. */}
                {vialIsVariance && <Layers className="h-3 w-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />}
                {m.vialLabel} — {m.vialSampleId}
                {vialLocked && <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}
          {!!historyCount && (
            <button
              onClick={onToggleHistory}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted transition-colors cursor-pointer shrink-0"
              title={isHistoryExpanded ? 'Hide previous results' : 'Show previous results'}
            >
              {isHistoryExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
              {historyCount} prev
            </button>
          )}
        </div>
      </td>
      <EditableResultCell analysis={analysis} editing={editing} conformsValue={conformsValue} readOnly={resultsReadOnly} />
      <td className="py-2.5 px-3 text-center">
        {analysis.retested ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
            Yes
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No</span>
        )}
      </td>
      <EditableSelectCell
        analysis={analysis}
        field="method"
        mk1Override={vialOverlay}
        mk1OverrideEditable={vialOverlayEditable}
        readOnly={verbPolicy === 'parent-native'}
        onSaved={(newUid, newTitle) => {
          if (vialOverlay) onVialMethodInstrumentSaved?.()
          else if (analysis.uid) onMethodInstrumentSaved?.(analysis.uid, 'method', newUid, newTitle)
        }}
      />
      <EditableSelectCell
        analysis={analysis}
        field="instrument"
        mk1Override={vialOverlay}
        mk1OverrideEditable={vialOverlayEditable}
        readOnly={verbPolicy === 'parent-native'}
        onSaved={(newUid, newTitle) => {
          if (vialOverlay) onVialMethodInstrumentSaved?.()
          else if (analysis.uid) onMethodInstrumentSaved?.(analysis.uid, 'instrument', newUid, newTitle)
        }}
      />
      <td className="py-2.5 px-3 text-xs text-muted-foreground">
        <AnalystNames
          prepper={((vialOverlayEditable ? vialOverlay?.analyst : null) ?? analysis.analyst) || null}
          processedBy={analysis.processed_by ?? null}
        />
      </td>
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {analysis.review_state && (
            <StatusBadge
              state={analysis.review_state}
              promotable={isPromotable(analysis, vialKind)}
              varianceReady={canVarVerify}
            />
          )}
          {showVarianceChip(analysis, vialKind) && <VarianceChip />}
          {isPromoted && (
            <span
              className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400"
              title="This vial-tier row has been promoted to a parent-tier canonical result"
            >
              Promoted → #{analysis.promoted_to_parent_id}
            </span>
          )}
          {/* Task 10 fix round 1: tooltipCopy (promotedRowTooltipCopy) covers
              the seam-active-but-not-currently-promoted case too — see its
              own doc comment. The "Promoted → #N" badge above stays
              isPromoted-only (there's no live parent id to show there). */}
          {tooltipCopy !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex items-center text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-help"
                  aria-label="How to correct a promoted result"
                >
                  <HelpCircle size={11} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-left">
                {tooltipCopy === 'retracted-parent' ? (
                  <>
                    This promoted result&apos;s parent value was already
                    retracted. Retesting here creates a fresh run and does
                    not change any parent value.
                  </>
                ) : tooltipCopy === 'seam-active' ? (
                  <>
                    This result has been promoted to the parent. Retest here
                    to un-verify the parent value directly, or retest the
                    line on the parent AR to cascade down the same way.
                  </>
                ) : (
                  <>
                    This result has been promoted to the parent. To correct
                    it, retest the line on the parent AR — the retest
                    cascades back down to this vial.
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          )}
          {locked && (
            <span
              className="inline-flex items-center gap-0.5 text-muted-foreground/50"
              title="Parent result verified in SENAITE — retest on the parent to supersede"
            >
              <Lock size={11} />
            </span>
          )}
        </div>
      </td>
      <td className="py-2.5 px-3">
        <AnalysisSlaCell
          snapshot={slaSnapshot}
          priority={slaPriority}
          isLoading={isSlaLoading}
          isError={isSlaError}
          isPublished={isSlaPublished}
        />
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(analysis.captured)}
      </td>
      <td className="py-2 px-3 text-right">
        {analysis.uid && (allowedTransitions.length > 0 || canPromote || canVarVerify || showSetMethodInstrument) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={isPending}
                className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Analysis actions"
              >
                {isPending ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <MoreHorizontal size={14} />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canPromote && (
                <DropdownMenuItem
                  onClick={() => setPromoteOpen(true)}
                >
                  Promote
                </DropdownMenuItem>
              )}
              {canVarVerify && (
                <DropdownMenuItem
                  onClick={() => {
                    if (!analysis.uid) return
                    void transition.executeTransition(analysis.uid, 'variance_verify')
                  }}
                >
                  Verify (Variance)
                </DropdownMenuItem>
              )}
              {showSetMethodInstrument && (
                <DropdownMenuItem onClick={() => void openMethodDialog()}>
                  <Wrench aria-hidden="true" />
                  Set method / instrument
                </DropdownMenuItem>
              )}
              {allowedTransitions.map(t => (
                <DropdownMenuItem
                  key={t}
                  variant={DESTRUCTIVE_TRANSITIONS.has(t) ? 'destructive' : 'default'}
                  onClick={() => {
                    if (!analysis.uid) return
                    if (promotedSourceRetestSeam) {
                      onPromotedNativeRetest?.(analysis)
                    } else if (verbPolicy === 'parent-native') {
                      if (t === 'verify') {
                        void transition.executeTransition(analysis.uid, 'verify')
                      } else {
                        onParentRetest?.(analysis)
                      }
                    } else if (DESTRUCTIVE_TRANSITIONS.has(t)) {
                      transition.requestConfirm(analysis.uid, t, analysis.title)
                    } else {
                      void transition.executeTransition(analysis.uid, t)
                    }
                  }}
                >
                  {TRANSITION_LABELS[t] ?? t}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canPromote && (
          <PromoteDialog
            analysis={analysis}
            open={promoteOpen}
            onOpenChange={setPromoteOpen}
            onPromoted={() => {
              // Phase 4b: invalidate react-query (for hooks-backed callers)
              // AND fire the parent's onPromoted (SampleDetails uses
              // useState/useEffect, not react-query, so this is needed
              // to drive a re-fetch of the senaite_shape rows).
              queryClient.invalidateQueries()
              onPromoted?.()
            }}
          />
        )}
        {showSetMethodInstrument && analysis.uid && (
          <SetMethodInstrumentDialog
            analysisId={Number(analysis.uid.slice('mk1:'.length))}
            serviceId={methodDialogServiceId ?? 0}
            currentMethodId={toIntOrNull(analysis.method_uid)}
            currentInstrumentId={toIntOrNull(analysis.instrument_uid)}
            open={methodDialogOpen}
            onOpenChange={setMethodDialogOpen}
            onSaved={() => {
              // Same reload contract as Promote above — invalidate for
              // react-query callers, fire onPromoted (== the table's
              // onTransitionComplete) for useState/useEffect callers.
              queryClient.invalidateQueries()
              onPromoted?.()
            }}
          />
        )}
      </td>
    </tr>
  )
}

// --- Sorting ---

/** Analyst cell: the visible name is the PREPPER (worksheet assignment).
 * When the prep bridge has stamped who ran the Process HPLC, a dotted
 * underline + tooltip surfaces both roles without widening the table. */
function AnalystNames({ prepper, processedBy }: { prepper: string | null; processedBy: string | null }) {
  if (!processedBy) return <>{prepper || '—'}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
          {prepper || '—'}
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-left">
        <div className="flex flex-col gap-0.5 text-xs">
          <div>Prepped by: {prepper || '—'}</div>
          <div>Processed by: {processedBy}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

type SortColumn = 'title' | 'result' | 'review_state' | 'analyst' | 'method' | 'instrument' | 'captured' | 'sla'
type SortDir = 'asc' | 'desc'

interface SortConfig { column: SortColumn; dir: SortDir }

function SortableHeader({
  column, label, align = 'left', sortConfig, onSort,
}: {
  column: SortColumn
  label: string
  align?: 'left' | 'center' | 'right'
  sortConfig: SortConfig | null
  onSort: (col: SortColumn) => void
}) {
  const active = sortConfig?.column === column
  const alignClass = align === 'center' ? 'justify-center' : align === 'right' ? 'justify-end' : 'justify-start'
  return (
    <th className={`py-2 px-3 text-${align} text-[11px] font-semibold text-muted-foreground uppercase tracking-wider`}>
      <button
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors ${alignClass}`}
      >
        {label}
        {active
          ? <ArrowDownUp size={11} className="text-foreground shrink-0" />
          : <ArrowUpDown size={11} className="opacity-30 shrink-0" />
        }
      </button>
    </th>
  )
}

function getSlaSortValue(
  a: SenaiteAnalysis,
  analysisSlaMap: Map<string, SampleSlaSnapshot> | undefined,
  isPublished: boolean
): number {
  if (!analysisSlaMap || !a.keyword) return Number.POSITIVE_INFINITY
  const snap = analysisSlaMap.get(a.keyword)
  if (!snap) return Number.POSITIVE_INFINITY
  return isPublished ? snap.status.elapsed_minutes : snap.status.remaining_minutes
}

function sortGroups(
  groups: AnalysisGroup[],
  config: SortConfig,
  nameMap: Map<number, string>,
  analysisSlaMap: Map<string, SampleSlaSnapshot> | undefined,
  isPublished: boolean
): AnalysisGroup[] {
  return [...groups].sort((a, b) => {
    if (config.column === 'sla') {
      const aVal = getSlaSortValue(a.current, analysisSlaMap, isPublished)
      const bVal = getSlaSortValue(b.current, analysisSlaMap, isPublished)
      // Missing-data rows (POSITIVE_INFINITY sentinel) always sort to the
      // bottom regardless of direction — per spec.
      const aMissing = !Number.isFinite(aVal)
      const bMissing = !Number.isFinite(bVal)
      if (aMissing && bMissing) return 0
      if (aMissing) return 1
      if (bMissing) return -1
      const cmp = aVal - bVal
      return config.dir === 'asc' ? cmp : -cmp
    }
    const aVal = getCellValue(a.current, config.column, nameMap)
    const bVal = getCellValue(b.current, config.column, nameMap)
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
    return config.dir === 'asc' ? cmp : -cmp
  })
}

function getCellValue(a: SenaiteAnalysis, col: Exclude<SortColumn, 'sla'>, nameMap: Map<number, string>): string {
  switch (col) {
    case 'title': return formatAnalysisTitle(a.title, nameMap).display
    case 'result': return a.result ?? ''
    case 'review_state': return a.review_state ?? ''
    case 'analyst': return a.analyst ?? ''
    case 'method': return a.method ?? ''
    case 'instrument': return a.instrument ?? ''
    case 'captured': return a.captured ?? ''
  }
}

// --- Main AnalysisTable component ---

interface AnalysisTableProps {
  analyses: SenaiteAnalysis[]
  analyteNameMap: Map<number, string>
  onResultSaved?: (uid: string, newResult: string, newReviewState: string | null) => void
  onTransitionComplete?: () => void
  onMethodInstrumentSaved?: (uid: string, field: 'method' | 'instrument', newUid: string | null, newTitle: string | null) => void
  analysisSlaMap?: Map<string, SampleSlaSnapshot>
  isAnalysisSlaLoading?: boolean
  isAnalysisSlaError?: boolean
  isAnalysisSlaPublished?: boolean
  analysisSlaPriority?: InboxPriority | null
  /**
   * UIDs of analyses that are "primary" for the viewing sample's vial-
   * assignment role. Used to tint the analysis title — does NOT filter
   * rows. Caller is responsible for deriving the set; this component
   * just renders the highlight when an analysis is in it.
   */
  primaryAnalysisUids?: Set<string>
  /**
   * Role string (hplc / endo / ster / xtra) driving the tint color.
   * Required for the highlight to actually colorize; without it the
   * primary rows render with normal title styling.
   */
  primaryRole?: string | null
  /**
   * Promotion provenance map for parent pages — keyword → ParentPromotionInfo.
   * When provided, matching analysis rows render a "from <sub-sample>" badge.
   * Omit (undefined) on sub-sample pages; no behavior change for existing callers.
   */
  promotionsByKeyword?: Map<string, ParentPromotionInfo>
  /**
   * Parent-page vial assignment overlay — keyword → VialAssignment. When a row's
   * keyword maps here, the row shows an inline assigned-vial link and overlays
   * Method/Instrument/Analyst from that vial's Mk1 analysis. Omit on sub-sample pages.
   */
  vialAssignmentByKeyword?: Map<string, VialAssignment>
  /** Called after a Method/Instrument edit that was routed to a vial's Mk1 row,
   *  so the caller can refetch the overlay. */
  onVialMethodInstrumentSaved?: () => void
  /**
   * SENAITE parent-line states for sub-sample pages — keyword → review_state.
   * When a keyword maps to 'verified', the vial row is locked: all mutating
   * actions (Promote / Retest / Retract / Reject) are hidden. Corrections must
   * start from the parent AR. Omit on parent pages.
   */
  parentLineStates?: Record<string, string>
  /**
   * When provided, REPLACES the default left block of the card header row
   * (the "Activity icon · ANALYSES · n of m" group). The filter tabs on the
   * right stay regardless. Used by the Vials Quick Look dialog to fold each
   * vial's header into the table's own Card. Omit for byte-identical default.
   */
  headerContent?: ReactNode
  /**
   * When true, the progress-bar block under the header is not rendered. Used
   * by the Quick Look dialog (per-vial progress is noise in the stacked view).
   * Default false → unchanged for sample pages.
   */
  hideProgress?: boolean
  /** The host vial's assignment_kind ('core' | 'variance' | null). Pass on
   *  vial-scoped surfaces (quicklook sections, sub-sample page); parent pages
   *  pass null/omit — parents have no kind, and the Verify (Variance) action
   *  never appears there. Vial-list overlay entries carry their own kind on
   *  the match (VialMatch.assignmentKind), independent of this prop. */
  vialKind?: string | null
  /**
   * When true, result cells render their static value only — the inline
   * editor / pencil / auto-input is suppressed. Used on parent pages to
   * deter result entry on the parent (work belongs on the vials); the
   * Manage Analyses overlay has an opt-in to flip it back on. Default
   * false → unchanged for sub-sample pages and the Vials Quick Look.
   */
  resultsReadOnly?: boolean
  /** Verb policy. Omit ('default') = existing behavior byte-identical.
   *  'parent-native' = the native parent analyses card: retest-only on
   *  verified rows via onParentRetest/onParentBulkRetest; method/instrument
   *  editing suppressed; promote/variance side channels suppressed. */
  verbPolicy?: AnalysisVerbPolicy
  /** parent-native only: row retest requested — open the card's confirm. */
  onParentRetest?: (analysis: SenaiteAnalysis) => void
  /** parent-native only: bulk retest over the selected current rows. */
  onParentBulkRetest?: (analyses: SenaiteAnalysis[]) => void
  /** Task 10: default-policy only — see isPromotedSourceRetestEligible.
   *  Omitted (every existing surface) → byte-identical to today. */
  onPromotedNativeRetest?: (analysis: SenaiteAnalysis) => void
}

export function AnalysisTable({
  analyses,
  analyteNameMap,
  onResultSaved,
  onTransitionComplete,
  onMethodInstrumentSaved,
  analysisSlaMap,
  isAnalysisSlaLoading = false,
  isAnalysisSlaError = false,
  isAnalysisSlaPublished = false,
  analysisSlaPriority = null,
  primaryAnalysisUids,
  primaryRole,
  promotionsByKeyword,
  vialAssignmentByKeyword,
  onVialMethodInstrumentSaved,
  parentLineStates,
  headerContent,
  hideProgress = false,
  vialKind,
  resultsReadOnly = false,
  verbPolicy = 'default',
  onParentRetest,
  onParentBulkRetest,
  onPromotedNativeRetest,
}: AnalysisTableProps) {
  const [analysisFilter, setAnalysisFilter] = useState<'all' | 'verified' | 'pending' | 'invalid'>('all')
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null)
  const [bulkPendingConfirm, setBulkPendingConfirm] = useState<{ transition: string; count: number } | null>(null)
  const [bulkPromoteOpen, setBulkPromoteOpen] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [isCardVisible, setIsCardVisible] = useState(true)
  const cardRef = useRef<HTMLDivElement>(null)

  // Show toolbar fixed at bottom while the card is visible; hide when scrolled out of view
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setIsCardVisible(entry!.isIntersecting),
      { threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const { open: sidebarOpen } = useSidebar()
  const editing = useAnalysisEditing({ analyses, onResultSaved })
  const transition = useAnalysisTransition({ onTransitionComplete })
  const bulk = useBulkAnalysisTransition({ onTransitionComplete })
  // S1 roles-as-data: the one useVialRoles()/useDepartments() call for this
  // table, threaded into each AnalysisRow for its role-colored title/vial-chip text.
  const vialRoles = useVialRoles().data
  const departments = useDepartments().data


  const INVALID_STATES = new Set(['rejected', 'retracted'])
  const invalidCount = analyses.filter(a => INVALID_STATES.has(a.review_state ?? '')).length
  const verifiedCount = analyses.filter(
    a => a.review_state === 'verified' || a.review_state === 'published' || a.review_state === 'promoted'
  ).length
  const validCount = analyses.length - invalidCount
  const pendingCount = validCount - verifiedCount
  const progressPct =
    validCount > 0 ? Math.round((verifiedCount / validCount) * 100) : 0

  const filteredAnalyses = analyses.filter(a => {
    if (analysisFilter === 'verified')
      return a.review_state === 'verified' || a.review_state === 'published' || a.review_state === 'promoted'
    if (analysisFilter === 'pending')
      return a.review_state !== 'verified' && a.review_state !== 'published' && a.review_state !== 'promoted' && !INVALID_STATES.has(a.review_state ?? '')
    if (analysisFilter === 'invalid')
      return INVALID_STATES.has(a.review_state ?? '')
    // 'all' — exclude invalid by default, matching SENAITE's "Valid" view
    return !INVALID_STATES.has(a.review_state ?? '')
  })

  const handleSort = (col: SortColumn) => {
    setSortConfig(prev =>
      prev?.column === col
        ? { column: col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { column: col, dir: 'asc' }
    )
  }

  // Group filtered analyses by title so retest chains collapse
  const rawGroups = groupAnalysesByTitle(filteredAnalyses)
  const groups = sortConfig
    ? sortGroups(rawGroups, sortConfig, analyteNameMap, analysisSlaMap, isAnalysisSlaPublished)
    : rawGroups

  // Profile sections (mk1 rows only — backend-resolved profile_section_*
  // on the shaped row; senaite-mode rows never carry them, so this table
  // stays flat there by construction). An explicit column sort flattens
  // too: interleaving a user-chosen sort across section boundaries would
  // misrepresent the order. Sectionless rows lead, with NO header — the
  // backend deliberately leaves unmatched rows unlabeled (never mislabel).
  interface ProfileSection {
    key: string | null
    label: string | null
    groups: AnalysisGroup[]
  }
  const sectioned: ProfileSection[] = (() => {
    if (sortConfig || !groups.some(g => g.current.profile_section_key)) {
      return [{ key: null, label: null, groups }]
    }
    const byKey = new Map<string | null, ProfileSection & { sort: number }>()
    for (const g of groups) {
      const key = g.current.profile_section_key ?? null
      let section = byKey.get(key)
      if (!section) {
        section = {
          key,
          label: key === null ? null : (g.current.profile_section_label ?? null),
          groups: [],
          sort: key === null ? -1 : (g.current.profile_section_sort ?? Number.MAX_SAFE_INTEGER),
        }
        byKey.set(key, section)
      }
      section.groups.push(g)
    }
    return Array.from(byKey.values()).sort((a, b) => a.sort - b.sort)
  })()

  // Header checkbox state — current (COA) rows only
  const selectableUids = groups
    .map(g => g.current.uid)
    .filter((uid): uid is string => !!uid)
  const allSelected =
    selectableUids.length > 0 && selectableUids.every(uid => bulk.selectedUids.has(uid))
  const someSelected = selectableUids.some(uid => bulk.selectedUids.has(uid))
  const headerChecked: boolean | 'indeterminate' =
    allSelected ? true : someSelected ? 'indeterminate' : false

  // Bulk available actions — promote-aware intersection (see deriveBulkActions)
  const selectedAnalyses = groups
    .filter(g => g.current.uid && bulk.selectedUids.has(g.current.uid))
    .map(g => g.current)
  const { actions: bulkAvailableActions, showPromote: bulkShowPromote, showVarianceVerify: bulkShowVarianceVerify } =
    deriveBulkActionsForPolicy(selectedAnalyses, verbPolicy, parentLineStates, vialKind)

  // Disable toolbar when any per-row transition is in-flight
  const toolbarDisabled = transition.pendingUids.size > 0

  if (analyses.length === 0) return null

  return (
    <Card ref={cardRef} className="p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        {headerContent ?? (
          <div className="flex items-center gap-2">
            <Activity size={15} className="text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground tracking-wide uppercase">
              Analyses
            </span>
            <span className="text-xs text-muted-foreground ml-1">
              {filteredAnalyses.length} of {validCount}
            </span>
          </div>
        )}
        <div
          className="flex items-center gap-2"
          role="tablist"
          aria-label="Filter analyses"
        >
          <div className="flex items-center bg-muted rounded-lg p-0.5 border border-border/50">
            <TabButton
              active={analysisFilter === 'all'}
              onClick={() => setAnalysisFilter('all')}
              count={validCount}
            >
              All
            </TabButton>
            <TabButton
              active={analysisFilter === 'verified'}
              onClick={() => setAnalysisFilter('verified')}
              count={verifiedCount}
            >
              Verified
            </TabButton>
            <TabButton
              active={analysisFilter === 'pending'}
              onClick={() => setAnalysisFilter('pending')}
              count={pendingCount}
            >
              Pending
            </TabButton>
            {invalidCount > 0 && (
              <TabButton
                active={analysisFilter === 'invalid'}
                onClick={() => setAnalysisFilter('invalid')}
                count={invalidCount}
              >
                Invalid
              </TabButton>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {!hideProgress && (
        <div className="mb-4">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="text-[11px] text-muted-foreground">Analysis Progress</span>
            <span className="text-[11px] text-muted-foreground">{progressPct}% complete</span>
          </div>
        </div>
      )}

      {/* Bulk action toolbar — fixed at browser bottom while table is visible */}
      {bulk.selectedUids.size > 0 && isCardVisible && (
        <div
          className="fixed bottom-4 z-50 flex items-center justify-between px-4 py-2.5 rounded-lg bg-slate-900 border border-slate-500 shadow-xl"
          style={{
            // var() needs 0px fallbacks: in portaled contexts (e.g. the Vials
            // Quick Look dialog, which portals to document.body OUTSIDE the
            // SidebarProvider) these CSS vars don't resolve, the calc() goes
            // invalid, left collapses to 0, and the toolbar jumps bottom-left.
            // Falling back to 0px centers it on the viewport — correct for the
            // 90vw dialog and a no-op on the page (where the var resolves).
            left: sidebarOpen
              ? 'calc(50% + var(--sidebar-width, 0px) / 2)'
              : 'calc(50% + var(--sidebar-width-icon, 0px) / 2)',
            transform: 'translateX(-50%)',
            width: sidebarOpen
              ? 'min(calc(100vw - var(--sidebar-width, 0px) - 3rem), 64rem)'
              : 'min(calc(100vw - var(--sidebar-width-icon, 0px) - 3rem), 64rem)',
          }}
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-foreground">
              {bulk.selectedUids.size} selected
            </span>
            <button
              onClick={bulk.clearSelection}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer"
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2">
            {bulk.isBulkProcessing && bulk.bulkProgress ? (
              <div className="flex items-center gap-2">
                <Spinner className="size-3.5" />
                <span className="text-sm text-muted-foreground">
                  {bulk.bulkProgress.transition === 'variance_verify'
                    ? 'Verifying (Variance)'
                    : `${TRANSITION_LABELS[bulk.bulkProgress.transition] ?? bulk.bulkProgress.transition}ing`}{' '}
                  {bulk.bulkProgress.current}/{bulk.bulkProgress.total}...
                </span>
              </div>
            ) : (
              <>
                {bulkShowPromote && (
                  <Button
                    size="sm"
                    disabled={toolbarDisabled}
                    onClick={() => setBulkPromoteOpen(true)}
                  >
                    Promote selected
                  </Button>
                )}
                {bulkShowVarianceVerify && (
                  <Button
                    size="sm"
                    disabled={toolbarDisabled}
                    onClick={() => void bulk.executeBulk([...bulk.selectedUids], 'variance_verify')}
                  >
                    Verify (Variance) selected
                  </Button>
                )}
                {bulkAvailableActions.map(t => (
                  <Button
                    key={t}
                    size="sm"
                    variant={DESTRUCTIVE_TRANSITIONS.has(t) ? 'destructive' : 'default'}
                    disabled={toolbarDisabled}
                    onClick={() => {
                      if (verbPolicy === 'parent-native') {
                        if (t === 'verify') {
                          void bulk.executeBulk([...bulk.selectedUids], 'verify')
                        } else {
                          onParentBulkRetest?.(selectedAnalyses)
                        }
                        return
                      }
                      if (DESTRUCTIVE_TRANSITIONS.has(t)) {
                        setBulkPendingConfirm({ transition: t, count: bulk.selectedUids.size })
                      } else {
                        void bulk.executeBulk([...bulk.selectedUids], t)
                      }
                    }}
                  >
                    {TRANSITION_LABELS[t] ?? t} selected
                  </Button>
                ))}
              </>
            )}
            {bulkAvailableActions.length === 0 && !bulkShowPromote && !bulkShowVarianceVerify && !bulk.isBulkProcessing && (
              <span className="text-xs text-muted-foreground italic">
                No common actions for selection
              </span>
            )}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full">
          <caption className="sr-only">
            Sample analyses and their verification status
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="py-2 px-3 w-10">
                <Checkbox
                  checked={headerChecked}
                  onCheckedChange={(checked) => {
                    if (checked === true) {
                      bulk.selectAll(selectableUids)
                    } else {
                      bulk.clearSelection()
                    }
                  }}
                  disabled={bulk.isBulkProcessing || toolbarDisabled}
                  aria-label="Select all analyses"
                />
              </th>
              <SortableHeader column="title" label="Analysis" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="result" label="Result" sortConfig={sortConfig} onSort={handleSort} />
              <th className="py-2 px-3 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Retested
              </th>
              <SortableHeader column="method" label="Method" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="instrument" label="Instrument" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="analyst" label="Analyst" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="review_state" label="Status" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="sla" label="SLA" sortConfig={sortConfig} onSort={handleSort} />
              <SortableHeader column="captured" label="Captured" sortConfig={sortConfig} onSort={handleSort} />
              <th className="py-2 px-3 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wider w-12">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.length > 0 ? (
              sectioned.map(section => (
                <Fragment key={section.key ?? '__no_section'}>
                  {section.label != null && (
                    <tr>
                      <td
                        colSpan={11}
                        className="pt-3 pb-1.5 px-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/50"
                      >
                        {section.label}
                      </td>
                    </tr>
                  )}
                  {section.groups.map(group => {
                const groupKey = group.current.uid ?? group.current.title
                const isExpanded = expandedGroups.has(groupKey)
                return (
                  <Fragment key={groupKey}>
                    <AnalysisRow
                      analysis={group.current}
                      analyteNameMap={analyteNameMap}
                      vialRoles={vialRoles}
                      departments={departments}
                      editing={editing}
                      transition={transition}
                      selectedUids={bulk.selectedUids}
                      onToggleSelection={bulk.toggleSelection}
                      isBulkProcessing={bulk.isBulkProcessing}
                      historyCount={group.history.length}
                      isHistoryExpanded={isExpanded}
                      onToggleHistory={() => toggleGroup(groupKey)}
                      onMethodInstrumentSaved={onMethodInstrumentSaved}
                      onPromoted={onTransitionComplete}
                      slaSnapshot={
                        analysisSlaMap && group.current.keyword
                          ? analysisSlaMap.get(group.current.keyword) ?? null
                          : null
                      }
                      isSlaLoading={isAnalysisSlaLoading}
                      isSlaError={isAnalysisSlaError}
                      isSlaPublished={isAnalysisSlaPublished}
                      slaPriority={analysisSlaPriority}
                      primaryAnalysisUids={primaryAnalysisUids}
                      primaryRole={primaryRole}
                      promotionsByKeyword={promotionsByKeyword}
                      vialAssignmentByKeyword={vialAssignmentByKeyword}
                      onVialMethodInstrumentSaved={onVialMethodInstrumentSaved}
                      parentLineStates={parentLineStates}
                      vialKind={vialKind}
                      resultsReadOnly={resultsReadOnly}
                      verbPolicy={verbPolicy}
                      onParentRetest={onParentRetest}
                      onPromotedNativeRetest={onPromotedNativeRetest}
                    />
                    {isExpanded && group.history.map(h => (
                      <HistoryRow
                        key={h.uid ?? h.title}
                        analysis={h}
                        analyteNameMap={analyteNameMap}
                      />
                    ))}
                  </Fragment>
                )
              })}
                </Fragment>
              ))
            ) : (
              <tr>
                <td
                  colSpan={11}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No {analysisFilter === 'all' ? '' : analysisFilter} analyses found
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Per-row destructive transition confirmation */}
        <AlertDialog
          open={transition.pendingConfirm !== null}
          onOpenChange={(open) => {
            if (!open) transition.cancelConfirm()
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {transition.pendingConfirm?.transition === 'retract'
                  ? 'Retract analysis?'
                  : 'Reject analysis?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                <strong>{transition.pendingConfirm?.analysisTitle}</strong> will be{' '}
                {transition.pendingConfirm?.transition === 'retract'
                  ? 'retracted back to unassigned state'
                  : 'permanently rejected'}
                . This action cannot be undone from this application.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => { void transition.confirmAndExecute() }}
              >
                Confirm {transition.pendingConfirm?.transition}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Bulk promote confirm */}
      <BulkPromoteDialog
        analyses={selectedAnalyses}
        open={bulkPromoteOpen}
        onOpenChange={setBulkPromoteOpen}
        onPromoted={() => {
          bulk.clearSelection()
          onTransitionComplete?.()
        }}
      />

      {/* Bulk destructive transition confirmation */}
      <AlertDialog
        open={bulkPendingConfirm !== null}
        onOpenChange={(open) => { if (!open) setBulkPendingConfirm(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkPendingConfirm?.transition === 'retract'
                ? `Retract ${bulkPendingConfirm.count} analyses?`
                : `Reject ${bulkPendingConfirm?.count} analyses?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkPendingConfirm?.count} analyses will be{' '}
              {bulkPendingConfirm?.transition === 'retract'
                ? 'retracted back to unassigned state'
                : 'permanently rejected'}
              . This action cannot be undone from this application.
              {promotedDestructiveNote(selectedAnalyses) && (
                <span className="block mt-2">{promotedDestructiveNote(selectedAnalyses)}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (bulkPendingConfirm) {
                  void bulk.executeBulk([...bulk.selectedUids], bulkPendingConfirm.transition)
                }
                setBulkPendingConfirm(null)
              }}
            >
              Confirm {bulkPendingConfirm?.transition}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
