import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  loading: false,
  forms: [
    {
      id: 1,
      name: 'Vial',
      route: 'injectable',
      is_default: true,
      active: true,
      sort_order: 10,
      icon: 'powder_vial',
      sample_count: 5,
    },
    {
      id: 2,
      name: 'Pen',
      route: 'injectable',
      is_default: false,
      active: true,
      sort_order: 20,
      icon: 'pen',
      sample_count: 1,
    },
    {
      id: 3,
      name: 'Old kit',
      route: 'oral',
      is_default: false,
      active: false,
      sort_order: 30,
      icon: null,
      sample_count: 0,
    },
  ],
  mutate: vi.fn(),
}))

vi.mock('@/services/sample-forms', () => ({
  useSampleForms: () => ({
    data: h.loading ? undefined : h.forms,
    isLoading: h.loading,
  }),
  useSetSampleForm: () => ({ mutate: h.mutate, isPending: false }),
}))

import { SampleFormSelect } from '@/components/common/SampleFormSelect'

function renderSelect(
  props: Partial<React.ComponentProps<typeof SampleFormSelect>> = {}
) {
  const onChanged = vi.fn()
  render(
    <SampleFormSelect
      sampleId="P-1"
      valueId={1}
      valueName="Vial"
      onChanged={onChanged}
      ariaLabel="Form for P-1"
      {...props}
    />
  )
  return { onChanged }
}

// Radix Select needs fireEvent under jsdom (hasPointerCapture is missing).
const open = () => fireEvent.click(screen.getByRole('combobox'))

describe('SampleFormSelect', () => {
  beforeEach(() => {
    h.loading = false
    h.mutate.mockReset()
  })

  it('shows an inactive current form as selected and disabled', async () => {
    renderSelect({ valueId: 3, valueName: 'Old kit' })
    expect(screen.getByRole('combobox')).toHaveTextContent('Old kit (inactive)')
    open()
    const current = await screen.findByRole('option', { name: /Old kit/ })
    expect(current).toHaveAttribute('aria-disabled', 'true')
    expect(current).toHaveAttribute('data-state', 'checked')
    // active forms stay pickable
    expect(screen.getByRole('option', { name: 'Pen' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('does not offer an inactive form the sample is not holding', async () => {
    renderSelect({ valueId: 1 })
    open()
    await screen.findByRole('option', { name: 'Pen' })
    expect(
      screen.queryByRole('option', { name: /Old kit/ })
    ).not.toBeInTheDocument()
  })

  it('picking a form calls setSampleForm then onChanged', async () => {
    h.mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
    const { onChanged } = renderSelect()
    open()
    fireEvent.click(await screen.findByRole('option', { name: 'Pen' }))
    expect(h.mutate).toHaveBeenCalledWith(
      { sampleId: 'P-1', sampleFormId: 2 },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('draws each form icon on the closed picker and on every option', async () => {
    renderSelect()
    const icon = (el: Element) =>
      el.querySelector('svg[data-icon]')?.getAttribute('data-icon')
    expect(icon(screen.getByRole('combobox'))).toBe('powder_vial')
    open()
    expect(icon(await screen.findByRole('option', { name: 'Pen' }))).toBe('pen')
  })

  it('draws the generic icon for a form with none', () => {
    renderSelect({ valueId: 3, valueName: 'Old kit' })
    expect(
      screen.getByRole('combobox').querySelector('svg[data-icon="other"]')
    ).not.toBeNull()
  })

  it('shows a placeholder when an eligible sample has no form yet', () => {
    renderSelect({ valueId: null, valueName: null })
    expect(screen.getByRole('combobox')).toHaveTextContent('Select form')
  })

  it('stays disabled and still names the value while the list loads', () => {
    h.loading = true
    renderSelect()
    const trigger = screen.getByRole('combobox')
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('Vial')
  })
})
