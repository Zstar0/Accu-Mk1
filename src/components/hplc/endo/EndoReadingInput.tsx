import { useState } from 'react'
import { parseReading } from '@/lib/endo-prep-2ml'

/**
 * The reading as it will be saved, or null when the text is not one.
 * parseReading is the only judge (the server's parse_reading accepts the
 * same set, "<0" refused by both); whitespace goes, so "< 0.05" saves as
 * "<0.05".
 */
function normalizeReading(text: string): string | null {
  const t = text.replace(/\s+/g, '')
  return parseReading(t) ? t : null
}

/**
 * The instrument reading, typed as the MCS shows it with the factor at 1:
 * "<0.05", "0.8", "0". Commits on blur or Enter; Escape throws the draft
 * away. A text that is not a reading stays in the cell, marked, until it is
 * fixed: it drives a verdict and the value that goes to Accu-Mk1, so it must
 * never snap back silently (the PrepField rule). Emptying a saved reading
 * clears it.
 */
export function EndoReadingInput({
  value,
  placeholder,
  disabled,
  label,
  onCommit,
}: {
  value: string | null
  placeholder: string
  disabled: boolean
  label: string
  onCommit: (reading: string | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [rejected, setRejected] = useState(false)

  if (disabled) {
    return <span className="font-mono tabular-nums">{value || '-'}</span>
  }

  function commit() {
    if (draft === null) return
    if (draft.trim() === '') {
      setDraft(null)
      setRejected(false)
      if (value) onCommit(null)
      return
    }
    const reading = normalizeReading(draft)
    if (reading === null) {
      setRejected(true)
      return
    }
    setDraft(null)
    setRejected(false)
    if (reading !== value) onCommit(reading)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={rejected || undefined}
      title={
        rejected
          ? `Not a reading: "${draft ?? ''}" was not saved. Type it as the instrument shows it (<0.05, 0.8 or 0), or press Escape.`
          : undefined
      }
      className={`h-7 w-full rounded-[3px] border bg-transparent px-1.5 text-right font-mono text-[12.5px] tabular-nums placeholder:text-muted-foreground/50 focus:bg-background focus:outline-none focus:ring-2 ${rejected ? 'border-red-500 bg-red-500/10 text-red-600 focus:ring-red-500/25 dark:border-red-400 dark:bg-red-400/15 dark:text-red-400 dark:focus:ring-red-400/30' : 'border-transparent text-foreground hover:border-border focus:border-teal-500 focus:ring-teal-500/20 dark:focus:border-teal-400 dark:focus:ring-teal-400/25'}`}
      value={draft ?? value ?? ''}
      placeholder={placeholder}
      onChange={e => {
        setDraft(e.target.value)
        setRejected(false)
      }}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          setRejected(false)
        }
      }}
    />
  )
}

export default EndoReadingInput
