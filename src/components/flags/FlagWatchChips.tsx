/**
 * State-change watches on a flag's anchor entity, rendered in the thread.
 * Armed watches show as cancellable "⏱ waiting: PB-0102 → received" chips; a
 * small inline form arms a new comment-on-fire watch (posts a comment to THIS
 * flag when the entity reaches the typed state). Renders nothing when the
 * anchor entity type has no backend `state` seam (spec §9 — unwatchable).
 */
import { useState } from 'react'
import { Clock, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useFlagWatches, useArmWatch, useCancelWatch } from '@/hooks/use-flags'
import {
  WATCHABLE_ENTITY_TYPES,
  entityLabel,
} from '@/components/flags/flag-entity'

export function FlagWatchChips({
  flagId,
  entityType,
  entityId,
}: {
  flagId: number
  entityType: string | null
  entityId: string | null
}) {
  const watchable = !!entityType && WATCHABLE_ENTITY_TYPES.has(entityType)
  const { data: watches } = useFlagWatches(watchable ? flagId : null)
  const arm = useArmWatch(flagId)
  const cancel = useCancelWatch(flagId)
  const [adding, setAdding] = useState(false)
  const [equals, setEquals] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!watchable || !entityType || !entityId) return null
  const label = entityLabel(entityType, entityId)

  const submit = () => {
    const value = equals.trim()
    if (!value) return
    setError(null)
    arm.mutate(
      {
        entity_type: entityType,
        entity_id: entityId,
        condition: { field: 'state', equals: value },
        action: {
          kind: 'comment',
          flag_id: flagId,
          body: `⏱ ${label} reached "${value}".`,
        },
        watch_flag_id: flagId,
      },
      {
        onSuccess: () => {
          setEquals('')
          setAdding(false)
        },
        onError: e =>
          setError(e instanceof Error ? e.message : 'Could not arm watch'),
      }
    )
  }

  const armed = watches ?? []

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {armed.map(w => (
        <span
          key={w.id}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5"
        >
          <Clock className="h-3 w-3" />
          waiting: {label} → {w.condition.equals}
          <button
            type="button"
            aria-label="Cancel watch"
            className="hover:text-destructive"
            onClick={() => cancel.mutate(w.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <Input
            autoFocus
            value={equals}
            onChange={e => setEquals(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submit()
            }}
            placeholder="received"
            className="h-6 w-28 text-xs"
          />
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={arm.isPending}
            onClick={submit}
          >
            Arm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setAdding(false)
              setError(null)
            }}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" /> Watch for state…
        </Button>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  )
}
