import { cn } from '@/lib/utils'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  WINDOW_PERIODS,
  monthOptions,
  type ReceivedWindow,
} from './received-window'

/** Period buttons plus a month picker; picking a month replaces the period. */
export function ReceivedWindowPicker({
  value,
  onChange,
  className,
}: {
  value: ReceivedWindow
  onChange: (next: ReceivedWindow) => void
  className?: string
}) {
  const months = monthOptions()
  const isMonth = /^\d{4}-\d{2}$/.test(value)
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div
        className="inline-flex rounded-md border border-border/60 p-0.5"
        role="group"
        aria-label="Received period"
      >
        {WINDOW_PERIODS.map(p => (
          <button
            key={p.key}
            type="button"
            aria-pressed={value === p.key}
            onClick={() => onChange(p.key)}
            className={cn(
              'rounded px-2.5 py-0.5 text-xs font-medium transition-colors',
              value === p.key
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <NativeSelect
        aria-label="Received month"
        value={isMonth ? value : ''}
        onChange={e => onChange(e.target.value || 'all')}
        className={cn('h-7 w-40 text-xs', isMonth && 'text-foreground')}
      >
        <NativeSelectOption value="">Month…</NativeSelectOption>
        {months.map(m => (
          <NativeSelectOption key={m.key} value={m.key}>
            {m.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}
