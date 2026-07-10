/**
 * "Watch for state change" affordance on an entity page. Arms a STANDALONE
 * watch (no flag yet) that mints a Task flag when the entity reaches the typed
 * state. Only rendered for entity types with a backend `state` seam. Free-text
 * state value — the seam's domain is host-defined (spec §9).
 */
import { useState } from 'react'
import { Clock } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useArmWatch } from '@/hooks/use-flags'
import { useFlagUsers } from '@/components/flags/flag-users'
import { displayName } from '@/lib/user-display'

export function WatchStateButton({
  entityType,
  entityId,
  targetLabel,
}: {
  entityType: string
  entityId: string
  targetLabel: string
}) {
  const arm = useArmWatch()
  const users = useFlagUsers()
  const [open, setOpen] = useState(false)
  const [equals, setEquals] = useState('')
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState<string>('none')
  const [error, setError] = useState<string | null>(null)

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
          kind: 'create_flag',
          type: 'task',
          title: title.trim() || `${targetLabel} reached ${value}`,
          assignee_id: assignee === 'none' ? null : Number(assignee),
        },
      },
      {
        onSuccess: () => {
          setOpen(false)
          setEquals('')
          setTitle('')
          setAssignee('none')
        },
        onError: e =>
          setError(e instanceof Error ? e.message : 'Could not arm watch'),
      }
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Watch for state change"
          title="Watch for state change"
          className="gap-1.5 text-muted-foreground"
        >
          <Clock className="h-3.5 w-3.5" /> Watch
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2">
        <p className="text-xs font-semibold">
          Watch {targetLabel} for a state change
        </p>
        <div className="space-y-1">
          <Label htmlFor="watch-state" className="text-xs">
            When state equals
          </Label>
          <Input
            id="watch-state"
            value={equals}
            placeholder="received"
            onChange={e => setEquals(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="watch-title" className="text-xs">
            Create task titled (optional)
          </Label>
          <Input
            id="watch-title"
            value={title}
            placeholder={`${targetLabel} reached ${equals || '…'}`}
            onChange={e => setTitle(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Assign to (optional)</Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Unassigned</SelectItem>
              {[...users.values()]
                .sort((a, b) => displayName(a).localeCompare(displayName(b)))
                .map(u => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {displayName(u)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={arm.isPending || !equals.trim()}
            onClick={submit}
          >
            Arm
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
