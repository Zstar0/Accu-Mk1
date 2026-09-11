import { useCallback, useEffect, useRef, useState } from 'react'
import { lookupSenaiteSample, type SenaiteLookupResult } from '@/lib/api'

interface FetchState {
  /** The sample id this state was fetched for (for keyed comparison). */
  forSampleId: string | null
  details: SenaiteLookupResult | null
  loading: boolean
  error: string | null
  /** Non-destructive failure of an in-place refresh: `details` still holds the
   *  last good payload, which may now be stale. */
  refreshError: string | null
}

const INITIAL: FetchState = {
  forSampleId: null,
  details: null,
  loading: true,
  error: null,
  refreshError: null,
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

  // The id the hook is currently mounted on. Written from the mount effect
  // (which commits long before any network resolution), read by both fetch
  // paths so a response for a previous parent is discarded rather than
  // painted over the current one.
  const latestIdRef = useRef(parentSampleId)

  // Shared by the mount effect and refresh(). Never writes a "loading" state:
  // a refresh triggered by an inline control (the priority row's assign) must
  // not unmount the panel behind the user's cursor — the visible values just
  // swap when the new payload lands.
  //
  // The two modes differ only in how failure is handled. On 'mount' there is
  // nothing to preserve, so the error replaces the (absent) payload. On
  // 'refresh' the panel is already showing good data: a transient backend
  // failure must NOT null `details` or set `error`/`loading` (the panel
  // early-returns on both), so it lands in `refreshError` instead.
  const fetchDetails = useCallback(
    (mode: 'mount' | 'refresh', isCancelled: () => boolean = () => false) => {
      const idAtCall = parentSampleId
      const isStaleOrCancelled = () =>
        isCancelled() || idAtCall !== latestIdRef.current
      return lookupSenaiteSample(idAtCall)
        .then(result => {
          if (isStaleOrCancelled()) return
          setState({
            forSampleId: idAtCall,
            details: result,
            loading: false,
            error: null,
            refreshError: null,
          })
        })
        .catch((e: unknown) => {
          if (isStaleOrCancelled()) return
          const msg = e instanceof Error ? e.message : String(e)
          if (mode === 'refresh') {
            setState(prev => ({ ...prev, refreshError: msg }))
            return
          }
          setState({
            forSampleId: idAtCall,
            details: null,
            loading: false,
            error: msg,
            refreshError: null,
          })
        })
    },
    [parentSampleId]
  )

  useEffect(() => {
    latestIdRef.current = parentSampleId
    let cancelled = false
    void fetchDetails('mount', () => cancelled)
    return () => {
      cancelled = true
    }
  }, [fetchDetails, parentSampleId])

  /** Re-read the parent's payload in place (e.g. after a priority assign, so
   *  the effective value and its source refresh without a remount). */
  const refresh = useCallback(() => {
    void fetchDetails('refresh')
  }, [fetchDetails])

  // If the parent sampleId changed since the last completed fetch, the cached
  // state is stale — surface it as still-loading so the UI doesn't flash old
  // data for a different parent.
  const isStale = state.forSampleId !== parentSampleId
  return {
    details: isStale ? null : state.details,
    loading: isStale ? true : state.loading,
    error: isStale ? null : state.error,
    refreshError: isStale ? null : state.refreshError,
    refresh,
  }
}
