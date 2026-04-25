import type { PeptideRequest } from '@/types/peptide-request'
import { Badge } from '@/components/ui/badge'

export function PeptideRequestRow({ request }: { request: PeptideRequest }) {
  return (
    <div className="flex items-center justify-between py-3 hover:bg-muted/50">
      <div>
        <div className="flex items-center gap-2 font-medium">
          <span>{request.compound_name}</span>
          {request.source === 'manual' && (
            <Badge
              variant="secondary"
              className="text-xs font-normal text-muted-foreground"
              title="Created manually in ClickUp by a lab tech"
            >
              Manual
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {request.compound_kind} · {request.vendor_producer}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {request.retired_at !== null && (
          <Badge
            variant="secondary"
            className="text-xs font-normal text-muted-foreground"
            title="The corresponding ClickUp task was deleted — row kept for history"
          >
            Retired
          </Badge>
        )}
        <Badge variant="outline">{request.status.replace(/_/g, ' ')}</Badge>
        <span className="text-sm text-muted-foreground">
          {new Date(request.created_at).toLocaleDateString()}
        </span>
      </div>
    </div>
  )
}
