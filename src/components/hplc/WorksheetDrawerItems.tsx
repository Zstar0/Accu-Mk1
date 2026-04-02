import { useState } from 'react'
import { X, MoveRight, ClipboardX, GripVertical } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
// Badge import kept for potential future use
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
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import {
  SERVICE_GROUP_COLORS,
  type ServiceGroupColor,
} from '@/lib/service-group-colors'
import type { WorksheetListItem, InboxPriority, Instrument } from '@/lib/api'

/** Extract unique peptide names from analyses — compact display for worksheet */
function getPeptideNames(analyses: { title: string; peptide_name: string | null }[]): string[] {
  const names = new Set<string>()
  for (const a of analyses) {
    if (a.peptide_name) names.add(a.peptide_name)
  }
  return Array.from(names)
}

type ItemType = WorksheetListItem['items'][number]

interface WorksheetDrawerItemsProps {
  items: ItemType[]
  worksheetId: number
  openWorksheets: WorksheetListItem[]
  isCompleted: boolean
  prepStartedItems: Set<string>
  onRemove: (sampleUid: string, serviceGroupId: number) => void
  onReassign: (sampleUid: string, serviceGroupId: number, targetWorksheetId: number) => void
  onStartPrep: (item: { sampleId: string; serviceGroupId: number | null; groupName: string; peptideId: number | null }) => void
  instruments: Instrument[]
  onUpdateItem: (itemId: number, data: { instrument_uid?: string }) => void
  onReorder: (itemIds: number[]) => void
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
  instruments,
  onUpdateItem,
  onReorder,
}: WorksheetDrawerItemsProps) {
  const otherWorksheets = openWorksheets.filter(ws => ws.id !== worksheetId)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const itemIds = items.map(item => item.id)

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex(item => item.id === active.id)
    const newIndex = items.findIndex(item => item.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = [...items]
    const moved = reordered.splice(oldIndex, 1)[0]
    if (!moved) return
    reordered.splice(newIndex, 0, moved)
    onReorder(reordered.map(i => i.id))
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Section label */}
      <div className="px-4 pt-3 pb-1">
        <span className="text-xs font-semibold text-muted-foreground">
          Items ({items.length})
        </span>
      </div>

      {/* Column headers */}
      {items.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-1 border-b text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          {!isCompleted && <div className="w-4 shrink-0" />}
          {!isCompleted && <div className="w-8 shrink-0" />}
          <div className="w-[80px] shrink-0">Sample</div>
          <div className="w-[80px] shrink-0">Group</div>
          <div className="w-[70px] shrink-0">Priority</div>
          <div className="flex-1 min-w-[140px]">Peptide</div>
          <div className="w-[110px] shrink-0">Method</div>
          <div className="w-[120px] shrink-0">Instrument</div>
          <div className="w-[100px] shrink-0">Tech</div>
          <div className="w-[60px] shrink-0">Age</div>
          <div className="w-[80px] shrink-0 text-right">Actions</div>
        </div>
      )}

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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
              <div className="pb-4">
                {items.map(item => (
                  <SortableItemRow
                    key={item.id}
                    item={item}
                    isCompleted={isCompleted}
                    prepStartedItems={prepStartedItems}
                    otherWorksheets={otherWorksheets}
                    instruments={instruments}
                    onRemove={onRemove}
                    onReassign={onReassign}
                    onStartPrep={onStartPrep}
                    onUpdateItem={onUpdateItem}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </ScrollArea>
    </div>
  )
}

interface SortableItemRowProps {
  item: ItemType
  isCompleted: boolean
  prepStartedItems: Set<string>
  otherWorksheets: WorksheetListItem[]
  instruments: Instrument[]
  onRemove: (sampleUid: string, serviceGroupId: number) => void
  onReassign: (sampleUid: string, serviceGroupId: number, targetWorksheetId: number) => void
  onStartPrep: (item: { sampleId: string; serviceGroupId: number | null; groupName: string; peptideId: number | null }) => void
  onUpdateItem: (itemId: number, data: { instrument_uid?: string }) => void
}

function SortableItemRow({
  item,
  isCompleted,
  prepStartedItems,
  otherWorksheets,
  instruments,
  onRemove,
  onReassign,
  onStartPrep,
  onUpdateItem,
}: SortableItemRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: isCompleted })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  const prepKey = `${item.sample_id}-${item.service_group_id}`
  const isPrepStarted = prepStartedItems.has(prepKey)
  const colorKey = (item.group_color as ServiceGroupColor) in SERVICE_GROUP_COLORS
    ? (item.group_color as ServiceGroupColor)
    : 'zinc'
  const groupColorClass = SERVICE_GROUP_COLORS[colorKey]
  const peptideNames = getPeptideNames(item.analyses)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/item flex items-start gap-2 px-4 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/40"
    >
      {/* Drag handle */}
      {!isCompleted && (
        <button
          className="h-6 w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground touch-none mt-0.5"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Remove button */}
      {!isCompleted && (
        <button
          className="h-6 w-8 shrink-0 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-destructive rounded mt-0.5"
          aria-label={`Remove ${item.sample_id} from worksheet`}
          onClick={() => onRemove(item.sample_uid, item.service_group_id ?? 0)}
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {/* Sample ID */}
      <div className="w-[80px] shrink-0">
        <span className="font-mono text-xs font-medium tabular-nums">{item.sample_id}</span>
      </div>

      {/* Service group badge */}
      <div className="w-[80px] shrink-0">
        <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${groupColorClass}`}>
          {item.group_name}
        </span>
      </div>

      {/* Priority */}
      <div className="w-[70px] shrink-0">
        <PriorityBadge priority={item.priority as InboxPriority} />
      </div>

      {/* Peptide — compact list of peptide names */}
      <div className="flex-1 min-w-[140px]">
        {peptideNames.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="text-xs font-medium">
            {peptideNames.join(', ')}
          </span>
        )}
      </div>

      {/* Method — only shown when instrument is set (computed from instrument+peptide) */}
      <div className="w-[110px] shrink-0">
        <span className="text-xs text-muted-foreground font-mono truncate block">
          {item.method_name ?? '—'}
        </span>
      </div>

      {/* Instrument */}
      <div className="w-[120px] shrink-0">
        {isCompleted ? (
          <span className="text-[10px] text-muted-foreground font-mono truncate block">
            {instruments.find(i => i.senaite_uid === item.instrument_uid)?.name ?? item.instrument_uid ?? '—'}
          </span>
        ) : (
          <Select
            value={item.instrument_uid ?? ''}
            onValueChange={value => onUpdateItem(item.id, { instrument_uid: value })}
          >
            <SelectTrigger
              size="sm"
              className="h-6 text-[10px] border-transparent bg-transparent shadow-none hover:border-border"
            >
              <SelectValue placeholder="Instrument…" />
            </SelectTrigger>
            <SelectContent>
              {instruments.map(inst => (
                <SelectItem key={inst.senaite_uid ?? inst.id} value={inst.senaite_uid ?? String(inst.id)}>
                  {inst.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Tech */}
      <div className="w-[100px] shrink-0">
        <span
          className="text-[10px] text-muted-foreground truncate block"
          title={item.assigned_analyst_email ?? 'Unassigned'}
        >
          {item.assigned_analyst_email ?? '—'}
        </span>
      </div>

      {/* Age */}
      <div className="w-[60px] shrink-0">
        <AgingTimer dateReceived={item.date_received ?? item.added_at} compact />
      </div>

      {/* Actions */}
      <div className="w-[80px] shrink-0 flex items-center justify-end gap-1">
        {!isCompleted && (
          <ReassignButton
            item={item}
            otherWorksheets={otherWorksheets}
            onReassign={onReassign}
          />
        )}
        {!isCompleted && (
          isPrepStarted ? (
            <span className="text-[10px] text-muted-foreground/60 italic">Prep</span>
          ) : (
            <button
              className="h-6 px-2 text-[10px] rounded-md border bg-secondary text-secondary-foreground opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
              onClick={() =>
                onStartPrep({
                  sampleId: item.sample_id,
                  serviceGroupId: item.service_group_id,
                  groupName: item.group_name,
                  peptideId: item.peptide_id,
                })
              }
            >
              Start Prep
            </button>
          )
        )}
      </div>
    </div>
  )
}

interface ReassignButtonProps {
  item: ItemType
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
          className="h-6 w-6 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-foreground rounded disabled:opacity-30 disabled:cursor-not-allowed"
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
