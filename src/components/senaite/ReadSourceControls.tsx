import { cn } from '@/lib/utils'
import { ReadSourceIndicator } from '@/components/senaite/ReadSourceIndicator'
import type { ReadSource } from '@/lib/read-source'

/** Shared read-source indicator + tri-state override control (Follow default /
 *  SENAITE / Accu-Mk1). Used on both sample-details (parent rows only — the
 *  caller gates on isParent) and the samples-list page. Gating-agnostic by
 *  design: callers decide whether/where to render it. */
export function ReadSourceControls({
  effective,
  override,
  setOverride,
}: {
  effective: ReadSource
  override: ReadSource | null
  setOverride: (source: ReadSource | null) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <ReadSourceIndicator source={effective} />
      <div className="flex items-center gap-0.5 rounded border p-0.5">
        {(
          [
            ['follow', null],
            ['senaite', 'senaite'],
            ['mk1', 'mk1'],
          ] as const
        ).map(([label, val]) => (
          <button
            key={label}
            type="button"
            onClick={() => setOverride(val)}
            className={cn(
              'px-1.5 py-0.5 text-[10px] font-mono rounded',
              override === val
                ? 'bg-emerald-600/30 text-emerald-400'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label === 'follow'
              ? 'Follow default'
              : label === 'senaite'
                ? 'SENAITE'
                : 'Accu-Mk1'}
          </button>
        ))}
      </div>
    </div>
  )
}
