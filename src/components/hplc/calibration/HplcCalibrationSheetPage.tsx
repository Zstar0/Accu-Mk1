import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  CalSheetError,
  createCalSheet,
  getCalSheet,
  getInstruments,
  getPeptides,
  type CalFileResult,
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
  CHECKING,
  NEW_NO_ANSWER,
  NO_ANSWER,
  inTime,
  refusalOf,
  useDuplicateCalSheet,
  useFileCalSheet,
  useSaveCalSheet,
  type CalDraft,
  type CalSaveState,
} from '@/services/hplc-calibration-sheets'
import { useUIStore } from '@/store/ui-store'
import { CalDateBox, CalTextBox } from './CalCells'
import { CalTip } from './CalTip'
import {
  DILUTION_COLUMNS,
  NET_FIELDS,
  PEAK_COLUMNS,
  STEP1_FIELDS,
  STOCK_COLUMNS,
} from './cal-sheet-columns'
import { HplcCalSheetList } from './HplcCalSheetList'
import {
  HplcCalStandardSection,
  Step,
  type CalCommit,
} from './HplcCalStandardSection'
import { HplcCalTables } from './HplcCalTables'

/** The page root: isolate (the app's fixed sidebar is z-10), contain
 *  inline-size (wide tables scroll inside their own box), dark controls.
 *  scroll-pt-28: a box reached by Tab or the arrows scrolls clear of the
 *  sticky status bar (round 2). */
const ROOT =
  'isolate h-full min-h-0 scroll-pt-28 space-y-4 overflow-y-auto bg-muted/30 px-6 pb-8 pt-5 [contain:inline-size] dark:[color-scheme:dark]'

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

/** The replicate note (cal.js renderReplicate, 350 and 351). */
function replicateNote(sheet: CalSheet, original: CalSheet | undefined) {
  const own = sheet.instrument_name
  const theirs = original?.instrument_name
  const where = !own
    ? 'with no instrument chosen yet'
    : theirs && theirs !== own
      ? `on the ${own} (the original ran on the ${theirs})`
      : `on the ${own}`
  return `Another injection of the same vials as ${sheet.replicate_of_name ?? 'the original sheet'}, ${where}. Steps 1 to 3 are that sheet's (read-only here): open it to correct a weighing, and every injection follows. Choose this injection's Instrument above, and type its peak areas, purity and RT in Step 4.`
}

/** What the original needs before this injection can be filed, from the
 *  original as this page last read it (round 2); null when nothing. The
 *  server refuses the injection's File in both cases. */
function originalLine(sheet: CalSheet, original: CalSheet | undefined) {
  if (!original) return null
  const name = sheet.replicate_of_name ?? original.proposed_name
  if (original.curve_id === null)
    return `The original worksheet, ${name}, is not filed. File it first, then file this one.`
  if (original.changed_since_filed)
    return `The original worksheet, ${name}, has been changed since it was filed. If its preparation changed, file it before this one.`
  return null
}

// --- The Worksheet toolbar (calibration.html:57 to 61, Task 7) ---

/** A message that stays until dismissed or replaced: what filing did, and
 *  every warning the server sent (task-7-addendum). Held above the sheet, so
 *  a Duplicate's message is still there on the copy it opens. */
export interface CalNotice {
  sheetId: number
  tone: 'ok' | 'bad'
  lines: string[]
  warnings: string[]
}

// The source's tooltips (calibration.html:59 to 61). Duplicate files only
// when it has to; New never files (the sheet is already saved here).
const FILE_HELP =
  'Saves this worksheet as the curve, under its curve name. Filing again updates it.'
const DUP_HELP =
  "Another injection of the same vials, on this or another instrument: files this sheet (when it is not filed yet, or has changed since), then opens a copy with the standard, stock and every level's weighings locked to this one, the Instrument free to change, and Step 4 blank for the new peak areas. On the same instrument it files as ...-Inj2 (then -Inj3 ...); on another, as that instrument's own curve."
const NEW_HELP =
  'Starts a blank one. This worksheet stays saved under Calibration worksheets as it is; it is not filed. Asks first: click, then click again within four seconds.'
const NEW_LABEL = 'New calibration worksheet'
const NEW_ASK = 'Start a blank one? Click again'
/** cal.js armed(): the question stays this long. */
const ARMED_MS = 4000

type FileReason =
  | 'first_active'
  | 'replaced'
  | 'several_active'
  | 'poor_fit'
  | 'replicate'
  | 'refiled'

/** What filing did to the active curve, keyed on activation.reason (never on
 *  a warning's text). The server decides; this only says it. */
function filedMessage(res: CalFileResult): string {
  const name = res.sheet.curve_name ?? res.curve.source_filename ?? 'the curve'
  const on = res.sheet.instrument_name ?? 'its instrument'
  const a = res.activation
  switch (a.reason as FileReason) {
    case 'first_active':
      return `Filed ${name}, now the active curve on ${on}.`
    case 'replaced':
      return `Filed ${name}. It replaces curve ${a.deactivated_ids.join(', ')} as the active curve on ${on}.`
    case 'several_active':
      return `Filed ${name}, not starred: ${on} already has ${a.other_active_ids.length} active curves for this peptide (${a.other_active_ids.join(', ')}). The lab has to choose which stays first: press Set Active on that one on the Peptides page.`
    case 'poor_fit':
      return `Filed ${name}, not made active: no curve on ${on} was switched on or off.`
    case 'replicate':
      return `Filed ${name}, another injection of the same vials. To use it, press Set Active on its curve on the Peptides page.`
    case 'refiled': {
      const n = res.refiled_curve_ids.length
      const inj = n ? ` and its ${n} injection${n === 1 ? '' : 's'}` : ''
      return `Updated ${name}${inj}. It is still ${a.active ? '' : 'not '}the active curve on ${on}.`
    }
    default:
      // a reason this page does not know yet: say only what is certain
      return `Filed ${name}. It is ${a.active ? '' : 'not '}the active curve on ${on}.`
  }
}

/** The time limit ends the wait, not the request: a filing can land after
 *  the one re-read, so this promises nothing it cannot see (fix round 2). */
const FILE_NO_ANSWER =
  'File curve: the server did not answer, so the curve may or may not have been filed. This page has read the sheet again once: a Filed mark beside the curve name means it was. Pressing File curve again is safe: it files the sheet if it was not filed, and updates the same curve if it was.'
/** The same, for a sheet that had a curve before the press: its Filed mark
 *  was there already, so it proves nothing (round 2). */
const FILE_NO_ANSWER_REFILE =
  'File curve: the server did not answer, so the curve may or may not have been updated. Pressing File curve again is safe: it updates the same curve.'
const DUP_NO_ANSWER =
  'Duplicate: the server did not answer, so the copy may have been made. Look under Calibration worksheets before trying again.'

/** Duplicate's check of a lagging copy (M1): nothing was filed or copied. */
const DUP_CHANGED =
  'Duplicate did not go: this sheet was saved again since the page last read it. Check it and try again.'
const DUP_UNREAD =
  'Duplicate did not go: the sheet could not be read again to check it. Try again.'
/** The two lines near File (fix round 1). */
const CHANGED_LINE =
  'Changed since filed: the curve still has the numbers it was filed with. File curve updates it.'
const ELSEWHERE_LINE =
  'The filed curve was changed on the Peptides page after this sheet was filed. Filing again replaces those changes.'

/** A refused box's label, as the page shows it, when the key names one. */
function boxName(key: string): string | null {
  const [part, a = '', b = ''] = key.split('.')
  const find = (cols: { key: string; label: string }[], k: string) =>
    cols.find(c => c.key === k)?.label ?? null
  if (part === 'level') {
    const label = find([...DILUTION_COLUMNS, ...PEAK_COLUMNS], b)
    return label ? `Level ${Number(a) + 1}, ${label}` : null
  }
  if (part === 'stock') return find(STOCK_COLUMNS, a)
  if (part === 'net') return find(NET_FIELDS, a)
  if (part === 'sheet')
    return (
      find(STEP1_FIELDS, a) ??
      (
        { date: 'Date', top_aliquot_ul: 'Aliquot (uL)' } as Record<
          string,
          string
        >
      )[a] ??
      null
    )
  return null
}

/** Why File and Duplicate cannot go now, one reason per line (rules 1 and 6). */
function notReady(
  state: CalSaveState,
  sheet: CalSheet,
  blocking: string[],
  busy: string | null
): string[] {
  const r: string[] = []
  if (busy) r.push(busy)
  if (state.saving) r.push('Still saving. This waits until the save lands.')
  else if (state.checking) r.push('Checking that the last save went through.')
  else if (state.error !== null) r.push('Not saved yet. Retry the save above.')
  if (state.refused.length) {
    const names = state.refused.map(boxName).filter(n => n !== null)
    r.push(
      names.length
        ? `A box holds a value that was not accepted: ${names.join(', ')}.`
        : 'A box holds a value that was not accepted.'
    )
  } else if (!state.saved && r.length === (busy ? 1 : 0))
    r.push('Not saved yet.')
  if (sheet.blocking.includes('cannot_be_worked_out'))
    r.push(
      'These numbers cannot be worked out as stored, so nothing can be filed from them.'
    )
  else if (blocking.length) r.push(...blocking)
  else if (sheet.blocking.length)
    r.push('A warning must be fixed before filing. Check the warnings above.')
  if (state.local.peptide_id === null)
    r.push(
      // an injection's picker is disabled: the compound is the original's (M7)
      sheet.replicate_of_sheet_id !== null
        ? `The original worksheet, ${sheet.replicate_of_name ?? 'the original sheet'}, has no compound. An injection is filed under its original's compound.`
        : 'Pick the compound first. The curve is filed under it.'
    )
  if (state.local.instrument_id === null)
    r.push(
      'Pick the instrument. A curve belongs to the instrument that ran it.'
    )
  return r
}

/** A toolbar button whose reasons show on hover and as its description,
 *  even while disabled (a disabled button fires no hover: the wrapper does). */
function ActionButton({
  label,
  help,
  reasons,
  variant = 'outline',
  onClick,
  buttonRef,
}: {
  label: string
  help: string
  reasons: string[]
  variant?: 'default' | 'outline'
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
}) {
  const reasonsId = useId()
  const helpId = useId()
  const off = reasons.length > 0
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={off ? 0 : undefined} className="inline-block">
            <Button
              ref={buttonRef}
              size="sm"
              variant={variant}
              disabled={off}
              aria-describedby={`${reasonsId} ${helpId}`}
              onClick={onClick}
            >
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          {off ? (
            <CalTip title="Not now:" lines={reasons} />
          ) : (
            <CalTip title={label} lines={[help]} />
          )}
        </TooltipContent>
      </Tooltip>
      <span id={reasonsId} className="sr-only">
        {reasons.map(r => (
          <span key={r} className="block">
            {r}
          </span>
        ))}
      </span>
      <span id={helpId} className="sr-only">
        {help}
      </span>
    </>
  )
}

function SheetToolbar({
  id,
  sheet,
  state,
  blocking,
  onNotice,
  onOpened,
}: {
  id: number
  sheet: CalSheet
  state: CalSaveState
  blocking: string[]
  onNotice: (n: CalNotice | null) => void
  /** A sheet is about to open from here: focus goes to it (M4). */
  onOpened: (id: number) => void
}) {
  const qc = useQueryClient()
  const file = useFileCalSheet(id)
  const duplicate = useDuplicateCalSheet()
  // one filing at a time: set before the first await, so a double click
  // sends one request (rule 3)
  const running = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const fileRef = useRef<HTMLButtonElement>(null)
  const dupRef = useRef<HTMLButtonElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  // the button that gets focus back once nothing runs (it was disabled
  // meanwhile); a run that opens another sheet unmounts this first (M4)
  const refocus = useRef<RefObject<HTMLButtonElement | null> | null>(null)

  useEffect(() => {
    if (!asking) return
    const t = setTimeout(() => setAsking(false), ARMED_MS)
    return () => clearTimeout(t)
  }, [asking])
  useEffect(() => {
    if (busy === null && refocus.current) {
      refocus.current.current?.focus()
      refocus.current = null
    }
  }, [busy])

  async function run(label: string, work: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(label)
    try {
      await work()
    } finally {
      running.current = false
      setBusy(null)
    }
  }
  // an answer can land after the chemist has moved on (M3): this sheet is
  // still on screen only while this toolbar is mounted and the store shows it
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const here = () =>
    alive.current && useUIStore.getState().calibrationSheetPageId === id
  const name = sheet.curve_name ?? sheet.proposed_name
  // what a run says: in the notice while this sheet shows, else one toast
  // (never another sheet's notice)
  const say = (
    tone: CalNotice['tone'],
    lines: string[],
    warnings: string[] = []
  ) => {
    if (here()) onNotice({ sheetId: id, tone, lines, warnings })
    else
      (tone === 'bad' ? toast.error : toast.success)(
        `Calibration sheet ${name}: ${[...lines, ...warnings].join(' ')}`
      )
  }
  /** A sheet made from here opens, with its notice, only while the chemist
   *  is still here; else one toast names it, with what filing said (M3). */
  const openMade = (made: CalSheet, n: CalNotice | null, said: string[]) => {
    if (!here()) {
      toast.success(
        `Made ${made.proposed_name}. It is under Calibration worksheets.`,
        said.length ? { description: said.join(' ') } : undefined
      )
      return
    }
    if (n) onNotice(n)
    onOpened(made.id)
    useUIStore.getState().navigateToCalibrationSheet(made.id)
  }

  const reasons = notReady(state, sheet, blocking, busy)

  const onFile = () =>
    void run('Filing...', async () => {
      refocus.current = fileRef
      // read before the press: the no-answer sentence depends on it
      const noAnswer =
        state.latest.curve_id !== null ? FILE_NO_ANSWER_REFILE : FILE_NO_ANSWER
      try {
        // the version the hook holds, not a query copy that may lag (rule 2)
        const res = await file(state.version)
        say('ok', [filedMessage(res)], res.warnings)
      } catch (e) {
        say('bad', [refusalOf(e, noAnswer)])
      }
    })

  const onDuplicate = () =>
    void run('Duplicating...', async () => {
      refocus.current = dupRef
      let lines: string[] = []
      let warnings: string[] = []
      // the query copy can lag the hook (M1): read the sheet again and
      // decide from that; still out of step, stop rather than guess (a
      // needless filing writes an audit row and can be refused)
      let fresh = sheet
      if (sheet.version !== state.version) {
        try {
          fresh = await inTime(() => getCalSheet(id))
        } catch {
          say('bad', [DUP_UNREAD])
          return
        }
        qc.setQueryData(CAL_SHEET_KEY(id), fresh)
        if (fresh.version !== state.version) {
          say('bad', [DUP_CHANGED])
          return
        }
      }
      let tone: CalNotice['tone'] = 'ok'
      // files first when there is no curve yet or the sheet changed since
      // (rule 5); a refusal stops here, so the route's 400 is never hit.
      // With a curve, a 409 (most often: the curve is used by analyses) does
      // not stop the copy: the server decides at the copy's own File (M1).
      if (fresh.curve_id === null || fresh.changed_since_filed) {
        try {
          const res = await file(state.version)
          lines = [filedMessage(res)]
          warnings = res.warnings
        } catch (e) {
          const inUse =
            fresh.curve_id !== null &&
            e instanceof CalSheetError &&
            e.status === 409
          if (!inUse) {
            say('bad', [
              refusalOf(
                e,
                fresh.curve_id !== null ? FILE_NO_ANSWER_REFILE : FILE_NO_ANSWER
              ),
            ])
            return
          }
          // a 409 can also be a stale version (someone else saved): read
          // again, and copy only the sheet this page holds (round 2 N1)
          let now: CalSheet
          try {
            now = await inTime(() => getCalSheet(id))
          } catch {
            say('bad', [DUP_UNREAD])
            return
          }
          if (now.version !== state.version) {
            say('bad', [DUP_CHANGED])
            return
          }
          lines = [e.message]
          tone = 'bad'
        }
      }
      let copy: CalSheet
      try {
        copy = await duplicate(id)
      } catch (e) {
        say('bad', [...lines, refusalOf(e, DUP_NO_ANSWER)], warnings)
        return
      }
      const where = copy.instrument_name
        ? `it files as ${copy.proposed_name} on the ${copy.instrument_name}`
        : `it files as ${copy.proposed_name} once its Instrument is chosen`
      openMade(
        copy,
        {
          sheetId: copy.id,
          tone,
          lines: [
            ...lines,
            `Opened a copy of ${copy.replicate_of_name ?? sheet.curve_name ?? sheet.proposed_name}: the same vials. Choose its Instrument (${where}), type its peak areas in Step 4, then File curve.`,
          ],
          warnings,
        },
        [...lines, ...warnings]
      )
    })

  const onNew = () => {
    if (!asking) {
      setAsking(true)
      return
    }
    setAsking(false)
    void run('Opening a new one...', async () => {
      refocus.current = newRef
      try {
        const s = await inTime(() => createCalSheet({}))
        qc.setQueryData(CAL_SHEET_KEY(s.id), s)
        void qc.invalidateQueries({ queryKey: [...CAL_SHEETS_KEY, 'list'] })
        openMade(s, null, [])
      } catch (e) {
        say('bad', [refusalOf(e, NEW_NO_ANSWER)])
      }
    })
  }

  return (
    <div
      role="group"
      aria-label="Worksheet"
      className="flex flex-wrap items-center gap-2"
    >
      <ActionButton
        label={busy === 'Filing...' ? busy : 'File curve'}
        help={FILE_HELP}
        reasons={reasons}
        variant="default"
        onClick={onFile}
        buttonRef={fileRef}
      />
      <ActionButton
        label={
          busy === 'Duplicating...' ? busy : 'Duplicate for another injection'
        }
        help={DUP_HELP}
        reasons={reasons}
        onClick={onDuplicate}
        buttonRef={dupRef}
      />
      <ActionButton
        label={asking ? NEW_ASK : NEW_LABEL}
        help={NEW_HELP}
        reasons={busy ? [busy] : []}
        onClick={onNew}
        buttonRef={newRef}
      />
    </div>
  )
}

function SheetView({
  id,
  notice,
  onNotice,
  focusOnOpen,
  onOpened,
  onFocused,
}: {
  id: number
  notice: CalNotice | null
  onNotice: (n: CalNotice | null) => void
  /** Opened from File, Duplicate or New: focus its notice or heading (M4). */
  focusOnOpen: boolean
  onOpened: (id: number) => void
  onFocused: () => void
}) {
  const save = useSaveCalSheet(id)
  const { sheet, state } = save
  const headingRef = useRef<HTMLHeadingElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const loaded = !!sheet && !!state
  useEffect(() => {
    if (!focusOnOpen || !loaded) return
    ;(noticeRef.current ?? headingRef.current)?.focus()
    onFocused()
  }, [focusOnOpen, loaded, onFocused])
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
  // the original's instrument, for the replicate note (read only here)
  const originalId = sheet?.replicate_of_sheet_id ?? null
  const { data: original } = useQuery({
    queryKey: CAL_SHEET_KEY(originalId ?? 0),
    queryFn: () => getCalSheet(originalId ?? 0),
    enabled: originalId !== null,
    refetchOnWindowFocus: false,
    staleTime: 0, // read on every open, as the sheet itself (I2)
  })

  // the way back to the list, on every state of the sheet (round 2 N3)
  const back = (
    <Button
      variant="link"
      size="sm"
      className="mb-1 h-auto gap-1 p-0 text-xs"
      onClick={() => useUIStore.getState().navigateToCalibrationSheet(null)}
    >
      <ArrowLeft className="h-3 w-3" aria-hidden />
      Calibration worksheets
    </Button>
  )
  if (!sheet && save.loadError)
    return (
      <div>
        {back}
        <p role="alert" className="text-sm text-destructive">
          {`This sheet could not be opened: ${save.loadError.message}`}
        </p>
      </div>
    )
  if (!sheet || !state)
    return (
      <div>
        {back}
        <p className="text-sm text-muted-foreground">Loading the sheet...</p>
      </div>
    )

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
          {back}
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-[23px] font-semibold leading-tight tracking-tight outline-none"
          >
            Calibration Curve Worksheet
          </h2>
          <p className="text-sm">
            Curve name:{' '}
            <code className="font-mono" data-testid="curve-name">
              {sheet.proposed_name}
            </code>
            {/* from the freshest copy, as the two lines near File (M-N1) */}
            {state.latest.curve_id !== null && (
              <Badge
                role="img"
                aria-label="Filed: this sheet is filed as a curve"
                className="ml-2 px-1.5 py-0 align-middle text-[10px]"
              >
                Filed
              </Badge>
            )}
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
            <CalDateBox
              label="Date"
              value={inputs.date}
              disabled={replicate}
              onCommit={v => commit('sheet', 0, 'date', v)}
              onRefused={on => save.setRefused('sheet.date', on)}
            />
          </label>
        </div>
      </div>

      {/* the toolbar and the save status stay in view while Step 4 is typed
          (round 2): sticky inside the page's own scroll area, which is
          isolated, so it never slides over the docked sidebar */}
      <div
        data-testid="status-bar"
        className="sticky top-0 z-10 -mx-6 space-y-2 border-b bg-background/95 px-6 py-2 backdrop-blur"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SheetToolbar
            id={id}
            sheet={sheet}
            state={state}
            blocking={blocking.map(w => w.text)}
            onNotice={onNotice}
            onOpened={onOpened}
          />
          {/* one polite live region: Saving, Checking, or a quiet Saved */}
          <div role="status" className="text-xs text-muted-foreground">
            {state.error === null && state.saving && (
              <span data-testid="save-line">Saving...</span>
            )}
            {state.checking && <span>{CHECKING}</span>}
            {save.saved && !state.checking && <span>Saved</span>}
          </div>
        </div>
        {state.error !== null && (
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
        )}
      </div>
      {state.latest.curve_id !== null && state.latest.changed_since_filed && (
        <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
          {CHANGED_LINE}
        </p>
      )}
      {state.latest.curve_changed_since_filed === true && (
        <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
          {ELSEWHERE_LINE}
        </p>
      )}
      {notice && notice.sheetId === id && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          data-testid="cal-notice"
          className={`flex flex-wrap items-start gap-3 rounded-md border px-3 py-2 text-sm ${notice.tone === 'bad' ? 'border-red-500/60 bg-red-500/10' : 'border-emerald-500/50 bg-emerald-500/10'}`}
        >
          <div className="min-w-0 flex-1 space-y-1">
            {notice.lines.map(l => (
              <p key={l}>{l}</p>
            ))}
            {notice.warnings.length > 0 && (
              <ul className="space-y-1 font-medium text-amber-800 dark:text-amber-200">
                {notice.warnings.map(w => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => onNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {state.reloaded && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span>{state.reloaded}</span>
          <Button size="sm" variant="outline" onClick={save.dismissReloaded}>
            Dismiss
          </Button>
        </div>
      )}
      {state.said && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm"
        >
          <span>{state.said}</span>
          <Button size="sm" variant="outline" onClick={save.dismissSaid}>
            Dismiss
          </Button>
        </div>
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
          {replicateNote(sheet, original)}{' '}
          {originalLine(sheet, original) && (
            <span
              className="mt-1 block font-medium"
              data-testid="original-state"
            >
              {originalLine(sheet, original)}
            </span>
          )}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() =>
              useUIStore
                .getState()
                .navigateToCalibrationSheet(sheet.replicate_of_sheet_id ?? id)
            }
          >
            {`Open ${sheet.replicate_of_name ?? 'the original sheet'}`}
          </Button>
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
        stored={{
          peptide: sheet.peptide_id,
          instrument: sheet.instrument_id,
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

export function HplcCalibrationSheetPage() {
  const id = useUIStore(s => s.calibrationSheetPageId)
  // held here, not in the sheet view: a Duplicate's message must survive
  // the move to the copy it opens (the page stays mounted between sheets, I1)
  const [notice, setNotice] = useState<CalNotice | null>(null)
  // moving to another sheet or the list drops a notice for another sheet,
  // so coming back later never shows an old one again (set during render,
  // as React's "adjusting state when a prop changes")
  const [noticeFor, setNoticeFor] = useState(id)
  if (noticeFor !== id) {
    setNoticeFor(id)
    if (notice && notice.sheetId !== id) setNotice(null)
  }
  // the sheet File, Duplicate or New is opening, for its focus (M4)
  const [opened, setOpened] = useState<number | null>(null)
  const focused = useCallback(() => setOpened(null), [])
  return (
    <div data-testid="hplc-calibration-page" className={ROOT}>
      {id === null ? (
        <HplcCalSheetList onOpened={setOpened} />
      ) : (
        <SheetView
          key={id}
          id={id}
          notice={notice}
          onNotice={setNotice}
          focusOnOpen={opened === id}
          onOpened={setOpened}
          onFocused={focused}
        />
      )}
    </div>
  )
}

export default HplcCalibrationSheetPage
