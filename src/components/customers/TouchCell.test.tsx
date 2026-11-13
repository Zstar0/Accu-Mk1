import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CrmTouch } from '@/lib/api'
import { TouchCell, TouchCard } from './TouchCell'

const NOW = new Date('2026-10-19T18:00:00Z')
const crm = (over: Partial<CrmTouch> = {}): CrmTouch => ({
  state: 'ok',
  at: '2026-10-12T15:00:00Z',
  type: 'email',
  direction: 'inbound',
  who: 'Zack',
  title: 'Re: COA',
  preview: 'thanks',
  lead_name: 'UMS Rx',
  lead_url: 'https://app.close.com/lead/x/',
  stale: false,
  reason: null,
  ...over,
})

describe('TouchCell', () => {
  it('renders the date, the age and opens on click without bubbling', async () => {
    const onOpen = vi.fn()
    const onRow = vi.fn()
    render(
      <table>
        <tbody>
          <tr onClick={onRow}>
            <td>
              <TouchCell
                kind="crm"
                touch={crm()}
                tz="America/Los_Angeles"
                now={NOW}
                onOpen={onOpen}
              />
            </td>
          </tr>
        </tbody>
      </table>
    )
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent('Oct 12')
    expect(btn).toHaveTextContent('7 d')
    await userEvent.click(btn)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onRow).not.toHaveBeenCalled()
  })

  it('shows none, n/a and a loading state', () => {
    const { rerender } = render(
      <TouchCell
        kind="support"
        touch={{ state: 'none', stale: false, reason: null }}
        tz="UTC"
        onOpen={vi.fn()}
      />
    )
    expect(screen.getByText('none')).toBeInTheDocument()
    rerender(
      <TouchCell
        kind="support"
        touch={{ state: 'unavailable', stale: false, reason: 'not_configured' }}
        tz="UTC"
        onOpen={vi.fn()}
      />
    )
    expect(screen.getByText('n/a')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(
      <TouchCell kind="support" touch={undefined} tz="UTC" onOpen={vi.fn()} />
    )
    expect(screen.getByLabelText(/loading/i)).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })

  it('TouchCard lists the CRM fields and the stale note', () => {
    render(<TouchCard kind="crm" touch={crm({ stale: true })} />)
    for (const t of ['Zack', 'Re: COA', 'thanks', 'UMS Rx', /cached/i])
      expect(screen.getByText(t)).toBeInTheDocument()
  })
})
