import { FlaskConical } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ReadSource } from '@/lib/read-source'

/** Marks a SENAITE-pulled value in Accu-Mk1 read mode (per-field provenance,
 *  driven by the details endpoint's field_sources / the list's slim refresh).
 *  Renders nothing for registry-sourced fields or outside mk1 mode — zero
 *  visual change in SENAITE mode. Self-wraps in TooltipProvider so it works
 *  standalone (rich sectioned tooltip per docs/developer/ui-patterns.md). */
export function FieldSourceGlyph({
  source,
  field,
  note,
  className,
}: {
  source: ReadSource | undefined
  field: string
  note?: string
  className?: string
}) {
  if (source !== 'senaite') return null
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex text-muted-foreground/70', className)}
            aria-label={`${field}: live from SENAITE`}
          >
            <FlaskConical size={10} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="p-0 max-w-xs">
          <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
            <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
              live from SENAITE
            </div>
            <div>{field} is read from SENAITE, not the Accu-Mk1 registry.</div>
            {note && (
              <div className="border-t border-primary-foreground/20 pt-1.5">
                {note}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
