/**
 * Which bench a worksheet item belongs to. Worksheets 2.0 (spec
 * 2026-09-18-endo-worksheet-design) hangs a bench-specific view off this:
 * endo today, PCR next, then HPLC, split by instrument and method. The vial's
 * catalog role is the truth; parent-sample items (legacy "<order> E"
 * worksheets) fall back to their analyses' keywords.
 */
export type BenchKind = 'endo' | 'pcr' | 'sterility' | 'hm' | 'hplc'

const ROLE_KIND: Record<string, BenchKind> = {
  endo: 'endo',
  endo85: 'endo',
  pcr: 'pcr',
  ster: 'sterility',
  usp71: 'sterility',
  hm: 'hm',
  hplc: 'hplc',
  fentanyl: 'hplc',
}

export interface BenchKindItem {
  assignment_role?: string | null
  analyses: { keyword: string | null }[]
}

export function benchKindForItem(item: BenchKindItem): BenchKind | null {
  const role = item.assignment_role ?? ''
  const byRole = ROLE_KIND[role]
  if (byRole) return byRole
  for (const a of item.analyses) {
    const k = a.keyword ?? ''
    if (/ENDO/i.test(k)) return 'endo'
    if (/PCR/i.test(k)) return 'pcr'
    if (/USP71|STERILITY[_-]USP/i.test(k)) return 'sterility'
    if (/PURITY|IDENTITY|^ID_|^HPLC/i.test(k)) return 'hplc'
  }
  return null
}

/** One kind when every item agrees, 'mixed' otherwise, null when empty. */
export function worksheetKind(
  items: BenchKindItem[]
): BenchKind | 'mixed' | null {
  if (!items.length) return null
  const kinds = new Set(items.map(benchKindForItem))
  if (kinds.size !== 1) return 'mixed'
  const only = [...kinds][0]
  return only ?? 'mixed'
}
