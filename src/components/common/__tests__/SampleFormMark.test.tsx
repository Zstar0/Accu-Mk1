import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  forms: [
    {
      id: 4,
      name: 'Nasal Spray',
      route: 'nasal_inhaled',
      is_default: false,
      active: true,
      sort_order: 40,
      icon: 'nasal_spray',
      sample_count: 2,
    },
  ] as unknown[] | undefined,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/services/sample-forms', () => ({
  useSampleForms: () => ({ data: h.forms }),
}))

import {
  SampleFormCard,
  SampleFormMark,
} from '@/components/common/SampleFormIcon'

describe('SampleFormMark', () => {
  it('draws the form icon, named for screen readers', () => {
    render(<SampleFormMark formId={4} />)
    const mark = screen.getByRole('img', { name: 'Form: Nasal Spray' })
    expect(mark.querySelector('svg')?.getAttribute('data-icon')).toBe(
      'nasal_spray'
    )
  })

  it('draws nothing without a form, for an unknown id, or before the list loads', () => {
    const { container, rerender } = render(<SampleFormMark formId={null} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<SampleFormMark formId={99} />)
    expect(container).toBeEmptyDOMElement()
    h.forms = undefined
    rerender(<SampleFormMark formId={4} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SampleFormCard', () => {
  it('names the form and its route, and flags an inactive form', () => {
    render(<SampleFormCard name="Capsule" routeLabel="Oral" active={false} />)
    expect(screen.getByText('Capsule')).toBeInTheDocument()
    expect(screen.getByText('Route:').parentElement).toHaveTextContent(
      'Route: Oral (inactive)'
    )
  })
})
