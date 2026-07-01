import { useState, useCallback, useEffect, useRef } from 'react'
import {
  listSubSamples,
  ensureParentSampleRow,
  createSubSample,
  updateSubSample,
  deleteSubSample,
  createSubSamplesBulk,
  getVialPlan,
  receiveSenaiteSample,
  seedSubSamplePhoto,
  type SubSample,
} from '@/lib/api'

export interface ParentInfo {
  uid: string
  sample_id: string
  status: string | null
}

interface SessionVial {
  sub: SubSample
  isThisSession: boolean
}

const PRE_RECEIVED_STATES = new Set<string | null>([
  null,
  '',
  'sample_due',
  'sample_registered',
  'to_be_sampled',
])

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    )
  }
  return btoa(binary)
}

export function useReceiveWizard(parent: ParentInfo) {
  const [vials, setVials] = useState<SessionVial[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Tracks whether the parent has been transitioned to received during this
  // wizard session. Combined with the initial parent.status, this gates
  // whether we dual-fire on the next save.
  const [parentReceivedThisSession, setParentReceivedThisSession] = useState(false)
  // Parent's assignment_role pulled from listSubSamples response. Defaults
  // to 'hplc' (matches DB default) until the first refresh resolves.
  const [parentRole, setParentRole] = useState<string | null>('hplc')
  // Container family (parent is a pure report depository — container-parent
  // design): drives vial numbering and the first-vial check-in policy.
  // Defaults false (legacy) for display until the ensure call resolves; the
  // first-vial SAVE decision never reads this state — it awaits ensureRef,
  // the authoritative server answer (a brand-new family has no lims_samples
  // row yet, so the list endpoint's fallback would wrongly report false).
  const [containerMode, setContainerMode] = useState(false)
  // Resolves to the authoritative container_mode. On failure resolves false
  // (legacy path — the safe default; a SENAITE outage fails the save anyway).
  const ensureRef = useRef<Promise<boolean> | null>(null)

  // Track which sub-samples were created in this wizard session so they can
  // be flagged for the print step at the end. Keyed by sample_id (stable
  // primary identifier on the SubSample model).
  const sessionSampleIdsRef = useRef<Set<string>>(new Set())

  const isParentInPreReceivedState =
    PRE_RECEIVED_STATES.has(parent.status) && !parentReceivedThisSession

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listSubSamples(parent.sample_id)
      setVials(
        data.sub_samples.map(s => ({
          sub: s,
          isThisSession: sessionSampleIdsRef.current.has(s.sample_id),
        })),
      )
      // Backend defaults assignment_role to 'hplc' on lims_samples; preserve
      // that locally when the response carries null (e.g. cold-cache parent).
      setParentRole(data.parent.assignment_role ?? 'hplc')
      // containerMode is set ONLY by the mount-time ensure call (authoritative;
      // the flag never changes after row creation). The list endpoint's
      // missing-parent fallback reports false and must not downgrade the
      // display value if this refresh races ahead of ensure's commit.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [parent.sample_id])

  useEffect(() => {
    // Materialize the parent row server-side so container_mode is decided
    // (state-gated at upsert) BEFORE the first vial can be saved.
    ensureRef.current = ensureParentSampleRow(parent.sample_id)
      .then(p => {
        setContainerMode(p.container_mode ?? false)
        return p.container_mode ?? false
      })
      .catch(() => false)
    void refresh()
  }, [refresh, parent.sample_id])

  const saveNewVial = useCallback(
    async (
      photoBytes: Uint8Array,
      remarks?: string,
    ): Promise<{ sampleId: string }> => {
      const photoBase64 = bytesToBase64(photoBytes)
      const isFirstVialEver =
        isParentInPreReceivedState && !vials.some(v => v.isThisSession)
      // Authoritative mode — never the (possibly still-default) state value.
      const isContainer = ensureRef.current ? await ensureRef.current : containerMode

      // Single-vial check-in policy (LEGACY families): the first vial of a
      // never-received parent becomes the parent itself. Photo + remarks land
      // on the parent AR; no sub-sample row is created. Sub-samples represent
      // vials *beyond* the first (the parent is vial 1). See the design doc's
      // "Single-vial check-in policy" section under Save semantics.
      //
      // CONTAINER families (container-parent design): the parent is a pure
      // report depository and never a physical vial. Under deferred check-in
      // the first vial does NOT transition the parent AR — the parent stays
      // sample_due and is received later via the explicit "Complete Check-In"
      // step. The vial itself becomes S01 via the normal sub-sample path below.
      if (isFirstVialEver) {
        if (isContainer) {
          // Deferred check-in: the container parent stays sample_due here.
          // The parent AR is received later via the explicit "Complete
          // Check-In" step; this first physical vial still becomes S01 via
          // the normal sub-sample path below.
        } else {
          await receiveSenaiteSample(
            parent.uid,
            parent.sample_id,
            photoBase64,
            remarks ?? null,
          )
          // The parent photo lives on the SENAITE AR, whose attachment listing
          // has a read-after-write window — seed the cache with the captured
          // bytes so Vial 1's thumbnail shows immediately instead of racing the
          // photo-endpoint round-trip.
          seedSubSamplePhoto(parent.sample_id, photoBytes)
          setParentReceivedThisSession(true)
          return { sampleId: parent.sample_id }
        }
      }

      // Subsequent vials → sub-samples. SENAITE assigns the next -SNN id.
      const sub = await createSubSample({
        parentSampleId: parent.sample_id,
        photoBase64,
        remarks,
      })

      seedSubSamplePhoto(sub.sample_id, photoBytes)
      sessionSampleIdsRef.current.add(sub.sample_id)
      setVials(prev => [...prev, { sub, isThisSession: true }])
      return { sampleId: sub.sample_id }
    },
    [
      isParentInPreReceivedState,
      containerMode,
      parent.uid,
      parent.sample_id,
      vials,
    ],
  )

  const saveNewVialsBulk = useCallback(
    async (
      photoBytes: Uint8Array,
      remarks: string | undefined,
      count: number,
    ): Promise<{ created: number }> => {
      const photoBase64 = bytesToBase64(photoBytes)
      let remaining = count

      // The first vial of a never-received parent goes through the parent-
      // receive transition (legacy: becomes the parent; container: bare receive
      // + S01). Reuse saveNewVial for that one so the one-time logic isn't
      // duplicated, then bulk-create the remainder as sub-samples.
      const isFirstVialEver =
        isParentInPreReceivedState && !vials.some(v => v.isThisSession)
      if (isFirstVialEver) {
        await saveNewVial(photoBytes, remarks)
        remaining -= 1
      }

      if (remaining > 0) {
        const result = await createSubSamplesBulk({
          parentSampleId: parent.sample_id,
          photoBase64,
          count: remaining,
          remarks,
        })
        for (const sub of result.created) {
          seedSubSamplePhoto(sub.sample_id, photoBytes)
          sessionSampleIdsRef.current.add(sub.sample_id)
        }
        setVials(prev => [
          ...prev,
          ...result.created.map(sub => ({ sub, isThisSession: true })),
        ])
      }

      // Run auto-assignment over the freshly created vials, then refresh so the
      // assigned roles surface in the list. Best-effort: if IS is unreachable
      // the Assignment tab assigns on demand — don't fail the save over it.
      try {
        await getVialPlan(parent.sample_id)
        await refresh()
      } catch {
        /* auto-assign is best-effort here */
      }

      return { created: count }
    },
    [isParentInPreReceivedState, parent.sample_id, vials, saveNewVial, refresh],
  )

  const editSessionVial = useCallback(
    async (sampleId: string, photoBytes?: Uint8Array, remarks?: string) => {
      const photoBase64 = photoBytes ? bytesToBase64(photoBytes) : undefined
      const sub = await updateSubSample(sampleId, { photoBase64, remarks })
      // Retake within the session: refresh the cached thumbnail to the new shot.
      if (photoBytes) seedSubSamplePhoto(sampleId, photoBytes)
      setVials(prev =>
        prev.map(v =>
          v.sub.sample_id === sampleId ? { sub, isThisSession: true } : v,
        ),
      )
      return sub
    },
    [],
  )

  const deleteSessionVial = useCallback(async (sampleId: string) => {
    await deleteSubSample(sampleId)
    sessionSampleIdsRef.current.delete(sampleId)
    setVials(prev => prev.filter(v => v.sub.sample_id !== sampleId))
  }, [])

  const sessionVials = vials.filter(v => v.isThisSession).map(v => v.sub)

  return {
    vials,
    sessionVials,
    loading,
    error,
    parentReceived: !isParentInPreReceivedState,
    parentReceivedThisSession,
    parentRole,
    containerMode,
    refresh,
    saveNewVial,
    saveNewVialsBulk,
    editSessionVial,
    deleteSessionVial,
  }
}
