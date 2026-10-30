import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * A computed figure with its worked line on hover, in the app's default
 * hover card (the shadcn Tooltip, not a native title). Focusable, so the
 * line is reachable from the keyboard too. No tip, no tooltip.
 */
export function WorkedTip({
  tip,
  className,
  children,
}: {
  tip: string | null | undefined
  className?: string
  children: ReactNode
}) {
  if (!tip) return <span className={className}>{children}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`cursor-help focus-visible:outline-2 focus-visible:outline-teal-500 dark:focus-visible:outline-teal-400 ${className ?? ''}`}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm p-0">
        <div className="whitespace-pre-line p-3 font-mono text-xs leading-relaxed">
          {tip}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export default WorkedTip
