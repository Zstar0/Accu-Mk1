import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HplcMethod, MethodAttachment } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getMethods: vi.fn(),
    createMethod: vi.fn(),
    deleteMethod: vi.fn(),
    updateMethod: vi.fn(),
    getInstruments: vi.fn(),
    getDepartments: vi.fn(),
    getAnalysisServices: vi.fn(),
    getMethodServices: vi.fn(),
    putMethodServices: vi.fn(),
    getPeptides: vi.fn(),
    updatePeptide: vi.fn(),
    newMethodRevision: vi.fn(),
    activateMethod: vi.fn(),
    retireMethod: vi.fn(),
    getMethodAttachments: vi.fn(),
    uploadMethodAttachment: vi.fn(),
    deleteMethodAttachment: vi.fn(),
    downloadMethodAttachment: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getMethods,
  createMethod,
  deleteMethod,
  updateMethod,
  getInstruments,
  getDepartments,
  getAnalysisServices,
  getMethodServices,
  putMethodServices,
  getPeptides,
  updatePeptide,
  newMethodRevision,
  activateMethod,
  retireMethod,
  getMethodAttachments,
  uploadMethodAttachment,
  deleteMethodAttachment,
  downloadMethodAttachment,
} from '@/lib/api'
import { MethodPanel } from '@/components/hplc/MethodPanel'
import { MethodsPage } from '@/components/hplc/MethodsPage'

const ACTIVE_M = {
  id: 1,
  name: 'ICP-MS',
  senaite_id: null,
  code: 'AM-E-1',
  status: 'active',
  revision: 2,
  active: true,
  supersedes_id: 9,
  origin: 'mk1',
  instrument_ids: [],
  instruments: [],
  services: [],
  common_peptides: [],
  technique: 'ICP-MS',
  department_id: null,
  reference: null,
  notes: null,
  procedure_summary: 'locked text',
  size_peptide: null,
  starting_organic_pct: null,
  temperature_mct_c: null,
  dissolution: null,
  activated_at: '2026-06-01T00:00:00Z',
  retired_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as HplcMethod

describe('MethodPanel — lifecycle UI', () => {
  beforeEach(() => {
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(createMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(deleteMethod).mockReset().mockResolvedValue(undefined)
    vi.mocked(updateMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(getInstruments).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getMethodServices).mockReset().mockResolvedValue([])
    vi.mocked(putMethodServices).mockReset().mockResolvedValue([])
    vi.mocked(getPeptides).mockReset().mockResolvedValue([])
    vi.mocked(updatePeptide)
      .mockReset()
      .mockResolvedValue({} as never)
    vi.mocked(newMethodRevision).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(activateMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(retireMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(getMethodAttachments).mockReset().mockResolvedValue([])
    vi.mocked(uploadMethodAttachment)
      .mockReset()
      .mockResolvedValue({} as never)
    vi.mocked(deleteMethodAttachment).mockReset().mockResolvedValue(undefined)
    vi.mocked(downloadMethodAttachment).mockReset().mockResolvedValue(undefined)
  })

  it('active method offers Retire + New Revision, never Activate', async () => {
    render(<MethodPanel method={ACTIVE_M} onUpdated={vi.fn()} />)
    expect(
      await screen.findByRole('button', { name: /retire/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /new revision/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^activate$/i })
    ).not.toBeInTheDocument()
  })

  it('locks issued content in edit mode, keeps notes editable', async () => {
    const user = userEvent.setup()
    render(<MethodPanel method={ACTIVE_M} onUpdated={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /edit/i }))
    expect(
      screen.queryByLabelText(/procedure summary/i)
    ).not.toBeInTheDocument()
    expect(screen.getByText('locked text')).toBeInTheDocument() // read-only DetailRow
    expect(screen.getByLabelText(/notes/i)).toBeInTheDocument()
  })

  it('draft shows badge + Activate; delete on attachments only while draft', async () => {
    const draft = { ...ACTIVE_M, status: 'draft', active: false } as HplcMethod
    vi.mocked(getMethodAttachments).mockResolvedValue([
      {
        id: 5,
        filename: 'sop.pdf',
        content_type: 'application/pdf',
        size_bytes: 9,
        created_at: '2026-08-19T00:00:00Z',
      },
    ] as MethodAttachment[])
    render(<MethodPanel method={draft} onUpdated={vi.fn()} />)
    expect(await screen.findByText(/draft/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /activate/i })
    ).toBeInTheDocument()
    expect(await screen.findByText('sop.pdf')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /delete attachment/i })
    ).toBeInTheDocument()
  })

  it('Download button fetches the attachment via authenticated blob, not a bare link', async () => {
    const user = userEvent.setup()
    vi.mocked(getMethodAttachments).mockResolvedValue([
      {
        id: 5,
        filename: 'sop.pdf',
        content_type: 'application/pdf',
        size_bytes: 9,
        created_at: '2026-08-19T00:00:00Z',
      },
    ] as MethodAttachment[])
    render(<MethodPanel method={ACTIVE_M} onUpdated={vi.fn()} />)
    const downloadButton = await screen.findByRole('button', {
      name: /download/i,
    })
    expect(downloadButton.tagName).toBe('BUTTON') // not an <a href> — R-P3-4
    await user.click(downloadButton)
    await waitFor(() =>
      expect(downloadMethodAttachment).toHaveBeenCalledWith(
        ACTIVE_M.id,
        5,
        'sop.pdf'
      )
    )
  })

  it('saving a locked method sends only notes/department/instruments', async () => {
    const user = userEvent.setup()
    render(<MethodPanel method={ACTIVE_M} onUpdated={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /edit/i }))
    const notesBox = screen.getByLabelText(/notes/i)
    await user.type(notesBox, 'lab note')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(updateMethod).toHaveBeenCalled())
    const call = vi.mocked(updateMethod).mock.calls[0]
    expect(call).toBeDefined()
    const [methodId, payload] = call ?? []
    expect(methodId).toBe(ACTIVE_M.id)
    expect(Object.keys(payload as object).sort()).toEqual(
      ['department_id', 'instrument_ids', 'notes'].sort()
    )
  })

  it('activate confirm names the predecessor and invokes activateMethod', async () => {
    const predecessor = {
      ...ACTIVE_M,
      id: 9,
      revision: 1,
      status: 'retired',
      supersedes_id: null,
      active: false,
    } as HplcMethod
    const draft = {
      ...ACTIVE_M,
      id: 20,
      status: 'draft',
      active: false,
      supersedes_id: 9,
      revision: 2,
    } as HplcMethod
    vi.mocked(getMethods).mockResolvedValue([predecessor, draft])
    const onUpdated = vi.fn()
    const user = userEvent.setup()
    render(<MethodPanel method={draft} onUpdated={onUpdated} />)
    await user.click(await screen.findByRole('button', { name: /^activate$/i }))
    expect(await screen.findByText(/retires rev 1/i)).toBeInTheDocument()
    const activateButtons = screen.getAllByRole('button', {
      name: /^activate$/i,
    })
    const confirmButton = activateButtons.at(-1)
    expect(confirmButton).toBeDefined()
    await user.click(confirmButton as HTMLElement)
    await waitFor(() => expect(activateMethod).toHaveBeenCalledWith(20))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
  })

  it('revision history shows the full family, including sibling drafts off one source (R-P3-5)', async () => {
    // R-P3-2: two drafts independently new-revision'd off the SAME source
    // are both legitimately activatable — siblings, not a linear chain. A
    // supersedes_id chain-walk only follows one successor per node and
    // silently drops the second one; the family view (grouped by name)
    // must surface both.
    const source = {
      ...ACTIVE_M,
      id: 9,
      revision: 1,
      status: 'retired',
      supersedes_id: null,
      active: false,
    } as HplcMethod
    const current = {
      ...ACTIVE_M,
      id: 20,
      revision: 2,
      status: 'draft',
      supersedes_id: 9,
      active: false,
    } as HplcMethod
    const sibling = {
      ...ACTIVE_M,
      id: 30,
      revision: 3,
      status: 'draft',
      supersedes_id: 9,
      active: false,
    } as HplcMethod
    vi.mocked(getMethods).mockResolvedValue([source, current, sibling])
    const onSelectMethod = vi.fn()
    render(
      <MethodPanel
        method={current}
        onUpdated={vi.fn()}
        onSelectMethod={onSelectMethod}
      />
    )

    // All three family members are listed, including the current row itself.
    const sourceRow = await screen.findByRole('button', { name: /rev 1/i })
    const currentRow = screen.getByRole('button', { name: /rev 2/i })
    const siblingRow = screen.getByRole('button', { name: /rev 3/i })
    expect(sourceRow).toBeInTheDocument()
    expect(siblingRow).toBeInTheDocument()

    // The current row is visually marked and isn't itself click-through.
    expect(currentRow).toBeDisabled()
    expect(within(currentRow).getByText(/current/i)).toBeInTheDocument()

    // The sibling is a true sibling (not a linear successor of `current`)
    // — exactly what the old chain-walk dropped — and is still click-through.
    await userEvent.click(siblingRow)
    expect(onSelectMethod).toHaveBeenCalledWith(30)
  })

  it('uploads a new attachment through the file input', async () => {
    const draft = { ...ACTIVE_M, status: 'draft', active: false } as HplcMethod
    vi.mocked(uploadMethodAttachment).mockResolvedValue({
      id: 2,
      filename: 'proc.pdf',
      content_type: 'application/pdf',
      size_bytes: 100,
      created_at: '2026-08-19T00:00:00Z',
    })
    const user = userEvent.setup()
    render(<MethodPanel method={draft} onUpdated={vi.fn()} />)
    const file = new File(['hello'], 'proc.pdf', { type: 'application/pdf' })
    const input = await screen.findByLabelText(/upload/i)
    await user.upload(input, file)
    await waitFor(() =>
      expect(uploadMethodAttachment).toHaveBeenCalledWith(draft.id, file)
    )
  })
})

describe('MethodsPage — status badge + revision suffix', () => {
  beforeEach(() => {
    vi.mocked(getMethods)
      .mockReset()
      .mockResolvedValue([
        {
          ...ACTIVE_M,
          id: 1,
          name: 'Draft Method',
          status: 'draft',
          revision: 1,
          active: false,
        },
        {
          ...ACTIVE_M,
          id: 2,
          name: 'Active Method',
          status: 'active',
          revision: 3,
        },
      ])
    vi.mocked(createMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(deleteMethod).mockReset().mockResolvedValue(undefined)
    vi.mocked(updateMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(getInstruments).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getMethodServices).mockReset().mockResolvedValue([])
    vi.mocked(putMethodServices).mockReset().mockResolvedValue([])
    vi.mocked(getPeptides).mockReset().mockResolvedValue([])
    vi.mocked(updatePeptide)
      .mockReset()
      .mockResolvedValue({} as never)
    vi.mocked(getMethodAttachments).mockReset().mockResolvedValue([])
    vi.mocked(newMethodRevision).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(activateMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(retireMethod).mockReset().mockResolvedValue(ACTIVE_M)
    vi.mocked(uploadMethodAttachment)
      .mockReset()
      .mockResolvedValue({} as never)
    vi.mocked(deleteMethodAttachment).mockReset().mockResolvedValue(undefined)
    vi.mocked(downloadMethodAttachment).mockReset().mockResolvedValue(undefined)
  })

  it('shows a status badge per row and a rev suffix only when revision > 1', async () => {
    render(<MethodsPage />)
    expect(await screen.findByText('Draft Method')).toBeInTheDocument()
    expect(screen.getByText(/^draft$/i)).toBeInTheDocument()
    expect(screen.getByText(/^active$/i)).toBeInTheDocument()
    expect(screen.getByText('rev 3')).toBeInTheDocument()
    expect(screen.queryByText('rev 1')).not.toBeInTheDocument()
  })
})
