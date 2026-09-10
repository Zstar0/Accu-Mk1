import { useCallback, useEffect, useState } from 'react'
import { lookupSenaiteSample, type SenaiteLookupResult } from '@/lib/api'

interface FetchState {
  /** The sample id this state was fetched for (for keyed comparison). */
  forSampleId: string | null
  details: SenaiteLookupResult | null
  loading: boolean
  error: string | null
}

const INITIAL: FetchState = {
  forSampleId: null,
  details: null,
  loading: true,
  error: null,
}

/**
 * Lightweight presentation hook: fetches the parent sample's full SENAITE
 * metadata (client, contact, profiles, analytes, etc.) so the wizard can
 * render the same context the legacy Step 2 detail panel showed.
 *
 * Intentionally separate from useReceiveWizard — this is read-only,
 * presentation-only data and shouldn't block save flows on its loading state.
 *
 * Uses a single combined state to avoid cascading setState calls inside the
 * effect (eslint react-hooks/set-state-in-effect). When the sampleId changes,
 * the next render derives a fresh "loading" state from the mismatch between
 * `parentSampleId` and `state.forSampleId`, and the effect only writes state
 * from the async resolution.
 */
export function useParentSampleDetails(parentSampleId: string) {
  const [state, setState] = useState<FetchState>(INITIAL)

  // Shared by the mount effect and refresh(). Never writes a "loading" state:
  // a refresh triggered by an inline control (the priority row's assign) must
  // not unmount the panel behind the user's cursor — the visible values just
  // swap when the new payload lands.
  const fetchDetails = useCallback(
    (isCancelled: () => boolean = () => false) =>
      lookupSenaiteSample(parentSampleId)
        .then(result => {
          if (isCancelled()) return
          setState({
            forSampleId: parentSampleId,
            details: result,
            loading: false,
            error: null,
          })
        })
        .catch((e: unknown) => {
          if (isCancelled()) return
          setState({
            forSampleId: parentSampleId,
            details: null,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          })
        }),
    [parentSampleId]
  )

  useEffect(() => {
    let cancelled = false
    void fetchDetails(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [fetchDetails])

  /** Re-read the parent's payload in place (e.g. after a priority assign, so
   *  the effective value and its source refresh without a remount). */
  const refresh = useCallback(() => {
    void fetchDetails()
  }, [fetchDetails])

  // If the parent sampleId changed since the last completed fetch, the cached
  // state is stale — surface it as still-loading so the UI doesn't flash old
  // data for a different parent.
  const isStale = state.forSampleId !== parentSampleId
  return {
    details: isStale ? null : state.details,
    loading: isStale ? true : state.loading,
    error: isStale ? null : state.error,
    refresh,
  }
}
