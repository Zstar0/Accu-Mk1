import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Radix Select under jsdom: pointer capture and scrollIntoView are missing.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

/** Open a Radix Select and pick an option (fireEvent, as in SampleFormSelect.test). */
async function pickRoute(trigger: HTMLElement, route: string) {
  fireEvent.click(trigger)
  fireEvent.click(
    await screen.findByRole('option', {
      name: `preferences.sampleForms.route.${route}`,
    })
  )
}

const h = vi.hoisted(() => ({
  state: { loading: false, error: false, empty: false },
  forms: [
    {
      id: 1,
      name: 'Vial',
      route: 'injectable',
      is_default: true,
      active: true,
      sort_order: 10,
      sample_count: 12,
    },
    {
      id: 2,
      name: 'Pen',
      route: 'injectable',
      is_default: false,
      active: true,
      sort_order: 20,
      sample_count: 3,
    },
    {
      id: 3,
      name: 'Old kit',
      route: 'oral',
      is_default: false,
      active: false,
      sort_order: 30,
      sample_count: 0,
    },
  ],
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/services/sample-forms', () => ({
  useSampleForms: () => ({
    data: h.state.loading ? undefined : h.state.empty ? [] : h.forms,
    isLoading: h.state.loading,
    isError: h.state.error,
  }),
  useCreateSampleForm: () => ({ mutate: h.create, isPending: false }),
  useUpdateSampleForm: () => ({ mutate: h.update, isPending: false }),
}))

import { SampleFormsPane } from '@/components/preferences/panes/SampleFormsPane'

const row = (name: string) => screen.getByRole('group', { name })

describe('SampleFormsPane', () => {
  beforeEach(() => {
    h.state.loading = false
    h.state.error = false
    h.state.empty = false
    h.create.mockReset()
    h.update.mockReset()
  })

  it('lists forms with default badge and sample count', () => {
    render(<SampleFormsPane />)
    expect(screen.getByDisplayValue('Vial')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Pen')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Old kit')).toBeInTheDocument()
    // exactly one default badge, on the default form's row
    expect(screen.getAllByText('preferences.sampleForms.default')).toHaveLength(
      1
    )
    expect(
      within(row('Vial')).getByText('preferences.sampleForms.default')
    ).toBeInTheDocument()
    expect(within(row('Vial')).getByText('12')).toBeInTheDocument()
    expect(within(row('Pen')).getByText('3')).toBeInTheDocument()
    expect(
      within(row('Old kit')).getByText('preferences.sampleForms.inactive')
    ).toBeInTheDocument()
  })

  it('deactivate is disabled for the default form', () => {
    render(<SampleFormsPane />)
    expect(
      within(row('Vial')).getByRole('button', {
        name: 'preferences.sampleForms.deactivate',
      })
    ).toBeDisabled()
    expect(
      within(row('Pen')).getByRole('button', {
        name: 'preferences.sampleForms.deactivate',
      })
    ).toBeEnabled()
    // an inactive form offers Activate instead
    expect(
      within(row('Old kit')).getByRole('button', {
        name: 'preferences.sampleForms.activate',
      })
    ).toBeEnabled()
  })

  it('deactivating a non-default form sends active false', async () => {
    const user = userEvent.setup()
    render(<SampleFormsPane />)
    await user.click(
      within(row('Pen')).getByRole('button', {
        name: 'preferences.sampleForms.deactivate',
      })
    )
    expect(h.update).toHaveBeenCalledWith({ id: 2, data: { active: false } })
  })

  it('make default calls update with is_default true', async () => {
    const user = userEvent.setup()
    render(<SampleFormsPane />)
    // the default form has nothing to promote to; an inactive form cannot be promoted
    expect(
      within(row('Vial')).queryByRole('button', {
        name: 'preferences.sampleForms.makeDefault',
      })
    ).not.toBeInTheDocument()
    expect(
      within(row('Old kit')).getByRole('button', {
        name: 'preferences.sampleForms.makeDefault',
      })
    ).toBeDisabled()
    await user.click(
      within(row('Pen')).getByRole('button', {
        name: 'preferences.sampleForms.makeDefault',
      })
    )
    expect(h.update).toHaveBeenCalledWith({ id: 2, data: { is_default: true } })
  })

  it('save sends only the changed fields', async () => {
    const user = userEvent.setup()
    render(<SampleFormsPane />)
    const save = within(row('Pen')).getByRole('button', {
      name: 'preferences.sampleForms.save',
    })
    expect(save).toBeDisabled()
    const name = screen.getByDisplayValue('Pen')
    await user.clear(name)
    await user.type(name, 'Pen v2')
    await pickRoute(
      within(row('Pen')).getByLabelText('Pen route'),
      'nasal_inhaled'
    )
    const order = within(row('Pen')).getByLabelText('Pen order')
    await user.clear(order)
    await user.type(order, '5')
    await user.click(save)
    expect(h.update).toHaveBeenCalledWith({
      id: 2,
      data: { name: 'Pen v2', route: 'nasal_inhaled', sort_order: 5 },
    })
  })

  it('add form submits name and route', async () => {
    const user = userEvent.setup()
    render(<SampleFormsPane />)
    const add = screen.getByRole('button', {
      name: /preferences.sampleForms.add/,
    })
    expect(add).toBeDisabled() // no name yet
    await user.type(
      screen.getByLabelText('preferences.sampleForms.newName'),
      'Syringe'
    )
    await pickRoute(
      screen.getByLabelText('preferences.sampleForms.newRoute'),
      'oral'
    )
    await user.click(add)
    expect(h.create).toHaveBeenCalledWith(
      { name: 'Syringe', route: 'oral' },
      expect.anything()
    )
  })

  it('every row, the header and the add row share one column template', () => {
    const { container } = render(<SampleFormsPane />)
    const template = (el: Element) =>
      [...el.classList].find(c => c.startsWith('grid-cols-['))
    const rows = screen.getAllByRole('group')
    const header = screen.getByText(
      'preferences.sampleForms.colForm'
    ).parentElement
    const addRow = container.querySelector('form')
    if (!header || !addRow) throw new Error('expected the header and add row')
    const templates = [...rows, header, addRow].map(template)
    expect(templates[0]).toBeDefined()
    // A per-row `auto` track is what let the columns drift: no track may size
    // itself from its own row's content.
    expect(templates[0]).not.toMatch(/auto/)
    expect(new Set(templates).size).toBe(1)
    // The default badge sits in the Make default slot, not beside the name.
    expect(
      within(row('Vial')).getByText('preferences.sampleForms.default')
        .parentElement
    ).toBe(
      within(row('Vial')).getByRole('button', {
        name: 'preferences.sampleForms.save',
      }).parentElement
    )
  })

  it('renders no delete control', () => {
    render(<SampleFormsPane />)
    expect(
      screen.queryByRole('button', { name: /delete|remove/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/delete|remove/i)).not.toBeInTheDocument()
  })

  it('shows a spinner while loading, an error on failure, a hint when empty', () => {
    h.state.loading = true
    const { rerender } = render(<SampleFormsPane />)
    expect(
      screen.queryByText('preferences.sampleForms.sectionTitle')
    ).not.toBeInTheDocument()

    h.state.loading = false
    h.state.error = true
    rerender(<SampleFormsPane />)
    expect(
      screen.getByText('preferences.sampleForms.loadError')
    ).toBeInTheDocument()

    h.state.error = false
    h.state.empty = true
    rerender(<SampleFormsPane />)
    expect(
      screen.getByText('preferences.sampleForms.empty')
    ).toBeInTheDocument()
    // the add row is still there so the lab can create the first form
    expect(
      screen.getByLabelText('preferences.sampleForms.newName')
    ).toBeInTheDocument()
  })
})
