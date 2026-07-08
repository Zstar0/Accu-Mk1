import { describe, it, expect } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { ReadSourceBanner } from '@/components/senaite/ReadSourceBanner'

describe('ReadSourceBanner', () => {
  it('renders nothing when readSource is not mk1 (senaite mode)', () => {
    const { container } = render(
      <ReadSourceBanner
        readSource={undefined}
        registryMissing={false}
        fieldSources={{ client: 'mk1' }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the registry-missing variant when registryMissing is true', () => {
    render(
      <ReadSourceBanner
        readSource="mk1"
        registryMissing={true}
        fieldSources={{}}
      />
    )
    expect(
      screen.getByText(/reading from Accu-Mk1.*no registry row, showing SENAITE/i)
    ).toBeInTheDocument()
  })

  it('shows an N/M field-count summary when read from the registry', () => {
    render(
      <ReadSourceBanner
        readSource="mk1"
        registryMissing={false}
        fieldSources={{
          client: 'mk1',
          contact: 'mk1',
          client_lot: 'senaite',
        }}
      />
    )
    expect(
      screen.getByText(/reading basic-info from Accu-Mk1 — 2\/3 fields/i)
    ).toBeInTheDocument()
  })
})
