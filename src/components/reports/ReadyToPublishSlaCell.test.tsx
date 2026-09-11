import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ReadyRow } from '@/lib/api'
import { SlaCell } from '@/components/reports/ReadyToPublishReport'

const row: ReadyRow = {
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
  lines: { total: 1, verified: 1, pending: [] },
  priority: 'normal',
  sla: {
    tier: 'Standard',
    target_minutes: 2880,
    business_hours_only: true,
    elapsed_minutes: 600,
    remaining_minutes: 2280,
    breached: false,
    color: 'green',
  },
  hold: null,
}

describe('Ready to Publish SlaCell', () => {
  it('hovers the shared SLA breakdown card with tier, target and received', async () => {
    render(
      <TooltipProvider>
        <SlaCell row={row} />
      </TooltipProvider>
    )
    const trigger = screen.getByTestId('rtp-sla')
    fireEvent.pointerMove(trigger)
    fireEvent.mouseEnter(trigger)
    fireEvent.focus(trigger)
    const card = await screen.findAllByText(/Standard/)
    expect(card.length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/Received/)).length).toBeGreaterThan(0)
  })
})
