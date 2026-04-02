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
import { SERVICE_GROUP_COLORS } from '@/lib/service-group-colors'
import { getInboxSamples } from '@/lib/api'
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
  const { data: inboxData } = useQuery({
    queryKey: ['inbox-samples', { hideTestOrders: true }],
    queryFn: () => getInboxSamples(true),
    enabled: open,
  })

  // Flatten inbox samples into per-group rows
  const flatItems: FlatInboxItem[] = []
  for (const sample of inboxData?.items ?? []) {
    for (const group of sample.analyses_by_group) {
      flatItems.push({
        sample_uid: sample.uid,
        sample_id: sample.id,
        priority: sample.priority,
        service_group_id: group.group_id,
        group_name: group.group_name,
        group_color: group.group_color,
        analyses: group.analyses.map(a => ({ title: a.title, keyword: a.keyword, peptide_name: a.peptide_name, method: a.method })),
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
      <span className="font-mono text-xs tabular-nums flex-shrink-0">{item.sample_id}</span>
      <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold flex-shrink-0 ${colorClass}`}>
        {item.group_name}
      </span>
      <PriorityBadge priority={item.priority} />
    </button>
  )
}

export default AddSamplesModal
