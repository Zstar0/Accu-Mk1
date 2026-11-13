import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  createCalSheet,
  getInstruments,
  getPeptides,
  type CalSheet,
} from '@/lib/api'
import {
  replicatePrep,
  workOutSheet,
  type CalInputs,
  type CalLevelInputs,
  type CalReplicateInputs,
} from '@/lib/hplc-calibration'
import {
  CAL_SHEETS_KEY,
  CAL_SHEET_KEY,
  NO_ANSWER,
  RELOADED,
  useCalSheets,
  useSaveCalSheet,
  type CalDraft,
} from '@/services/hplc-calibration-sheets'
import { useUIStore } from '@/store/ui-store'
import { CalTextBox } from './CalCells'
import {
  HplcCalStandardSection,
  Step,
  type CalCommit,
} from './HplcCalStandardSection'
import { HplcCalTables } from './HplcCalTables'

/** The page root: isolate (the app's fixed sidebar is z-10), contain
 *  inline-size (wide tables scroll inside their own box), dark controls. */
const ROOT =
  'isolate h-full min-h-0 space-y-4 overflow-y-auto bg-muted/30 px-6 pb-8 pt-5 [contain:inline-size] dark:[color-scheme:dark]'

const REPLICATE_OWN = new Set(['peak_area', 'purity', 'rt'])

/** The draft with one value written, as the server stores it. */
function written(
  d: CalDraft,
  replicate: boolean,
  part: Parameters<CalCommit>[0],
  i: number,
  field: string,
  value: Parameters<CalCommit>[3]
): CalDraft {
  if (replicate) {
    const rep = d.inputs as CalReplicateInputs
    if (part === 'sheet' && field === 'notes')
      return { ...d, inputs: { ...rep, notes: value as string | null } }
    if (part !== 'level' || !REPLICATE_OWN.has(field)) return d
    const levels = [...(rep.levels ?? [])]
    while (levels.length <= i)
      levels.push({ peak_area: null, purity: null, rt: null })
    levels[i] = { ...(levels[i] ?? {}), [field]: value }
    return { ...d, inputs: { ...rep, levels } }
  }
  const inp = d.inputs as CalInputs
  let next: CalInputs
  if (part === 'sheet') next = { ...inp, [field]: value }
  else if (part === 'net')
    next = { ...inp, net: { ...(inp.net ?? {}), [field]: value } }
  else if (part === 'stock')
    next = { ...inp, stock: { ...(inp.stock ?? {}), [field]: value } }
  else {
    const levels: CalLevelInputs[] = [...(inp.levels ?? [])]
    levels[i] = { ...(levels[i] ?? {}), [field]: value }
    next = { ...inp, levels }
  }
  return { ...d, inputs: next }
}

/** The replicate note (cal.js renderReplicate, 351). */
function replicateNote(sheet: CalSheet) {
  const where = sheet.instrument_name
    ? `on the ${sheet.instrument_name}`
    : 'with no instrument chosen yet'
  return `Another injection of the same vials as ${sheet.replicate_of_name ?? 'the original sheet'}, ${where}. Steps 1 to 3 are that sheet's (read-only here): open it to correct a weighing, and every injection follows. Choose this injection's Instrument above, and type its peak areas, purity and RT in Step 4.`
}

function SheetView({ id }: { id: number }) {
  const save = useSaveCalSheet(id)
  const { sheet, state } = save
  const { data: peptides = [] } = useQuery({
    queryKey: ['peptides'],
    queryFn: () => getPeptides(),
    staleTime: 5 * 60 * 1000,
  })
  const { data: instruments = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: 5 * 60 * 1000,
  })

  if (!sheet && save.loadError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {`This sheet could not be opened: ${save.loadError.message}`}
      </p>
    )
  if (!sheet || !state)
    return <p className="text-sm text-muted-foreground">Loading the sheet...</p>

  const replicate = sheet.replicate_of_sheet_id !== null
  const local = state.local
  const inputs: CalInputs = replicate
    ? replicatePrep(sheet.effective_inputs, local.inputs as CalReplicateInputs)
    : (local.inputs as CalInputs)
  const worked = workOutSheet(inputs)
  const filed = sheet.curve_id !== null
  const commit: CalCommit = (part, i, field, value) =>
    save.edit(d => written(d, replicate, part, i, field, value))
  const blocking = worked.warnings.filter(w => worked.blocking.includes(w.code))
  const others = worked.warnings.filter(w => !worked.blocking.includes(w.code))

  return (
    // data-saved: what File and Duplicate will wait for (Task 7)
    <div className="space-y-4" data-saved={String(save.saved)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[23px] font-semibold leading-tight tracking-tight">
            Calibration Curve Worksheet
          </h2>
          <p className="text-sm">
            Curve name:{' '}
            <code className="font-mono" data-testid="curve-name">
              {sheet.proposed_name}
            </code>
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Analyst</span>
            <CalTextBox
              label="Analyst"
              value={inputs.analyst}
              placeholder="Initials or name"
              disabled={replicate}
              className="w-36"
              onCommit={v => commit('sheet', 0, 'analyst', v)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Date</span>
            <input
              type="date"
              aria-label="Date"
              value={inputs.date ?? ''}
              disabled={replicate}
              onChange={e => commit('sheet', 0, 'date', e.target.value || null)}
              className="rounded-md border bg-card px-1.5 py-[3px] font-mono text-[12.5px] disabled:opacity-50"
            />
          </label>
        </div>
      </div>

      {state.reloaded && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span>{RELOADED}</span>
          <Button size="sm" variant="outline" onClick={save.dismissReloaded}>
            Dismiss
          </Button>
        </div>
      )}
      {state.error !== null ? (
        <div
          role="alert"
          data-testid="save-line"
          className="flex flex-wrap items-center gap-3 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm"
        >
          <span>
            {`Not saved: ${(state.error || NO_ANSWER).replace(/\.$/, '')}. Your changes are still on this page.`}
            {state.saving && ' Saving...'}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={state.saving}
            onClick={save.retry}
          >
            Retry
          </Button>
        </div>
      ) : (
        state.saving && (
          <div
            role="status"
            data-testid="save-line"
            className="text-xs text-muted-foreground"
          >
            Saving...
          </div>
        )
      )}
      {sheet.blocking.includes('cannot_be_worked_out') && (
        <div
          role="alert"
          className="rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm"
        >
          This sheet cannot be worked out as stored. Check the values below.
        </div>
      )}
      {replicate && (
        <p
          className="rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-2 text-sm"
          data-testid="replicate-note"
        >
          {replicateNote(sheet)}
        </p>
      )}
      {worked.warnings.length > 0 && (
        <div
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
          data-testid="warnings"
        >
          <ul className="space-y-1">
            {blocking.map((w, i) => (
              <li
                key={`b${i}`}
                className="font-medium text-red-700 dark:text-red-300"
              >
                <span className="mr-2 rounded bg-red-500/20 px-1.5 text-xs">
                  Must be fixed before filing
                </span>
                {w.text}
              </li>
            ))}
            {others.map((w, i) => (
              <li key={`w${i}`}>{w.text}</li>
            ))}
          </ul>
        </div>
      )}

      <HplcCalStandardSection
        inputs={inputs}
        worked={worked}
        peptideId={local.peptide_id}
        instrumentId={local.instrument_id}
        peptides={peptides}
        instruments={instruments}
        names={{
          peptide:
            sheet.peptide_id === local.peptide_id ? sheet.peptide_name : null,
          instrument:
            sheet.instrument_id === local.instrument_id
              ? sheet.instrument_name
              : null,
        }}
        replicate={replicate}
        filed={filed}
        onSheet={(field, v) => save.edit(d => ({ ...d, [field]: v }))}
        onCommit={commit}
        onRefused={save.setRefused}
      />
      <HplcCalTables
        inputs={inputs}
        worked={worked}
        replicate={replicate}
        onCommit={commit}
        onRefused={save.setRefused}
      />
      <Step title="Notes">
        <CalTextBox
          label="Notes"
          value={inputs.notes}
          placeholder="Anything about this curve worth keeping"
          disabled={false}
          maxLength={2000}
          multiline
          className="w-full"
          onCommit={v => commit('sheet', 0, 'notes', v)}
        />
      </Step>
    </div>
  )
}

/** The sheets, newest first (Task 7 builds this list out). */
function SheetList() {
  const { data: sheets = [], error } = useCalSheets()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const open = (id: number) =>
    useUIStore.getState().navigateToCalibrationSheet(id)
  async function create() {
    setBusy(true)
    try {
      const s = await createCalSheet({})
      qc.setQueryData(CAL_SHEET_KEY(s.id), s)
      void qc.invalidateQueries({ queryKey: [...CAL_SHEETS_KEY, 'list'] })
      open(s.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-[23px] font-semibold tracking-tight">
          Calibration worksheets
        </h2>
        <Button onClick={() => void create()} disabled={busy}>
          New calibration worksheet
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <ul className="divide-y rounded-md border bg-card">
        {sheets.map(s => (
          <li
            key={s.id}
            className="flex items-center justify-between px-3 py-2 text-sm"
          >
            <span className="font-mono">{s.curve_name ?? s.proposed_name}</span>
            <Button size="sm" variant="outline" onClick={() => open(s.id)}>
              Open
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function HplcCalibrationSheetPage() {
  const id = useUIStore(s => s.calibrationSheetPageId)
  return (
    <div data-testid="hplc-calibration-page" className={ROOT}>
      {id === null ? <SheetList /> : <SheetView key={id} id={id} />}
    </div>
  )
}

export default HplcCalibrationSheetPage
