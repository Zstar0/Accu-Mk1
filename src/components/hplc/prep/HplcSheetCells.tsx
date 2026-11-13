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

/** Where a box reports a number too large to send: the page's failure
 *  list. `what` is the box's name. */
// eslint-disable-next-line react-refresh/only-export-components
export const NumberRefusedContext = createContext<
  ((what: string) => void) | undefined
>(undefined)

// The server's ceilings (worksheets_hplc._MAX_NUMBER, _MAX_WHOLE): it answers
// 400 above them, so they are refused here instead.
const MAX_NUMBER = 1e12
const TOO_LARGE = 'that number is too large'

/**
 * A number box that commits on blur or Enter. Empty sends null (never 0); a
 * value that is not a number (or not a whole number, for `integer`), or one
 * larger than the server takes, is refused and stays in the box, marked,
 * until fixed or cleared. While the box is not being edited it shows
 * `value`, so a save the server refuses shows the rolled-back figure as soon
 * as the cache has it. A box that turns disabled drops its draft.
 */
export function NumberBox({
  label,
  field,
  value,
  placeholder,
  integer = false,
  disabled,
  hint,
  title,
  onCommit,
}: {
  /** The accessible name: <sample id>, <column label>. */
  label: string
  /** The column, for the keyboard walk. */
  field: string
  value: number | null | undefined
  placeholder?: string
  integer?: boolean
  disabled: boolean
  hint?: string | null
  /** The box's tooltip (a refused value's reason replaces it). */
  title?: string
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
  const refused = useContext(NumberRefusedContext)
  // the text last reported as too large: Enter and the blur after it
  // report it once
  const reported = useRef<string | null>(null)
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

  function commit() {
    // a locked box never saves (a row promoted while it was being edited)
    if (draftNow.current === null || disabled) return
    const text = draftNow.current.trim()
    const v = text === '' ? null : Number(text)
    if (
      v !== null &&
      (!Number.isFinite(v) || (integer && !Number.isInteger(v)))
    ) {
      setBad(integer ? 'Type a whole number' : 'Type a number')
      return
    }
    if (
      v !== null &&
      Math.abs(v) > (integer ? Number.MAX_SAFE_INTEGER : MAX_NUMBER)
    ) {
      setBad(TOO_LARGE)
      if (reported.current !== text) refused?.(label)
      reported.current = text
      return
    }
    setBad(null)
    reported.current = null
    setDraft(null)
    if (v !== (value ?? null)) onCommit(v)
  }

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        data-field={field}
        aria-invalid={bad ? true : undefined}
        title={bad ?? title}
        disabled={disabled}
        placeholder={placeholder}
        value={draft ?? shown}
        onFocus={() => setDraft(shown)}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
        }}
        className={`w-[84px] rounded-md border bg-card px-1.5 py-[3px] text-right ${MONO} placeholder:text-muted-foreground/60 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 disabled:cursor-default disabled:opacity-50 ${bad ? 'border-red-500' : ''}`}
      />
      {hint && <Hint id={hintId}>{hint}</Hint>}
    </>
  )
}

/** A compact native select; '' is its "not set" choice. */
export function CellSelect({
  label,
  field,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  field?: string
  value: string
  options: [string, string][]
  disabled: boolean
  onChange: (v: string) => void
}) {
  return (
    <NativeSelect
      aria-label={label}
      data-field={field}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className="h-auto rounded-md bg-card py-[3px] pl-1.5 pr-7 text-[12.5px] dark:bg-card"
    >
      {options.map(([v, text], i) => (
        <NativeSelectOption key={i} value={v}>
          {text}
        </NativeSelectOption>
      ))}
    </NativeSelect>
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
