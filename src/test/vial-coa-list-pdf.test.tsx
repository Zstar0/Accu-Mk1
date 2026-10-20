import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, getExplorerCOASignedUrl: vi.fn() }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { VialCOAList } from '@/components/senaite/SampleDetails'
import { getExplorerCOASignedUrl } from '@/lib/api'
import { toast } from 'sonner'

const mockSignedUrl = vi.mocked(getExplorerCOASignedUrl)

// A per-vial child as the Per-Vial COAs card receives it (P-5324, 2026-10-20:
// four drafts, Gen #9..#12, one per HPLC vial, all under the primary).
function vialGen(
  generationNumber: number,
  vialSequence: number,
  code: string
): ExplorerCOAGeneration {
  return {
    id: `g${generationNumber}`,
    sample_id: 'P-5324',
    generation_number: generationNumber,
    verification_code: code,
    content_hash: 'hash',
    status: 'draft',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: null,
    superseded_at: null,
    created_at: '2026-10-20T15:22:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: 'primary-gen',
    vial_sequence: vialSequence,
    is_regular_coa: false,
    ingestion_status: null,
  }
}

describe('VialCOAList PDF button', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockSignedUrl.mockReset()
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    openSpy.mockRestore()
  })

  it('shows a PDF button per vial that opens that vial generation', async () => {
    mockSignedUrl.mockResolvedValue({
      url: 'https://s3.test/coa/EJU8-ULRB.pdf',
    } as Awaited<ReturnType<typeof getExplorerCOASignedUrl>>)
    render(
      <VialCOAList
        sampleId="P-5324"
        generations={[vialGen(9, 1, 'TYKE-YCJU'), vialGen(10, 2, 'EJU8-ULRB')]}
      />
    )
    const buttons = screen.getAllByRole('button', { name: /PDF/ })
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[1] as HTMLElement)
    // The signed URL is asked for the parent's sample id and THAT vial's
    // generation number, never the primary's.
    await waitFor(() =>
      expect(mockSignedUrl).toHaveBeenCalledWith('P-5324', 10)
    )
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://s3.test/coa/EJU8-ULRB.pdf',
        '_blank'
      )
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a failed signed-URL lookup instead of opening a blank tab', async () => {
    mockSignedUrl.mockRejectedValue(
      new Error('COA PDF not found for P-5324 v9')
    )
    render(
      <VialCOAList
        sampleId="P-5324"
        generations={[vialGen(9, 1, 'TYKE-YCJU')]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to open COA PDF')
    )
    expect(openSpy).not.toHaveBeenCalled()
  })
})
