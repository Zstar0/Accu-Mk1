import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TrackingLink } from '../TrackingLink'

describe('TrackingLink', () => {
  it('renders an anchor to the tracking url', () => {
    render(
      <TrackingLink
        trackingNumber="1Z999"
        trackingUrl="https://ups.test/1Z999"
      />
    )
    const a = screen.getByRole('link', { name: '1Z999' })
    expect(a).toHaveAttribute('href', 'https://ups.test/1Z999')
    expect(a).toHaveAttribute('target', '_blank')
  })

  it('stops click propagation (row onClick must not fire)', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <TrackingLink
          trackingNumber="1Z999"
          trackingUrl="https://ups.test/1Z999"
        />
      </div>
    )
    screen.getByRole('link', { name: '1Z999' }).click()
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('renders plain text when there is no url', () => {
    render(<TrackingLink trackingNumber="1Z999" trackingUrl={null} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('1Z999')).toBeTruthy()
  })

  it('renders a dash when there is no number', () => {
    render(<TrackingLink trackingNumber={null} trackingUrl={null} />)
    expect(screen.getByText('—')).toBeTruthy()
  })
})
