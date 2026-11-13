/**
 * HPLC prep rules (plan 2026-11-12-hplc-prep-rules, Task 4): the type the
 * rules API serves and the matcher, the browser's mirror of
 * backend/hplc_prep_rules.py match_rule, component_target, pick_lead,
 * row_diluent, row_instrument and row_floor. The shared fixture
 * backend/tests/fixtures/hplc_prep_rule_cases.json pins both sides to the
 * same answers. A null value on a line means the method default
 * (HPLC_RUN_PARAM_DEFAULTS in hplc-run-params, DEFAULT_DILUENT for the
 * diluent). Pure: no DOM, no fetch.
 *
 * A component's own line is matched on the component's declared_mg; a row's
 * own line on the row's declared total. For a solo row `components` is the
 * one peptide and `rowRule` is that peptide's line.
 */

export type HplcPrepRuleStatus = 'trial' | 'validated'

export const HPLC_DILUENTS = ['Water', 'Water + 0.1% TFA'] as const
export const DEFAULT_DILUENT = 'Water'

/** One rule line, as the rules API serves it (HplcPrepRuleOut). */
export interface HplcPrepRule {
  id: number
  /** A solo peptide, a blend component or a blend. */
  peptide_id: number
  /** Band: weight > min_mg (null: no lower bound) and <= max_mg (null: no upper bound). */
  min_mg: number | null
  max_mg: number | null
  /** The vial's target concentration, ug/mL; null: the method's. */
  target_conc_ug_ml: number | null
  /** The peptide's target as a blend component, ug/mL; null: its target alone. */
  blend_target_conc_ug_ml: number | null
  /** A blend line only: the component that leads. */
  lead_component_id: number | null
  /** A component line only: lower leads first. */
  lead_priority: number | null
  /** null: the method's. */
  floor_ug_ml: number | null
  /** One of HPLC_DILUENTS; null: DEFAULT_DILUENT. */
  diluent: string | null
  default_instrument_id: number | null
  status: HplcPrepRuleStatus
  note: string | null
  sort_order: number
  active: boolean
  peptide_name: string | null
  peptide_is_blend: boolean
  lead_component_name: string | null
  default_instrument_name: string | null
  updated_at: string | null
}

/** What the matcher reads: a snapshot line (the fixture's) or a served one. */
type Line = Pick<
  HplcPrepRule,
  | 'id'
  | 'peptide_id'
  | 'min_mg'
  | 'max_mg'
  | 'target_conc_ug_ml'
  | 'blend_target_conc_ug_ml'
  | 'lead_component_id'
  | 'lead_priority'
  | 'floor_ug_ml'
  | 'diluent'
  | 'default_instrument_id'
  | 'sort_order'
  | 'active'
>

/** One peptide in an autosampler vial. */
export interface HplcPrepComponent {
  peptide_id: number
  declared_mg: number | null
}

export interface ComponentTarget {
  value: number
  source: 'blend_rule' | 'rule' | 'default'
  rule_id: number | null
}

export interface LeadPick {
  peptide_id: number
  why: 'chosen' | 'rule' | 'preferred' | 'heaviest' | 'first'
}

export interface RowDiluent {
  diluent: string
  rule_id: number | null
}

/** weight > min_mg and weight <= max_mg, a null bound meaning none. A row
 *  with no weight sits only in a line with both bounds null. */
function inBand(r: Line, w: number | null): boolean {
  if (w === null) return r.min_mg === null && r.max_mg === null
  return (
    (r.min_mg === null || w > r.min_mg) && (r.max_mg === null || w <= r.max_mg)
  )
}

/** (max_mg or infinity) - (min_mg or 0). Every open band is infinitely wide,
 *  so any closed band beats it. */
function width(r: Line): number {
  return (r.max_mg ?? Infinity) - (r.min_mg ?? 0)
}

/**
 * The active line for this peptide whose band holds the weight, or null. Of
 * several the narrowest band wins; a tie goes to the lowest sort_order, then
 * the lowest id. Returns the line from `rules` itself, not a copy.
 */
export function matchRule<R extends Line>(
  rules: R[],
  q: { peptideId: number | null; weightMg: number | null }
): R | null {
  if (q.peptideId === null) return null
  let best: R | null = null
  for (const r of rules) {
    if (!r.active || r.peptide_id !== q.peptideId || !inBand(r, q.weightMg))
      continue
    const wins =
      best === null ||
      width(r) < width(best) ||
      (width(r) === width(best) &&
        (r.sort_order < best.sort_order ||
          (r.sort_order === best.sort_order && r.id < best.id)))
    if (wins) best = r
  }
  return best
}

/**
 * A peptide's target concentration and where it came from: its blend target
 * when it is in a blend and its line sets one, else its target alone, else
 * `default` (the method's).
 */
export function componentTarget(
  rules: Line[],
  q: {
    peptideId: number | null
    weightMg: number | null
    inBlend: boolean
    default: number
  }
): ComponentTarget {
  const line = matchRule(rules, q)
  if (line !== null && q.inBlend && line.blend_target_conc_ug_ml !== null)
    return {
      value: line.blend_target_conc_ug_ml,
      source: 'blend_rule',
      rule_id: line.id,
    }
  if (line !== null && line.target_conc_ug_ml !== null)
    return { value: line.target_conc_ug_ml, source: 'rule', rule_id: line.id }
  return { value: q.default, source: 'default', rule_id: null }
}

/** A component's own line, matched on the component's declared_mg. */
function ownLine(rules: Line[], c: HplcPrepComponent): Line | null {
  return matchRule(rules, { peptideId: c.peptide_id, weightMg: c.declared_mg })
}

/**
 * Which component of one autosampler vial leads, and why. `components` is
 * the vial's in display order. In turn: the tech's pick ("chosen"); with 2+
 * components, the blend line's lead ("rule") and the component whose own
 * line has the lowest lead_priority ("preferred", a tie to the first
 * listed); the greatest declared_mg among those with one ("heaviest", a tie
 * to the first); else the first.
 */
export function pickLead(
  rules: Line[],
  components: HplcPrepComponent[],
  q: { rowRule: Line | null; chosenId?: number | null }
): LeadPick | null {
  const first = components[0]
  if (first === undefined) return null
  const ids = components.map(c => c.peptide_id)
  const chosen = q.chosenId ?? null
  if (chosen !== null && ids.includes(chosen))
    return { peptide_id: chosen, why: 'chosen' }
  if (components.length > 1) {
    const lead = q.rowRule?.lead_component_id ?? null
    if (lead !== null && ids.includes(lead))
      return { peptide_id: lead, why: 'rule' }
    let preferred: HplcPrepComponent | null = null
    let bestPriority = Infinity
    for (const c of components) {
      const priority = ownLine(rules, c)?.lead_priority ?? null
      if (priority !== null && priority < bestPriority) {
        preferred = c
        bestPriority = priority
      }
    }
    if (preferred !== null)
      return { peptide_id: preferred.peptide_id, why: 'preferred' }
  }
  let heaviest: HplcPrepComponent | null = null
  let mostMg = -Infinity
  for (const c of components) {
    if (
      c.declared_mg !== null &&
      (heaviest === null || c.declared_mg > mostMg)
    ) {
      heaviest = c
      mostMg = c.declared_mg
    }
  }
  if (heaviest !== null)
    return { peptide_id: heaviest.peptide_id, why: 'heaviest' }
  return { peptide_id: first.peptide_id, why: 'first' }
}

/** The line that sets `key` for a row: the row's own line if it sets it,
 *  else the first component, in order, whose own line does; else null. */
function rowValue(
  rules: Line[],
  key: 'diluent' | 'default_instrument_id',
  rowRule: Line | null,
  components: HplcPrepComponent[]
): Line | null {
  if (rowRule !== null && rowRule[key] !== null) return rowRule
  for (const c of components) {
    const line = ownLine(rules, c)
    if (line !== null && line[key] !== null) return line
  }
  return null
}

/** The row's diluent and the line that set it (DEFAULT_DILUENT, rule_id
 *  null, when no line names one). */
export function rowDiluent(
  rules: Line[],
  q: { rowRule: Line | null; components: HplcPrepComponent[] }
): RowDiluent {
  const line = rowValue(rules, 'diluent', q.rowRule, q.components)
  if (line === null || line.diluent === null)
    return { diluent: DEFAULT_DILUENT, rule_id: null }
  return { diluent: line.diluent, rule_id: line.id }
}

/** The instrument the row usually runs on, by rowDiluent's walk; null when
 *  no line names one. */
export function rowInstrument(
  rules: Line[],
  q: { rowRule: Line | null; components: HplcPrepComponent[] }
): number | null {
  const line = rowValue(rules, 'default_instrument_id', q.rowRule, q.components)
  return line === null ? null : line.default_instrument_id
}

/** The row's line's floor, else `default` (the method's). */
export function rowFloor(
  rowRule: Pick<HplcPrepRule, 'floor_ug_ml'> | null,
  q: { default: number }
): number {
  if (rowRule === null || rowRule.floor_ug_ml === null) return q.default
  return rowRule.floor_ug_ml
}

/** The band in the words of the server's warnings: "any weight", "up to
 *  30 mg", "above 30 mg" or "above 10 up to 30 mg". */
export function bandText(r: Pick<HplcPrepRule, 'min_mg' | 'max_mg'>): string {
  if (r.min_mg === null && r.max_mg === null) return 'any weight'
  if (r.min_mg === null) return `up to ${r.max_mg} mg`
  if (r.max_mg === null) return `above ${r.min_mg} mg`
  return `above ${r.min_mg} up to ${r.max_mg} mg`
}

/**
 * A line as the lab reads it: "GHK-Cu any weight · target 125 ug/mL,
 * 350 ug/mL in a blend, lead priority 2, Water + 0.1% TFA", values it leaves
 * at the method default left out ("the standard" when it sets none). Names
 * come from the served display keys, an id when one is missing.
 */
export function ruleText(r: HplcPrepRule): string {
  const values = [
    r.target_conc_ug_ml !== null ? `target ${r.target_conc_ug_ml} ug/mL` : null,
    r.blend_target_conc_ug_ml !== null
      ? `${r.blend_target_conc_ug_ml} ug/mL in a blend`
      : null,
    r.lead_component_id !== null
      ? `lead ${r.lead_component_name ?? `peptide #${r.lead_component_id}`}`
      : null,
    r.lead_priority !== null ? `lead priority ${r.lead_priority}` : null,
    r.diluent,
    r.floor_ug_ml !== null ? `floor ${r.floor_ug_ml} ug/mL` : null,
    r.default_instrument_id !== null
      ? `on ${r.default_instrument_name ?? `instrument #${r.default_instrument_id}`}`
      : null,
  ].filter(Boolean)
  const peptide = r.peptide_name ?? `peptide #${r.peptide_id}`
  return `${peptide} ${bandText(r)} · ${values.length ? values.join(', ') : 'the standard'}`
}

/** The tag text: "rule" or "rule (trial)". */
export function ruleTag(r: Pick<HplcPrepRule, 'status'>): string {
  return r.status === 'trial' ? 'rule (trial)' : 'rule'
}
