import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { listServiceSpecs, type AnalysisServiceSpecRecord } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import {
  CoaVariantEditor,
  type CoaVariantEditorProps,
} from '@/components/hplc/CoaVariantEditor'
import {
  COA_FIELD_ROWS,
  COA_MACRO_HINT,
  newDraft,
  type CoaDefaults,
} from '@/components/hplc/coa-variant-logic'

vi.mock('@/lib/api', () => ({ listServiceSpecs: vi.fn() }))

const DEFAULTS: CoaDefaults = {
  name: 'Heavy Metals',
  coa_section_title: null,
  coa_basis_note: 'Basis: USP<232>',
  coa_method_text: 'MP-AES',
  coa_prep_text: 'Hot block digestion',
  coa_footnotes: [{ label: 'Basis:', text: 'Limits per USP<232>.' }],
}
const SERVICES = [
  { id: 1, title: 'Arsenic' },
  { id: 2, title: 'Lead' },
]
const rule = (over: Partial<AnalysisServiceSpecRecord>) =>
  ({
    sample_form_id: 4,
    peptide_id: null,
    rule_kind: 'informational',
    ...over,
  }) as AnalysisServiceSpecRecord
const formRule = rule({})

function Harness(overrides: Partial<CoaVariantEditorProps>) {
  const [draft, setDraft] = useState(newDraft(4, 'Nasal Spray'))
  return (
    <CoaVariantEditor
      defaults={DEFAULTS}
      savedMemberIds={[1, 2]}
      membersLoading={false}
      services={SERVICES}
      dirty={false}
      saving={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      onAddRule={vi.fn()}
      {...overrides}
      draft={draft}
      onChange={setDraft}
    />
  )
}

function renderEditor(overrides: Partial<CoaVariantEditorProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Harness {...overrides} />
    </QueryClientProvider>
  )
}

function specsFor(map: Record<number, AnalysisServiceSpecRecord[] | Error>) {
  vi.mocked(listServiceSpecs).mockImplementation(async id => {
    const specs = map[id] ?? []
    if (specs instanceof Error) throw specs
    return specs
  })
}

function row(label: string) {
  const field = COA_FIELD_ROWS.find(r => r.label === label)?.field
  const el = screen.getByTestId(`coa-variant-row-${field}`)
  within(el).getByText(label)
  return el
}

let user: UserEvent
const pick = (label: string, choice: string) =>
  user.click(screen.getByRole('radio', { name: `${label}: ${choice}` }))

beforeEach(() => {
  user = userEvent.setup()
  // Never settles unless a test calls specsFor, so the rules stay loading.
  vi.mocked(listServiceSpecs).mockReset()
  vi.mocked(listServiceSpecs).mockReturnValue(new Promise(() => undefined))
})

describe('CoaVariantEditor', () => {
  it('shows the Default text tagged under Same as default', async () => {
    renderEditor()
    expect(
      within(row('Sample prep')).getByText('Hot block digestion')
    ).toBeVisible()
    expect(within(row('Sample prep')).getByText('Default')).toBeVisible()
    expect(within(row('Section title')).getByText('Heavy Metals')).toBeVisible()
  })

  it('says when the Default is blank', () => {
    renderEditor({ defaults: { ...DEFAULTS, coa_prep_text: null } })
    expect(
      within(row('Sample prep')).getByText(
        'The Default is blank, so nothing prints'
      )
    ).toBeVisible()
  })

  it('labels the limit fields and gives the title no Leave off', () => {
    renderEditor()
    expect(
      within(row('Basis note')).getByText('describes the limits')
    ).toBeVisible()
    expect(
      within(row('Footnotes')).getByText('describes the limits')
    ).toBeVisible()
    expect(
      within(row('Section title')).queryByRole('radio', { name: /Leave off/ })
    ).toBeNull()
  })

  it('Leave off explains itself, and clicking the active choice keeps it', async () => {
    renderEditor()
    await pick('Sample prep', 'Leave off')
    expect(
      within(row('Sample prep')).getByText('Not printed on Nasal Spray COAs')
    ).toBeVisible()
    await pick('Sample prep', 'Leave off')
    expect(
      within(row('Sample prep')).getByText('Not printed on Nasal Spray COAs')
    ).toBeVisible()
  })

  it('Custom prefills, and typed text survives switching away and back', async () => {
    renderEditor()
    await pick('Sample prep', 'Custom')
    const box = within(row('Sample prep')).getByRole('textbox')
    expect(box).toHaveValue('Hot block digestion')
    await user.clear(box)
    await user.type(box, 'Diluted')
    await pick('Sample prep', 'Leave off')
    await pick('Sample prep', 'Custom')
    expect(within(row('Sample prep')).getByRole('textbox')).toHaveValue(
      'Diluted'
    )
  })

  it('Custom footnotes use the list editor, and no rows blocks Save', async () => {
    renderEditor({ dirty: true })
    await pick('Footnotes', 'Custom')
    const footnotes = within(row('Footnotes'))
    expect(footnotes.getByLabelText('Footnote 1 label')).toHaveValue('Basis:')
    await user.click(
      footnotes.getByRole('button', { name: 'Remove footnote 1' })
    )
    expect(
      footnotes.getByText('Type the text, or choose Leave off')
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    ).toBeDisabled()
  })

  it('blocks Save on blank Custom text, with the message', async () => {
    renderEditor({ dirty: true })
    await pick('Sample prep', 'Custom')
    await user.clear(within(row('Sample prep')).getByRole('textbox'))
    expect(screen.getByText('Type the text, or choose Leave off')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    ).toBeDisabled()
  })

  it('keeps Save disabled until something changed', () => {
    renderEditor({ dirty: false })
    expect(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    ).toBeDisabled()
  })

  it('hides the guard line while both limit fields are on Same as default', async () => {
    specsFor({ 1: [formRule], 2: [formRule] })
    renderEditor()
    await waitFor(() => expect(listServiceSpecs).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('coa-variant-guard')).toBeNull()
  })

  it('is green when every member has a rule', async () => {
    specsFor({ 1: [formRule], 2: [formRule] })
    renderEditor()
    await pick('Basis note', 'Leave off')
    expect(
      await screen.findByText(
        "All 2 services have a Nasal Spray rule, so this version's basis note and footnotes print."
      )
    ).toBeVisible()
  })

  it('is amber naming the service, marks overridden limit fields Held, and links to the rule', async () => {
    const onAddRule = vi.fn()
    specsFor({ 1: [], 2: [formRule] })
    renderEditor({ onAddRule })
    await pick('Basis note', 'Leave off')
    expect(
      await screen.findByText(/^Arsenic has no Nasal Spray rule/)
    ).toBeVisible()
    expect(
      within(row('Basis note')).getByText(
        'Held: the Default prints on a COA that includes Arsenic'
      )
    ).toBeVisible()
    expect(within(row('Footnotes')).queryByText(/^Held:/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add the rule' }))
    expect(onAddRule).toHaveBeenCalledWith(1)
  })

  it('names each service on its Add the rule button when several have none', async () => {
    const onAddRule = vi.fn()
    specsFor({ 1: [], 2: [] })
    renderEditor({ onAddRule })
    await pick('Footnotes', 'Leave off')
    await user.click(
      await screen.findByRole('button', { name: 'Add the rule: Lead' })
    )
    expect(onAddRule).toHaveBeenCalledWith(2)
    expect(
      screen.getByRole('button', { name: 'Add the rule: Arsenic' })
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add the rule' })).toBeNull()
  })

  it('asks for the rules again when reopened, so a stale cache cannot keep it green', async () => {
    // The app's own defaults: their 5-minute staleTime is what kept it green.
    const client = new QueryClient({
      defaultOptions: {
        queries: { ...queryClient.getDefaultOptions().queries, retry: false },
      },
    })
    const mount = () =>
      render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      )
    specsFor({ 1: [formRule], 2: [formRule] })
    const first = mount()
    await pick('Basis note', 'Leave off')
    expect(await screen.findByText(/^All 2 services have/)).toBeVisible()
    first.unmount()

    specsFor({ 1: [], 2: [formRule] })
    mount()
    await pick('Basis note', 'Leave off')
    expect(
      await screen.findByText(/^Arsenic has no Nasal Spray rule/)
    ).toBeVisible()
    expect(listServiceSpecs).toHaveBeenCalledTimes(4)
  })

  it('is never green when a call fails', async () => {
    specsFor({ 1: [formRule], 2: new Error('boom') })
    renderEditor()
    await pick('Basis note', 'Leave off')
    expect(
      await screen.findByText('Could not confirm the Nasal Spray rules.')
    ).toBeVisible()
  })

  it('is never green with no members', async () => {
    renderEditor({ savedMemberIds: [] })
    await pick('Basis note', 'Leave off')
    expect(
      screen.getByText('Could not confirm the Nasal Spray rules.')
    ).toBeVisible()
  })

  it('previews what prints, with tags', async () => {
    specsFor({ 1: [], 2: [formRule] })
    renderEditor()
    await pick('Basis note', 'Leave off')
    const preview = screen.getByTestId('coa-variant-preview')
    expect(
      within(preview).getByText('What prints on a Nasal Spray COA')
    ).toBeVisible()
    expect(await within(preview).findByText('Default, held')).toBeVisible()
    expect(within(preview).getByText('Arsenic')).toBeVisible()
  })

  it('previews a missing piece by name, and the macro note', async () => {
    specsFor({ 1: [formRule], 2: [formRule] })
    renderEditor()
    await pick('Footnotes', 'Leave off')
    await pick('Basis note', 'Custom')
    const box = within(row('Basis note')).getByRole('textbox')
    await user.clear(box)
    await user.type(box, 'LOD {{lod}')
    const preview = within(screen.getByTestId('coa-variant-preview'))
    expect(await preview.findByText('no footnotes')).toBeVisible()
    expect(preview.getByText('LOD {lod}')).toBeVisible()
    expect(
      preview.getByText("{lod} fills in from each sample's results")
    ).toBeVisible()
  })

  it('previews no footnotes as a plain line with its tag inline and no box', async () => {
    renderEditor()
    await pick('Footnotes', 'Leave off')
    const line = within(screen.getByTestId('coa-variant-preview')).getByText(
      'no footnotes'
    )
    expect(within(line).getByText('Nasal Spray')).toBeVisible()
    expect(line).not.toHaveClass('italic')
    expect(screen.queryByTestId('coa-variant-preview-footnotes')).toBeNull()
  })

  it('previews footnotes in a box with the tag inline after the last note', () => {
    renderEditor({
      defaults: {
        ...DEFAULTS,
        coa_footnotes: [
          { label: 'Basis:', text: 'First note.' },
          { label: 'Assumed MDD:', text: 'Last note.' },
        ],
      },
    })
    const box = within(screen.getByTestId('coa-variant-preview-footnotes'))
    expect(
      within(box.getByText('First note.')).queryByText('Default')
    ).toBeNull()
    expect(
      within(box.getByText('Last note.')).getByText('Default')
    ).toBeVisible()
    expect(box.getAllByText('Default')).toHaveLength(1)
  })

  it('shows the macro hint', () => {
    renderEditor()
    expect(screen.getByTestId('coa-variant-macro-hint')).toHaveTextContent(
      COA_MACRO_HINT
    )
  })

  it('Stop using appears only for existing versions', () => {
    renderEditor({ onStop: undefined })
    expect(
      screen.queryByRole('button', { name: 'Stop using this version' })
    ).toBeNull()
  })

  it('Stop using fires onStop when the version exists', async () => {
    const onStop = vi.fn()
    renderEditor({ onStop })
    await user.click(
      screen.getByRole('button', { name: 'Stop using this version' })
    )
    expect(onStop).toHaveBeenCalled()
  })
})
