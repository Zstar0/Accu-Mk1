import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { closeBox, listActiveBoxes, type LimsBox } from '@/lib/api'
import { roleBadgeClass, roleTextClass } from '@/lib/assignment-colors'

const ROLE_LABEL: Record<string, string> = { hplc: 'HPLC', endo: 'Endotoxin', ster: 'Sterility' }

/** All not-yet-stored boxes across orders. Minimal slice-2 surface: list +
 *  Close action. Location / last-scan / history columns arrive with the
 *  deferred bench-scan slices (see the box-location-tracking spec). */
export function ActiveBoxesPage() {
  const qc = useQueryClient()
  const [closing, setClosing] = useState<LimsBox | null>(null)

  const boxesQ = useQuery({ queryKey: ['active-boxes'], queryFn: listActiveBoxes })
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
              <th className="py-2 pr-4">Order</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Vials</th>
              <th className="py-2 pr-4">Created</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {boxes.map(b => (
              <tr key={b.id} className="border-b">
                <td className={`py-2 pr-4 font-mono font-semibold ${roleTextClass(b.role)}`}>{b.label_code}</td>
                <td className="py-2 pr-4">{b.order_key}</td>
                <td className="py-2 pr-4">
                  <span className={`rounded px-2 py-0.5 text-xs ${roleBadgeClass(b.role)}`}>
                    {ROLE_LABEL[b.role] ?? b.role}
                  </span>
                </td>
                <td className="py-2 pr-4">{b.vial_count}</td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}
                </td>
                <td className="py-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => setClosing(b)}>
                    Close
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
