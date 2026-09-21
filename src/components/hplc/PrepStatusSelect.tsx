import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const STATUS_COLORS: Record<string, string> = {
  ready: 'text-zinc-400',
  in_progress: 'text-amber-500',
  complete: 'text-emerald-500',
}
const STATUS_BG: Record<string, string> = {
  ready: '',
  in_progress: 'bg-amber-500/10 border-amber-500/20',
  complete: 'bg-emerald-500/10 border-emerald-500/20',
}

/** The worksheet item's bench status (ready / in progress / complete). Shared
 *  by the generic item row and the endo bench table. */
export function PrepStatusSelect({
  status,
  isCompleted,
  onChange,
}: {
  status: string | null | undefined
  isCompleted: boolean
  onChange: (status: string) => void
}) {
  const value = status ?? 'ready'
  const colorClass = STATUS_COLORS[value] ?? 'text-muted-foreground'
  if (isCompleted) {
    return (
      <span className={`text-[10px] capitalize ${colorClass}`}>
        {value.replace('_', ' ')}
      </span>
    )
  }
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        className={`h-6 text-[10px] border-transparent shadow-none hover:border-border ${STATUS_BG[value] ?? ''} ${colorClass}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ready">
          <span className="text-zinc-400">Ready</span>
        </SelectItem>
        <SelectItem value="in_progress">
          <span className="text-amber-500">In Progress</span>
        </SelectItem>
        <SelectItem value="complete">
          <span className="text-emerald-500">Complete</span>
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

export default PrepStatusSelect
