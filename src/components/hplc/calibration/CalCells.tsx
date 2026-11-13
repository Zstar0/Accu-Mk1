import { useEffect, useId, useRef, useState } from 'react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { MONO } from '@/components/hplc/EndoWorksheetTable'
import { refusalOf } from './cal-sheet-columns'

/**
 * The calibration sheet's own boxes. The prep sheet's NumberBox and
 * CellSelect are not used: their help is looked up by data-field from the
 * prep columns (vial_mg would describe itself as an autosampler vial), and
 * NumberBox refuses negatives, which a peak area or RT may be. These follow
 * the calibration bounds (task-4-report) instead.
 */

const BOX = `rounded-md border bg-card px-1.5 py-[3px] ${MONO} placeholder:text-muted-foreground/60 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 disabled:cursor-default disabled:opacity-50`
const FLAG = 'border-red-500 ring-1 ring-red-500'

/** Hidden descriptions for a box: its help, a warning flag, a refusal. */
function useDescribed(parts: (string | null | undefined)[]) {
  const id = useId()
  const text = parts.filter(Boolean) as string[]
  return {
    id: text.length ? id : undefined,
    note: text.length ? (
      <span id={id} className="sr-only">
        {text.join('. ')}
      </span>
    ) : null,
  }
}

/**
 * A number box that commits on blur, Enter or Tab, and only once something
 * was typed in it. Empty sends null, never 0. A value the server would
 * refuse stays in the box with its reason under it, is never committed, and
 * holds Enter and Tab; Escape gives the stored value back unsaved.
 */
export function CalNumberBox({
  label,
  field,
  bound,
  value,
  placeholder,
  disabled,
  help,
  flag,
  wide,
  onCommit,
  onRefused,
}: {
  /** The accessible name: the label, plus the level for a row. */
  label: string
  /** data-field, for the keyboard walk. */
  field: string
  /** The input key whose server bounds apply. */
  bound: string
  value: number | null | undefined
  placeholder?: string
  disabled: boolean
  help?: string
  /** A warning on this box: outlined, and the text in its description. */
  flag?: string
  wide?: boolean
  onCommit: (v: number | null) => void
  /** The box now holds (true) or no longer holds a refused value. */
  onRefused?: (on: boolean) => void
}) {
  const [draft, setDraftState] = useState<string | null>(null)
  const draftNow = useRef<string | null>(null)
  const setDraft = (d: string | null) => {
    draftNow.current = d
    setDraftState(d)
  }
  const [bad, setBad] = useState<string | null>(null)
  const refusedRef = useRef(onRefused)
  useEffect(() => {
    refusedRef.current = onRefused
  })
  useEffect(() => {
    if (!bad) return
    refusedRef.current?.(true)
    return () => refusedRef.current?.(false)
  }, [bad])

  const [wasDisabled, setWasDisabled] = useState(disabled)
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled)
    if (disabled) {
      // commit refuses a disabled box and a focus starts a new draft, so
      // the ref needs no reset (as the prep sheet's NumberBox)
      setDraftState(null)
      setBad(null)
    }
  }

  const why = (raw: string): string | null => {
    const t = raw.trim()
    if (t === '') return null
    return refusalOf(bound, Number(t))
  }

  function commit(): boolean {
    if (draftNow.current === null || disabled) return true
    const t = draftNow.current.trim()
    const refusal = why(t)
    if (refusal) {
      setBad(refusal)
      return false
    }
    const v = t === '' ? null : Number(t)
    setBad(null)
    setDraft(null)
    if (v !== (value ?? null)) onCommit(v)
    return true
  }

  const errId = useId()
  const desc = useDescribed([help, flag])
  const shown = value === null || value === undefined ? '' : String(value)
  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-describedby={
          [bad ? errId : null, desc.id].filter(Boolean).join(' ') || undefined
        }
        aria-invalid={bad ? true : undefined}
        data-field={field}
        data-flagged={flag ? 'true' : undefined}
        // what is wrong, on hover, as cal.js marks() sets it
        title={bad ?? flag}
        disabled={disabled}
        placeholder={placeholder}
        value={draft ?? shown}
        onChange={e => {
          setDraft(e.target.value)
          if (bad && !why(e.target.value)) setBad(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={e => {
          if ((e.key === 'Enter' || e.key === 'Tab') && !commit()) {
            e.preventDefault()
            e.stopPropagation()
          }
          if (e.key === 'Escape') {
            setDraft(null)
            setBad(null)
          }
        }}
        className={`${wide ? 'w-28' : 'w-[88px]'} text-right ${BOX} ${bad || flag ? FLAG : ''}`}
      />
      {bad && (
        <span
          id={errId}
          className="block text-[10px] leading-tight text-red-600 dark:text-red-400"
        >
          {bad}
        </span>
      )}
      {desc.note}
    </>
  )
}

/** A text box that commits on blur or Enter; empty sends null. */
export function CalTextBox({
  label,
  value,
  placeholder,
  disabled,
  help,
  maxLength = 200,
  className = 'w-44',
  multiline = false,
  onCommit,
}: {
  /** A textarea (the Notes), where Enter is a new line. */
  multiline?: boolean
  label: string
  value: string | null | undefined
  placeholder?: string
  disabled: boolean
  help?: string
  maxLength?: number
  className?: string
  onCommit: (v: string | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const desc = useDescribed([help])
  const commit = () => {
    if (draft === null) return
    const v = draft === '' ? null : draft
    setDraft(null)
    if (v !== (value ?? null)) onCommit(v)
  }
  const shared = {
    'aria-label': label,
    'aria-describedby': desc.id,
    disabled,
    placeholder,
    maxLength,
    value: draft ?? value ?? '',
    onBlur: commit,
    className: `${className} ${BOX}`,
  }
  return (
    <>
      {multiline ? (
        // Enter is a new line here; it saves on leaving the box
        <textarea
          {...shared}
          rows={3}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') setDraft(null)
          }}
        />
      ) : (
        <input
          {...shared}
          type="text"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setDraft(null)
          }}
        />
      )}
      {desc.note}
    </>
  )
}

/** A native select sized to its choices; '' is "not set". */
export function CalSelect({
  label,
  value,
  options,
  disabled,
  help,
  minWidth = 'min-w-36',
  onChange,
}: {
  label: string
  value: string
  options: [string, string][]
  disabled: boolean
  help?: string
  minWidth?: string
  onChange: (v: string) => void
}) {
  const desc = useDescribed([help])
  return (
    <>
      <NativeSelect
        aria-label={label}
        aria-describedby={desc.id}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={`h-auto w-auto ${minWidth} rounded-md bg-card py-[3px] pl-1.5 pr-7 text-[12.5px] dark:bg-card`}
      >
        {options.map(([v, text]) => (
          <NativeSelectOption key={v} value={v}>
            {text}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {desc.note}
    </>
  )
}
