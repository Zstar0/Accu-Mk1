import { it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReadSourceIndicator } from '@/components/senaite/ReadSourceIndicator'

it('labels Accu-Mk1', () => {
  render(<ReadSourceIndicator source="mk1" />)
  expect(screen.getByText(/Read from Accu-Mk1/i)).toBeInTheDocument()
})
it('labels SENAITE', () => {
  render(<ReadSourceIndicator source="senaite" />)
  expect(screen.getByText(/Read from SENAITE/i)).toBeInTheDocument()
})
