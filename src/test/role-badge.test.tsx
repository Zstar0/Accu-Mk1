import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VialRoleRow, Department } from '@/lib/api'
import { vialRolesQueryKeys } from '@/services/vial-roles'
import { departmentsQueryKeys } from '@/services/departments'
import { RoleBadge } from '@/components/shared/RoleBadge'

// Query cache is always pre-seeded via setQueryData in tests that need data;
// the "no data yet" tests rely on queryFn never resolving mid-test, so stub
// it here rather than let it fire a real fetch() against jsdom.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getVialRoles: vi.fn(() => new Promise<VialRoleRow[]>(() => undefined)),
    getDepartments: vi.fn(() => new Promise<Department[]>(() => undefined)),
  }
})

function role(
  overrides: Partial<VialRoleRow> & Pick<VialRoleRow, 'code' | 'label'>
): VialRoleRow {
  return {
    id: overrides.code.length,
    department_id: null,
    boxable: false,
    variance_eligible: false,
    sort_order: 0,
    frozen: false,
    is_system: true,
    color: null,
    short_label: null,
    badge_glyph: null,
    ...overrides,
  }
}

const ROLES: VialRoleRow[] = [
  role({
    code: 'hplc',
    label: 'HPLC',
    department_id: 1,
    color: 'green',
    short_label: 'HPLC',
    badge_glyph: 'H',
  }),
  role({
    code: 'ster',
    label: 'Sterility',
    department_id: 2,
    color: 'purple',
    short_label: 'PCR',
    badge_glyph: 'P',
  }),
  role({
    code: 'usp71',
    label: 'USP <71> Sterility',
    department_id: 2,
    color: null,
    short_label: null,
    badge_glyph: null,
  }),
]

const DEPARTMENTS: Department[] = [
  {
    id: 1,
    name: 'Chemistry',
    sort_order: 0,
    color: 'blue',
    is_system: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Microbiology',
    sort_order: 1,
    color: 'violet',
    is_system: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
]

function renderWithRoles(
  ui: React.ReactElement,
  { seedRoles = true }: { seedRoles?: boolean } = {}
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (seedRoles) {
    qc.setQueryData(vialRolesQueryKeys.all, ROLES)
    qc.setQueryData(departmentsQueryKeys.all, DEPARTMENTS)
  }
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('RoleBadge', () => {
  it('renders the seeded short label with the seeded color', () => {
    renderWithRoles(<RoleBadge role="ster" />)
    const badge = screen.getByText('PCR')
    expect(badge.className).toContain('purple')
  })

  it('renders the uppercased code for a catalog row with no seeded short_label (usp71 regression)', () => {
    renderWithRoles(<RoleBadge role="usp71" />)
    expect(screen.getByText('USP71')).toBeInTheDocument()
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument()
  })

  it('renders "Unassigned" in amber for a null role', () => {
    renderWithRoles(<RoleBadge role={null} />)
    const badge = screen.getByText('Unassigned')
    expect(badge.className).toContain('amber')
  })

  it('renders a custom unassignedLabel for a null role', () => {
    renderWithRoles(<RoleBadge role={null} unassignedLabel="—" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders amber "Unassigned" for an unknown/unrecognized code', () => {
    renderWithRoles(<RoleBadge role="zzghost" />)
    const badge = screen.getByText('Unassigned')
    expect(badge.className).toContain('amber')
  })

  it('renders nothing for a null role when hideUnassigned is set', () => {
    const { container } = renderWithRoles(
      <RoleBadge role={null} hideUnassigned />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for an unknown code when hideUnassigned is set', () => {
    const { container } = renderWithRoles(
      <RoleBadge role="zzghost" hideUnassigned />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the single-char glyph form', () => {
    renderWithRoles(<RoleBadge role="ster" form="glyph" />)
    expect(screen.getByText('P')).toBeInTheDocument()
  })

  it('renders the uppercased code in zinc while the roles query has no data yet (no Unassigned flash)', () => {
    renderWithRoles(<RoleBadge role="ster" />, { seedRoles: false })
    const badge = screen.getByText('STER')
    expect(badge.className).toContain('zinc')
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument()
  })

  it('renders the loading-state badge even with hideUnassigned set (loading is not "unassigned")', () => {
    renderWithRoles(<RoleBadge role="ster" hideUnassigned />, {
      seedRoles: false,
    })
    expect(screen.getByText('STER')).toBeInTheDocument()
  })
})
