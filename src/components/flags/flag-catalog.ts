/**
 * Flag type catalog — the single front-end source for pill colors + labels.
 *
 * Values mirror `backend/flags/catalog.py` FLAG_TYPES exactly. The `color`
 * hexes are the validated dark-mode accents from the approved mockup and are
 * intentionally hardcoded here (the one sanctioned exception to the "theme
 * tokens only" rule — these are semantic type accents, not chrome).
 */

import type { FlagType } from '@/lib/flags-api'

export type FlagKind = 'issue' | 'signal'

export interface FlagTypeDef {
  label: string
  color: string
  kind: FlagKind
}

export const FLAG_TYPES: Record<FlagType, FlagTypeDef> = {
  blocker: { label: 'Blocker', color: '#e5484d', kind: 'issue' },
  critical: { label: 'Critical', color: '#e8730a', kind: 'issue' },
  question: { label: 'Question', color: '#3b82f6', kind: 'issue' },
  waiting_on_customer: {
    label: 'Waiting on Customer',
    color: '#8b5cf6',
    kind: 'issue',
  },
  ready_for_verification: {
    label: 'Ready for Verification',
    color: '#22c55e',
    kind: 'signal',
  },
}

/** Ordered for display (issues first, by urgency; signal last) — drives the
 *  left-to-right order of the segmented count chips on the header button. */
export const FLAG_TYPE_ORDER: FlagType[] = [
  'blocker',
  'critical',
  'question',
  'waiting_on_customer',
  'ready_for_verification',
]

/** Look up a type def, tolerating unknown strings from the wire. */
export function flagTypeDef(type: string): FlagTypeDef {
  return (
    FLAG_TYPES[type as FlagType] ?? {
      label: type,
      color: '#94a3b8',
      kind: 'issue',
    }
  )
}
