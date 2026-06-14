// Classifies whether an analysis service is part of the HPLC analyte-measurement
// family — identity / purity / quantity that is driven by a parent's analyte
// slots and managed through the Analytes-card Replace flow. The Manage Analyses
// overlay hides these by default so identity/purity/quantity are only ever
// changed via Replace (manual add/remove there leaves the slot field and the
// slot-generic vial rows out of sync — the "PUR/QTY trap").

// Aggregate/generic HPLC analyte services (exact keywords from the catalog).
// Listed explicitly rather than wildcarding HPLC-*/BLEND-* so a future non-
// analyte HPLC/blend service isn't hidden by accident.
const IDENTITY_EXACT = new Set(['HPLC-ID', 'BLEND-IDENT'])
const PURITY_EXACT = new Set(['HPLC-PUR', 'BLEND-PUR'])
const QUANTITY_EXACT = new Set(['PEPT-TOTAL'])

const PER_ANALYTE = /^ANALYTE-[1-4]-(IDENT|PUR|QTY)$/

/** True for the HPLC analyte-measurement family: identity (ID_*, HPLC-ID,
 *  BLEND-IDENT, ANALYTE-N-IDENT), purity (PUR_*, HPLC-PUR, BLEND-PUR,
 *  ANALYTE-N-PUR) and quantity (QTY_*, PEPT-Total, ANALYTE-N-QTY). Micro
 *  (ENDO-*, STER-*, PCR-*), moisture (KF) and everything else → false. */
export function isHplcAnalyteService(keyword: string | null | undefined): boolean {
  if (!keyword) return false
  const k = keyword.toUpperCase()
  if (k.startsWith('ID_') || k.startsWith('PUR_') || k.startsWith('QTY_')) return true
  if (PER_ANALYTE.test(k)) return true
  return IDENTITY_EXACT.has(k) || PURITY_EXACT.has(k) || QUANTITY_EXACT.has(k)
}
