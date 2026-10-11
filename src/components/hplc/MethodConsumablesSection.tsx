import { useEffect, useState } from 'react'
import { Loader2, Lock, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  getMethodConsumables,
  listConsumableKinds,
  listConsumables,
  putMethodConsumables,
  type ConsumableKind,
  type ConsumableType,
  type HplcMethod,
  type MethodConsumableLink,
} from '@/lib/api'

interface LinkWire {
  consumable_type_id: number
  is_default: boolean
}

const wire = (l: MethodConsumableLink): LinkWire => ({
  consumable_type_id: l.consumable_type_id,
  is_default: l.is_default,
})

/** "0.05 EU/mL": a type's numbers as its kind labels them. */
function specText(
  kind: ConsumableKind,
  specs: Record<string, number> | undefined
): string {
  if (!specs) return ''
  return kind.specs
    .map(s => {
      const v = specs[s.key]
      return v == null ? '' : `${v}${s.unit ? ` ${s.unit}` : ''}`
    })
    .filter(Boolean)
    .join(', ')
}

/**
 * The consumable types a method allows, per kind, with one default each
 * (spec 2026-10-10 3.3, 6.5). Editable on a draft only: an issued method's
 * list changes through a new revision, which copies it with its defaults.
 * Same replace-set idiom as Covered Services; names come from the catalog.
 * A revision also copies links to types retired since, which the server
 * refuses (400 "is retired"): they are flagged and left out of every save.
 */
export function MethodConsumablesSection({
  method,
  onUpdated,
}: {
  method: HplcMethod
  onUpdated: () => void
}) {
  const locked = method.status !== 'draft'
  const [links, setLinks] = useState<MethodConsumableLink[]>([])
  const [catalog, setCatalog] = useState<ConsumableType[]>([])
  const [kinds, setKinds] = useState<ConsumableKind[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMethodConsumables(method.id).then(setLinks).catch(console.error)
    listConsumables().then(setCatalog).catch(console.error)
    listConsumableKinds().then(setKinds).catch(console.error)
  }, [method.id])

  // The server refuses a referenced draft too (409): its reason shows here.
  async function save(next: LinkWire[]) {
    setBusy(true)
    try {
      setLinks(await putMethodConsumables(method.id, next))
      setError(null)
      onUpdated()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update consumables'
      )
    } finally {
      setBusy(false)
    }
  }

  const byId = new Map(catalog.map(c => [c.id, c]))
  const retired = (l: MethodConsumableLink) =>
    (l.active ?? byId.get(l.consumable_type_id)?.active) === false
  // Every save starts from the links the server still accepts.
  const kept = links.filter(l => !retired(l))

  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-muted-foreground">
          Consumables ({links.length})
        </h4>
        {busy && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {locked && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            Changes need a new revision
          </span>
        )}
      </div>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {!locked && kept.length < links.length && (
        <p className="mb-3 text-xs text-muted-foreground">
          Retired types are dropped on the next save.
        </p>
      )}
      {locked && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No consumables linked.</p>
      ) : (
        <div className="space-y-3">
          {kinds.map(kind => {
            const mine = links.filter(l => l.kind === kind.key)
            const addable = catalog.filter(
              c =>
                c.kind === kind.key &&
                c.active &&
                !links.some(l => l.consumable_type_id === c.id)
            )
            if (mine.length === 0 && (locked || addable.length === 0))
              return null
            return (
              <div key={kind.key} className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  {kind.label}
                </div>
                {mine.map(link => {
                  const c = byId.get(link.consumable_type_id)
                  const name =
                    link.name ?? c?.name ?? `#${link.consumable_type_id}`
                  const isRetired = retired(link)
                  return (
                    <div
                      key={link.consumable_type_id}
                      className="flex items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5 text-sm"
                    >
                      <span className="font-medium">{name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {specText(kind, link.specs ?? c?.specs)}
                      </span>
                      {isRetired && (
                        <Badge variant="outline" className="text-xs">
                          Retired
                        </Badge>
                      )}
                      {locked ? (
                        link.is_default && (
                          <Badge
                            variant="secondary"
                            className="ml-auto text-xs"
                          >
                            Default
                          </Badge>
                        )
                      ) : (
                        <div className="ml-auto flex items-center gap-2">
                          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              type="radio"
                              name={`default-${kind.key}`}
                              aria-label={`Default: ${name}`}
                              checked={link.is_default}
                              disabled={busy || isRetired}
                              onChange={() =>
                                save(
                                  kept.map(l => ({
                                    consumable_type_id: l.consumable_type_id,
                                    is_default:
                                      l.kind === kind.key
                                        ? l.consumable_type_id ===
                                          link.consumable_type_id
                                        : l.is_default,
                                  }))
                                )
                              }
                            />
                            Default
                          </label>
                          <button
                            type="button"
                            aria-label={`Remove ${name}`}
                            title={`Remove ${name}`}
                            disabled={busy}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                            onClick={() =>
                              save(
                                kept
                                  .filter(
                                    l =>
                                      l.consumable_type_id !==
                                      link.consumable_type_id
                                  )
                                  .map(wire)
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {!locked && addable.length > 0 && (
                  <select
                    aria-label={`Add ${kind.label}`}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    defaultValue=""
                    disabled={busy}
                    onChange={e => {
                      const id = Number(e.target.value)
                      e.target.value = ''
                      // The first type of a kind becomes its default.
                      if (id)
                        save([
                          ...kept.map(wire),
                          {
                            consumable_type_id: id,
                            is_default: !kept.some(l => l.kind === kind.key),
                          },
                        ])
                    }}
                  >
                    <option value="" disabled>
                      Add {kind.label.toLowerCase()}...
                    </option>
                    {addable.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {specText(kind, c.specs)
                          ? ` (${specText(kind, c.specs)})`
                          : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default MethodConsumablesSection
