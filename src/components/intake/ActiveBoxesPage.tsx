import { Fragment, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
import { closeBox, getSenaiteSamples, listActiveBoxes, type LimsBox } from '@/lib/api'
import { getWordpressUrl } from '@/lib/api-profiles'
import { roleBadgeClass, roleTextClass } from '@/lib/assignment-colors'
import { invalidateBoxCaches } from '@/lib/box-cache'
import { groupSamplesByOrder } from '@/lib/inbox-orders'
import { useUIStore } from '@/store/ui-store'

const ROLE_LABEL: Record<string, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility', xtra: 'Extras' }

const stripWp = (s: string) => s.replace(/^wp-/i, '')
const inc = (hay: string, needle: string) => hay.toLowerCase().includes(needle.trim().toLowerCase())

/** Group boxes by order_key preserving first-appearance order, so the API's
 *  oldest-box-first ordering holds within and across groups. */
function groupByOrder(boxes: LimsBox[]): { orderKey: string; boxes: LimsBox[] }[] {
  const groups: { orderKey: string; boxes: LimsBox[] }[] = []
  const byKey = new Map<string, LimsBox[]>()
  for (const b of boxes) {
    let g = byKey.get(b.order_key)
    if (!g) {
      g = []
      byKey.set(b.order_key, g)
      groups.push({ orderKey: b.order_key, boxes: g })
    }
    g.push(b)
  }
  return groups
}

/** "WP-3267" → link to the WooCommerce order admin page (same URL shape as
 *  SampleDetails' "View in WP Admin"). Plain text when the key has no digits. */
function OrderLink({ orderKey }: { orderKey: string }) {
  const wpId = orderKey.match(/\d+/)?.[0]
  if (!wpId) return <span className="font-medium">{orderKey}</span>
  return (
    <a
      href={`${getWordpressUrl()}/wp-admin/admin.php?page=wc-orders&action=edit&id=${wpId}`}
      target="_blank"
      rel="noreferrer"
      className="font-medium hover:text-blue-500 hover:underline transition-colors"
    >
      {orderKey}
    </a>
  )
}

/** All not-yet-stored boxes across orders, grouped per order. Slice-2 surface:
 *  list + Close action; the Location column is a placeholder until the
 *  deferred bench-scan slices land (see the box-location-tracking spec). */
export function ActiveBoxesPage() {
  const qc = useQueryClient()
  const [closing, setClosing] = useState<LimsBox | null>(null)
  // A label click opens that order's check-in overlay (OrderReceiveSession)
  // in place, landed on the Boxing tab — all boxes of one order share it.
  const [sessionOrderKey, setSessionOrderKey] = useState<string | null>(null)
  const [sampleQ, setSampleQ] = useState('')
  const [orderQ, setOrderQ] = useState('')
  const [boxQ, setBoxQ] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Deep link (e.g. the sample-header box chip): seed the Box ID search with
  // the incoming label, then consume-and-clear the store slot.
  const boxesSearchTarget = useUIStore(s => s.boxesSearchTarget)
  useEffect(() => {
    if (boxesSearchTarget === null) return
    setBoxQ(boxesSearchTarget)
    useUIStore.setState({ boxesSearchTarget: null })
  }, [boxesSearchTarget])

  const boxesQ = useQuery({ queryKey: ['active-boxes'], queryFn: listActiveBoxes })

  // Samples for the clicked order. reviewState is deliberately undefined —
  // checked-in orders have left the due queue, so the overlay must see ALL
  // states. The search can be fuzzy, so exact-match filter below.
  const sessionQ = useQuery({
    queryKey: ['boxes-session-samples', sessionOrderKey],
    queryFn: () => getSenaiteSamples(undefined, 200, 0, sessionOrderKey!, 'order_number'),
    enabled: sessionOrderKey !== null,
  })
  const sessionItems = (sessionQ.data?.items ?? []).filter(
    s => s.client_order_number === sessionOrderKey
  )
  const sessionGroup =
    groupSamplesByOrder(sessionItems).find(g => g.orderKey === sessionOrderKey) ?? null

  // Order-less box keys (e.g. a bare sample id) resolve to zero samples —
  // drop the session and tell the tech instead of opening an empty dialog.
  useEffect(() => {
    if (!sessionOrderKey || !sessionQ.data || sessionGroup) return
    toast.error(`No order session available for ${sessionOrderKey}`)
    setSessionOrderKey(null)
  }, [sessionOrderKey, sessionQ.data, sessionGroup])
  // Gate on !isFetching so a reopen against a cached error waits for its
  // retry instead of insta-failing, and drop the errored cache entry when
  // closing so the next label click starts a clean fetch (not a replay of
  // the stale error until gcTime).
  useEffect(() => {
    if (!sessionOrderKey || !sessionQ.isError || sessionQ.isFetching) return
    toast.error(`Failed to load samples for ${sessionOrderKey}`)
    setSessionOrderKey(null)
    qc.removeQueries({ queryKey: ['boxes-session-samples', sessionOrderKey] })
  }, [sessionOrderKey, sessionQ.isError, sessionQ.isFetching, qc])
  const closeM = useMutation({
    mutationFn: (boxId: number) => closeBox(boxId),
    onSuccess: async closed => {
      setClosing(null)
      // Closing returns the box's vials to Unboxed and stores the box — every
      // box surface (Boxing tab, sample-header chip, worksheet Box column)
      // must refresh, scoped by the closed box's own order key.
      await invalidateBoxCaches(qc, closed.order_key)
    },
    onError: err =>
      toast.error(err instanceof Error ? err.message : 'Failed to close box'),
  })

  const boxes = boxesQ.data ?? []

  // All non-empty search fields AND together; order/box tolerate a WP- prefix
  // either side, box matches the numeric id (QR scan) or the human label.
  const filtered = boxes.filter(b =>
    (orderQ.trim() === '' || inc(stripWp(b.order_key), stripWp(orderQ))) &&
    (boxQ.trim() === '' || String(b.id).includes(boxQ.trim()) || inc(b.label_code, boxQ)) &&
    (sampleQ.trim() === '' || (b.vials ?? []).some(v => inc(v.sample_id, sampleQ)))
  )

  const toggleExpanded = (id: number) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // A sample search auto-expands every box it leaves visible.
  const isOpen = (b: LimsBox) => expanded.has(b.id) || sampleQ.trim() !== ''

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <Archive className="h-5 w-5" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Active Boxes</h2>
      </div>

      {boxesQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!boxesQ.isLoading && boxes.length === 0 && (
        <div className="text-sm text-muted-foreground">No active boxes.</div>
      )}

      {boxes.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            value={sampleQ}
            onChange={e => setSampleQ(e.target.value)}
            placeholder="Sample ID"
            aria-label="Sample ID"
            className="w-48"
          />
          <Input
            value={orderQ}
            onChange={e => setOrderQ(e.target.value)}
            placeholder="Order #"
            aria-label="Order #"
            className="w-48"
          />
          <Input
            value={boxQ}
            onChange={e => setBoxQ(e.target.value)}
            placeholder="Box ID"
            aria-label="Box ID"
            className="w-48"
          />
        </div>
      )}

      {boxes.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-muted-foreground">No boxes match your search.</div>
      )}

      {filtered.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="w-8 py-2 pr-2" aria-label="Expand" />
              <th className="py-2 pr-4">Label</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Vials</th>
              <th className="py-2 pr-4">Created</th>
              <th className="py-2 pr-4">Location</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {groupByOrder(filtered).map(g => (
              <Fragment key={g.orderKey}>
                <tr className="border-b bg-muted/50">
                  <td colSpan={7} className="py-2 pr-4">
                    <OrderLink orderKey={g.orderKey} />
                    <span className="ml-2 text-xs text-muted-foreground">
                      {g.boxes.length} box{g.boxes.length === 1 ? '' : 'es'}
                    </span>
                  </td>
                </tr>
                {g.boxes.map(b => (
                  <Fragment key={b.id}>
                    <tr className="border-b">
                      <td className="py-2 pr-2">
                        {(b.vials ?? []).length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(b.id)}
                            aria-label={isOpen(b) ? `Collapse ${b.label_code}` : `Expand ${b.label_code}`}
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {isOpen(b) ? (
                              <ChevronDown className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        ) : (
                          <span className="px-1 text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <button
                          type="button"
                          onClick={() => setSessionOrderKey(b.order_key)}
                          disabled={sessionOrderKey === b.order_key && sessionQ.isPending}
                          className={`inline-flex items-center gap-1.5 font-mono font-semibold hover:underline ${roleTextClass(b.role)}`}
                        >
                          {b.label_code}
                          {sessionOrderKey === b.order_key && sessionQ.isPending && (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          )}
                        </button>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`rounded px-2 py-0.5 text-xs ${roleBadgeClass(b.role)}`}>
                          {ROLE_LABEL[b.role] ?? b.role}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{b.vial_count}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}
                      </td>
                      {/* Fed by lims_box_location_events once the bench-scan slices land
                          (spec 2026-07-01-box-location-tracking-design.md, slices 3-4). */}
                      <td className="py-2 pr-4 italic text-muted-foreground">Coming soon</td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => setClosing(b)}>
                          Close
                        </Button>
                      </td>
                    </tr>
                    {isOpen(b) && (b.vials ?? []).map(v => (
                      <tr
                        key={v.sample_id}
                        className={`border-b bg-muted/20 ${
                          sampleQ.trim() && inc(v.sample_id, sampleQ) ? 'bg-primary/10' : ''
                        }`}
                      >
                        <td className="py-1.5 pr-2" />
                        <td className="py-1.5 pr-4">
                          <button
                            type="button"
                            onClick={() => useUIStore.getState().navigateToSample(v.sample_id)}
                            className="font-mono hover:underline"
                          >
                            {v.sample_id}
                          </button>
                          {v.parent_sample_id && !v.sample_id.startsWith(v.parent_sample_id) && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ↳ {v.parent_sample_id}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4">
                          <span className={`rounded px-2 py-0.5 text-xs ${roleBadgeClass(v.assignment_role)}`}>
                            {ROLE_LABEL[v.assignment_role ?? ''] ?? (v.assignment_role ?? '—')}
                          </span>
                        </td>
                        <td colSpan={4} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {/* The order's check-in overlay, landed on Boxing. On close, refresh the
          box list (and the overlay's order-scoped box/vial queries) so counts
          reflect whatever the tech did inside. */}
      {sessionGroup && (
        <OrderReceiveSession
          orders={[sessionGroup]}
          initialPhase="boxing"
          onClose={() => {
            const key = sessionOrderKey
            setSessionOrderKey(null)
            void qc.invalidateQueries({ queryKey: ['active-boxes'] })
            if (key) {
              void qc.invalidateQueries({ queryKey: ['order-boxes', key] })
              void qc.invalidateQueries({ queryKey: ['order-vials', key] })
            }
          }}
        />
      )}

      <AlertDialog open={closing !== null} onOpenChange={open => { if (!open) setClosing(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {closing?.label_code}?</AlertDialogTitle>
            <AlertDialogDescription>
              {closing?.vial_count ?? 0} vial(s) will be returned to Unboxed and the box
              marked stored. The physical box goes back to the check-in desk for reuse.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={closeM.isPending}
              onClick={() => { if (closing) closeM.mutate(closing.id) }}
            >
              Return vials &amp; close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
