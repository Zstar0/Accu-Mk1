import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** The help card's body, as SlaBreakdownTooltip draws its card: a title and
 *  one line per sentence. Pure; hosted inside a TooltipContent. */
export function CalTip({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="flex max-w-sm flex-col gap-1.5 p-1 text-xs normal-case tracking-normal">
      <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
        {title}
      </div>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

/** A label with its help in the tooltip card on hover; never a Tab stop
 *  (each box carries the same help as its accessible description). */
export function HelpLabel({
  label,
  lines,
  children,
}: {
  label: string
  lines: string[]
  children?: ReactNode
}) {
  if (!lines.length) return <span>{children ?? label}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">
          {children ?? label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <CalTip title={label} lines={lines} />
      </TooltipContent>
    </Tooltip>
  )
}
