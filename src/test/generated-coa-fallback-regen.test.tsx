import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, regenPrimaryCOA: vi.fn() }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { GeneratedCOAFallbackList } from '@/components/senaite/SampleDetails'
import { regenPrimaryCOA } from '@/lib/api'
import { toast } from 'sonner'

const mockRegen = vi.mocked(regenPrimaryCOA)

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'gen-1',
    sample_id: 'PB-0001',
    generation_number: 1,
    verification_code: 'ABCD-1234',
    content_hash: 'hash',
    status: 'draft',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: null,
    superseded_at: null,
    created_at: '2026-09-09T01:50:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: null,
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    ...overrides,
  }
}

// Shapes from the prod screenshot that surfaced the bug: a published primary
// (#15) above never-published drafts (#8, #1). Newest first, as
// selectRootGenerations hands them to the card.
const PUBLISHED_15 = gen({
  id: 'g15',
  generation_number: 15,
  status: 'published',
  verification_code: 'HQFL-R9KD',
  published_at: '2026-09-09T01:52:00Z',
  created_at: '2026-09-09T01:52:00Z',
  ingestion_status: 'notified',
})
const DRAFT_8 = gen({
  id: 'g8',
  generation_number: 8,
  verification_code: 'YBWW-Q9CJ',
  created_at: '2026-09-09T01:51:00Z',
})
const DRAFT_16_ORPHAN = gen({
  id: 'g16',
  generation_number: 16,
  verification_code: 'ZZZZ-0016',
  created_at: '2026-09-09T02:00:00Z',
})

const regenButtons = () =>
  screen.queryAllByRole('button', { name: /regen & republish/i })
const regenButton = () =>
  screen.getByRole('button', { name: /regen & republish/i })

describe('GeneratedCOAFallbackList — primary Regen & Republish (mk1 read mode)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => {
    confirmSpy.mockRestore()
  })

  it('renders exactly one Regen & Republish button, on the published primary row', () => {
    // Orphan draft newer than the published cert: the button must follow the
    // published row, not "first row" and not "every row".
    render(
      <GeneratedCOAFallbackList
        generations={[DRAFT_16_ORPHAN, PUBLISHED_15, DRAFT_8]}
        sampleId="PB-0001"
        onPrimaryRegenerated={vi.fn()}
      />
    )
    expect(regenButtons()).toHaveLength(1)
  })

  it('renders no Regen & Republish button when onPrimaryRegenerated is absent (Core COA card)', () => {
    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED_15, DRAFT_8]}
        sampleId="PB-0001"
      />
    )
    expect(regenButtons()).toHaveLength(0)
  })

  it('renders no Regen & Republish button when no root generation is published', () => {
    render(
      <GeneratedCOAFallbackList
        generations={[DRAFT_8]}
        sampleId="PB-0001"
        onPrimaryRegenerated={vi.fn()}
      />
    )
    expect(regenButtons()).toHaveLength(0)
    expect(screen.getByText('Not yet attached to SENAITE')).toBeInTheDocument()
  })

  it('confirms, calls regenPrimaryCOA for the sample, toasts the new code and refreshes', async () => {
    mockRegen.mockResolvedValue({
      success: true,
      message: 'ok',
      verification_code: 'NEW1-CODE',
    })
    const onRegenerated = vi.fn()
    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED_15, DRAFT_8]}
        sampleId="PB-0001"
        onPrimaryRegenerated={onRegenerated}
      />
    )
    fireEvent.click(regenButton())

    await waitFor(() => expect(onRegenerated).toHaveBeenCalledTimes(1))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('PB-0001'))
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining('Additional COAs keep their existing codes')
    )
    expect(mockRegen).toHaveBeenCalledWith('PB-0001')
    expect(toast.success).toHaveBeenCalledWith(
      'Primary COA regenerated & republished',
      expect.objectContaining({ description: 'New code: NEW1-CODE' })
    )
  })

  it('does nothing when the confirm dialog is declined', () => {
    confirmSpy.mockReturnValue(false)
    const onRegenerated = vi.fn()
    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED_15]}
        sampleId="PB-0001"
        onPrimaryRegenerated={onRegenerated}
      />
    )
    fireEvent.click(regenButton())
    expect(mockRegen).not.toHaveBeenCalled()
    expect(onRegenerated).not.toHaveBeenCalled()
  })

  it('surfaces a failed regen as an error toast and does not refresh', async () => {
    mockRegen.mockResolvedValue({
      success: false,
      message: 'COA Builder error: boom',
      verification_code: null,
    })
    const onRegenerated = vi.fn()
    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED_15]}
        sampleId="PB-0001"
        onPrimaryRegenerated={onRegenerated}
      />
    )
    fireEvent.click(regenButton())

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Regen failed', {
        description: 'COA Builder error: boom',
      })
    )
    expect(onRegenerated).not.toHaveBeenCalled()
  })
})
