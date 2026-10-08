import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import en from '../../../../../locales/en.json'

const h = vi.hoisted(() => ({
  createMutate: vi.fn(),
  replaceGrantsMutate: vi.fn(),
}))

const space = (id: number, slug: string, visibility: string) => ({
  id,
  slug,
  name: slug,
  description: null,
  visibility,
  is_active: true,
  sort_order: id,
  document_count: 0,
  can_write: true,
  created_at: '2026-10-06T00:00:00',
  updated_at: '2026-10-06T00:00:00',
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) => {
      const s = (en as Record<string, string>)[k] ?? k
      return o?.count !== undefined
        ? s.replace('{{count}}', String(o.count))
        : s
    },
  }),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) =>
    sel({ user: { role: 'admin' } }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({
    data: [{ id: 7, slug: 'leaders', name: 'Leaders', is_active: true }],
    isLoading: false,
  }),
}))
vi.mock('@/services/documents', () => ({
  useDocumentCategories: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useCreateDocumentCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDocumentCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDocumentCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDocumentSpaces: () => ({
    data: [
      space(1, 'general', 'company'),
      space(2, 'leadership', 'restricted'),
    ],
    isLoading: false,
    isError: false,
  }),
  useCreateDocumentSpace: () => ({
    mutate: h.createMutate,
    isPending: false,
  }),
  useUpdateDocumentSpace: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDocumentSpace: () => ({ mutate: vi.fn(), isPending: false }),
  useDocumentSpaceGrants: () => ({ data: [], isLoading: false }),
  useReplaceDocumentSpaceGrants: () => ({
    mutate: h.replaceGrantsMutate,
    isPending: false,
  }),
}))

import { DocumentsPane } from '@/components/preferences/panes/DocumentsPane'

describe('DocumentsPane spaces', () => {
  beforeEach(() => {
    h.createMutate.mockReset()
    h.replaceGrantsMutate.mockReset()
  })

  it('lists spaces above categories and hides General guards', () => {
    render(<DocumentsPane />)
    expect(screen.getByText('Document spaces')).toBeInTheDocument()
    const general = screen.getByTestId('doc-space-row-general')
    expect(
      within(general).queryByRole('button', { name: /Restrict/ })
    ).toBeNull()
    expect(within(general).queryByRole('button', { name: /Delete/ })).toBeNull()
    const exec = screen.getByTestId('doc-space-row-leadership')
    expect(
      within(exec).getByRole('button', { name: /Groups/ })
    ).toBeInTheDocument()
  })

  it('creates a space from the form', () => {
    render(<DocumentsPane />)
    fireEvent.change(screen.getByLabelText('Slug'), {
      target: { value: 'accounting' },
    })
    fireEvent.change(screen.getByLabelText('Space name'), {
      target: { value: 'Accounting' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Add space/ }))
    expect(h.createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'accounting',
        name: 'Accounting',
        visibility: 'company',
      }),
      expect.anything()
    )
  })

  it('saves grants for a restricted space', () => {
    render(<DocumentsPane />)
    fireEvent.click(
      within(screen.getByTestId('doc-space-row-leadership')).getByRole(
        'button',
        { name: /Groups/ }
      )
    )
    fireEvent.click(screen.getByLabelText('Leaders'))
    fireEvent.click(screen.getByRole('button', { name: /Save access/ }))
    expect(h.replaceGrantsMutate).toHaveBeenCalledWith(
      { id: 2, groupIds: [7] },
      expect.anything()
    )
  })
})
