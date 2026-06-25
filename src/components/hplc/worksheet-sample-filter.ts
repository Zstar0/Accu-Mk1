import type { WorksheetListItem } from '@/lib/api'

/**
 * True if the worksheet contains a sample whose ID matches the query
 * (case-insensitive substring, trimmed). An empty/whitespace query matches
 * every worksheet — i.e. no sample filtering is applied.
 *
 * Membership is by each item's own `sample_id`, so this matches both parent
 * (e.g. "P-0144") and sub-sample (e.g. "P-0144-S03") ids.
 */
export function worksheetMatchesSampleQuery(
  ws: WorksheetListItem,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return ws.items.some(item => item.sample_id.toLowerCase().includes(q))
}

/**
 * The worksheet (if any) that contains a sample with the given id — exact
 * match on an item's own `sample_id`, so it resolves both parent ("P-0144")
 * and sub-sample ("P-0144-S03") ids. Returns the first match; a falsy id
 * yields undefined.
 */
export function findWorksheetForSample(
  worksheets: WorksheetListItem[],
  sampleId: string | null | undefined,
): WorksheetListItem | undefined {
  if (!sampleId) return undefined
  return worksheets.find(ws => ws.items.some(item => item.sample_id === sampleId))
}
