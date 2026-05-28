import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'

const updateSlaTierMock = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    getSlaTiers: () =>
      Promise.resolve([
        {
          id: 1,
          name: 'Standard',
          target_minutes: 1440,
          business_hours_only: false,
          is_default: true,
          amber_threshold_percent: 25,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
      ]),
    getSlaPriorityTiers: () => Promise.resolve([]),
    updateSlaTier: (id: number, data: unknown) => updateSlaTierMock(id, data),
    createSlaTier: vi.fn(),
    deleteSlaTier: vi.fn(),
    setSlaPriorityTier: vi.fn(),
    deleteSlaPriorityTier: vi.fn(),
  }
})

vi.mock('@/store/auth-store', () => ({
  useAuthStore: <T,>(selector: (s: { user: { role: string } }) => T) =>
    selector({ user: { role: 'admin' } }),
}))

const { SlaPane } = await import('@/components/preferences/panes/SlaPane')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  updateSlaTierMock.mockClear()
})

describe('SlaPane — amber threshold input', () => {
  it('renders the amber input with the tier value and PUTs on blur', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1')
    expect((input as HTMLInputElement).value).toBe('25')
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(updateSlaTierMock).toHaveBeenCalled()
    })
    const firstCall = updateSlaTierMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const payload = firstCall?.[1]
    expect(payload).toMatchObject({ amber_threshold_percent: 40 })
  })

  it('blur with an unchanged value does NOT call updateSlaTier', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1')
    fireEvent.blur(input)
    // No mutation expected — value unchanged
    expect(updateSlaTierMock).not.toHaveBeenCalled()
  })

  it('rejects invalid input "abc" and snaps the input back to the persisted value', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    // No mutate; input snapped back to '25' (the persisted value)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
    expect(input.value).toBe('25')
  })

  it('rejects out-of-range "0" and "101" and snaps back', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
    expect(input.value).toBe('25')
    fireEvent.change(input, { target: { value: '101' } })
    fireEvent.blur(input)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
    expect(input.value).toBe('25')
  })

  it('accepts boundary "1" and "100"', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateSlaTierMock).toHaveBeenCalled())
    const firstCall = updateSlaTierMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall?.[1]).toMatchObject({ amber_threshold_percent: 1 })
    updateSlaTierMock.mockClear()
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateSlaTierMock).toHaveBeenCalled())
    const secondCall = updateSlaTierMock.mock.calls[0]
    expect(secondCall).toBeDefined()
    expect(secondCall?.[1]).toMatchObject({ amber_threshold_percent: 100 })
  })
})
