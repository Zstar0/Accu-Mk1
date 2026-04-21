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
  type SyncApplyRequest,
  type SyncApplyResult,
  type SyncDiff,
} from '@/hooks/peptide-requests'

type Selections = {
  materialize: Set<string> // task_ids
  retire: Set<string> // row_ids
  fixStatus: Set<string> // row_ids (keyed by row_id)
}

const EMPTY: Selections = {
  materialize: new Set(),
  retire: new Set(),
  fixStatus: new Set(),
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
    sel.materialize.size + sel.retire.size + sel.fixStatus.size

  function toggle(kind: keyof Selections, key: string) {
    setSel(prev => {
      const next = new Set(prev[kind])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...prev, [kind]: next }
    })
  }

  function allSelected(kind: keyof Selections, keys: string[]): boolean {
    if (keys.length === 0) return false
    return keys.every(k => sel[kind].has(k))
  }

  function toggleAll(kind: keyof Selections, keys: string[]) {
    setSel(prev => {
      const every = keys.every(k => prev[kind].has(k))
      return {
        ...prev,
        [kind]: every ? new Set<string>() : new Set<string>(keys),
      }
    })
  }

  // Payload for Apply --------------------------------------------------

  const payload: SyncApplyRequest = useMemo(() => {
    if (!diffQ.data) {
      return {
        materialize_task_ids: [],
        retire_row_ids: [],
        fix_status_pairs: [],
      }
    }
    const data: SyncDiff = diffQ.data
    const fixPairs = data.status_mismatch
      .filter(item => sel.fixStatus.has(item.row_id))
      .map(item => ({
        row_id: item.row_id,
        target_status: item.mapped_status,
      }))
    return {
      materialize_task_ids: Array.from(sel.materialize),
      retire_row_ids: Array.from(sel.retire),
      fix_status_pairs: fixPairs,
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
          </div>
        )}

        {lastResult && (
          <div
            className="rounded-md border p-3 text-sm"
            data-testid="sync-result"
          >
            <p>
              Applied: {lastResult.materialized} created, {lastResult.retired}{' '}
              retired, {lastResult.fixed_status} status fixes.
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
