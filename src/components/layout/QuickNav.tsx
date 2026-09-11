/**
 * Header quick controls (2026-09-11). Replaces the "Accu-Mk1" label at the
 * left of the header. Three Enter-to-go boxes styled like the Worksheets pill
 * (accent background, 28 px tall, label as placeholder) and a Ready to
 * Publish button with two count chips: red = every line verified, green =
 * Ready for Partial Publish. Held rows count in neither.
 */
import { useState, type KeyboardEvent } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'
import { useReadyToPublishCount } from '@/hooks/use-ready-to-publish-count'
import { cn } from '@/lib/utils'

const BOX =
  'h-7 w-28 rounded-md bg-accent px-2.5 text-xs text-foreground placeholder:text-muted-foreground ' +
  'outline-none border border-transparent focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]'

function QuickBox({
  label,
  onSubmit,
  className,
}: {
  label: string
  onSubmit: (value: string) => void
  className?: string
}) {
  const [value, setValue] = useState('')
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    const v = value.trim()
    if (!v) return
    onSubmit(v)
    setValue('')
  }
  return (
    <input
      type="text"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      className={cn(BOX, className)}
      autoComplete="off"
      spellCheck={false}
    />
  )
}

function CountChip({
  count,
  tone,
  title,
}: {
  count: number
  tone: 'red' | 'green'
  title: string
}) {
  if (count <= 0) return null
  return (
    <span
      title={title}
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white',
        tone === 'red' ? 'bg-red-600' : 'bg-emerald-600'
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

export function ReadyToPublishChips() {
  const { ready, partial } = useReadyToPublishCount()
  return (
    <>
      <CountChip count={ready} tone="red" title={`${ready} ready to publish (all lines verified)`} />
      <CountChip count={partial} tone="green" title={`${partial} ready for partial publish`} />
    </>
  )
}

export function QuickNav() {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const navigateToCustomers = useUIStore(state => state.navigateToCustomers)
  const setSearchAndResetPage = useUIStore(state => state.setSearchAndResetPage)
  const navigateToOrderStatus = useUIStore(state => state.navigateToOrderStatus)
  const navigateTo = useUIStore(state => state.navigateTo)

  return (
    <div className="flex items-center gap-2" data-testid="quick-nav">
      <QuickBox label="Sample ID" onSubmit={v => navigateToSample(v.toUpperCase())} />
      <QuickBox
        label="Customer Email"
        className="w-40"
        onSubmit={v => {
          // navigateToCustomers clears the per-customer order search slots;
          // the list search term is set AFTER so it survives.
          navigateToCustomers()
          setSearchAndResetPage(v)
        }}
      />
      <QuickBox label="Order ID" className="w-24" onSubmit={v => navigateToOrderStatus(v)} />
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 h-7 px-2.5 bg-accent text-foreground hover:bg-accent/80 hover:shadow-sm cursor-pointer"
        onClick={() => navigateTo('reports', 'ready-to-publish')}
      >
        <ClipboardCheck className="h-3.5 w-3.5" />
        <span className="text-xs">Ready to Publish</span>
        <ReadyToPublishChips />
      </Button>
    </div>
  )
}
