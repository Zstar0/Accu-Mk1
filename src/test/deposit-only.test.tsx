/** depositOnly = container-mode parent page: AnalysisTable renders as the
 *  cumulative report view — bench affordances hidden, provenance kept.
 *  SOFT lock: server still accepts transitions; this is UI-only. */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// AnalysisTable uses IntersectionObserver for its sticky-toolbar effect; jsdom
// doesn't have it. Must be a real class (same stub as vials-quicklook.test.tsx).
class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
})

// AnalysisTable calls useSidebar internally; stub it so tests don't need a
// full SidebarProvider (same stub as vials-quicklook.test.tsx).
vi.mock('@/components/ui/sidebar', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/ui/sidebar')>()
  return {
    ...actual,
    useSidebar: () => ({
      state: 'expanded' as const,
      open: true,
      setOpen: vi.fn(),
      openMobile: false,
      setOpenMobile: vi.fn(),
      isMobile: false,
      toggleSidebar: vi.fn(),
    }),
  }
})
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const mk = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:900',
    keyword: 'PUR_GHKCU',
    title: 'GHK-Cu - Purity',
    result: '99',
    review_state: 'to_be_verified',
    promoted_to_parent_id: null,
    service_group_name: 'Analytics',
    ...over,
  }) as SenaiteAnalysis

function renderTable(analyses: SenaiteAnalysis[], depositOnly?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={analyses}
          analyteNameMap={new Map()}
          depositOnly={depositOnly}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

describe('AnalysisTable depositOnly (container-mode parent page)', () => {
  it('hides row action menus', () => {
    renderTable([mk({})], true)
    expect(screen.queryByRole('button', { name: /analysis actions/i })).not.toBeInTheDocument()
  })
  it('hides selection checkboxes (no bulk bench actions)', () => {
    renderTable([mk({})], true)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
  it('keeps promote provenance visible', () => {
    renderTable([mk({ review_state: 'promoted', promoted_to_parent_id: 7 })], true)
    expect(screen.getByText(/Promoted → #7/)).toBeInTheDocument()
  })
  it('default (legacy) keeps the menus and checkboxes', () => {
    renderTable([mk({})])
    expect(screen.getByRole('button', { name: /analysis actions/i })).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
  })
})
