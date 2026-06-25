import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VialsList } from '@/components/intake/ReceiveWizard/VialsList'
import type { SubSample } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, fetchSubSamplePhotoUrl: vi.fn().mockResolvedValue(null) }
})

function sub(id: string, seq: number, role: string | null): SubSample {
  return {
    id: seq,
    sample_id: id,
    parent_sample_id: 'P-0993',
    vial_sequence: seq,
    received_at: '2026-06-25T00:00:00Z',
    received_by_user_id: 1,
    photo_external_uid: 'mk1://x/y.jpg',
    remarks: null,
    assignment_role: role,
    assignment_kind: null,
    external_lims_uid: 'mk1://x',
  } as SubSample
}

describe('VialsList — every sub-sample vial is editable (Feature A)', () => {
  it('renders a PRIOR-session vial as a clickable button and selects it on click', async () => {
    const onSelect = vi.fn()
    render(
      <VialsList
        vials={[{ sub: sub('P-0993-S03', 3, 'ster'), isThisSession: false }]}
        parentVial={null}
        activeSampleId={null}
        onSelect={onSelect}
        containerMode={true}
      />,
    )
    // No longer shows the old "read-only" affordance for prior vials.
    expect(screen.queryByText(/read-only/i)).toBeNull()
    const btn = screen.getByRole('button', { name: /P-0993-S03/ })
    await userEvent.click(btn)
    expect(onSelect).toHaveBeenCalledWith('P-0993-S03')
  })

  it('still renders this-session vials as clickable buttons', async () => {
    const onSelect = vi.fn()
    render(
      <VialsList
        vials={[{ sub: sub('P-0993-S01', 1, 'hplc'), isThisSession: true }]}
        parentVial={null}
        activeSampleId={null}
        onSelect={onSelect}
        containerMode={true}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /P-0993-S01/ }))
    expect(onSelect).toHaveBeenCalledWith('P-0993-S01')
  })
})
