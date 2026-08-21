/** Which service catalog the Manage Analyses "Add analysis" picker reads.
 *  Native (Accu-Mk1) VIAL pages list local mk1-origin services (the SENAITE
 *  proxy never shows services without a senaite_uid); everything else keeps
 *  the SENAITE catalog. Parent pages keep SENAITE here — native PROFILES have
 *  their own block (NativeManageAnalysesBlock). */
export function pickerSourceFor(
  parentSampleId: string | null,
  sampleUid: string | null | undefined
): 'native' | 'senaite' {
  return parentSampleId !== null &&
    !!sampleUid &&
    sampleUid.startsWith('mk1://')
    ? 'native'
    : 'senaite'
}
