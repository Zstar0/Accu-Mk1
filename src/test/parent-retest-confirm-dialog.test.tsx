import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ParentRetestConfirmDialog } from '@/components/senaite/ParentRetestConfirmDialog'

const state = {
  titles: ['Heavy Metals'],
  keywords: ['HM'],
  impact: { sourceCount: 2, vialIds: ['P-0120-S01', 'P-0120-S02'] },
}

describe('ParentRetestConfirmDialog', () => {
  it('names the blast radius', () => {
    render(<ParentRetestConfirmDialog state={state} pending={false} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText(/retracts 2 promoted source results/i)).toBeInTheDocument()
    expect(screen.getByText(/P-0120-S01, P-0120-S02/)).toBeInTheDocument()
  })
  it('confirm fires onConfirm', async () => {
    const onConfirm = vi.fn()
    render(<ParentRetestConfirmDialog state={state} pending={false} onCancel={() => {}} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: /^retest$/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
  it('fails closed: zero-impact state disables the action', () => {
    render(
      <ParentRetestConfirmDialog
        state={{ ...state, impact: { sourceCount: 0, vialIds: [] } }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/no promoted source results are visible for this row/i)).toBeInTheDocument()
    expect(screen.getByText(/promotion record may still be loading, or failed to load/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).toBeDisabled()
  })
  it('renders nothing when state is null', () => {
    const { container } = render(
      <ParentRetestConfirmDialog state={null} pending={false} onCancel={() => {}} onConfirm={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })
  it('retest button prevents auto-close: calls onConfirm only, dialog stays open', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ParentRetestConfirmDialog state={state} pending={false} onCancel={onCancel} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: /^retest$/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText(/retracts 2 promoted source results/i)).toBeInTheDocument()
  })
  it('pending state disables both buttons and shows "Retesting…"', () => {
    render(<ParentRetestConfirmDialog state={state} pending={true} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('button', { name: /^retesting/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled()
  })
})
