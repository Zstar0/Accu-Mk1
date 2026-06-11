import { useState, useCallback, useEffect, useRef } from 'react'
import {
  listSubSamples,
  createSubSample,
  updateSubSample,
  deleteSubSample,
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
  // Defaults false (legacy) until the first listSubSamples refresh resolves.
  const [containerMode, setContainerMode] = useState(false)

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
      setContainerMode(data.parent.container_mode ?? false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [parent.sample_id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveNewVial = useCallback(
    async (
      photoBytes: Uint8Array,
      remarks?: string,
    ): Promise<{ sampleId: string }> => {
      const photoBase64 = bytesToBase64(photoBytes)
      const isFirstVialEver =
        isParentInPreReceivedState && !vials.some(v => v.isThisSession)

      // Single-vial check-in policy (LEGACY families): the first vial of a
      // never-received parent becomes the parent itself. Photo + remarks land
      // on the parent AR; no sub-sample row is created. Sub-samples represent
      // vials *beyond* the first (the parent is vial 1). See the design doc's
      // "Single-vial check-in policy" section under Save semantics.
      //
      // CONTAINER families (container-parent design): the parent is a pure
      // report depository and never a physical vial — the first photo still
      // transitions the parent AR to received (bare: no photo/remarks on it),
      // but the vial itself becomes S01 via the normal sub-sample path below.
      if (isFirstVialEver) {
        if (containerMode) {
          await receiveSenaiteSample(parent.uid, parent.sample_id, null, null)
          setParentReceivedThisSession(true)
          // fall through: this physical vial is S01, a real sub-sample
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
    editSessionVial,
    deleteSessionVial,
  }
}
