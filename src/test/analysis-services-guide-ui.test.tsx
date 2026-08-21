import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getAnalysisServices: vi.fn(),
    getDepartments: vi.fn(),
    getPeptides: vi.fn(),
  }
})

vi.mock('@/services/analysis-services', () => ({
  useCreateAnalysisService: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateAnalysisService: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteAnalysisService: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { getAnalysisServices, getDepartments, getPeptides } from '@/lib/api'
import { AnalysisServicesGuide } from '@/components/hplc/AnalysisServicesGuide'
import { AnalysisServicesPage } from '@/components/hplc/AnalysisServicesPage'

describe('AnalysisServicesGuide — in-app catalog guide dialog', () => {
  it('opens from the trigger button and shows the catalog content', async () => {
    const user = userEvent.setup()
    render(<AnalysisServicesGuide />)

    expect(
      screen.queryByText(/Analysis Services — the Catalog/i)
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /services guide/i }))

    expect(
      await screen.findByText(/Analysis Services — the Catalog/i)
    ).toBeInTheDocument()
    // Load-bearing content: keyword discipline and the retired-sync note
    expect(screen.getByText(/Keywords are load-bearing/i)).toBeInTheDocument()
    expect(screen.getByText(/The sync is retired/i)).toBeInTheDocument()
    expect(screen.getByText(/Deactivate, don't delete/i)).toBeInTheDocument()
  })
})

describe('AnalysisServicesPage — sync affordance removed, guide present', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getPeptides).mockReset().mockResolvedValue([])
  })

  it('offers New Service + Services Guide and no SENAITE sync button', async () => {
    render(<AnalysisServicesPage />)
    expect(
      await screen.findByRole('button', { name: /new service/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /services guide/i })
    ).toBeInTheDocument()
    // Sync button removed outright — backend route stays frozen for the
    // phase-out program, but the catalog UI no longer offers it.
    expect(
      screen.queryByRole('button', { name: /sync/i })
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText(/No analysis services yet\. Click "New Service"/i)
    ).toBeInTheDocument()
  })
})
