import { useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { notifications } from '@/lib/notifications'
import { useCreateFlag } from '@/hooks/use-flags'
import { useFlagTypes } from '@/services/flag-types'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'

/**
 * Raise-flag compose. Prop-driven so any entity surface can drop it in with a
 * preset target (`entityType`/`entityId` locked), or render generically (the
 * flyout header) with manual entity fields.
 *
 * The success toast + fly-home are NOT fired here — the create triggers a
 * `raised` SSE event that the app-scope stream glue turns into the toast / glow
 * / badge bump (one code path for my raises and others' relevant raises alike).
 *
 * Deferred: the "Undo" grace window (toast-animation.html) needs a delete-flag
 * endpoint, which Plan 1 does not provide — noted, not implemented.
 */
/** One pickable target for the order-scope create flow. */
export interface FlagCandidate {
  entityType: string
  entityId: string
  label: string
}

export function RaiseFlagButton({
  entityType,
  entityId,
  candidates,
  defaultAssigneeId = null,
  variant = 'default',
  trigger,
}: {
  entityType?: string
  entityId?: string
  /** Order scope (Plan 6): the samples this order spans. With >1 the compose
   *  opens on a "Which sample?" select; with exactly one it's prefilled. Ignored
   *  when an explicit `entityType`/`entityId` is given. */
  candidates?: FlagCandidate[]
  defaultAssigneeId?: number | null
  variant?: 'default' | 'compact'
  /** Custom popover trigger (e.g. EntityFlagButton's outline affordance). When
   *  provided it replaces the built-in variant buttons. */
  trigger?: ReactNode
}) {
  const create = useCreateFlag()
  const users = useFlagUsers()
  const presetEntity = entityType != null && entityId != null
  const hasCandidates =
    !presetEntity && candidates != null && candidates.length > 0

  const [open, setOpen] = useState(false)
  const [type, setType] = useState<string>('blocker')
  const [title, setTitle] = useState('')
  const [assigneeId, setAssigneeId] = useState<number | null>(defaultAssigneeId)
  const [firstComment, setFirstComment] = useState('')
  const [entityTypeInput, setEntityTypeInput] = useState('sub_sample')
  const [entityIdInput, setEntityIdInput] = useState('')
  const [candidateId, setCandidateId] = useState<string>(
    candidates?.[0]?.entityId ?? ''
  )

  // The chosen candidate (order scope), defaulting to the first.
  const selectedCandidate = hasCandidates
    ? (candidates.find(c => c.entityId === candidateId) ?? candidates[0])
    : undefined

  const reset = () => {
    setType('blocker')
    setTitle('')
    setAssigneeId(defaultAssigneeId)
    setFirstComment('')
    setEntityIdInput('')
    setCandidateId(candidates?.[0]?.entityId ?? '')
  }

  const resolvedEntityType = presetEntity
    ? (entityType ?? '')
    : selectedCandidate
      ? selectedCandidate.entityType
      : entityTypeInput
  const resolvedEntityId = presetEntity
    ? (entityId ?? '')
    : selectedCandidate
      ? selectedCandidate.entityId
      : entityIdInput.trim()

  // Only types active AND allowed for this entity, ordered by sort_order
  // (the backend returns them ordered). Colors come from the row.
  const typesQuery = useFlagTypes({
    entity_type: resolvedEntityType || undefined,
    active_only: true,
  })
  const flagTypes = typesQuery.data ?? []
  // Keep the selection valid as the entity (and thus the allowed set) changes.
  const selectedType = flagTypes.some(t => t.slug === type)
    ? type
    : (flagTypes[0]?.slug ?? type)
  const selectedColor =
    flagTypes.find(t => t.slug === selectedType)?.color ??
    flagTypeDef(selectedType).color

  const canSubmit =
    title.trim().length > 0 && resolvedEntityId.length > 0 && !create.isPending

  const submit = () => {
    if (!canSubmit) return
    create.mutate(
      {
        entity_type: resolvedEntityType,
        entity_id: resolvedEntityId,
        type: selectedType,
        title: title.trim(),
        assignee_id: assigneeId,
        first_comment: firstComment.trim() || null,
      },
      {
        onSuccess: () => {
          setOpen(false)
          reset()
        },
        onError: err =>
          notifications.error(
            'Could not raise flag',
            err instanceof Error ? err.message : undefined
          ),
      }
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={o => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <PopoverTrigger asChild>
        {trigger ??
          (variant === 'compact' ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Raise a flag"
            >
              <Plus className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" /> Raise a flag
            </Button>
          ))}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <p className="text-sm font-semibold">Raise a flag</p>

        {hasCandidates && candidates.length > 1 && (
          <div className="space-y-1">
            <Label className="text-xs">Which sample?</Label>
            <Select
              value={selectedCandidate?.entityId}
              onValueChange={setCandidateId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map(c => (
                  <SelectItem key={c.entityId} value={c.entityId}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!presetEntity && !hasCandidates && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Entity type</Label>
              <Select
                value={entityTypeInput}
                onValueChange={setEntityTypeInput}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sub_sample">Vial</SelectItem>
                  <SelectItem value="sample">Sample</SelectItem>
                  <SelectItem value="worksheet">Worksheet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Entity id</Label>
              <Input
                value={entityIdInput}
                onChange={e => setEntityIdInput(e.target.value)}
                placeholder="e.g. 42"
                className="h-8 text-xs"
              />
            </div>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={selectedType} onValueChange={setType}>
            <SelectTrigger className="h-8 gap-1.5 text-xs">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: selectedColor }}
              />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {flagTypes.map(t => (
                <SelectItem key={t.slug} value={t.slug}>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: t.color }}
                    />
                    {t.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Title</Label>
          <Input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="What needs attention?"
            className="h-8 text-xs"
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Assignee (optional)</Label>
          <Select
            value={assigneeId == null ? 'unassigned' : String(assigneeId)}
            onValueChange={v =>
              setAssigneeId(v === 'unassigned' ? null : Number(v))
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {[...users.values()].map(u => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {nameForUser(users, u.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">First comment (optional)</Label>
          <Textarea
            value={firstComment}
            onChange={e => setFirstComment(e.target.value)}
            placeholder="Add context…"
            className="min-h-16 text-xs"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            Raise flag
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default RaiseFlagButton
