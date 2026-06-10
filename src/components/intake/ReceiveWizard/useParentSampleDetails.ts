import { useEffect, useState } from 'react'
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

  useEffect(() => {
    let cancelled = false

    lookupSenaiteSample(parentSampleId)
      .then(result => {
        if (cancelled) return
        setState({
          forSampleId: parentSampleId,
          details: result,
          loading: false,
          error: null,
        })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({
          forSampleId: parentSampleId,
          details: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        })
      })

    return () => {
      cancelled = true
    }
  }, [parentSampleId])

  // If the parent sampleId changed since the last completed fetch, the cached
  // state is stale — surface it as still-loading so the UI doesn't flash old
  // data for a different parent.
  const isStale = state.forSampleId !== parentSampleId
  return {
    details: isStale ? null : state.details,
    loading: isStale ? true : state.loading,
    error: isStale ? null : state.error,
  }
}
