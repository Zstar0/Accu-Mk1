import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getAnalysisProfiles: vi.fn(),
    getAnalysisProfileMembers: vi.fn(),
    getAnalysisServices: vi.fn(),
    createAnalysisProfile: vi.fn(),
    updateAnalysisProfile: vi.fn(),
    deleteAnalysisProfile: vi.fn(),
    setAnalysisProfileMembers: vi.fn(),
    getRideHosts: vi.fn(),
    putRideHosts: vi.fn(),
    getVialRoles: vi.fn(),
    getDepartments: vi.fn(),
    getSlaTiers: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getAnalysisProfiles,
  getAnalysisProfileMembers,
  getAnalysisServices,
  getRideHosts,
  getVialRoles,
  getDepartments,
  getSlaTiers,
} from '@/lib/api'
import AnalysisProfilesPage from '@/components/hplc/AnalysisProfilesPage'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('AnalysisProfilesPage — onboarding guide', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisProfiles).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisProfileMembers).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getRideHosts).mockReset().mockResolvedValue([])
    vi.mocked(getVialRoles).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getSlaTiers).mockReset().mockResolvedValue([])
  })

  it('shows a help trigger in the page header', async () => {
    render(<AnalysisProfilesPage />, { wrapper })
    expect(
      await screen.findByRole('button', { name: /new test guide/i })
    ).toBeInTheDocument()
  })

  it('opens the guide dialog with all five phases and the checklist', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    await user.click(
      await screen.findByRole('button', { name: /new test guide/i })
    )

    expect(
      await screen.findByRole('heading', {
        name: /bringing a new test online/i,
      })
    ).toBeInTheDocument()

    // One heading per phase, in guide order.
    expect(
      screen.getByRole('heading', { name: /build the catalog in accu-mk1/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: /integration service learn the key/i,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /put it on sale in wordpress/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /prove it end-to-end/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /arm the certificate/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /pre-flight checklist/i })
    ).toBeInTheDocument()
  })

  it('carries the two load-bearing rules: verbatim profile key and archetype-last', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    await user.click(
      await screen.findByRole('button', { name: /new test guide/i })
    )
    await screen.findByRole('heading', { name: /bringing a new test online/i })

    // The one-string identity rule.
    expect(screen.getByText(/one string rules everything/i)).toBeInTheDocument()
    // Arming is the last step and is fail-closed.
    expect(
      screen.getByText(/deliberately absent at create/i)
    ).toBeInTheDocument()
    expect(
      screen.getAllByText(/retroactively and fail-closed/i).length
    ).toBeGreaterThan(0)
  })
})
