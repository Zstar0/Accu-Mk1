import { describe, it, expect, vi, beforeEach } from 'vitest'

const receiveSenaiteSample = vi.fn()

vi.mock('@/lib/api', () => ({
  receiveSenaiteSample: (...args: unknown[]) => receiveSenaiteSample(...args),
}))

import { completeCheckIn } from '@/lib/complete-checkin'

describe('completeCheckIn', () => {
  beforeEach(() => vi.clearAllMocks())

  it('receives only samples with >=1 vial', async () => {
    await completeCheckIn([
      { uid: 'u1', sampleId: 'PB-0075', vialCount: 2 },
      { uid: 'u2', sampleId: 'BW-0014', vialCount: 0 },
    ])
    expect(receiveSenaiteSample).toHaveBeenCalledWith('u1', 'PB-0075', null, null)
    expect(receiveSenaiteSample).not.toHaveBeenCalledWith('u2', 'BW-0014', null, null)
    expect(receiveSenaiteSample).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no samples have vials', async () => {
    await completeCheckIn([{ uid: 'u1', sampleId: 'PB-0075', vialCount: 0 }])
    expect(receiveSenaiteSample).not.toHaveBeenCalled()
  })

  it('receives every vialed sample with a bare receive', async () => {
    await completeCheckIn([
      { uid: 'u1', sampleId: 'PB-0075', vialCount: 1 },
      { uid: 'u2', sampleId: 'BW-0014', vialCount: 3 },
    ])
    expect(receiveSenaiteSample).toHaveBeenCalledTimes(2)
    expect(receiveSenaiteSample).toHaveBeenNthCalledWith(1, 'u1', 'PB-0075', null, null)
    expect(receiveSenaiteSample).toHaveBeenNthCalledWith(2, 'u2', 'BW-0014', null, null)
  })
})
