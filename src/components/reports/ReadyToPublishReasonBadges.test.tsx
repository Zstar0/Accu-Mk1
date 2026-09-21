import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ReadyRow } from '@/lib/api'
import { ReasonBadges } from '@/components/reports/ReadyToPublishReport'

const base: ReadyRow = {
  sample_id: 'P-1',
  status: 'verified',
  client: 'Acme',
  order: '7001',
  email: null,
  created_at: null,
  received_at: '2026-09-02T12:00:00',
  lot: null,
  analytes: ['BPC-157'],
  reasons: ['all_verified'],
  flags: [],
  lines: { total: 2, verified: 2, pending: [] },
  priority: 'normal',
  sla: null,
  hold: null,
}

function renderBadges(row: ReadyRow) {
  return render(
    <TooltipProvider>
      <ReasonBadges row={row} />
    </TooltipProvider>
  )
}

describe('Ready to Publish reason badges', () => {
  it('chips a sample whose primary COA is already out (waiting_for_addon_results)', () => {
    renderBadges({ ...base, status: 'waiting_for_addon_results', lines: { total: 2, verified: 1, pending: ['STERILITY-PCR'] }, reasons: ['flag_partial'] })
    expect(screen.getByTestId('rtp-partial')).toHaveTextContent('Partially Published')
  })

  it('keeps the chip when the add-on has since verified (second publish owed)', () => {
    renderBadges({ ...base, status: 'waiting_for_addon_results' })
    expect(screen.getByTestId('rtp-partial')).toBeInTheDocument()
    expect(screen.getByText('All lines verified')).toBeInTheDocument()
  })

  it('shows no chip for a sample that has never been published', () => {
    renderBadges(base)
    expect(screen.queryByTestId('rtp-partial')).toBeNull()
  })
})
