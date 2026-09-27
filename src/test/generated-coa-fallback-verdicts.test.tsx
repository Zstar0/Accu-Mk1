import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    setCoaForwardEnabled: vi.fn(),
    revokeCoaGeneration: vi.fn(),
    getCoaRevokePreview: vi.fn(),
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { GeneratedCOAFallbackList } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'
import {
  revokeCoaGeneration,
  setCoaForwardEnabled,
  getCoaRevokePreview,
} from '@/lib/api'

const mockForward = vi.mocked(setCoaForwardEnabled)
const mockRevoke = vi.mocked(revokeCoaGeneration)
const mockPreview = vi.mocked(getCoaRevokePreview)

// Lab-side controls on the COA console rows (sample details): a superseded
// row gets the "Forward to current" toggle (the prelim -> final flow), and any
// issued row gets Revoke with a mandatory reason. Drafts get neither.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'gen-1',
    sample_id: 'P-0001',
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
    created_at: '2026-09-01T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: null,
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  }
}

const PUBLISHED = gen({
  id: 'g2',
  generation_number: 2,
  status: 'published',
  verification_code: 'NEW-0002',
  published_at: '2026-09-10T00:00:00Z',
  ingestion_status: 'notified',
})
const SUPERSEDED = gen({
  id: 'g1',
  status: 'superseded',
  verification_code: 'OLD-0001',
  published_at: '2026-09-01T00:00:00Z',
  superseded_at: '2026-09-10T00:00:00Z',
})
const DRAFT = gen({
  id: 'g0',
  generation_number: 3,
  status: 'draft',
  verification_code: 'DRF-0003',
})

// Revocation is admin-only (server-enforced); the UI hides it from everyone else.
function signInAs(role: string) {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role } as never,
  })
}

beforeEach(() => {
  mockForward.mockReset()
  mockRevoke.mockReset()
  mockPreview.mockReset()
  signInAs('admin')
})

describe('GeneratedCOAFallbackList verdict controls', () => {
  it('offers Forward to current only on the superseded row and persists the toggle', async () => {
    const onStateChanged = vi.fn()
    mockForward.mockResolvedValue({
      generation_id: 'g1',
      verification_code: 'OLD-0001',
      status: 'superseded',
      forward_enabled: true,
      revoked_at: null,
      revocation_reason: null,
    })

    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED, SUPERSEDED]}
        sampleId="P-0001"
        onStateChanged={onStateChanged}
      />
    )

    screen
      .getAllByRole('button', { name: 'Manage' })
      .forEach(btn => fireEvent.click(btn))
    expect(screen.getAllByLabelText('Forward to current')).toHaveLength(1) // superseded only
    fireEvent.click(screen.getByLabelText('Forward to current'))

    await waitFor(() => expect(mockForward).toHaveBeenCalledWith('g1', true))
    await waitFor(() => expect(onStateChanged).toHaveBeenCalled())
  })

  it('offers Revoke on issued rows only, and sends the typed reason', async () => {
    const onStateChanged = vi.fn()
    mockRevoke.mockResolvedValue({
      revoked: [
        {
          generation_id: 'g2',
          verification_code: 'NEW-0002',
          status: 'revoked',
          kind: 'primary',
          brand: null,
          revoked_at: '2026-09-22T12:00:00Z',
          revocation_reason: 'Sample mix-up',
        },
      ],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })

    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED, DRAFT]}
        sampleId="P-0001"
        onStateChanged={onStateChanged}
      />
    )

    expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(1) // published yes, draft no
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))

    const reason = await screen.findByPlaceholderText(/reason/i)
    fireEvent.change(reason, { target: { value: 'Sample mix-up' } })
    fireEvent.click(
      screen.getByRole('button', { name: /^revoke 1 certificate$/i })
    )

    await waitFor(() =>
      expect(mockRevoke).toHaveBeenCalledWith('g2', 'Sample mix-up', [], true)
    )
    await waitFor(() => expect(onStateChanged).toHaveBeenCalled())
  })

  it('unticking "Email the customer" revokes without the customer email', async () => {
    signInAs('admin')
    mockRevoke.mockResolvedValue({
      revoked: [
        {
          generation_id: 'g2',
          verification_code: 'PRIM-0002',
          status: 'revoked',
          kind: 'primary',
          brand: null,
          revoked_at: '2026-09-23T15:04:05Z',
          revocation_reason: 'Internal test certificate',
        },
      ],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })

    render(
      <GeneratedCOAFallbackList generations={[PUBLISHED]} sampleId="P-0001" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))

    const emailBox = await screen.findByLabelText(
      'Email the customer about this revocation'
    )
    expect(
      emailBox.getAttribute('aria-checked') ??
        emailBox.getAttribute('data-state')
    ).toMatch(/true|checked/)
    fireEvent.click(emailBox)
    expect(screen.getByText(/No email goes out/)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/reason/i), {
      target: { value: 'Internal test certificate' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^revoke 1 certificate$/i })
    )

    await waitFor(() =>
      expect(mockRevoke).toHaveBeenCalledWith(
        'g2',
        'Internal test certificate',
        [],
        false
      )
    )
  })

  it('labels a revoked row as Revoked and offers no controls on it', () => {
    render(
      <GeneratedCOAFallbackList
        generations={[
          gen({
            id: 'g3',
            status: 'revoked',
            revocation_reason: 'Lot recalled',
            published_at: '2026-09-01T00:00:00Z',
          }),
        ]}
        sampleId="P-0001"
      />
    )
    expect(screen.getByText('Revoked')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
    expect(screen.queryByLabelText('Forward to current')).toBeNull()
  })

  it('hides Revoke from non-admins but still lets them set the forward switch', () => {
    signInAs('hplc')
    render(
      <GeneratedCOAFallbackList
        generations={[PUBLISHED, SUPERSEDED]}
        sampleId="P-0001"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage' })) // superseded only; published has no controls at all here
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
    expect(screen.getByLabelText('Forward to current')).toBeTruthy()
  })

  it('on a primary, ticking the cascade box previews the others and sends exactly those codes', async () => {
    mockPreview.mockResolvedValue({
      target: {
        generation_id: 'g2',
        verification_code: 'NEW-0002',
        status: 'published',
        kind: 'primary',
        brand: null,
      },
      others: [
        {
          generation_id: 'g9',
          verification_code: 'ACOA-0009',
          status: 'published',
          kind: 'additional',
          brand: 'Acme Peptides',
        },
        {
          generation_id: 'g1',
          verification_code: 'OLD-0001',
          status: 'superseded',
          kind: 'primary',
          brand: null,
        },
      ],
    })
    mockRevoke.mockResolvedValue({
      revoked: [],
      skipped: [],
      wp_notified: true,
      wp_error: null,
    })

    render(
      <GeneratedCOAFallbackList generations={[PUBLISHED]} sampleId="P-0001" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))
    fireEvent.click(
      screen.getByLabelText(
        'Also revoke every other certificate issued for this sample'
      )
    )

    expect(await screen.findByText('ACOA-0009')).toBeTruthy()
    expect(screen.getByText(/Acme Peptides/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^revoke 3 certificates$/i })
    ).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/reason/i), {
      target: { value: 'Lot recalled' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^revoke 3 certificates$/i })
    )

    await waitFor(() =>
      expect(mockRevoke).toHaveBeenCalledWith(
        'g2',
        'Lot recalled',
        ['ACOA-0009', 'OLD-0001'],
        true
      )
    )
  })

  it('a child certificate never offers the cascade box', () => {
    const child = gen({
      id: 'c1',
      status: 'published',
      parent_generation_id: 'g2',
      verification_code: 'ACOA-0001',
    })
    render(<GeneratedCOAFallbackList generations={[child]} sampleId="P-0001" />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))
    expect(
      screen.queryByLabelText(
        'Also revoke every other certificate issued for this sample'
      )
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: /^revoke 1 certificate$/i })
    ).toBeTruthy()
  })

  it('warns when WordPress was not updated or codes were skipped', async () => {
    const { toast } = await import('sonner')
    mockRevoke.mockResolvedValue({
      revoked: [
        {
          generation_id: 'g2',
          verification_code: 'NEW-0002',
          status: 'revoked',
          kind: 'primary',
          brand: null,
          revoked_at: null,
          revocation_reason: 'r',
        },
      ],
      skipped: ['GONE-0000'],
      wp_notified: false,
      wp_error: 'HTTP 500: boom',
    })
    render(
      <GeneratedCOAFallbackList generations={[PUBLISHED]} sampleId="P-0001" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))
    fireEvent.change(screen.getByPlaceholderText(/reason/i), {
      target: { value: 'r' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /^revoke 1 certificate$/i })
    )

    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(2)
    )
    expect(
      vi
        .mocked(toast.warning)
        .mock.calls.some(c => String(c[0]).includes('customer was not updated'))
    ).toBe(true)
    expect(
      vi
        .mocked(toast.warning)
        .mock.calls.some(c => String(c[1]?.description).includes('GONE-0000'))
    ).toBe(true)
  })

  it('cancel clears the dialog so a reopened cascade fetches a fresh preview', async () => {
    mockPreview.mockResolvedValue({
      target: {
        generation_id: 'g2',
        verification_code: 'NEW-0002',
        status: 'published',
        kind: 'primary',
        brand: null,
      },
      others: [
        {
          generation_id: 'g9',
          verification_code: 'ACOA-0009',
          status: 'published',
          kind: 'additional',
          brand: null,
        },
      ],
    })
    render(
      <GeneratedCOAFallbackList generations={[PUBLISHED]} sampleId="P-0001" />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))
    fireEvent.change(screen.getByPlaceholderText(/reason/i), {
      target: { value: 'stale' },
    })
    fireEvent.click(
      screen.getByLabelText(
        'Also revoke every other certificate issued for this sample'
      )
    )
    expect(await screen.findByText('ACOA-0009')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))
    expect(
      (screen.getByPlaceholderText(/reason/i) as HTMLTextAreaElement).value
    ).toBe('')
    fireEvent.click(
      screen.getByLabelText(
        'Also revoke every other certificate issued for this sample'
      )
    )
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2))
  })
})
