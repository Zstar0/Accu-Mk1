/**
 * Phase 3 (mk1-native-analyses): SampleDetails initially loads a sub-sample's
 * analyses from SENAITE, then swaps them for the Mk1-sourced rows (which carry
 * an `mk1:` uid prefix). That swap was a one-shot effect; any later refetch that
 * reset the analyses back to SENAITE (e.g. after a result-entry transition) left
 * the view showing the legacy SENAITE clones — the displayed value "disappeared"
 * and unrelated cloned analyses reappeared.
 *
 * This predicate lets the swap effect self-heal: it re-runs whenever the analyses
 * are SENAITE-sourced again, and no-ops once they are Mk1-sourced (so it can be
 * a stable dependency without looping).
 *
 * A list is SENAITE-sourced (needs the swap) when it is non-empty and NO row
 * carries the `mk1:` uid prefix. Once swapped, every row is `mk1:`-prefixed, so
 * this returns false. An empty list returns false (nothing to swap).
 */
export function needsMk1AnalysesSwap(analyses: { uid?: string | null }[]): boolean {
  return analyses.length > 0 && !analyses.some(a => a.uid?.startsWith('mk1:'))
}
