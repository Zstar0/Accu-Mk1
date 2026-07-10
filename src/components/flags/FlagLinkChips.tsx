/**
 * Related-links row for the flag thread: navigational entity references and
 * related-flag chips, each with a remove ✕, plus two small add-pickers.
 * Links are navigation only — NOT counted in rollups/indicators (spec §2).
 */
import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { flagKeys } from '@/hooks/use-flags'
import {
  addEntityLink,
  removeEntityLink,
  addFlagLink,
  removeFlagLink,
  type FlagDetailResponse,
} from '@/lib/flags-api'
import { entityMeta, navigateForFlag } from '@/components/flags/flag-entity'
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
  const [addingEntity, setAddingEntity] = useState(false)
  const [addingFlag, setAddingFlag] = useState(false)
  const [etype, setEtype] = useState('sub_sample')
  const [eid, setEid] = useState('')
  const [otherFlag, setOtherFlag] = useState('')

  const addEnt = useMutation({
    mutationFn: () => addEntityLink(flagId, etype, eid.trim()),
    onSuccess: () => {
      invalidate()
      setAddingEntity(false)
      setEid('')
    },
  })
  const rmEnt = useMutation({
    mutationFn: (linkId: number) => removeEntityLink(flagId, linkId),
    onSuccess: invalidate,
  })
  const addFl = useMutation({
    mutationFn: () => addFlagLink(flagId, Number(otherFlag)),
    onSuccess: () => {
      invalidate()
      setAddingFlag(false)
      setOtherFlag('')
    },
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
        {addingEntity ? (
          <span className="inline-flex items-center gap-1">
            <Select value={etype} onValueChange={setEtype}>
              <SelectTrigger size="sm" className="h-6 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sub_sample">Vial</SelectItem>
                <SelectItem value="sample">Sample</SelectItem>
                <SelectItem value="worksheet">Worksheet</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={eid}
              onChange={e => setEid(e.target.value)}
              placeholder="id"
              aria-label="Related item id"
              className="h-6 w-20 text-xs"
            />
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={!eid.trim() || addEnt.isPending}
              onClick={() => addEnt.mutate()}
            >
              Add
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setAddingEntity(true)}
          >
            <Plus className="h-3 w-3" /> item
          </Button>
        )}
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
        {addingFlag ? (
          <span className="inline-flex items-center gap-1">
            <Input
              value={otherFlag}
              onChange={e => setOtherFlag(e.target.value)}
              placeholder="Flag #"
              aria-label="Related flag id"
              className="h-6 w-20 text-xs"
              inputMode="numeric"
            />
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={!otherFlag.trim() || addFl.isPending}
              onClick={() => addFl.mutate()}
            >
              Add
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setAddingFlag(true)}
          >
            <Plus className="h-3 w-3" /> flag
          </Button>
        )}
      </div>
    </div>
  )
}

export default FlagLinkChips
