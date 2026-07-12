import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SampleRegistryDebug } from '@/components/senaite/SampleRegistryDebug'
import * as api from '@/lib/api'

const base: api.SampleRegistryDebug = {
  sample_id: 'P-1',
  load: { exists: true, native_id: 'aP-0007', external_lims_system: 'senaite',
          last_synced_at: '2026-07-01T00:00:00', age_seconds: 60, reconcile_due: false },
  linkage: { registry_uid: 'U1', senaite_uid: 'U1', status: 'match' },
  origin: 'creation-signal',
  container: { container_mode: true, assignment_role: 'hplc' },
  fields: [
    { field: 'client_sample_id', registry: 'CS-1', senaite: 'CS-2', status: 'drift' },
    { field: 'client_title', registry: 'a@x.com', senaite: 'a@x.com', status: 'agree' },
    { field: 'sample_type_title', registry: null, senaite: 'Peptide', status: 'registry_null' },
  ],
  summary: { agree: 1, drift: 1, registry_null: 1, senaite_null: 0 },
  vials: { local: 2, senaite: 2, status: 'in_sync' },
  verdict: { linkage_ok: true, vials_ok: true, drift: 1, registry_null: 1 },
  senaite_error: null,
  raw: { registry: { sample_id: 'P-1' }, senaite: { uid: 'U1' } },
  analyses: null,
  transitions: null,
}

const analysesBase: api.AnalysesSync = {
  rows: [
    {
      keyword: 'PUR_KPV', title: 'KPV - Purity (HPLC)',
      senaite: { review_state: 'verified', result: '99.2' },
      shadow: { mirror_review_state: 'to_be_verified', result: '99.2' },
      canonical: null, status: 'drift',
    },
    {
      keyword: 'QTY_KPV', title: 'KPV - Quantity (HPLC)',
      senaite: { review_state: 'submitted', result: '2.00' },
      shadow: null, canonical: null, status: 'no_shadow',
    },
  ],
  summary: { senaite: 2, shadow: 1, in_sync: 0, drift: 1, missing: 1 },
  error: null,
}

const transitionsBase: api.SampleTransitionsTail = {
  rows: [
    { verb: 'receive', from_status: 'sample_due', to_status: 'sample_received',
      source: 'mk1', occurred_at: '2026-07-10T12:00:00' },
    { verb: null, from_status: 'sample_received', to_status: 'verified',
      source: 'reconcile', occurred_at: '2026-07-10T11:00:00' },
  ],
  error: null,
}

beforeEach(() => vi.restoreAllMocks())

describe('SampleRegistryDebug', () => {
  it('renders fields with their status and the drift value', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText('client_sample_id')).toBeInTheDocument())
    expect(screen.getByText(/CS-2/)).toBeInTheDocument()
    expect(screen.getByText('creation-signal')).toBeInTheDocument()
  })

  it('caps the panel width so it never exceeds the viewport', async () => {
    // Regression pin for the viewport-clipping fix: `max-w-[92vw]` (unprefixed,
    // so it applies at every width) must stay on the Sheet's width class list —
    // without it the fixed 1180px panel clips the analyses column below ~1200px.
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue(base)
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(screen.getByRole('dialog')).toHaveClass('max-w-[92vw]')
  })

  it('renders long field values in full (no truncation)', async () => {
    // 3-analyte JSON: the 3rd entry sits well past the old 22-char clip, so
    // finding it proves the value is rendered whole for accurate cross-check.
    const analytes = '[{"name": "KPV - Identity (HPLC)", "declared_quantity": "2.00"}, ' +
      '{"name": "GHK-Cu - Identity (HPLC)", "declared_quantity": "3.00"}, ' +
      '{"name": "DSIP - Identity (HPLC)", "declared_quantity": "4.00"}]'
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({
      ...base,
      fields: [{ field: 'analytes', registry: analytes, senaite: analytes, status: 'agree' }],
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText(/DSIP - Identity \(HPLC\)/)).toBeInTheDocument())
  })

  it('shows the missing-record state', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({
      ...base, load: { ...base.load, exists: false }, fields: [], summary: null,
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-9" />)
    await waitFor(() => expect(screen.getByText(/no registry record/i)).toBeInTheDocument())
  })

  it('renders analyses rows with keyword/title and senaite + shadow sides', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({ ...base, analyses: analysesBase })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText('PUR_KPV')).toBeInTheDocument())
    expect(screen.getByText(/KPV - Purity \(HPLC\)/)).toBeInTheDocument()
    expect(screen.getByText(/\bverified\b/)).toBeInTheDocument()
    expect(screen.getByText(/to_be_verified/)).toBeInTheDocument()
  })

  it('shows a drift glyph/marker on a row whose shadow state differs from SENAITE', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({ ...base, analyses: analysesBase })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText('PUR_KPV')).toBeInTheDocument())
    const driftRow = screen.getByText('PUR_KPV').closest('[data-status]')
    expect(driftRow).toHaveAttribute('data-status', 'drift')
  })

  it('marks a SENAITE-only row as no-shadow (expected pre-backfill)', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({ ...base, analyses: analysesBase })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText('QTY_KPV')).toBeInTheDocument())
    const noShadowRow = screen.getByText('QTY_KPV').closest('[data-status]')
    expect(noShadowRow).toHaveAttribute('data-status', 'no_shadow')
  })

  it('renders the analyses summary line', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({ ...base, analyses: analysesBase })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() =>
      expect(screen.getByText(/analyses senaite=2 shadow=1 in_sync=0 drift=1 missing=1/)).toBeInTheDocument()
    )
  })

  it('degrades gracefully when the analyses SENAITE fetch errored (fields still render)', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({
      ...base, analyses: { rows: [], summary: null, error: 'senaite down' },
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    // The unrelated basic-info field diff must still render...
    await waitFor(() => expect(screen.getByText('client_sample_id')).toBeInTheDocument())
    // ...alongside the analyses error.
    expect(screen.getByText(/senaite down/)).toBeInTheDocument()
  })

  it('renders recent-transitions rows with verb, from→to, and source', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({ ...base, transitions: transitionsBase })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText('receive')).toBeInTheDocument())
    expect(screen.getByText(/sample_due → sample_received/)).toBeInTheDocument()
    expect(screen.getByText('mk1')).toBeInTheDocument()
    // Second row has no verb — must render the em dash fallback, not blank.
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(/sample_received → verified/)).toBeInTheDocument()
    expect(screen.getByText('reconcile')).toBeInTheDocument()
  })

  it('shows the empty-transitions state when no rows have been logged yet', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({
      ...base, transitions: { rows: [], error: null },
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText(/no transitions logged yet/i)).toBeInTheDocument())
  })

  it('shows a warning line when the transitions query errored', async () => {
    vi.spyOn(api, 'getSampleRegistryDebug').mockResolvedValue({
      ...base, transitions: { rows: [], error: 'db down' },
    })
    render(<SampleRegistryDebug open onClose={() => {}} sampleId="P-1" />)
    await waitFor(() => expect(screen.getByText(/transitions_error: db down/)).toBeInTheDocument())
    // Error state must not also show the empty-state message.
    expect(screen.queryByText(/no transitions logged yet/i)).not.toBeInTheDocument()
  })
})
