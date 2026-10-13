import { useState } from 'react'
import { ChevronDown, ChevronRight, Crosshair } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { FlagCard } from '@/components/flags/FlagCard'
import { useBoardFlags } from '@/services/boards'
import { useFlagTypes } from '@/services/flag-types'
import { useUIStore } from '@/store/ui-store'
import type { BoardDetail } from '@/lib/api-boards'
import {
  attentionList,
  blockingTypeSet,
  dueLabel,
  locateTargetFor,
} from './board-flags'

/** Blocking or past-due flags on this board, overdue first (spec 8.6). Lives in the
 *  side panel's idle state; Locate centres the item through the one-shot pending node. */
export function AttentionDock({ board }: { board: BoardDetail }) {
  const flags = useBoardFlags(board.slug)
  const types = useFlagTypes({})
  const setPendingBoardNode = useUIStore(s => s.setPendingBoardNode)
  const [open, setOpen] = useState(true)
  // Read once into state (React Compiler: no impure reads during render).
  const [now] = useState(() => new Date())
  const rows = attentionList(flags.data ?? [], blockingTypeSet(types.data), now)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground"
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Needs attention ({rows.length})
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing needs attention.
          </p>
        )}
        {rows.map(f => {
          const target = locateTargetFor(f, board.nodes)
          const due = dueLabel(f.due_at, now)
          return (
            <div key={f.id} className="space-y-1">
              <FlagCard flag={f} />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {due && (
                  <span
                    className={due.startsWith('overdue') ? 'text-red-600' : ''}
                  >
                    {due}
                  </span>
                )}
                {f.entity?.label && (
                  <span className="truncate">{f.entity.label}</span>
                )}
                {target != null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => setPendingBoardNode(String(target))}
                  >
                    <Crosshair className="mr-1 h-3 w-3" />
                    Locate
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
