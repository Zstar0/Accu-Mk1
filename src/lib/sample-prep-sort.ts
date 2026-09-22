/**
 * Client-side sort for the Sample Preps list. The page loads every active prep
 * in one request (limit 500), so sorting in the browser is complete, not a
 * page-local approximation.
 *
 * The page flattens each prep into a PrepSortRow so this stays a pure function
 * of plain values: the SLA number comes from the live SLA snapshot and the
 * creator label from the user directory, neither of which lives on the prep.
 */

export type PrepSortKey =
  | 'sampleId'
  | 'peptide'
  | 'declaredWt'
  | 'targetConc'
  | 'actualConc'
  | 'sla'
  | 'status'
  | 'createdAt'
  | 'createdBy'

export type SortDir = 'asc' | 'desc'

export interface PrepSortRow {
  id: number
  sampleId: string | null
  peptide: string | null
  declaredWt: number | null
  targetConc: number | null
  actualConc: number | null
  /** SLA remaining minutes; negative = over. Null = no SLA clock on this row. */
  slaRemaining: number | null
  /** Index in the page's status list (workflow order). */
  statusRank: number
  createdAt: string
  createdBy: string
}

const VALUE: Record<PrepSortKey, (r: PrepSortRow) => string | number | null> = {
  sampleId: r => r.sampleId,
  peptide: r => r.peptide,
  declaredWt: r => r.declaredWt,
  targetConc: r => r.targetConc,
  actualConc: r => r.actualConc,
  sla: r => r.slaRemaining,
  status: r => r.statusRank,
  createdAt: r => r.createdAt,
  createdBy: r => r.createdBy || null,
}

/** Sorted copy. Empty values go last in BOTH directions, so flipping a column
 *  never buries the real rows under blanks. Ties keep the incoming order
 *  (newest first from the API); Array.prototype.sort is stable. */
export function sortPreps<T extends PrepSortRow>(
  rows: T[],
  key: PrepSortKey,
  dir: SortDir
): T[] {
  const value = VALUE[key]
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1
    if (typeof av === 'number' && typeof bv === 'number')
      return (av - bv) * sign
    // numeric: natural order, so P-999 sorts before P-1000.
    return (
      String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: 'base',
      }) * sign
    )
  })
}
