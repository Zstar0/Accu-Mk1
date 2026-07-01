import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Radix Tabs relies on pointer-capture APIs jsdom doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

// Mock the two packaging children to sentinels so we can assert they render.
vi.mock('@/components/intake/ReceiveWizard/PackagingPanel', () => ({
  PackagingPanel: ({ parentSampleId }: { parentSampleId: string }) => (
    <div data-testid="packaging-panel">panel:{parentSampleId}</div>
  ),
}))
vi.mock('@/components/intake/ReceiveWizard/PackagingImagesList', () => ({
  PackagingImagesList: ({ parentSampleId }: { parentSampleId: string }) => (
    <div data-testid="packaging-images-list">list:{parentSampleId}</div>
  ),
}))

// Stub the remaining heavy children so the wizard renders in isolation.
vi.mock('@/components/intake/ReceiveWizard/WizardHeader', () => ({
  WizardHeader: () => <div />,
}))
vi.mock('@/components/intake/ReceiveWizard/WizardSidebar', () => ({
  WizardSidebar: () => <div />,
}))
vi.mock('@/components/intake/ReceiveWizard/VialsList', () => ({
  VialsList: () => <div data-testid="vials-list" />,
}))
vi.mock('@/components/intake/ReceiveWizard/VialPanel', () => ({
  VialPanel: () => <div data-testid="vial-panel" />,
}))
vi.mock('@/components/intake/ReceiveWizard/PrintStep', () => ({
  PrintStep: () => <div />,
}))
vi.mock('@/components/intake/ReceiveWizard/AssignStep', () => ({
  AssignStep: () => <div />,
}))
vi.mock('@/components/intake/ReceiveWizard/VialDetailsTab', () => ({
  VialDetailsTab: () => <div />,
  useCloseAndNavigate: () => () => {},
}))
vi.mock('@/components/intake/ReceiveWizard/useReceiveWizard', () => ({
  useReceiveWizard: () => ({
    vials: [],
    sessionVials: [],
    loading: false,
    error: null,
    parentReceived: false,
    parentReceivedThisSession: false,
    parentRole: null,
    containerMode: false,
    refresh: vi.fn(),
    saveNewVial: vi.fn(),
    saveNewVialsBulk: vi.fn(),
    editSessionVial: vi.fn(),
    deleteSessionVial: vi.fn(),
  }),
}))
vi.mock('@/components/intake/ReceiveWizard/useParentSampleDetails', () => ({
  useParentSampleDetails: () => ({ details: null, loading: false, error: null }),
}))

import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'

const parent = { uid: 'U-1', sample_id: 'P-1', status: null }

describe('ReceiveWizard packaging tab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders a "Packaging" tab as the FIRST trigger', () => {
    render(<ReceiveWizard parent={parent} onClose={() => {}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveTextContent('Packaging')
    // still additive: Vial Management remains present
    expect(screen.getByRole('tab', { name: 'Vial Management' })).toBeInTheDocument()
  })

  it('defaults to the capture phase for existing callers (no packaging body)', () => {
    render(<ReceiveWizard parent={parent} onClose={() => {}} />)
    expect(screen.queryByTestId('packaging-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('vial-panel')).toBeInTheDocument()
  })

  it('selecting the Packaging tab renders PackagingPanel + PackagingImagesList', async () => {
    render(<ReceiveWizard parent={parent} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Packaging' }))

    const panel = screen.getByTestId('packaging-panel')
    const list = screen.getByTestId('packaging-images-list')
    expect(panel).toBeInTheDocument()
    expect(list).toBeInTheDocument()
    expect(within(panel).getByText('panel:P-1')).toBeInTheDocument()
    expect(within(list).getByText('list:P-1')).toBeInTheDocument()
  })
})
