import type { StatusLogEntry, RequestStatus } from '@/types/peptide-request'

interface StatusTimelineProps {
  entries: StatusLogEntry[]
  currentStatus: RequestStatus
}

export function StatusTimeline({ entries, currentStatus }: StatusTimelineProps) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No history. Current status: {currentStatus.replace(/_/g, ' ')}
      </p>
    )
  }
  return (
    <ol className="space-y-2">
      {entries.map(e => (
        <li key={e.id} className="border-l-2 pl-3 py-1">
          <div className="font-medium text-sm">
            {e.from_status ? `${e.from_status} → ${e.to_status}` : e.to_status}
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(e.created_at).toLocaleString()} · {e.source}
            {e.actor_clickup_user_id &&
              ` · actor: ${e.actor_clickup_user_id}`}
          </div>
          {e.note && <div className="text-sm mt-1">{e.note}</div>}
        </li>
      ))}
    </ol>
  )
}
