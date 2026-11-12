import type { VarianceRun, VarianceRunValue, VarianceTest } from '@/lib/api'

/** The tests the parent page renders Variance rows for: Mk1-born container
 *  parents only. undefined (SENAITE-born, legacy, vial pages, not loaded
 *  yet) leaves the analysis table exactly as today, chips included. */
export function parentVarianceRowTests(args: {
  isParentPage: boolean
  externalLimsSystem: string | null | undefined
  containerMode: boolean | null | undefined
  tests: VarianceTest[] | undefined
}): VarianceTest[] | undefined {
  return args.isParentPage && args.externalLimsSystem === 'mk1' && args.containerMode
    ? args.tests
    : undefined
}

/** Pills shown before "+N more" (ponytail: a count cap, no line measuring). */
export const VARIANCE_PILL_CAP = 8

const IDENTITY_KW = /(^HPLC-ID$|^ID_|-ID$|^HPLC-IDENTITY$)/i

function showUnit(unit: string | null): string {
  return unit && unit.toLowerCase() !== 'text' ? unit : ''
}

/** A value as the lab reads it: identity as its verdict, a blank as a dash. */
export function formatRunValue(v: VarianceRunValue): string {
  if (IDENTITY_KW.test(v.keyword)) {
    if (v.conforms === true) return 'Conforms'
    if (v.conforms === false) return 'Does not conform'
  }
  const raw = String(v.value ?? '').trim()
  return raw || '–'
}

/** Value plus its unit ("98 %", "11 mg", "Conforms"). */
export function formatRunValueWithUnit(v: VarianceRunValue): string {
  const text = formatRunValue(v)
  const unit = showUnit(v.unit)
  return unit && text !== '–' && !IDENTITY_KW.test(v.keyword) ? `${text} ${unit}` : text
}

/** The unit printed once after the pills: a one-analysis test whose runs
 *  share one unit. null otherwise (HPLC and multi-analysis tests carry
 *  units inside each pill). */
export function sharedUnit(test: VarianceTest): string | null {
  if (test.is_hplc) return null
  const units = new Set<string>()
  for (const run of test.runs) {
    if (run.values.length > 1) return null
    for (const v of run.values) units.add(showUnit(v.unit))
  }
  const [only] = [...units]
  return units.size === 1 && only ? only : null
}

/** The text inside one pill after "Vial n". */
export function pillValueText(run: VarianceRun, test: VarianceTest): string {
  if (test.is_hplc || run.values.length > 1) {
    // HPLC: identity, purity, quantity in slot order; heavy metals and other
    // multi-analysis tests: each element with its unit.
    return run.values
      .map(v =>
        test.is_hplc
          ? formatRunValueWithUnit(v)
          : `${v.label ?? v.keyword} ${formatRunValueWithUnit(v)}`
      )
      .join(' · ')
  }
  const [only] = run.values
  return only ? formatRunValue(only) : '–'
}
