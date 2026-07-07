import { receiveSenaiteSample } from '@/lib/api'

export interface CompleteCheckInSample {
  uid: string
  sampleId: string
  vialCount: number
}

// Transitions each vialed sample sample_due → sample_received via a bare
// receive (no photo/remarks — container photos live on the vials). Samples
// with no vials are skipped so empty samples stay Due. receiveSenaiteSample is
// idempotent, so re-running is safe. Sequential await, never parallel: SENAITE
// runs a single Zope core and dislikes concurrent receive bursts.
export async function completeCheckIn(samples: CompleteCheckInSample[]): Promise<void> {
  for (const sample of samples) {
    if (sample.vialCount <= 0) continue
    await receiveSenaiteSample(sample.uid, sample.sampleId, null, null)
  }
}
