/**
 * Variance overlay (variance-run-rows, part C).
 *
 * Pinned: container families get the per-test body (core cannot be
 * excluded, excluding asks for a reason, include controls are greyed out
 * while locked, no Promote for an add-on test, a refused lock is listed
 * inline); legacy families keep the original body; every help entry renders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { VarianceRun, VarianceSetResponse, VarianceTest } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getVarianceSet: vi.fn(),
    patchVarianceMembership: vi.fn().mockResolvedValue({}),
    lockVarianceSet: vi.fn(),
    unlockVarianceSet: vi.fn(),
  }
})

import { getVarianceSet, lockVarianceSet, patchVarianceMembership } from '@/lib/api'
import { VarianceSummary } from '@/components/samples/VarianceSummary'
import { VarianceHelpCard } from '@/components/samples/VarianceHelp'
import { VARIANCE_HELP, type VarianceHelpId } from '@/lib/variance-help'
import { lockProblems } from '@/lib/variance-values'

const run = (seq: number, over: Partial<VarianceRun> = {}): VarianceRun => ({
  sample_id: `P-5010-S${String(seq).padStart(2, '0')}`,
  vial_sequence: seq,
  kind: 'variance',
  in_variance_set: true,
  exclusion_reason: null,
  signed_off: true,
  has_result: true,
  values: [{
    keyword: 'ENDOTOXIN-USP85LAL', label: 'Endotoxin', value: '1.5', unit: 'EU/mL',
    conforms: true, review_state: 'variance_verified', analyst: null, specification: null,
  }],
  ...over,
})

const summary = { runs: 2, runs_with_result: 2, conforming: 2, replicates: 1, replicates_signed_off: 1, stats: [] }

const endo: VarianceTest = {
  role: 'endo85', section_key: 'endotoxin-usp85-lal', title: 'Endotoxin', is_hplc: false,
  runs: [run(2, { kind: 'core', in_variance_set: false }), run(5)], summary,
}
const hplc: VarianceTest = {
  role: 'hplc', section_key: 'hplc-purity-identity', title: 'HPLC Purity and Identity', is_hplc: true,
  runs: [run(1, { kind: 'core' }), run(4)],
  summary: { ...summary, stats: [{ keyword: 'HPLC-PUR', label: 'Purity', kind: 'numeric', mean: 97.5,
                                   sd: 0.7, cv_pct: 0.72, n: 2, conforms_count: null, total: null }] },
}

const parent = (container: boolean) => ({
  sample_id: 'P-5010', external_lims_uid: null, peptide_name: null, status: null,
  sub_sample_count: 4, last_synced_at: null, assignment_role: null, container_mode: container,
}) as unknown as VarianceSetResponse['parent']

const containerSet = (over: Partial<VarianceSetResponse> = {}): VarianceSetResponse => ({
  parent: parent(true),
  vials: [1, 2, 4, 5].map(seq => ({
    sample_id: `P-5010-S0${seq}`, vial_sequence: seq, is_parent: false, in_variance_set: true,
    exclusion_reason: null, review_state: null, results: {},
  })),
  stats: {},
  locked: false,
  locked_at: null,
  locked_by_user_id: null,
  locked_by_name: null,
  tests: [hplc, endo],
  ...over,
})

function renderOverlay() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <VarianceSummary parentSampleId="P-5010" open onOpenChange={vi.fn()} />
    </QueryClientProvider>
  )
}

const card = (role: string) =>
  within(screen.getByTestId('variance-test-card-' + role))

const runRow = (sampleId: string) =>
  screen.getByTestId('variance-run-' + sampleId)

beforeEach(() => vi.clearAllMocks())

describe('Variance overlay, container family', () => {
  it('titles the set and never offers to exclude the core run', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet())
    renderOverlay()
    expect(await screen.findByText('P-5010 · Variance')).toBeTruthy()
    const core = runRow('P-5010-S02')
    expect(within(core).getByTestId('variance-core-always').textContent).toContain('Always')
    expect(within(core).queryByRole('button', { name: /exclude/i })).toBeNull()
    expect(within(core).getByText('Core')).toBeTruthy()
    expect(within(runRow('P-5010-S05')).getByText('Variance 1')).toBeTruthy()
  })

  it('asks for a reason before excluding a replicate', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet())
    renderOverlay()
    await screen.findByText('P-5010 · Variance')
    const rep = runRow('P-5010-S05')
    fireEvent.click(within(rep).getByRole('button', { name: 'Exclude' }))
    const save = within(rep).getByRole('button', { name: 'Exclude' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    expect(patchVarianceMembership).not.toHaveBeenCalled()
    fireEvent.change(within(rep).getByLabelText('Reason for excluding P-5010-S05'), {
      target: { value: 'Cracked vial' },
    })
    fireEvent.click(save)
    await waitFor(() => expect(patchVarianceMembership).toHaveBeenCalled())
    expect(vi.mocked(patchVarianceMembership).mock.calls[0]?.[0]).toEqual({
      sampleId: 'P-5010-S05', inVarianceSet: false, exclusionReason: 'Cracked vial',
    })
  })

  it('greys out every include control while locked and names the locker', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet({
      locked: true, locked_at: '2026-11-10T09:00:00', locked_by_user_id: 166, locked_by_name: 'Dana Lee',
    }))
    renderOverlay()
    expect(await screen.findByText(/by Dana Lee/)).toBeTruthy()
    expect(screen.queryByText(/user #166/)).toBeNull()
    for (const id of ['P-5010-S01', 'P-5010-S04', 'P-5010-S05']) {
      const btn = within(runRow(id)).getByRole('button', { name: 'Exclude' }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    }
    expect(screen.getAllByLabelText('Unlock the set to change this')).toHaveLength(3)
  })

  it('gives the HPLC core run a real include control', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet({
      tests: [{ ...hplc, runs: [run(1, { kind: 'core', in_variance_set: false, exclusion_reason: 'Bad injection' }), run(4)] }, endo],
    }))
    renderOverlay()
    await screen.findByText('P-5010 · Variance')
    const core = within(runRow('P-5010-S01'))
    expect(core.queryByTestId('variance-core-always')).toBeNull()
    expect(core.getByText('Excluded: Bad injection')).toBeTruthy()
    fireEvent.click(core.getByRole('button', { name: 'Include' }))
    await waitFor(() => expect(patchVarianceMembership).toHaveBeenCalled())
    expect(vi.mocked(patchVarianceMembership).mock.calls[0]?.[0]).toEqual({
      sampleId: 'P-5010-S01', inVarianceSet: true, exclusionReason: null,
    })
    // The add-on test's core still always counts.
    expect(within(runRow('P-5010-S02')).getByTestId('variance-core-always')).toBeTruthy()
  })

  it('shows no Other vials block when every vial is in a test card', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet())
    renderOverlay()
    await screen.findByText('P-5010 · Variance')
    expect(screen.queryByTestId('variance-other-vials')).toBeNull()
  })

  it('lists vials outside every test card, collapsed, with an include control', async () => {
    const base = containerSet()
    vi.mocked(getVarianceSet).mockResolvedValue({
      ...base,
      vials: [...base.vials, {
        sample_id: 'P-5010-S03', vial_sequence: 3, is_parent: false, in_variance_set: true,
        exclusion_reason: null, review_state: null,
        results: { 'RAPID-PCR': { value: 'Not Detected', kind: 'categorical' } },
      }],
    })
    renderOverlay()
    await screen.findByText('P-5010 · Variance')
    const block = within(screen.getByTestId('variance-other-vials'))
    expect(block.getByText('1 · 1 in the set')).toBeTruthy()
    expect(block.queryByTestId('variance-other-P-5010-S03')).toBeNull()
    fireEvent.click(block.getByRole('button', { name: /Other vials/ }))
    const row = within(block.getByTestId('variance-other-P-5010-S03'))
    expect(row.getByText('RAPID-PCR: Not Detected')).toBeTruthy()
    fireEvent.click(row.getByRole('button', { name: 'Exclude' }))
    fireEvent.change(row.getByLabelText('Reason for excluding P-5010-S03'), { target: { value: 'Not a replicate' } })
    fireEvent.click(row.getByRole('button', { name: 'Exclude' }))
    await waitFor(() => expect(patchVarianceMembership).toHaveBeenCalled())
    expect(vi.mocked(patchVarianceMembership).mock.calls[0]?.[0]).toEqual({
      sampleId: 'P-5010-S03', inVarianceSet: false, exclusionReason: 'Not a replicate',
    })
  })

  it('offers the reported value for HPLC only', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet())
    renderOverlay()
    await screen.findByText('P-5010 · Variance')
    expect(card('hplc').getByRole('button', { name: /Reported value/ })).toBeTruthy()
    expect(card('endo85').queryByText(/Reported value/)).toBeNull()
    expect(card('endo85').queryByText(/Promote/)).toBeNull()
    expect(card('endo85').getByTestId('variance-card-footer').textContent).toContain('2 of 2 within spec')
    expect(card('endo85').getByTestId('variance-card-footer').textContent).not.toMatch(/Mean|SD|CV/)
    expect(card('hplc').getByTestId('variance-card-footer').textContent).toContain('Mean 97.50')
  })

  it('lists a refused lock inline', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue(containerSet())
    vi.mocked(lockVarianceSet).mockRejectedValue(new Error(
      'variance series incomplete: unfinished rows: P-5010-S05:ENDOTOXIN-USP85LAL'))
    renderOverlay()
    await screen.findByText('P-5010 · Variance')
    fireEvent.click(screen.getByRole('button', { name: /Lock variance set/ }))
    const alert = await screen.findByTestId('variance-lock-refusal')
    expect(within(alert).getByText('P-5010-S05 ENDOTOXIN-USP85LAL not signed off')).toBeTruthy()
  })
})

describe('Variance overlay, legacy family', () => {
  it('keeps the original body', async () => {
    vi.mocked(getVarianceSet).mockResolvedValue({
      ...containerSet({ tests: [] }),
      parent: parent(false),
      vials: [{ sample_id: 'P-0100', vial_sequence: 0, is_parent: true, in_variance_set: true,
                exclusion_reason: null, review_state: null, results: {} }],
      stats: { PUR: { kind: 'numeric', mean: 98, sd: null, cv_pct: null, n: 1, spec: { min: 95 }, pass: true } },
    })
    renderOverlay()
    expect(await screen.findByText('Select which vials participate in variance')).toBeTruthy()
    expect(screen.queryByTestId(/^variance-test-card/)).toBeNull()
    expect(screen.getByText('≥ 95')).toBeTruthy() // readable spec, never raw JSON
  })
})

describe('help', () => {
  it('renders every entry of the help map', () => {
    for (const id of Object.keys(VARIANCE_HELP) as VarianceHelpId[]) {
      const { container, unmount } = render(<VarianceHelpCard id={id} />)
      expect(container.textContent).toContain(VARIANCE_HELP[id].title)
      for (const line of VARIANCE_HELP[id].lines) expect(container.textContent).toContain(line)
      unmount()
    }
  })

  it('turns lock messages into lines', () => {
    expect(lockProblems(
      'variance series incomplete: endotoxin-usp85-lal bought 3 runs, 1 replicate runs carry results; '
      + 'variance series incomplete: rapid-sterility-pcr is missing the core run: no core vial of role pcr carries results'
    )).toEqual([
      'endotoxin-usp85-lal bought 3 runs, 1 replicate runs carry results',
      'rapid-sterility-pcr is missing the core run: no core vial of role pcr carries results',
    ])
  })
})
