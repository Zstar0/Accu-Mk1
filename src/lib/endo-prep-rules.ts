/**
 * Method prep rules on the 2 mL worksheet (slice 5, spec
 * docs/superpowers/specs/2026-10-14-endo-slice5-method-rules-design.md):
 * the types the API serves and the matcher, the browser's mirror of
 * backend/endo_prep_rules.py match_rule / row_rule. The shared fixture
 * backend/tests/fixtures/endo_prep_rule_cases.json pins both sides to the
 * same answers. Pure: no DOM, no fetch.
 */
import type { WorksheetItemRow } from '@/lib/worksheet-sla-subjects'

export type EndoPrepRuleStatus = 'trial' | 'validated'

/** One rule line, as GET /endo-prep-rules and a lock snapshot carry it. */
export interface EndoPrepRule {
  id: number
  peptide_id: number
  /** Band: weight > min_mg (null: no lower bound) and <= max_mg (null: no upper bound). */
  min_mg: number | null
  max_mg: number | null
  /** null: the method's standard. */
  total_dilution: number | null
  step1_ratio: number | null
  /** null: the row's usual cartridge chain. */
  cartridge_type_id: number | null
  status: EndoPrepRuleStatus
  note: string | null
  sort_order: number
  active: boolean
}

export type PrepRuleLockEvent =
  | 'print'
  | 'result'
  | 'complete'
  | 'reapply'
  | 'switch'

/** worksheet_items.prep_rule: the line a row locked to (null: the standard). */
export interface PrepRuleLock {
  rule: EndoPrepRule | null
  locked_at: string
  locked_by: PrepRuleLockEvent
  user_id: number | null
}

/** One past run in worksheet_items.prep_history (spec 7): stored facts only. */
export interface PrepHistoryEntry {
  at: string
  by: number | null
  why: 'reapply' | 'override'
  lock: PrepRuleLock | null
  total_dilution: number
  step1_ratio: number
  cartridge_type_id: number | null
  result_reading: string | null
  reader_test_id: string | null
  result_entered_at: string | null
}

export interface MatchQuery {
  peptideId: number | null
  weightMg: number | null
  isBac: boolean
  endoPrep: string | null
  rulesOff: boolean
}

function inBand(r: EndoPrepRule, w: number | null): boolean {
  if (w === null) return r.min_mg === null && r.max_mg === null
  return (
    (r.min_mg === null || w > r.min_mg) && (r.max_mg === null || w <= r.max_mg)
  )
}

/**
 * The active line for a row (spec 4), or null. Never for a stock worksheet,
 * bac water, a sample with no single catalog peptide or a "no rule" row.
 * Of several lines the narrowest band wins, width = (max_mg or infinity) -
 * (min_mg or 0), so any closed band beats an open one; a tie goes to the
 * lowest sort_order, then the lowest id, whatever the order of `rules`.
 */
export function matchRule(
  rules: EndoPrepRule[],
  q: MatchQuery
): EndoPrepRule | null {
  if (q.endoPrep !== '2ml' || q.isBac || q.rulesOff || q.peptideId === null)
    return null
  const w =
    typeof q.weightMg === 'number' && Number.isFinite(q.weightMg)
      ? q.weightMg
      : null
  let best: EndoPrepRule | null = null
  let bestWidth = Infinity
  for (const r of rules) {
    if (!r.active || r.peptide_id !== q.peptideId || !inBand(r, w)) continue
    const width = (r.max_mg ?? Infinity) - (r.min_mg ?? 0)
    const wins =
      best === null ||
      width < bestWidth ||
      (width === bestWidth &&
        (r.sort_order < best.sort_order ||
          (r.sort_order === best.sort_order && r.id < best.id)))
    if (wins) {
      best = r
      bestWidth = width
    }
  }
  return best
}

/**
 * The line a row runs under: none for a "no rule" row, the locked snapshot
 * once the row is locked (a rule edit never reaches it), none for a row
 * with a reading and no lock (data from before slice 5: read at the
 * standard, it stays there, as the server's row_rule reads it; final review
 * I1), else the live match.
 */
export function rowRule(
  item: Pick<
    WorksheetItemRow,
    'prep_rule' | 'prep_rules_off' | 'result_reading' | 'result_entered_at'
  >,
  rules: EndoPrepRule[],
  q: Omit<MatchQuery, 'rulesOff'>
): EndoPrepRule | null {
  if (item.prep_rules_off) return null
  if (item.prep_rule) return item.prep_rule.rule
  if (item.result_entered_at != null || item.result_reading != null) return null
  return matchRule(rules, { ...q, rulesOff: false })
}

/** The band in the words of the server's warnings: "any weight", "up to
 *  30 mg", "above 30 mg" or "above 10 up to 30 mg". */
export function bandText(r: Pick<EndoPrepRule, 'min_mg' | 'max_mg'>): string {
  if (r.min_mg === null && r.max_mg === null) return 'any weight'
  if (r.min_mg === null) return `up to ${r.max_mg} mg`
  if (r.max_mg === null) return `above ${r.min_mg} mg`
  return `above ${r.min_mg} up to ${r.max_mg} mg`
}

/**
 * A line as the lab reads it: "Retatrutide above 30 mg · 1:300 total", values
 * it leaves at the standard left out ("the standard" when it sets none).
 * `cartridge` names a cartridge type id.
 */
export function ruleText(
  r: EndoPrepRule,
  peptide: string,
  cartridge: (id: number) => string = id => `cartridge #${id}`
): string {
  const values = [
    r.total_dilution !== null ? `1:${r.total_dilution} total` : null,
    r.step1_ratio !== null ? `step 1 1:${r.step1_ratio}` : null,
    r.cartridge_type_id !== null ? cartridge(r.cartridge_type_id) : null,
  ].filter(Boolean)
  return `${peptide} ${bandText(r)} · ${values.length ? values.join(', ') : 'the standard'}`
}

/** The tag text: "rule" or "rule (trial)". */
export function ruleTag(r: Pick<EndoPrepRule, 'status'>): string {
  return r.status === 'trial' ? 'rule (trial)' : 'rule'
}
