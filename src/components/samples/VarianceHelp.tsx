import { HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { VARIANCE_HELP, type VarianceHelpId } from '@/lib/variance-help'

/** The sectioned card a help icon opens. Pure, so tests render it directly. */
export function VarianceHelpCard({ id }: { id: VarianceHelpId }) {
  const entry = VARIANCE_HELP[id]
  return (
    <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
      <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
        {entry.title}
      </div>
      {entry.lines.map(line => (
        <div key={line}>{line}</div>
      ))}
    </div>
  )
}

/** A small help-circle icon that opens the rich hover card for `id`
 *  (wording in src/lib/variance-help.ts). */
export function VarianceHelp({ id, className }: { id: VarianceHelpId; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Help: ${VARIANCE_HELP[id].title}`}
          className={cn('inline-flex text-muted-foreground/70 cursor-help', className)}
        >
          <HelpCircle size={12} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <VarianceHelpCard id={id} />
      </TooltipContent>
    </Tooltip>
  )
}
