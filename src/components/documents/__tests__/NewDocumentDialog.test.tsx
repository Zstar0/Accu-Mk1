import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewDocumentDialog } from '@/components/documents/NewDocumentDialog'

const createMutate = vi.hoisted(() => vi.fn())
const openForEditing = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/services/documents', () => ({
  useDocumentSpaces: () => ({ data: [], isLoading: false }),
  useDocumentCategories: () => ({
    data: [
      { id: 3, name: 'Artifacts', code_prefix: 'ART', active: true },
      { id: 4, name: 'SOPs', code_prefix: 'SOP', active: true },
    ],
  }),
  useCreateDocument: () => ({ mutate: createMutate, isPending: false }),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({
      user: {
        id: 1,
        role: 'admin',
        email: 'f@x.io',
        first_name: 'Forrest',
        last_name: 'P',
      },
    }),
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: (sel: (s: unknown) => unknown) =>
    sel({
      openDocumentForEditing: openForEditing,
      navigateToDocument: navigate,
    }),
}))

function renderDialog(onOpenChange = vi.fn(), space?: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NewDocumentDialog open onOpenChange={onOpenChange} space={space} />
    </QueryClientProvider>
  )
  return onOpenChange
}

const createButton = () => screen.getByRole('button', { name: 'Create' })

function chooseFile(name: string, text: string) {
  const input = screen.getByLabelText('HTML file') as HTMLInputElement
  const file = new File([text], name, { type: 'text/html' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('NewDocumentDialog', () => {
  beforeEach(() => {
    createMutate
      .mockReset()
      .mockImplementation(
        (
          _body: unknown,
          opts?: { onSuccess?: (row: { id: number; code: string }) => void }
        ) => opts?.onSuccess?.({ id: 77, code: 'ART-0009' })
      )
    openForEditing.mockReset()
    navigate.mockReset()
  })

  it('needs a title; the first category is preselected and names the code prefix', () => {
    renderDialog()
    expect(createButton()).toBeDisabled()
    expect(screen.getByText(/minted as ART-/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Balance SOP' },
    })
    expect(createButton()).toBeEnabled()
  })

  it('a blank page posts the starter template and opens the draft in edit mode', async () => {
    const onOpenChange = renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Balance SOP' },
    })
    fireEvent.click(createButton())
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
    const body = createMutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.title).toBe('Balance SOP')
    expect(body.category_id).toBe(3)
    expect(body.author).toBe('Forrest P')
    expect(body.description).toBeNull()
    expect(body.effective_date).toBeNull()
    expect(body.html).toContain('<h1>Balance SOP</h1>')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(openForEditing).toHaveBeenCalledWith(77)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('an uploaded file must be HTML; a good one posts as-is and opens in view mode', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Imported' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Upload an HTML file' }))
    expect(createButton()).toBeDisabled()

    chooseFile('notes.txt', '# Markdown title')
    await screen.findByText(/not an HTML document/)
    expect(createButton()).toBeDisabled()

    chooseFile(
      'sop.html',
      '<!doctype html><html><head></head><body><p>Imported body</p></body></html>'
    )
    await waitFor(() => expect(createButton()).toBeEnabled())
    expect(screen.queryByText(/not an HTML document/)).toBeNull()
    fireEvent.click(createButton())
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
    const body = createMutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.html).toContain('Imported body')
    expect(navigate).toHaveBeenCalledWith(77)
    expect(openForEditing).not.toHaveBeenCalled()
  })

  it('sends description and effective date when given', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.change(screen.getByLabelText('Short description'), {
      target: { value: '  why  ' },
    })
    fireEvent.change(screen.getByLabelText('Effective date'), {
      target: { value: '2026-10-05' },
    })
    fireEvent.click(createButton())
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
    const body = createMutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.description).toBe('why')
    expect(body.effective_date).toBe('2026-10-05')
    expect('space' in body).toBe(false)
  })

  it('publishes into the space being browsed', async () => {
    renderDialog(vi.fn(), 'leadership')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
    const body = createMutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.space).toBe('leadership')
  })
})
