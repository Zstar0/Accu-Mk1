import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// Mock the API surface the hook touches. Deferred check-in means the FIRST
// vial of a sample_due container parent must NOT call receiveSenaiteSample.
vi.mock('@/lib/api', () => ({
  listSubSamples: vi.fn(),
  ensureParentSampleRow: vi.fn(),
  createSubSample: vi.fn(),
  updateSubSample: vi.fn(),
  deleteSubSample: vi.fn(),
  createSubSamplesBulk: vi.fn(),
  getVialPlan: vi.fn(),
  receiveSenaiteSample: vi.fn(),
  seedSubSamplePhoto: vi.fn(),
}))

import {
  listSubSamples,
  ensureParentSampleRow,
  createSubSample,
  receiveSenaiteSample,
} from '@/lib/api'
import { useReceiveWizard } from '@/components/intake/ReceiveWizard/useReceiveWizard'

const parent = { uid: 'U-1', sample_id: 'PB-0075', status: 'sample_due' }

function subSampleFixture(sampleId: string) {
  return {
    id: 1,
    sample_id: sampleId,
    parent_sample_id: parent.sample_id,
    vial_sequence: 1,
    received_at: '2026-07-01T00:00:00Z',
    received_by_user_id: null,
    photo_external_uid: null,
    remarks: null,
    assignment_role: null,
  }
}

describe('useReceiveWizard — deferred check-in (container first vial)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listSubSamples).mockResolvedValue({
      parent: {
        sample_id: parent.sample_id,
        external_lims_uid: null,
        peptide_name: null,
        status: 'sample_due',
        sub_sample_count: 0,
        last_synced_at: '2026-07-01T00:00:00Z',
        assignment_role: 'hplc',
        container_mode: true,
      },
      sub_samples: [],
    })
    vi.mocked(ensureParentSampleRow).mockResolvedValue({
      sample_id: parent.sample_id,
      external_lims_uid: null,
      peptide_name: null,
      status: 'sample_due',
      sub_sample_count: 0,
      last_synced_at: '2026-07-01T00:00:00Z',
      assignment_role: 'hplc',
      container_mode: true,
    })
    vi.mocked(createSubSample).mockResolvedValue(subSampleFixture('PB-0075-S01'))
  })

  it('saving the first vial of a sample_due container parent does NOT receive the parent, and creates S01', async () => {
    const { result } = renderHook(() => useReceiveWizard(parent))

    // Let mount-time ensure + refresh resolve.
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.saveNewVial(new Uint8Array([1, 2, 3]))
    })

    // Deferred: the parent AR is NOT transitioned to received on first vial.
    expect(receiveSenaiteSample).not.toHaveBeenCalled()
    // The first physical vial still becomes S01 via the sub-sample path.
    expect(createSubSample).toHaveBeenCalledTimes(1)
    expect(createSubSample).toHaveBeenCalledWith(
      expect.objectContaining({ parentSampleId: parent.sample_id }),
    )
    // Parent stays due — not received this session.
    expect(result.current.parentReceivedThisSession).toBe(false)
  })
})
