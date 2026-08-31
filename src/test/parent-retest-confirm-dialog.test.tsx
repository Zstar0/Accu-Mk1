/**
 * Published-parent-retest ruling (2026-08-28): when any retest target is a
 * PUBLISHED parent row, the confirm dialog must say what actually happens —
 * the published value stays live on the certificate until the retested
 * result is promoted and verified over it — instead of the un-promote copy
 * that only applies to verified/awaiting rows.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ParentRetestConfirmDialog,
  type ParentRetestConfirmState,
} from '@/components/senaite/ParentRetestConfirmDialog'

function renderDialog(state: ParentRetestConfirmState) {
  return render(
    <ParentRetestConfirmDialog
      state={state}
      pending={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
}

const baseState: ParentRetestConfirmState = {
  titles: ['Bacteria Growth'],
  keywords: ['STER_BACT'],
  impact: { sourceCount: 1, vialIds: ['PB-0486-S04'] },
}

describe('ParentRetestConfirmDialog — published targets', () => {
  it('published target: names the published consequence, not the un-promote copy', () => {
    renderDialog({ ...baseState, publishedTitles: ['Bacteria Growth'] })
    expect(
      screen.getByText(/published value stays on the issued certificate/i)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Published COAs are not affected/i)
    ).not.toBeInTheDocument()
  })

  it('no published targets: existing copy unchanged', () => {
    renderDialog(baseState)
    expect(
      screen.getByText(/Published COAs are not affected/i)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/published value stays on the issued certificate/i)
    ).not.toBeInTheDocument()
  })
})
