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
})
