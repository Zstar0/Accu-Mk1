import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { InboxPriority } from '@/lib/api'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePriorityMutation } from '@/hooks/use-inbox-samples'
import { useSamplePriorities } from '@/services/sample-priorities'

const PRIORITIES: InboxPriority[] = ['normal', 'high', 'expedited']

/**
 * Sample-page priority control (2026-09-10). Priority used to be settable
 * only from the Worksheets Inbox, which lists received samples, so a sample
 * could not be expedited before receipt. This reads and writes the same
 * `sample_priorities` row (keyed by the sample's uid) the inbox, the SLA
 * header, and the reports use, and works in every lifecycle state — the uid
 * exists from registration onward. Renders a disabled badge while the row
 * has no uid yet (SENAITE-free registration before reconcile).
 */
export function SamplePriorityControl({
  sampleUid,
}: {
  sampleUid: string | null | undefined
}) {
  const uids = sampleUid ? [sampleUid] : []
  const lookup = useSamplePriorities(uids)
  const mutation = usePriorityMutation()
  const queryClient = useQueryClient()

  const current: InboxPriority =
    (sampleUid &&
      lookup.data?.find(row => row.sample_uid === sampleUid)?.priority) ||
    'normal'

  if (!sampleUid) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex opacity-60"
            data-testid="sample-priority-unavailable"
          >
            <PriorityBadge priority="normal" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Priority becomes editable once the sample has its LIMS id.
        </TooltipContent>
      </Tooltip>
    )
  }

  const onChange = (value: string) => {
    const priority = value as InboxPriority
    if (priority === current) return
    mutation.mutate(
      { sampleUid, priority },
      {
        onSuccess: () => {
          // The mutation hook refreshes the inbox; the sample page, SLA
          // header and reports read the lookup cache, so refresh that too.
          void queryClient.invalidateQueries({
            queryKey: ['sample-priorities'],
          })
        },
        onError: err => {
          toast.error(
            `Could not set priority: ${err instanceof Error ? err.message : String(err)}`
          )
        },
      }
    )
  }

  return (
    <Select
      value={current}
      onValueChange={onChange}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        size="sm"
        aria-label="Sample priority"
        data-testid="sample-priority-select"
        className="h-6 w-auto min-w-[90px] border-transparent bg-transparent shadow-none text-xs hover:border-border"
      >
        <SelectValue>
          <PriorityBadge priority={current} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map(p => (
          <SelectItem key={p} value={p}>
            <PriorityBadge priority={p} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
