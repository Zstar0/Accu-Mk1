import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { SampleIdBadge } from '@/components/samples/SampleIdBadge'
import { SERVICE_GROUP_COLORS } from '@/lib/service-group-colors'
import { getInboxSamples } from '@/lib/api'
import { useEffectiveReadSource } from '@/lib/read-source'
import type { WorksheetListItem, InboxPriority } from '@/lib/api'

interface AddSamplesModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worksheetId: number
  existingItems: WorksheetListItem['items']
  onAdd: (data: { sample_uid: string; sample_id: string; service_group_id: number; analyses?: { title: string; keyword?: string | null; peptide_name?: string | null; method?: string | null }[] }) => void
}

interface FlatInboxItem {
  sample_uid: string
  sample_id: string
  priority: InboxPriority
  service_group_id: number
  group_name: string
  group_color: string
  analyses: { title: string; keyword: string | null; peptide_name: string | null; method: string | null }[]
}

function getColorClass(groupColor: string): string {
  const key = groupColor as keyof typeof SERVICE_GROUP_COLORS
  return SERVICE_GROUP_COLORS[key] ?? SERVICE_GROUP_COLORS.zinc
}

export function AddSamplesModal({
  open,
  onOpenChange,
  existingItems,
  onAdd,
}: AddSamplesModalProps) {
  // Same read-source as the inbox page — the modal is the inbox in disguise.
  const { effective: readSource } = useEffectiveReadSource('worksheets_inbox')
  const { data: inboxData } = useQuery({
    queryKey: ['inbox-samples', { hideTestOrders: true, addSamplesModal: true, source: readSource }],
    queryFn: () => getInboxSamples({ hideTestOrders: true, source: readSource }),
    enabled: open,
  })

  // Regroup the vial-flat shape into per-(vial, service_group) rows so the
  // modal keeps its today-shape rendering. The new inbox returns one item per
  // vial with a flat analyses[]; each analysis carries its group_id/name/color
  // inline. A vial whose analyses span multiple groups produces one modal row
  // per group (today only the rare HPLC-subgroup case; practically one).
  const flatItems: FlatInboxItem[] = []
  for (const vial of inboxData?.items ?? []) {
    const byGroup = new Map<number, { name: string; color: string; analyses: typeof vial.analyses }>()
    for (const a of vial.analyses) {
      const slot = byGroup.get(a.group_id)
      if (slot) {
        slot.analyses.push(a)
      } else {
        byGroup.set(a.group_id, {
          name: a.group_name,
          color: a.group_color,
          analyses: [a],
        })
      }
    }
    for (const [groupId, slot] of byGroup) {
      flatItems.push({
        sample_uid: vial.uid,
        sample_id: vial.sample_id,
        priority: vial.priority,
        service_group_id: groupId,
        group_name: slot.name,
        group_color: slot.color,
        analyses: slot.analyses.map(a => ({
          title: a.title,
          keyword: a.keyword,
          peptide_name: a.peptide_name,
          method: a.method,
        })),
      })
    }
  }

  // Filter out items already in this worksheet
  const existingSet = new Set(existingItems.map(i => `${i.sample_uid}-${i.service_group_id}`))
  const availableItems = flatItems.filter(
    item => !existingSet.has(`${item.sample_uid}-${item.service_group_id}`)
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[70vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Samples to Worksheet</DialogTitle>
          <DialogDescription>{availableItems.length} sample(s) available</DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1">
          {availableItems.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No unassigned samples in the inbox.
            </p>
          ) : (
            <div className="space-y-1 py-1">
              {availableItems.map(item => (
                <AddSampleCard
                  key={`${item.sample_uid}-${item.service_group_id}`}
                  item={item}
                  onAdd={onAdd}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

interface AddSampleCardProps {
  item: FlatInboxItem
  onAdd: (data: { sample_uid: string; sample_id: string; service_group_id: number; analyses?: { title: string; keyword?: string | null; peptide_name?: string | null; method?: string | null }[] }) => void
}

function AddSampleCard({ item, onAdd }: AddSampleCardProps) {
  const [added, setAdded] = useState(false)
  const colorClass = getColorClass(item.group_color)

  function handleAdd() {
    if (added) return
    onAdd({
      sample_uid: item.sample_uid,
      sample_id: item.sample_id,
      service_group_id: item.service_group_id,
      analyses: item.analyses,
    })
    setAdded(true)
  }

  return (
    <button
      onClick={handleAdd}
      disabled={added}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-muted/60 transition-colors disabled:opacity-60 disabled:cursor-default relative"
    >
      {added && (
        <span className="absolute inset-0 flex items-center justify-center bg-background/80 rounded-md">
          <Check className="h-4 w-4 text-emerald-600" />
        </span>
      )}
      <div className="flex-shrink-0"><SampleIdBadge id={item.sample_id} /></div>
      <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold flex-shrink-0 ${colorClass}`}>
        {item.group_name}
      </span>
      <PriorityBadge priority={item.priority} />
    </button>
  )
}

export default AddSamplesModal
