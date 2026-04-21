import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  useApplySync,
  useSyncDiff,
  type FieldDriftResolution,
  type SyncApplyRequest,
  type SyncApplyResult,
  type SyncDiff,
} from '@/hooks/peptide-requests'

type Selections = {
  materialize: Set<string> // task_ids
  retire: Set<string> // row_ids
  fixStatus: Set<string> // row_ids (keyed by row_id)
  // Field drift is picker-style, not toggle: key is
  // `${row_id}:${field}`, value is the chosen side. Absence from the
  // map means "unresolved, don't include in payload" — per HANDOFF the
  // user must explicitly pick a side for each drift row.
  fieldDrift: Map<string, 'db' | 'clickup'>
}

const EMPTY: Selections = {
  materialize: new Set(),
  retire: new Set(),
  fixStatus: new Set(),
  fieldDrift: new Map(),
}

function driftKey(rowId: string, field: string): string {
  return `${rowId}:${field}`
}

/**
 * Modal that fetches the 3-bucket diff and lets the tech pick actions
 * via checkboxes. Apply submits the selected subset; on success we
 * surface counts + errors and re-fetch the diff so the modal shows
 * post-apply state (lets the tech confirm what's left to do).
 */
export function SyncClickUpModal(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { open, onOpenChange } = props

  // Diff is gated on `open` so we don't fetch until the modal mounts.
  const diffQ = useSyncDiff(open)
  const applyM = useApplySync()

  const [sel, setSel] = useState<Selections>(EMPTY)
  const [lastResult, setLastResult] = useState<SyncApplyResult | null>(null)

  // Selection helpers --------------------------------------------------

  const totalSelected =
    sel.materialize.size +
    sel.retire.size +
    sel.fixStatus.size +
    sel.fieldDrift.size

  // Toggle helper for the three Set-backed buckets. fieldDrift uses
  // its own picker helper below because it's a radio-style 3-state
  // widget (db | clickup | unchosen) rather than a boolean checkbox.
  function toggle(
    kind: Exclude<keyof Selections, 'fieldDrift'>,
    key: string,
  ) {
    setSel(prev => {
      const next = new Set(prev[kind])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...prev, [kind]: next }
    })
  }

  function allSelected(
    kind: Exclude<keyof Selections, 'fieldDrift'>,
    keys: string[],
  ): boolean {
    if (keys.length === 0) return false
    return keys.every(k => sel[kind].has(k))
  }

  function toggleAll(
    kind: Exclude<keyof Selections, 'fieldDrift'>,
    keys: string[],
  ) {
    setSel(prev => {
      const every = keys.every(k => prev[kind].has(k))
      return {
        ...prev,
        [kind]: every ? new Set<string>() : new Set<string>(keys),
      }
    })
  }

  function pickDrift(rowId: string, field: string, side: 'db' | 'clickup') {
    setSel(prev => {
      const next = new Map(prev.fieldDrift)
      const key = driftKey(rowId, field)
      // Re-clicking the same side clears the choice — lets the tech
      // back out of a selection without needing an explicit clear
      // button.
      if (next.get(key) === side) next.delete(key)
      else next.set(key, side)
      return { ...prev, fieldDrift: next }
    })
  }

  // Payload for Apply --------------------------------------------------

  const payload: SyncApplyRequest = useMemo(() => {
    if (!diffQ.data) {
      return {
        materialize_task_ids: [],
        retire_row_ids: [],
        fix_status_pairs: [],
        resolve_field_drift: [],
      }
    }
    const data: SyncDiff = diffQ.data
    const fixPairs = data.status_mismatch
      .filter(item => sel.fixStatus.has(item.row_id))
      .map(item => ({
        row_id: item.row_id,
        target_status: item.mapped_status,
      }))
    // Only include drift items where the user explicitly picked a
    // side. `data.field_drift` may not round-trip 1:1 because a diff
    // re-fetch between pick and apply could drop some items; filter
    // through the CURRENT diff so we never send stale
    // (row_id, field) pairs the server can't map.
    const driftResolutions: FieldDriftResolution[] = (
      data.field_drift ?? []
    )
      .map(item => {
        const key = driftKey(item.row_id, item.field)
        const side = sel.fieldDrift.get(key)
        if (!side) return null
        return {
          row_id: item.row_id,
          field: item.field,
          value_to_use: side,
        }
      })
      .filter((x): x is FieldDriftResolution => x !== null)
    return {
      materialize_task_ids: Array.from(sel.materialize),
      retire_row_ids: Array.from(sel.retire),
      fix_status_pairs: fixPairs,
      resolve_field_drift: driftResolutions,
    }
  }, [diffQ.data, sel])

  async function handleApply() {
    if (totalSelected === 0) return
    const result = await applyM.mutateAsync(payload)
    setLastResult(result)
    // Clear selections so the tech sees a fresh state after the
    // re-fetch. Items that still appear in the new diff can be
    // re-selected.
    setSel(EMPTY)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      // Reset local state when dismissed so reopening is a clean slate.
      setSel(EMPTY)
      setLastResult(null)
    }
    onOpenChange(nextOpen)
  }

  // --------------------------------------------------------------------

  const createItems = diffQ.data?.in_clickup_not_mk1 ?? []
  const retireItems = diffQ.data?.in_mk1_not_clickup ?? []
  const fixItems = diffQ.data?.status_mismatch ?? []
  const driftItems = diffQ.data?.field_drift ?? []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sync from ClickUp</DialogTitle>
          <DialogDescription>
            Reconcile the ClickUp sandbox list with Accu-Mk1. Select the
            rows you want to apply; unchecked items are ignored.
          </DialogDescription>
        </DialogHeader>

        {diffQ.isLoading && (
          <p className="py-6 text-muted-foreground">Loading diff…</p>
        )}
        {diffQ.isError && (
          <p className="py-6 text-destructive">
            Failed to load diff: {String(diffQ.error)}
          </p>
        )}

        {diffQ.data && (
          <div className="space-y-6">
            <Section
              title="Create in Accu-Mk1"
              subtitle="Tasks in ClickUp that have no matching row here."
              emptyLabel="No new tasks to import."
              allSelected={allSelected(
                'materialize',
                createItems.map(c => c.task_id),
              )}
              hasItems={createItems.length > 0}
              onToggleAll={() =>
                toggleAll(
                  'materialize',
                  createItems.map(c => c.task_id),
                )
              }
            >
              {createItems.map(item => (
                <Row
                  key={item.task_id}
                  checked={sel.materialize.has(item.task_id)}
                  onToggle={() => toggle('materialize', item.task_id)}
                  primary={item.name || '(no name)'}
                  secondary={`ClickUp column: ${item.clickup_status || '—'} · creator: ${item.creator_username || '—'}`}
                />
              ))}
            </Section>

            <Section
              title="Retire in Accu-Mk1"
              subtitle="Rows whose ClickUp task is no longer in the list."
              emptyLabel="No stale rows."
              allSelected={allSelected(
                'retire',
                retireItems.map(r => r.row_id),
              )}
              hasItems={retireItems.length > 0}
              onToggleAll={() =>
                toggleAll(
                  'retire',
                  retireItems.map(r => r.row_id),
                )
              }
            >
              {retireItems.map(item => (
                <Row
                  key={item.row_id}
                  checked={sel.retire.has(item.row_id)}
                  onToggle={() => toggle('retire', item.row_id)}
                  primary={item.compound_name}
                  secondary={`status: ${item.status} · task: ${item.clickup_task_id}`}
                />
              ))}
            </Section>

            <Section
              title="Fix status"
              subtitle="Rows whose DB status drifted from ClickUp."
              emptyLabel="No status drift."
              allSelected={allSelected(
                'fixStatus',
                fixItems.map(f => f.row_id),
              )}
              hasItems={fixItems.length > 0}
              onToggleAll={() =>
                toggleAll(
                  'fixStatus',
                  fixItems.map(f => f.row_id),
                )
              }
            >
              {fixItems.map(item => (
                <Row
                  key={item.row_id}
                  checked={sel.fixStatus.has(item.row_id)}
                  onToggle={() => toggle('fixStatus', item.row_id)}
                  primary={item.compound_name}
                  secondary={`${item.mk1_status} → ${item.mapped_status} (ClickUp: ${item.clickup_column})`}
                />
              ))}
            </Section>

            <section data-testid="sync-field-drift-section">
              <header className="mb-2">
                <h3 className="font-semibold text-sm">Field drift</h3>
                <p className="text-xs text-muted-foreground">
                  Rows where a custom field disagrees between DB and
                  ClickUp. Pick which side wins — rows with no pick are
                  excluded from Apply.
                </p>
              </header>
              {driftItems.length > 0 ? (
                <div className="border rounded-md divide-y">
                  {driftItems.map(item => {
                    const key = driftKey(item.row_id, item.field)
                    const side = sel.fieldDrift.get(key)
                    return (
                      <DriftRow
                        key={key}
                        compoundName={item.compound_name}
                        field={item.field}
                        dbValue={item.db_value}
                        clickupValue={item.clickup_value}
                        side={side}
                        onPick={next => pickDrift(item.row_id, item.field, next)}
                      />
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No field drift.
                </p>
              )}
            </section>
          </div>
        )}

        {lastResult && (
          <div
            className="rounded-md border p-3 text-sm"
            data-testid="sync-result"
          >
            <p>
              Applied: {lastResult.materialized} created, {lastResult.retired}{' '}
              retired, {lastResult.fixed_status} status fix
              {lastResult.fixed_status === 1 ? '' : 'es'},{' '}
              {lastResult.field_drift_resolved ?? 0} field drift resolved.
            </p>
            {lastResult.errors.length > 0 && (
              <div className="mt-2">
                <p className="text-destructive font-medium">
                  {lastResult.errors.length} error
                  {lastResult.errors.length === 1 ? '' : 's'}:
                </p>
                <ul className="list-disc pl-5 text-xs">
                  {lastResult.errors.map((e, i) => (
                    <li key={i}>
                      [{e.type}] {e.id}: {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={applyM.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleApply}
            disabled={totalSelected === 0 || applyM.isPending}
            data-testid="sync-apply-btn"
          >
            {applyM.isPending
              ? 'Applying…'
              : `Apply (${totalSelected} action${totalSelected === 1 ? '' : 's'})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------
// Section + Row — extracted to keep the main component readable. Not
// exported because they're purely modal-internal layout primitives.
// ---------------------------------------------------------------------

function Section(props: {
  title: string
  subtitle: string
  emptyLabel: string
  hasItems: boolean
  allSelected: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  return (
    <section>
      <header className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-semibold text-sm">{props.title}</h3>
          <p className="text-xs text-muted-foreground">{props.subtitle}</p>
        </div>
        {props.hasItems && (
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={props.allSelected}
              onCheckedChange={props.onToggleAll}
              aria-label={`Select all ${props.title}`}
            />
            <span>Select all</span>
          </label>
        )}
      </header>
      {props.hasItems ? (
        <div className="border rounded-md divide-y">{props.children}</div>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          {props.emptyLabel}
        </p>
      )}
    </section>
  )
}

function Row(props: {
  checked: boolean
  onToggle: () => void
  primary: string
  secondary: string
}) {
  return (
    <label className="flex items-start gap-3 p-2 cursor-pointer hover:bg-accent/40">
      <Checkbox
        checked={props.checked}
        onCheckedChange={props.onToggle}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{props.primary}</p>
        <p className="text-xs text-muted-foreground truncate">
          {props.secondary}
        </p>
      </div>
    </label>
  )
}

/**
 * Row for the field-drift section. Renders the field name + two
 * side-by-side buttons (DB / ClickUp) that act as a radio group; the
 * currently-picked side is visually elevated via the `default`
 * variant. A third click on the selected side clears the pick.
 *
 * data-testids:
 *   - sync-drift-row-{row_id}-{field}: the container
 *   - sync-drift-db-{row_id}-{field}
 *   - sync-drift-clickup-{row_id}-{field}
 * These let the test harness drive picks without DOM-walking by text.
 */
function DriftRow(props: {
  compoundName: string
  field: string
  dbValue: string | null
  clickupValue: string | null
  side: 'db' | 'clickup' | undefined
  onPick: (side: 'db' | 'clickup') => void
}) {
  const empty = <span className="italic text-muted-foreground">(empty)</span>
  return (
    <div
      className="flex items-start gap-3 p-2"
      data-testid={`sync-drift-row`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {props.compoundName}{' '}
          <span className="text-xs text-muted-foreground">
            · {props.field}
          </span>
        </p>
        <div className="flex gap-2 mt-1">
          <Button
            type="button"
            size="sm"
            variant={props.side === 'db' ? 'default' : 'outline'}
            onClick={() => props.onPick('db')}
            data-testid="sync-drift-db"
            aria-pressed={props.side === 'db'}
          >
            DB: {props.dbValue ?? ''}
            {props.dbValue === null ? empty : null}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={props.side === 'clickup' ? 'default' : 'outline'}
            onClick={() => props.onPick('clickup')}
            data-testid="sync-drift-clickup"
            aria-pressed={props.side === 'clickup'}
          >
            ClickUp: {props.clickupValue ?? ''}
            {props.clickupValue === null ? empty : null}
          </Button>
        </div>
      </div>
    </div>
  )
}
