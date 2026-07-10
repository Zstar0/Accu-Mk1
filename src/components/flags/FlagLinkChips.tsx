/**
 * Related-links row for the flag thread: navigational entity references and
 * related-flag chips, each with a remove ✕, plus two typeahead add-pickers.
 * Links are navigation only — NOT counted in rollups/indicators (spec §2).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { flagKeys } from '@/hooks/use-flags'
import {
  removeEntityLink,
  removeFlagLink,
  type FlagDetailResponse,
} from '@/lib/flags-api'
import { entityMeta, navigateForFlag } from '@/components/flags/flag-entity'
import {
  EntityLinkPicker,
  FlagLinkPicker,
} from '@/components/flags/flag-link-pickers'
import { useUIStore } from '@/store/ui-store'

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5">
      {children}
    </span>
  )
}

export function FlagLinkChips({
  flagId,
  currentFlag,
}: {
  flagId: number
  currentFlag: FlagDetailResponse
}) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: flagKeys.all })
  const rmEnt = useMutation({
    mutationFn: (linkId: number) => removeEntityLink(flagId, linkId),
    onSuccess: invalidate,
  })
  const rmFl = useMutation({
    mutationFn: (linkId: number) => removeFlagLink(flagId, linkId),
    onSuccess: invalidate,
  })

  const entityLinks = currentFlag.entity_links ?? []
  const flagLinks = currentFlag.flag_links ?? []

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Related:</span>
        {entityLinks.map(l => (
          <Chip key={l.id}>
            <button
              type="button"
              className="hover:underline"
              onClick={() => navigateForFlag(l)}
            >
              {l.entity?.label ??
                `${entityMeta(l.entity_type).label} ${l.entity_id}`}
            </button>
            <button
              type="button"
              aria-label="Remove linked item"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => rmEnt.mutate(l.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </Chip>
        ))}
        <EntityLinkPicker flagId={flagId} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Related flags:</span>
        {flagLinks.map(l => (
          <Chip key={l.id}>
            <button
              type="button"
              className="hover:underline"
              onClick={() => useUIStore.getState().openFlagThread(l.flag_id)}
            >
              #{l.flag_id} {l.title}
            </button>
            <button
              type="button"
              aria-label="Remove linked flag"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => rmFl.mutate(l.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </Chip>
        ))}
        <FlagLinkPicker flagId={flagId} />
      </div>
    </div>
  )
}

export default FlagLinkChips
