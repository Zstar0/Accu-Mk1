import type { PeptideRequest } from '@/types/peptide-request'
import { Badge } from '@/components/ui/badge'

export function PeptideRequestRow({ request }: { request: PeptideRequest }) {
  return (
    <div className="flex items-center justify-between py-3 hover:bg-muted/50">
      <div>
        <div className="font-medium">{request.compound_name}</div>
        <div className="text-sm text-muted-foreground">
          {request.compound_kind} · {request.vendor_producer}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="outline">{request.status.replace(/_/g, ' ')}</Badge>
        <span className="text-sm text-muted-foreground">
          {new Date(request.created_at).toLocaleDateString()}
        </span>
      </div>
    </div>
  )
}
