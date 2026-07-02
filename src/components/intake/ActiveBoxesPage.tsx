import { Fragment, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
import { closeBox, getSenaiteSamples, listActiveBoxes, type LimsBox } from '@/lib/api'
import { getWordpressUrl } from '@/lib/api-profiles'
import { roleBadgeClass, roleTextClass } from '@/lib/assignment-colors'
import { groupSamplesByOrder } from '@/lib/inbox-orders'

const ROLE_LABEL: Record<string, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility' }

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
  useEffect(() => {
    if (!sessionOrderKey || !sessionQ.isError) return
    toast.error(`Failed to load samples for ${sessionOrderKey}`)
    setSessionOrderKey(null)
  }, [sessionOrderKey, sessionQ.isError])
  const closeM = useMutation({
    mutationFn: (boxId: number) => closeBox(boxId),
    onSuccess: async () => {
      setClosing(null)
      await qc.invalidateQueries({ queryKey: ['active-boxes'] })
    },
  })

  const boxes = boxesQ.data ?? []

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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4">Label</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Vials</th>
              <th className="py-2 pr-4">Created</th>
              <th className="py-2 pr-4">Location</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {groupByOrder(boxes).map(g => (
              <Fragment key={g.orderKey}>
                <tr className="border-b bg-muted/50">
                  <td colSpan={6} className="py-2 pr-4">
                    <OrderLink orderKey={g.orderKey} />
                    <span className="ml-2 text-xs text-muted-foreground">
                      {g.boxes.length} box{g.boxes.length === 1 ? '' : 'es'}
                    </span>
                  </td>
                </tr>
                {g.boxes.map(b => (
                  <tr key={b.id} className="border-b">
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
