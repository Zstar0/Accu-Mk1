import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const mutate = vi.fn()

vi.mock('@/hooks/use-inbox-samples', () => ({
  usePriorityMutation: () => ({ mutate, isPending: false }),
}))

vi.mock('@/services/sample-priorities', () => ({
  useSamplePriorities: (uids: string[]) => ({
    data: uids.length
      ? uids.map(uid => ({
          sample_uid: uid,
          priority: uid === 'uid-exp' ? 'expedited' : 'normal',
        }))
      : undefined,
    isLoading: false,
  }),
}))

import { SamplePriorityControl } from '@/components/senaite/SamplePriorityControl'

function wrap(node: ReactNode) {
  const qc = new QueryClient()
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('SamplePriorityControl', () => {
  it('renders the stored priority for a sample with a uid, in any lifecycle state', () => {
    wrap(<SamplePriorityControl sampleUid="uid-exp" />)
    const trigger = screen.getByTestId('sample-priority-select')
    expect(trigger).toBeTruthy()
    expect(trigger.textContent).toContain('Expedited')
  })

  it('defaults to Normal when no override row exists', () => {
    wrap(<SamplePriorityControl sampleUid="uid-plain" />)
    expect(screen.getByTestId('sample-priority-select').textContent).toContain(
      'Normal'
    )
  })

  it('shows a disabled badge when the sample has no uid yet', () => {
    wrap(<SamplePriorityControl sampleUid={null} />)
    expect(screen.getByTestId('sample-priority-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('sample-priority-select')).toBeNull()
  })
})
