import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SampleIdBadge } from './SampleIdBadge'
import { useUIStore } from '@/store/ui-store'

// Mock the store
vi.mock('@/store/ui-store', () => ({
  useUIStore: vi.fn(),
}))

describe('SampleIdBadge', () => {
  const mockNavigateToSample = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useUIStore).mockImplementation((selector: any) => {
      if (typeof selector === 'function') {
        return selector({
          navigateToSample: mockNavigateToSample,
        } as any)
      }
      return {
        navigateToSample: mockNavigateToSample,
      } as any
    })
  })

  it('renders bare ID with no hierarchy', () => {
    render(<SampleIdBadge id="P-0089" />)
    expect(screen.getByText('P-0089')).toBeInTheDocument()
  })

  it('renders parent linkage when given parentId', () => {
    render(<SampleIdBadge id="P-0134-S02" parentId="P-0134" vialSequence={2} />)
    expect(screen.getByText('P-0134-S02')).toBeInTheDocument()
    expect(screen.getByText(/child of/i)).toBeInTheDocument()
  })

  it('renders vial count when parent has children', () => {
    render(<SampleIdBadge id="P-0134" hasChildren={3} />)
    expect(screen.getByText('P-0134')).toBeInTheDocument()
    expect(screen.getByText(/3 vials/i)).toBeInTheDocument()
  })

  it('parent ID link navigates to parent detail on click', async () => {
    const user = userEvent.setup()
    render(<SampleIdBadge id="P-0134-S02" parentId="P-0134" vialSequence={2} />)
    const button = screen.getByRole('button', { name: /P-0134/ })
    await user.click(button)
    expect(mockNavigateToSample).toHaveBeenCalledWith('P-0134')
  })

  it('omits child-of region when parentId is undefined', () => {
    render(<SampleIdBadge id="P-0089" />)
    expect(screen.queryByText(/child of/i)).not.toBeInTheDocument()
  })
})
