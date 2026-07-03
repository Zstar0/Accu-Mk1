import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import type { SenaiteAnalysis } from '@/lib/api'

const unpromoteAnalysis = vi.fn()
const unverifyVarianceAnalysis = vi.fn()
vi.mock('@/lib/api', async () => {
  const actual = (await vi.importActual('@/lib/api')) as Record<string, unknown>
  return {
    ...actual,
    unpromoteAnalysis: (...a: unknown[]) => unpromoteAnalysis(...a),
    unverifyVarianceAnalysis: (...a: unknown[]) =>
      unverifyVarianceAnalysis(...a),
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const base = {
  title: 'Purity (HPLC)',
  keyword: 'PURITY-HPLC',
  result: '98.5',
} as unknown as SenaiteAnalysis

describe('canUnlock', () => {
  it('allows a promoted mk1 row that knows its parent', async () => {
    const { canUnlock } = await import('@/components/senaite/AnalysisTable')
    expect(
      canUnlock({
        ...base,
        uid: 'mk1:5',
        review_state: 'promoted',
        promoted_to_parent_id: 9,
      } as SenaiteAnalysis)
    ).toBe(true)
  })
  it('allows a variance_verified mk1 row', async () => {
    const { canUnlock } = await import('@/components/senaite/AnalysisTable')
    expect(
      canUnlock({
        ...base,
        uid: 'mk1:5',
        review_state: 'variance_verified',
        promoted_to_parent_id: null,
      } as SenaiteAnalysis)
    ).toBe(true)
  })
  it('rejects senaite-uid rows, other states, and promoted rows without a parent id', async () => {
    const { canUnlock } = await import('@/components/senaite/AnalysisTable')
    expect(
      canUnlock({
        ...base,
        uid: 'abc123',
        review_state: 'promoted',
        promoted_to_parent_id: 9,
      } as SenaiteAnalysis)
    ).toBe(false)
    expect(
      canUnlock({
        ...base,
        uid: 'mk1:5',
        review_state: 'to_be_verified',
        promoted_to_parent_id: null,
      } as SenaiteAnalysis)
    ).toBe(false)
    expect(
      canUnlock({
        ...base,
        uid: 'mk1:5',
        review_state: 'promoted',
        promoted_to_parent_id: null,
      } as SenaiteAnalysis)
    ).toBe(false)
  })
})

describe('UnlockDialog', () => {
  beforeEach(() => {
    unpromoteAnalysis.mockReset().mockResolvedValue(undefined)
    unverifyVarianceAnalysis.mockReset().mockResolvedValue(undefined)
  })

  it('disables confirm until a reason is typed, then unpromotes with it', async () => {
    const { UnlockDialog } = await import('@/components/senaite/UnlockDialog')
    const onUnlocked = vi.fn()
    render(
      <UnlockDialog
        analysis={
          {
            ...base,
            uid: 'mk1:5',
            review_state: 'promoted',
            promoted_to_parent_id: 9,
          } as SenaiteAnalysis
        }
        open
        onOpenChange={() => {}}
        onUnlocked={onUnlocked}
      />
    )
    const confirm = screen.getByRole('button', { name: /unlock/i })
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/reason/i), 'entry swap')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() =>
      expect(unpromoteAnalysis).toHaveBeenCalledWith(9, 'entry swap')
    )
    expect(unverifyVarianceAnalysis).not.toHaveBeenCalled()
    expect(onUnlocked).toHaveBeenCalled()
  })

  it('routes variance_verified rows to unverify', async () => {
    const { UnlockDialog } = await import('@/components/senaite/UnlockDialog')
    render(
      <UnlockDialog
        analysis={
          {
            ...base,
            uid: 'mk1:5',
            review_state: 'variance_verified',
            promoted_to_parent_id: null,
          } as SenaiteAnalysis
        }
        open
        onOpenChange={() => {}}
        onUnlocked={() => {}}
      />
    )
    await userEvent.type(screen.getByLabelText(/reason/i), 'wrong replicate')
    await userEvent.click(screen.getByRole('button', { name: /unlock/i }))
    await waitFor(() =>
      expect(unverifyVarianceAnalysis).toHaveBeenCalledWith(
        'mk1:5',
        'wrong replicate'
      )
    )
    expect(unpromoteAnalysis).not.toHaveBeenCalled()
  })
})
