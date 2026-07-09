import { cn } from '@/lib/utils'
import { Database, FlaskConical } from 'lucide-react'
import type { ReadSource } from '@/lib/read-source'

/** Small always-on badge stating where the page's basic-info is read from. */
export function ReadSourceIndicator({ source, className }: { source: ReadSource; className?: string }) {
  const mk1 = source === 'mk1'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono',
        mk1 ? 'bg-emerald-600/15 text-emerald-500' : 'bg-muted text-muted-foreground',
        className,
      )}
      title={mk1 ? 'Basic-info sourced from the Accu-Mk1 registry' : 'Basic-info sourced live from SENAITE'}
    >
      {mk1 ? <Database size={11} /> : <FlaskConical size={11} />}
      {mk1 ? 'Read from Accu-Mk1' : 'Read from SENAITE'}
    </span>
  )
}
