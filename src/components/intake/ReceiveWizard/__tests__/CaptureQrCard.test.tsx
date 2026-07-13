import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, mintCaptureToken: vi.fn() }
})

import { mintCaptureToken } from '@/lib/api'
import { CaptureQrCard } from '@/components/intake/ReceiveWizard/CaptureQrCard'

const mockMint = vi.mocked(mintCaptureToken)

describe('CaptureQrCard', () => {
  it('mints a token and renders the QR link', async () => {
    mockMint.mockResolvedValue({ id: 1, token: 'tok123', expires_at: '2099-01-01T00:00:00Z' })
    render(<CaptureQrCard captureContext={{ orderLabel: 'WP-1', samples: [{ sample_id: 'P-1' }] }} />)
    await screen.findByText(/scan with your phone/i)
    expect(mockMint).toHaveBeenCalledWith({ samples: [{ sample_id: 'P-1' }], orderLabel: 'WP-1' })
    // QRCodeSVG renders an <svg>
    expect(document.querySelector('svg')).toBeTruthy()
  })

  it('renders nothing when the mint fails', async () => {
    mockMint.mockRejectedValue(new Error('nope'))
    const { container } = render(
      <CaptureQrCard captureContext={{ orderLabel: null, samples: [{ sample_id: 'P-1' }] }} />
    )
    await waitFor(() => expect(mockMint).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
