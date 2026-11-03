import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  listServiceSpecs,
  type AnalysisProfile,
  type AnalysisServiceSpecRecord,
} from '@/lib/api'
import {
  createProfileCoaVariant,
  listProfileCoaVariants,
  patchProfileCoaVariant,
  type ProfileCoaVariant,
} from '@/lib/api-profile-coa-variants'
import { listSampleForms, type SampleForm } from '@/lib/api-sample-forms'
import { queryClient } from '@/lib/query-client'
import {
  ProfileCoaVariantsSection,
  type ProfileCoaVariantsSectionProps,
} from '@/components/hplc/ProfileCoaVariantsSection'
import { COA_FIELD_ROWS } from '@/components/hplc/coa-variant-logic'
import { useUIStore } from '@/store/ui-store'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  listServiceSpecs: vi.fn(),
}))
vi.mock('@/lib/api-profile-coa-variants', () => ({
  listProfileCoaVariants: vi.fn(),
  createProfileCoaVariant: vi.fn(),
  patchProfileCoaVariant: vi.fn(),
}))
vi.mock('@/lib/api-sample-forms', () => ({ listSampleForms: vi.fn() }))

const form = (
  id: number,
  name: string,
  over: Partial<SampleForm> = {}
): SampleForm => ({
  id,
  name,
  route: 'injectable',
  is_default: false,
  active: true,
  sort_order: id,
  icon: null,
  sample_count: 0,
  ...over,
})
const PEN = form(3, 'Pen')
const NASAL_FORM = form(4, 'Nasal Spray', { route: 'nasal_inhaled' })
const CAPSULE = form(5, 'Capsule', { route: 'oral', active: false })
const FORM_IDS: Record<string, number> = {
  Pen: PEN.id,
  'Nasal Spray': NASAL_FORM.id,
  Capsule: CAPSULE.id,
}

const NASAL_VERSION: ProfileCoaVariant = {
  id: 11,
  analysis_profile_id: 1,
  sample_form_id: 4,
  sample_form_name: 'Nasal Spray',
  coa_section_title: null,
  coa_basis_note: '',
  coa_method_text: null,
  coa_prep_text: 'Diluted',
  coa_footnotes: null,
  active: true,
  updated_at: null,
}
const PROFILE = {
  id: 1,
  name: 'Heavy Metals',
  coa_section_title: null,
  coa_basis_note: 'Basis: USP<232>',
  coa_method_text: 'MP-AES',
  coa_prep_text: 'Hot block digestion',
  coa_footnotes: [{ label: 'Basis:', text: 'Limits per USP<232>.' }],
} as AnalysisProfile

let user: UserEvent

function renderSection(
  overrides: Partial<ProfileCoaVariantsSectionProps> = {},
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
) {
  return render(
    <QueryClientProvider client={client}>
      <ProfileCoaVariantsSection
        profile={PROFILE}
        savedMemberIds={[1]}
        membersLoading={false}
        services={[{ id: 1, title: 'Arsenic' }]}
        onDirtyChange={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>
  )
}

const cardTestId = (name: string) => `coa-variant-card-${FORM_IDS[name]}`
const card = (name: string) => screen.getByTestId(cardTestId(name))

function row(label: string) {
  const field = COA_FIELD_ROWS.find(r => r.label === label)?.field
  const el = screen.getByTestId(`coa-variant-row-${field}`)
  within(el).getByText(label)
  return el
}

const pick = (label: string, choice: string) =>
  user.click(screen.getByRole('radio', { name: `${label}: ${choice}` }))

async function openCard(name: string) {
  const el = await screen.findByTestId(cardTestId(name))
  await user.click(within(el).getByRole('button', { name: 'Edit' }))
}

async function openPicker() {
  // Add form waits for both lists: before that it could offer a form that
  // already has a version.
  const add = await screen.findByRole('button', { name: 'Add form' })
  await waitFor(() => expect(add).toBeEnabled())
  await user.click(add)
  // Radix Select does not open from userEvent's pointer sequence under jsdom.
  fireEvent.click(screen.getByRole('combobox', { name: 'Form' }))
}

async function pickForm(name: string) {
  await openPicker()
  fireEvent.click(await screen.findByRole('option', { name }))
}

const formsAre = (list: SampleForm[]) =>
  vi.mocked(listSampleForms).mockResolvedValue(list)
const confirmReturns = (answer: boolean) =>
  vi.mocked(window.confirm).mockReturnValue(answer)

function specsFor(map: Record<number, AnalysisServiceSpecRecord[]>) {
  vi.mocked(listServiceSpecs).mockImplementation(async id => map[id] ?? [])
}

beforeEach(() => {
  vi.resetAllMocks()
  user = userEvent.setup()
  vi.mocked(listProfileCoaVariants).mockResolvedValue([NASAL_VERSION])
  vi.mocked(createProfileCoaVariant).mockResolvedValue(NASAL_VERSION)
  vi.mocked(patchProfileCoaVariant).mockResolvedValue(NASAL_VERSION)
  formsAre([PEN, NASAL_FORM, CAPSULE])
  // Never settles unless a test calls specsFor, so the rules stay loading.
  vi.mocked(listServiceSpecs).mockReturnValue(new Promise(() => undefined))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  useUIStore.setState({ analysisServiceTargetId: null })
})

describe('ProfileCoaVariantsSection', () => {
  it('lists each version with its summary and an intro line', async () => {
    renderSection()
    expect(
      await screen.findByText('Overrides: basis note left off, prep custom')
    ).toBeVisible()
    expect(
      screen.getByText(
        'Every sample prints the Default text above. A form listed here prints its own version instead, field by field.'
      )
    ).toBeVisible()
    expect(
      screen.getByRole('heading', { name: 'COA text by sample form' })
    ).toBeVisible()
  })

  it('the picker lists active forms with no version', async () => {
    renderSection()
    await openPicker()
    expect(await screen.findByRole('option', { name: /Pen/ })).toBeVisible()
    expect(screen.queryByRole('option', { name: /Nasal Spray/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Capsule/ })).toBeNull()
  })

  it('the picker leaves out a form that already has a new card', async () => {
    formsAre([PEN, NASAL_FORM, form(6, 'Tablet')])
    renderSection()
    await pickForm('Pen')
    await openPicker()
    expect(await screen.findByRole('option', { name: /Tablet/ })).toBeVisible()
    expect(screen.queryByRole('option', { name: /Pen/ })).toBeNull()
  })

  it('a failed load says so and offers no forms', async () => {
    vi.mocked(listProfileCoaVariants).mockRejectedValue(new Error('down'))
    renderSection()
    expect(
      await screen.findByText(
        'Could not load the versions and sample forms for this profile.'
      )
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add form' })).toBeDisabled()
  })

  it('asks for the versions again when the panel reopens', async () => {
    // The app's own defaults: their 5-minute staleTime is what hid a colleague's edit.
    const client = new QueryClient({
      defaultOptions: {
        queries: { ...queryClient.getDefaultOptions().queries, retry: false },
      },
    })
    const first = renderSection({}, client)
    await screen.findByTestId(cardTestId('Nasal Spray'))
    first.unmount()
    vi.mocked(listProfileCoaVariants).mockResolvedValue([
      { ...NASAL_VERSION, coa_method_text: '' },
    ])
    renderSection({}, client)
    expect(
      await screen.findByText(
        'Overrides: basis note left off, method left off, prep custom'
      )
    ).toBeVisible()
  })

  it('keeps a version whose form was deactivated', async () => {
    formsAre([{ ...NASAL_FORM, active: false }, PEN])
    renderSection()
    expect(await screen.findByText('Nasal Spray')).toBeVisible()
  })

  it('a new form writes nothing until Save, then POSTs all five fields', async () => {
    renderSection()
    await pickForm('Pen')
    expect(createProfileCoaVariant).not.toHaveBeenCalled()
    await pick('Sample prep', 'Leave off')
    await user.click(screen.getByRole('button', { name: 'Save Pen text' }))
    expect(createProfileCoaVariant).toHaveBeenCalledWith(1, {
      sample_form_id: 3,
      coa_section_title: null,
      coa_basis_note: null,
      coa_method_text: null,
      coa_prep_text: '',
      coa_footnotes: null,
    })
  })

  it('Save on an existing version PATCHes all five fields, null for Same as default', async () => {
    renderSection()
    await openCard('Nasal Spray')
    await pick('Sample prep', 'Same as default')
    await user.click(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    )
    expect(patchProfileCoaVariant).toHaveBeenCalledWith(11, {
      coa_section_title: null,
      coa_basis_note: '',
      coa_method_text: null,
      coa_prep_text: null,
      coa_footnotes: null,
    })
  })

  it('a good save says so, closes the card and shows the saved row', async () => {
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    vi.mocked(listProfileCoaVariants).mockResolvedValue([
      { ...NASAL_VERSION, coa_method_text: '' },
    ])
    await user.click(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    )
    expect(toast.success).toHaveBeenCalledWith('Nasal Spray text saved')
    await waitFor(() =>
      expect(
        within(card('Nasal Spray')).getByRole('button', { name: 'Edit' })
      ).toBeVisible()
    )
    expect(within(card('Nasal Spray')).queryByText('Unsaved')).toBeNull()
    expect(
      within(card('Nasal Spray')).getByText(
        'Overrides: basis note left off, method left off, prep custom'
      )
    ).toBeVisible()
  })

  it('locks the open card while a save runs, so nothing typed is lost', async () => {
    let finishSave: (row: ProfileCoaVariant) => void = () => undefined
    vi.mocked(patchProfileCoaVariant).mockReturnValue(
      new Promise(resolve => {
        finishSave = resolve
      })
    )
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    await user.click(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    )
    expect(screen.getByRole('textbox', { name: 'Sample prep' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Method: Custom' })).toBeDisabled()
    finishSave(NASAL_VERSION)
    await waitFor(() =>
      expect(
        within(card('Nasal Spray')).getByRole('button', { name: 'Edit' })
      ).toBeVisible()
    )
  })

  it('a save finishing does not close a card opened while it ran', async () => {
    let finishSave: (row: ProfileCoaVariant) => void = () => undefined
    vi.mocked(patchProfileCoaVariant).mockReturnValue(
      new Promise(resolve => {
        finishSave = resolve
      })
    )
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    await user.click(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    )
    await pickForm('Pen')
    finishSave(NASAL_VERSION)
    await waitFor(() =>
      expect(within(card('Nasal Spray')).queryByText('Unsaved')).toBeNull()
    )
    expect(screen.getByRole('button', { name: 'Save Pen text' })).toBeVisible()
  })

  it('opening another card keeps the first card edits and its Unsaved tag', async () => {
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    await pickForm('Pen')
    expect(within(card('Nasal Spray')).getByText('Unsaved')).toBeVisible()
    expect(
      within(card('Nasal Spray')).getByText(/method left off/)
    ).toBeVisible()
    await openCard('Nasal Spray')
    expect(
      within(row('Method')).getByText('Not printed on Nasal Spray COAs')
    ).toBeVisible()
  })

  it('a closed card with a blank Custom says so, not left off', async () => {
    renderSection()
    await openCard('Nasal Spray')
    await pick('Sample prep', 'Custom')
    await user.clear(screen.getByRole('textbox', { name: 'Sample prep' }))
    await pickForm('Pen')
    expect(
      within(card('Nasal Spray')).getByText('A Custom field is still blank')
    ).toBeVisible()
    expect(within(card('Nasal Spray')).queryByText(/prep left off/)).toBeNull()
  })

  it('Cancel drops the edits and closes the card', async () => {
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      within(card('Nasal Spray')).getByRole('button', { name: 'Edit' })
    ).toBeVisible()
    expect(within(card('Nasal Spray')).queryByText('Unsaved')).toBeNull()
    expect(
      within(card('Nasal Spray')).getByText(
        'Overrides: basis note left off, prep custom'
      )
    ).toBeVisible()
  })

  it('Cancel on a new card removes it', async () => {
    renderSection()
    await pickForm('Pen')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId(cardTestId('Pen'))).toBeNull()
  })

  it('a failed save keeps the card, the edits and the tag, and shows the server message', async () => {
    vi.mocked(patchProfileCoaVariant).mockRejectedValueOnce(
      new Error('unknown COA text macro {lot}; supported: {lod}')
    )
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    await user.click(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    )
    expect(toast.error).toHaveBeenCalledWith(
      'unknown COA text macro {lot}; supported: {lod}'
    )
    await waitFor(() => expect(listProfileCoaVariants).toHaveBeenCalledTimes(2))
    expect(
      within(row('Method')).getByText('Not printed on Nasal Spray COAs')
    ).toBeVisible()
    expect(within(card('Nasal Spray')).getByText('Unsaved')).toBeVisible()
  })

  describe('a save refused', () => {
    const STOPPED_ELSEWHERE =
      'this version is no longer in use; save again to add it back'

    const saveNasal = async () => {
      await user.click(
        screen.getByRole('button', { name: 'Save Nasal Spray text' })
      )
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
      )
    }

    /** Edits the card, then the PATCH is refused and the list holds `listed`. */
    async function refuseSave(message: string, listed: ProfileCoaVariant[]) {
      vi.mocked(patchProfileCoaVariant).mockRejectedValueOnce(
        new Error(message)
      )
      renderSection()
      await openCard('Nasal Spray')
      await pick('Method', 'Leave off')
      vi.mocked(listProfileCoaVariants).mockResolvedValue(listed)
      await saveNasal()
    }

    it('because the version was stopped elsewhere keeps the card, the edits and the tag', async () => {
      await refuseSave(STOPPED_ELSEWHERE, [])
      expect(toast.error).toHaveBeenCalledWith(STOPPED_ELSEWHERE)
      expect(listProfileCoaVariants).toHaveBeenCalledTimes(2)
      // Someone stopped it on purpose, so the refusal itself re-creates nothing.
      expect(createProfileCoaVariant).not.toHaveBeenCalled()
      expect(
        within(row('Method')).getByText('Not printed on Nasal Spray COAs')
      ).toBeVisible()
      expect(within(card('Nasal Spray')).getByText('Unsaved')).toBeVisible()
      expect(
        screen.queryByRole('button', { name: 'Stop using this version' })
      ).toBeNull()

      // Cancel drops the draft and frees the form in the picker.
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByTestId(cardTestId('Nasal Spray'))).toBeNull()
      await openPicker()
      expect(
        await screen.findByRole('option', { name: /Nasal Spray/ })
      ).toBeVisible()
    })

    it('because the version was stopped elsewhere adds it back on the next Save, and the card closes', async () => {
      await refuseSave(STOPPED_ELSEWHERE, [])
      vi.mocked(listProfileCoaVariants).mockResolvedValue([
        { ...NASAL_VERSION, id: 12, coa_method_text: '' },
      ])
      await user.click(
        screen.getByRole('button', { name: 'Save Nasal Spray text' })
      )
      expect(createProfileCoaVariant).toHaveBeenCalledWith(1, {
        sample_form_id: 4,
        coa_section_title: null,
        coa_basis_note: '',
        coa_method_text: '',
        coa_prep_text: 'Diluted',
        coa_footnotes: null,
      })
      expect(patchProfileCoaVariant).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(
          within(card('Nasal Spray')).getByRole('button', { name: 'Edit' })
        ).toBeVisible()
      )
      expect(within(card('Nasal Spray')).queryByText('Unsaved')).toBeNull()
    })

    it('with its row still in the list still PATCHes on the next Save', async () => {
      await refuseSave('unknown COA text macro {lot}; supported: {lod}', [
        NASAL_VERSION,
      ])
      await user.click(
        screen.getByRole('button', { name: 'Save Nasal Spray text' })
      )
      expect(patchProfileCoaVariant).toHaveBeenCalledTimes(2)
      expect(createProfileCoaVariant).not.toHaveBeenCalled()
    })

    it('whose refetch also fails still PATCHes on the next Save', async () => {
      vi.mocked(patchProfileCoaVariant).mockRejectedValueOnce(new Error('down'))
      renderSection()
      await openCard('Nasal Spray')
      await pick('Method', 'Leave off')
      vi.mocked(listProfileCoaVariants).mockRejectedValue(new Error('down'))
      await saveNasal()
      await user.click(
        screen.getByRole('button', { name: 'Save Nasal Spray text' })
      )
      expect(patchProfileCoaVariant).toHaveBeenCalledTimes(2)
      expect(createProfileCoaVariant).not.toHaveBeenCalled()
    })

    it('never doubles the card if its row comes back to the list', async () => {
      await refuseSave(STOPPED_ELSEWHERE, [])
      vi.mocked(createProfileCoaVariant).mockRejectedValueOnce(
        new Error(
          'an active version already exists for this form; stop using it first'
        )
      )
      vi.mocked(listProfileCoaVariants).mockResolvedValue([NASAL_VERSION])
      await saveNasal()
      expect(listProfileCoaVariants).toHaveBeenCalledTimes(3)
      await waitFor(() =>
        expect(screen.getAllByTestId(cardTestId('Nasal Spray'))).toHaveLength(1)
      )
    })
  })

  it('a 409 on a new card shows the version made elsewhere and keeps the new card', async () => {
    vi.mocked(listProfileCoaVariants).mockResolvedValue([])
    vi.mocked(createProfileCoaVariant).mockRejectedValueOnce(
      new Error(
        'an active version already exists for this form; stop using it first'
      )
    )
    renderSection()
    await pickForm('Nasal Spray')
    await pick('Method', 'Leave off')
    vi.mocked(listProfileCoaVariants).mockResolvedValue([NASAL_VERSION])
    await user.click(
      screen.getByRole('button', { name: 'Save Nasal Spray text' })
    )
    expect(
      await screen.findByText('Overrides: basis note left off, prep custom')
    ).toBeVisible()
    expect(screen.getAllByTestId(cardTestId('Nasal Spray'))).toHaveLength(2)
    expect(
      within(row('Method')).getByText('Not printed on Nasal Spray COAs')
    ).toBeVisible()
    expect(screen.getByText('Unsaved')).toBeVisible()
  })

  it('Stop using asks first, then PATCHes active false', async () => {
    confirmReturns(false)
    renderSection()
    await openCard('Nasal Spray')
    await user.click(
      screen.getByRole('button', { name: 'Stop using this version' })
    )
    expect(window.confirm).toHaveBeenCalledWith(
      'Stop using the Nasal Spray version? Nasal Spray COAs go back to the Default text. Published COAs stay as they are until they are regenerated.'
    )
    expect(patchProfileCoaVariant).not.toHaveBeenCalled()
    confirmReturns(true)
    vi.mocked(listProfileCoaVariants).mockResolvedValue([])
    await user.click(
      screen.getByRole('button', { name: 'Stop using this version' })
    )
    expect(patchProfileCoaVariant).toHaveBeenCalledWith(11, { active: false })
    expect(toast.success).toHaveBeenCalledWith(
      'Nasal Spray COAs now print the Default text'
    )
    await waitFor(() =>
      expect(screen.queryByTestId(cardTestId('Nasal Spray'))).toBeNull()
    )
  })

  it('Add the rule asks first when there are unsaved edits', async () => {
    specsFor({ 1: [] })
    renderSection()
    await openCard('Nasal Spray')
    await pick('Method', 'Leave off')
    confirmReturns(false)
    await user.click(
      await screen.findByRole('button', { name: 'Add the rule' })
    )
    expect(useUIStore.getState().analysisServiceTargetId).toBeNull()
    confirmReturns(true)
    await user.click(screen.getByRole('button', { name: 'Add the rule' }))
    expect(useUIStore.getState().analysisServiceTargetId).toBe(1)
  })

  it('reports dirty to the page', async () => {
    const onDirtyChange = vi.fn()
    renderSection({ onDirtyChange })
    await openCard('Nasal Spray')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    await pick('Method', 'Leave off')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })
})
