import { useState } from 'react'
import { X, MoveRight, ClipboardX } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import { SERVICE_GROUP_COLORS } from '@/lib/service-group-colors'
import type { WorksheetListItem, InboxPriority } from '@/lib/api'

// Map group_name to a stable color key by cycling through palette
const COLOR_KEYS = Object.keys(SERVICE_GROUP_COLORS) as (keyof typeof SERVICE_GROUP_COLORS)[]

function getColorForGroup(groupName: string): string {
  if (!groupName) return SERVICE_GROUP_COLORS.zinc
  // Simple deterministic hash: sum of char codes mod palette length
  let hash = 0
  for (let i = 0; i < groupName.length; i++) {
    hash = (hash + groupName.charCodeAt(i)) % COLOR_KEYS.length
  }
  const key = COLOR_KEYS[hash]
  return key ? SERVICE_GROUP_COLORS[key] : SERVICE_GROUP_COLORS.zinc
}

interface WorksheetDrawerItemsProps {
  items: WorksheetListItem['items']
  worksheetId: number
  openWorksheets: WorksheetListItem[]
  isCompleted: boolean
  prepStartedItems: Set<string>
  onRemove: (sampleUid: string, serviceGroupId: number) => void
  onReassign: (sampleUid: string, serviceGroupId: number, targetWorksheetId: number) => void
  onStartPrep: (item: { sampleId: string; serviceGroupId: number | null; groupName: string }) => void
}

export function WorksheetDrawerItems({
  items,
  worksheetId,
  openWorksheets,
  isCompleted,
  prepStartedItems,
  onRemove,
  onReassign,
  onStartPrep,
}: WorksheetDrawerItemsProps) {
  const otherWorksheets = openWorksheets.filter(ws => ws.id !== worksheetId)

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Section label */}
      <div className="px-4 pt-3 pb-1">
        <span className="text-xs font-semibold text-muted-foreground">
          Items ({items.length})
        </span>
      </div>

      {/* Items list */}
      <ScrollArea className="flex-1">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ClipboardX className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm font-semibold">No items in this worksheet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add samples from the inbox to get started.
            </p>
          </div>
        ) : (
          <div className="pb-4">
            {items.map(item => {
              const prepKey = `${item.sample_uid}-${item.service_group_id}`
              const isPrepStarted = prepStartedItems.has(prepKey)
              const groupColorClass = getColorForGroup(item.group_name)

              return (
                <div
                  key={prepKey}
                  className="group/item flex items-center gap-1.5 px-3 py-2 hover:bg-muted/50 transition-colors"
                >
                  {/* Remove button */}
                  {!isCompleted && (
                    <button
                      className="h-8 w-8 flex-shrink-0 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-destructive rounded"
                      aria-label={`Remove ${item.sample_id} from worksheet`}
                      onClick={() => onRemove(item.sample_uid, item.service_group_id ?? 0)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}

                  {/* Sample ID */}
                  <span className="font-mono text-xs tabular-nums flex-shrink-0">{item.sample_id}</span>

                  <span className="text-muted-foreground/40 flex-shrink-0">·</span>

                  {/* Analysis / Service group badge */}
                  <span
                    className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold flex-shrink-0 ${groupColorClass}`}
                  >
                    {item.group_name}
                  </span>

                  {/* Priority badge */}
                  <PriorityBadge priority={item.priority as InboxPriority} />

                  {/* Assigned tech */}
                  <span
                    className="text-[10px] text-muted-foreground truncate max-w-[100px]"
                    title={item.assigned_analyst_email ?? 'Unassigned'}
                  >
                    {item.assigned_analyst_email ?? '—'}
                  </span>

                  {/* Instrument */}
                  <span
                    className="text-[10px] text-muted-foreground font-mono truncate max-w-[80px]"
                    title={item.instrument_uid ?? 'No instrument'}
                  >
                    {item.instrument_uid ?? '—'}
                  </span>

                  {/* Aging timer */}
                  <AgingTimer dateReceived={item.added_at} compact />

                  <div className="flex-1" />

                  {/* Reassign button */}
                  {!isCompleted && (
                    <ReassignButton
                      item={item}
                      otherWorksheets={otherWorksheets}
                      onReassign={onReassign}
                    />
                  )}

                  {/* Start Prep button or indicator */}
                  {!isCompleted && (
                    isPrepStarted ? (
                      <span className="text-[10px] text-muted-foreground/60 italic flex-shrink-0">
                        Prep started
                      </span>
                    ) : (
                      <button
                        className="h-6 px-2 text-[10px] rounded-md border bg-secondary text-secondary-foreground opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0"
                        onClick={() =>
                          onStartPrep({
                            sampleId: item.sample_id,
                            serviceGroupId: item.service_group_id,
                            groupName: item.group_name,
                          })
                        }
                      >
                        Start Prep
                      </button>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

interface ReassignButtonProps {
  item: WorksheetListItem['items'][number]
  otherWorksheets: WorksheetListItem[]
  onReassign: (sampleUid: string, serviceGroupId: number, targetWorksheetId: number) => void
}

function ReassignButton({ item, otherWorksheets, onReassign }: ReassignButtonProps) {
  const [open, setOpen] = useState(false)
  const hasTargets = otherWorksheets.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="h-8 w-8 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-foreground rounded disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label={`Move ${item.sample_id} to another worksheet`}
          disabled={!hasTargets}
          title={hasTargets ? undefined : 'No other open worksheets'}
          onClick={e => { if (!hasTargets) e.preventDefault() }}
        >
          <MoveRight className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      {hasTargets && (
        <PopoverContent className="w-56 p-2" align="end">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Move to worksheet</p>
          <Select
            onValueChange={value => {
              onReassign(item.sample_uid, item.service_group_id ?? 0, Number(value))
              setOpen(false)
            }}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select worksheet..." />
            </SelectTrigger>
            <SelectContent>
              {otherWorksheets.map(ws => (
                <SelectItem key={ws.id} value={String(ws.id)}>
                  {ws.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PopoverContent>
      )}
    </Popover>
  )
}

export default WorksheetDrawerItems
