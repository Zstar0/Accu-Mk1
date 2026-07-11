import { useState, type DragEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { FlagType } from '@/lib/flags-api'
import {
  addTypeScope,
  removeTypeScope,
  clearTypeScope,
  isGlobalScope,
  isInBucket,
} from '@/components/flags/flag-type-buckets'

/** Custom MIME so the board only accepts its own chips (not arbitrary text). */
const DND_MIME = 'application/x-flag-type'

export interface Bucket {
  slug: string
  label: string
}

/**
 * Type-bucket board (slice 7 headline UI). Each flag type's scope
 * (`entity_types`) is expressed as bucket membership: an "All items" bucket for
 * globals, then one bucket per code entity + active item kind. Drag a chip from
 * the palette (or another bucket) into a bucket to scope the type to it; drop on
 * "All items" to widen it back to global (confirmed); the ✕ on a bucket chip
 * removes that one slug. A type can sit in multiple buckets. All the set logic
 * is in flag-type-buckets.ts; this component is just the DnD + click surface.
 * The ✕ makes the board fully usable without dragging (a11y + touch).
 */
export function TypeBucketBoard({
  types,
  buckets,
  readOnly,
  onScope,
}: {
  types: FlagType[]
  buckets: Bucket[]
  readOnly: boolean
  /** Persist a type's new scope (PUT /flags/types/{id} { entity_types }). */
  onScope: (typeId: number, entityTypes: string[]) => void
}) {
  // A restricted type dropped on "All items" confirms before widening.
  const [pendingClear, setPendingClear] = useState<FlagType | null>(null)

  const typeById = (id: number) => types.find(t => t.id === id)
  const readDragged = (e: DragEvent) => typeById(Number(e.dataTransfer.getData(DND_MIME)))

  const allowDrop = (e: DragEvent) => {
    if (!readOnly) e.preventDefault()
  }

  const dropInBucket = (slug: string) => (e: DragEvent) => {
    e.preventDefault()
    if (readOnly) return
    const t = readDragged(e)
    if (t) onScope(t.id, addTypeScope(t.entity_types, slug))
  }

  const dropOnAllItems = (e: DragEvent) => {
    e.preventDefault()
    if (readOnly) return
    const t = readDragged(e)
    if (!t || isGlobalScope(t.entity_types)) return
    setPendingClear(t) // widening is a big change — confirm first
  }

  const globalTypes = types.filter(t => isGlobalScope(t.entity_types))

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-3">
        <BucketColumn
          label="All items"
          hint="Types here can be raised on anything"
          onDragOver={allowDrop}
          onDrop={dropOnAllItems}
        >
          {globalTypes.map(t => (
            <TypeChip key={t.id} type={t} readOnly={readOnly} />
          ))}
          {globalTypes.length === 0 && <EmptyHint />}
        </BucketColumn>

        <div className="grid gap-3 sm:grid-cols-2">
          {buckets.map(b => {
            const inBucket = types.filter(t => isInBucket(t.entity_types, b.slug))
            return (
              <BucketColumn
                key={b.slug}
                label={b.label}
                onDragOver={allowDrop}
                onDrop={dropInBucket(b.slug)}
              >
                {inBucket.map(t => (
                  <TypeChip
                    key={t.id}
                    type={t}
                    readOnly={readOnly}
                    removeFrom={b.label}
                    onRemove={() =>
                      onScope(t.id, removeTypeScope(t.entity_types, b.slug))
                    }
                  />
                ))}
                {inBucket.length === 0 && <EmptyHint />}
              </BucketColumn>
            )
          })}
        </div>
      </div>

      <aside className="w-full shrink-0 rounded-lg border bg-muted/30 p-3 lg:w-56">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          All types
        </p>
        <div className="flex flex-wrap gap-1.5">
          {types.map(t => (
            <TypeChip
              key={t.id}
              type={t}
              readOnly={readOnly}
              bucketCount={t.entity_types.length}
            />
          ))}
        </div>
      </aside>

      <AlertDialog
        open={pendingClear != null}
        onOpenChange={open => {
          if (!open) setPendingClear(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Make “{pendingClear?.label}” available everywhere?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This clears its item restrictions so it can be raised on any item.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingClear) onScope(pendingClear.id, clearTypeScope())
                setPendingClear(null)
              }}
            >
              Make global
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function BucketColumn({
  label,
  hint,
  onDragOver,
  onDrop,
  children,
}: {
  label: string
  hint?: string
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  children: React.ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={label}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="rounded-lg border border-dashed p-3"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function EmptyHint() {
  return (
    <span className="text-[11px] italic text-muted-foreground">
      Drop a type here
    </span>
  )
}

function TypeChip({
  type,
  readOnly,
  removeFrom,
  onRemove,
  bucketCount,
}: {
  type: FlagType
  readOnly: boolean
  /** Bucket label — present only for a chip inside a specific bucket. */
  removeFrom?: string
  onRemove?: () => void
  /** Palette-only: number of specific buckets the type sits in. */
  bucketCount?: number
}) {
  return (
    <span
      draggable={!readOnly}
      onDragStart={e => {
        e.dataTransfer.setData(DND_MIME, String(type.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
        !type.is_active && 'opacity-50',
        !readOnly && 'cursor-grab active:cursor-grabbing'
      )}
      style={{ borderColor: type.color }}
      title={type.is_active ? undefined : 'Inactive'}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: type.color }}
        aria-hidden
      />
      <span className="truncate">{type.label}</span>
      {bucketCount != null && bucketCount > 0 && (
        <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[9px]">
          {bucketCount}
        </Badge>
      )}
      {onRemove && !readOnly && (
        <button
          type="button"
          aria-label={`Remove ${type.label} from ${removeFrom}`}
          onClick={onRemove}
          className="ml-0.5 rounded-full p-0.5 hover:bg-muted"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

export default TypeBucketBoard
