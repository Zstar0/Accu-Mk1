import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  MONO,
  TD,
  TD_CALC,
  TH,
  TH_CALC,
} from '@/components/hplc/EndoWorksheetTable'
import type { SheetColumn } from './hplc-sheet-columns'

/** The lab tool's fmt: dp places, "-0.00" read as zero; a dash for null. */
// The tables format with it too; Fast Refresh on this file only.
// eslint-disable-next-line react-refresh/only-export-components
export function fmtDp(n: number | null | undefined, dp: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  const t = n.toFixed(dp)
  return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t
}

const HINT = 'block text-[10px] font-normal leading-tight text-muted-foreground'

/** A small line under a cell, saying where its number comes from. */
export function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className={HINT}>
      {children}
    </span>
  )
}

/** The page's failure list, as the boxes see it. */
export interface SheetSaves {
  /** A box refused what was typed in it (`reason`), or now holds a value it
   *  takes or its stored one again (null). `what` is the box's
   *  name, `key` its boxKey. */
  refused?: (what: string, reason: string | null, key?: string) => void
  /** The boxes whose save did not land, by boxKey, with the failure
   *  sentence ("<what>: <reason>"). */
  failed: ReadonlyMap<string, string>
}

// eslint-disable-next-line react-refresh/only-export-components
export const SheetSavesContext = createContext<SheetSaves>({
  failed: new Map(),
})

/** A box's failure mark: its sentence (or null), the red outline, and the
 *  hidden description that carries it. */
// eslint-disable-next-line react-refresh/only-export-components
export function useFailMark(
  saveKey: string | undefined,
  bad: string | null = null
) {
  const { failed } = useContext(SheetSavesContext)
  const fail = saveKey ? failed.get(saveKey) : undefined
  const id = useId()
  const text = [bad, fail ? `Not saved: ${fail}` : null]
    .filter(Boolean)
    .join('. ')
  return {
    id: text ? id : undefined,
    outline: text ? 'border-red-500 ring-1 ring-red-500' : '',
    note: text ? (
      <span id={id} className="sr-only">
        {text}
      </span>
    ) : null,
  }
}

// The server's limits (worksheets_hplc: 0 to _MAX_NUMBER, a whole number 1
// to _MAX_WHOLE): it answers 400 outside them, so they are refused here.
const MAX_NUMBER = 1e12
const TOO_LARGE = 'that number is too large'

/** A tighter ceiling the server keeps for some boxes, with its sentence. */
interface Ceiling {
  max: number
  say: string
}
/** A balance reading (worksheets_hplc.MAX_WEIGHING_MG). */
const WEIGHING_CEILING: Ceiling = {
  max: 1e9,
  say: 'a weighing cannot be more than 1,000,000,000 mg',
}
/** A declared liquid volume (worksheets_hplc.MAX_DECLARED_VOLUME_ML). */
const VOLUME_CEILING: Ceiling = {
  max: 1e6,
  say: 'a declared volume cannot be more than 1,000,000 mL',
}

/** The keys of hplc_prep that are balance readings. */
const WEIGHINGS = new Set([
  'stock_vial_mg',
  'stock_vial_diluent_mg',
  'vial_mg',
  'vial_diluent_mg',
  'vial_all_mg',
  'int_vial_mg',
  'int_vial_diluent_mg',
  'int_vial_all_mg',
])

/** The ceiling of the value a box writes, by its boxKey's last part. */
function ceilingOf(saveKey: string | undefined): Ceiling | null {
  const leaf = saveKey?.split('.').pop() ?? ''
  if (WEIGHINGS.has(leaf)) return WEIGHING_CEILING
  return leaf === 'declared_volume_ml' ? VOLUME_CEILING : null
}

/**
 * A number box that commits on blur, Enter or Tab, and only once something
 * was typed in it: a box merely visited sends nothing, even when its stored
 * value changed under it. Empty sends null (never 0); a value that is not a
 * number (or not a whole number, for `integer`), or one outside what the
 * server takes, is refused and reported to SheetSavesContext (the page's
 * list, which keeps the row from being promoted): it stays in the
 * box, marked with its reason, Enter and Tab do not move on, and the mark
 * clears as soon as the box holds a value it takes or Escape gives the
 * stored one back. While the box is not being typed in it shows `value`, so
 * a save the server refuses shows the rolled-back figure as soon as the
 * cache has it; the failure marks the box (by `saveKey`) until that box
 * saves or the failure is dismissed. A box that turns disabled drops its
 * draft.
 */
export function NumberBox({
  label,
  field,
  saveKey,
  value,
  placeholder,
  integer = false,
  disabled,
  hint,
  title,
  zeroClears = false,
  onCommit,
}: {
  /** The accessible name: <sample id>, <column label>. */
  label: string
  /** The column, for the keyboard walk. */
  field: string
  /** The value it writes, as boxKey(item id, path): its failed saves. */
  saveKey?: string
  value: number | null | undefined
  placeholder?: string
  integer?: boolean
  disabled: boolean
  hint?: string | null
  /** The box's tooltip (a refused value's reason replaces it). */
  title?: string
  /** 0 or less goes back to the standard, as on the source sheet: it is
   *  sent as null, never refused. */
  zeroClears?: boolean
  onCommit: (v: number | null) => void
}) {
  const [draft, setDraftState] = useState<string | null>(null)
  // Enter commits and then moves on, and the move's blur would commit again
  // before a re-render: the ref is the draft as of now.
  const draftNow = useRef<string | null>(null)
  const setDraft = (d: string | null) => {
    draftNow.current = d
    setDraftState(d)
  }
  const [bad, setBad] = useState<string | null>(null)
  const { refused } = useContext(SheetSavesContext)
  const mark = useFailMark(saveKey, bad)
  // the text last reported to the list (the page lists a sentence once);
  // null when no refusal of this box is on the list
  const reported = useRef<string | null>(null)
  const unreport = () => {
    if (reported.current !== null) refused?.(label, null, saveKey)
    reported.current = null
  }
  const hintId = useId()
  const shown = value === null || value === undefined ? '' : String(value)

  // a row promoted while a box was being typed in: the box shows the stored
  // value again, not a draft that can never be saved (commit refuses a
  // disabled box, and a focus starts a new draft, so the ref needs no reset)
  const [wasDisabled, setWasDisabled] = useState(disabled)
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled)
    if (disabled) {
      setDraftState(null)
      setBad(null)
    }
  }

  /** Why the box will not take this text (null: it takes it). Every
   *  refusal goes on the page's list: the stored value was not changed, so
   *  the row cannot be promoted while it stands. */
  function refusalOf(raw: string): string | null {
    const text = raw.trim()
    if (text === '') return null
    const v = Number(text)
    if (!Number.isFinite(v) || (integer && !Number.isInteger(v)))
      return integer ? 'Type a whole number' : 'Type a number'
    // what the server would answer 400 for, in a plain sentence
    const ceiling = ceilingOf(saveKey)
    return Math.abs(v) > (integer ? Number.MAX_SAFE_INTEGER : MAX_NUMBER)
      ? TOO_LARGE
      : ceiling && v > ceiling.max
        ? ceiling.say
        : integer && v < 1
          ? 'type a whole number of 1 or more'
          : v < 0 && !zeroClears
            ? 'a number here cannot be below 0'
            : null
  }

  /** False when the box refused its text (focus stays). */
  function commit(): boolean {
    // a locked box never saves (a row promoted while it was being edited);
    // a box nothing was typed in sends nothing
    if (draftNow.current === null || disabled) return true
    const text = draftNow.current.trim()
    const refusal = refusalOf(text)
    if (refusal) {
      setBad(refusal)
      // every time: the list keeps one line per sentence, and lists it
      // again after it was dismissed
      refused?.(label, refusal, saveKey)
      reported.current = text
      return false
    }
    const v = text === '' ? null : Number(text)
    setBad(null)
    unreport()
    setDraft(null)
    // 0 or less means "the standard" in a zeroClears box: the key is removed
    if (v !== (value ?? null))
      onCommit(zeroClears && v !== null && v <= 0 ? null : v)
    return true
  }

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-describedby={
          [hint ? hintId : null, mark.id].filter(Boolean).join(' ') || undefined
        }
        data-field={field}
        aria-invalid={bad ? true : undefined}
        title={bad ?? title}
        disabled={disabled}
        placeholder={placeholder}
        value={draft ?? shown}
        onChange={e => {
          setDraft(e.target.value)
          // put right: the mark and the list entry go at once
          if (bad && !refusalOf(e.target.value)) {
            setBad(null)
            unreport()
          }
        }}
        onBlur={() => void commit()}
        onKeyDown={e => {
          // a refused value keeps the box: Enter and Tab do not move on
          if ((e.key === 'Enter' || e.key === 'Tab') && !commit()) {
            e.preventDefault()
            e.stopPropagation()
          }
          // a mistyped value: Escape gives the stored one back, unsaved
          // (the source has no Escape for a number box)
          if (e.key === 'Escape') {
            setDraft(null)
            setBad(null)
            unreport()
          }
        }}
        className={`w-[84px] rounded-md border bg-card px-1.5 py-[3px] text-right ${MONO} placeholder:text-muted-foreground/60 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 disabled:cursor-default disabled:opacity-50 ${mark.outline}`}
      />
      {hint && <Hint id={hintId}>{hint}</Hint>}
      {mark.note}
    </>
  )
}

/** A compact native select; '' is its "not set" choice. A save of it that
 *  did not land marks it (by `saveKey`), as a NumberBox. */
export function CellSelect({
  label,
  field,
  saveKey,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  field?: string
  saveKey?: string
  value: string
  options: [string, string][]
  disabled: boolean
  onChange: (v: string) => void
}) {
  const mark = useFailMark(saveKey)
  return (
    <>
      <NativeSelect
        aria-label={label}
        aria-describedby={mark.id}
        data-field={field}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={`h-auto rounded-md bg-card py-[3px] pl-1.5 pr-7 text-[12.5px] dark:bg-card ${mark.outline}`}
      >
        {options.map(([v, text], i) => (
          <NativeSelectOption key={i} value={v}>
            {text}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {mark.note}
    </>
  )
}

/** A worked-out cell: its figure at dp places, marked when off plan. */
export function ComputedCell({
  value,
  dp,
  mark,
  markTitle,
  title,
  children,
}: {
  value: number | null | undefined
  dp: number
  mark?: boolean
  markTitle?: string
  title?: string
  children?: ReactNode
}) {
  return (
    <td
      className={`${TD_CALC} ${mark ? '!bg-amber-500/20 font-semibold text-amber-700 dark:text-amber-300' : ''}`}
      title={mark ? markTitle : title}
    >
      {fmtDp(value, dp)}
      {children}
    </td>
  )
}

export function InputCell({ children }: { children: ReactNode }) {
  return <td className={`${TD} px-1 text-right`}>{children}</td>
}

/** The Sample ID column stays in view while the table scrolls right. */
const STICKY = 'sticky left-0 z-10 bg-card'

export function HeadCell({ col }: { col: SheetColumn }) {
  return (
    <th
      title={col.title}
      className={`${TH} ${col.kind === 'computed' ? TH_CALC : ''} ${col.key === 'sample_id' ? STICKY : ''} whitespace-normal`}
    >
      {col.label}
    </th>
  )
}

export function IdCell({ children }: { children: ReactNode }) {
  return <td className={`${TD} ${MONO} ${STICKY}`}>{children}</td>
}

/** A sheet row; shaded when on another instrument than the sheet's first,
 *  as the source shades its 1290B rows. */
export function SheetRow({
  shaded,
  children,
}: {
  shaded: boolean
  children: ReactNode
}) {
  return (
    <tr
      data-shaded={String(shaded)}
      className={shaded ? 'bg-sky-500/[0.07]' : ''}
    >
      {children}
    </tr>
  )
}
