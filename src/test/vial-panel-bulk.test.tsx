import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VialPanel } from '@/components/intake/ReceiveWizard/VialPanel'
import type { SubSample } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, fetchSubSamplePhotoUrl: vi.fn().mockResolvedValue(null) }
})
vi.mock('@/components/samples/usePrintLabel', () => ({
  usePrintLabel: () => ({ printLabel: vi.fn(), target: null }),
}))

const baseProps = {
  parentSampleId: 'P-0993',
  parentDetails: null,
  editingSub: null,
  loading: false,
  error: null,
  onSaveNew: vi.fn().mockResolvedValue({ sampleId: 'P-0993-S01' }),
  onSaveNewBulk: vi.fn().mockResolvedValue({ created: 3 }),
  onSaveEdit: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
}

function qtyInput() {
  return screen.getByLabelText(/number of identical vials/i) as HTMLInputElement
}

describe('VialPanel — bulk quantity (Feature B)', () => {
  it('shows a Quantity input defaulting to 1, with the button reading "Save vial"', () => {
    render(<VialPanel {...baseProps} />)
    expect(qtyInput().value).toBe('1')
    expect(screen.getByRole('button', { name: /^Save vial$/ })).toBeTruthy()
  })

  it('updates the button label to "Save N vials" and clamps to 1..50', () => {
    render(<VialPanel {...baseProps} />)
    const qty = qtyInput()

    fireEvent.change(qty, { target: { value: '10' } })
    expect(qty.value).toBe('10')
    expect(screen.getByRole('button', { name: /Save 10 vials/ })).toBeTruthy()

    fireEvent.change(qty, { target: { value: '99' } }) // over max
    expect(qty.value).toBe('50')

    fireEvent.change(qty, { target: { value: '0' } }) // under min
    expect(qty.value).toBe('1')
  })

  it('hides the Quantity input when editing an existing vial', () => {
    const editingSub = {
      id: 2,
      sample_id: 'P-0993-S02',
      parent_sample_id: 'P-0993',
      vial_sequence: 2,
      received_at: '2026-06-25T00:00:00Z',
      received_by_user_id: 1,
      photo_external_uid: null,
      remarks: '',
      assignment_role: 'xtra',
      assignment_kind: null,
      external_lims_uid: 'mk1://x',
    } as SubSample
    render(<VialPanel {...baseProps} editingSub={editingSub} canDelete />)
    expect(screen.queryByLabelText(/number of identical vials/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeTruthy()
  })
})
