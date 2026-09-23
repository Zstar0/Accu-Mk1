import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StackBanner } from './StackBanner'

const api = vi.hoisted(() => ({ healthCheck: vi.fn() }))
vi.mock('@/lib/api', async orig => ({ ...(await orig()), ...api }))

// No beforeEach(mockClear/mockReset): under vitest 4 a spy cleared in a hook
// reports the rejection below as unhandled even though the component catches
// it. Each test waits on its own call instead.
const settled = async (before: number) => {
  await waitFor(() =>
    expect(api.healthCheck.mock.calls.length).toBe(before + 1)
  )
  await new Promise(r => setTimeout(r, 0))
}

describe('StackBanner', () => {
  it('draws the stack name and one link per entry', async () => {
    api.healthCheck.mockResolvedValue({
      status: 'ok',
      version: '1.0.0',
      stack: {
        name: 'alice',
        links: { WP: 'http://h:5535/wp-admin/', Mk1: 'http://h:5532' },
      },
    })
    render(<StackBanner />)
    expect(await screen.findByRole('note')).toHaveTextContent('DEV STACK alice')
    expect(screen.getByRole('link', { name: 'WP' })).toHaveAttribute(
      'href',
      'http://h:5535/wp-admin/'
    )
    expect(screen.getByRole('link', { name: 'Mk1' })).toHaveAttribute(
      'href',
      'http://h:5532'
    )
  })

  it('renders nothing when /health has no stack (prod)', async () => {
    const before = api.healthCheck.mock.calls.length
    api.healthCheck.mockResolvedValue({ status: 'ok', version: '1.0.0' })
    const { container } = render(<StackBanner />)
    await settled(before)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the backend is unreachable', async () => {
    const before = api.healthCheck.mock.calls.length
    api.healthCheck.mockImplementation(() => Promise.reject(new Error('down')))
    const { container } = render(<StackBanner />)
    await settled(before)
    expect(container).toBeEmptyDOMElement()
  })
})
