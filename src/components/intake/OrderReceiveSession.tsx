import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'
import { BoxStep } from '@/components/intake/ReceiveWizard/BoxStep'
import type { OrderGroup } from '@/lib/inbox-orders'

interface Props {
  order: OrderGroup
  onClose: () => void
}

export function OrderReceiveSession({ order, onClose }: Props) {
  // index 0..n-1 = walking samples; index === n = order-level boxing stage
  const [index, setIndex] = useState(0)
  const total = order.samples.length
  const onBoxing = index >= total
  const current = order.samples[Math.min(index, total - 1)]
  if (!current) return null

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-w-6xl w-full p-0 sm:max-w-6xl h-[90vh] overflow-hidden">
        <DialogHeader className="px-6 pt-4 pb-2 border-b">
          <DialogTitle>
            Receive {order.orderLabel}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {onBoxing ? 'Boxing' : `Sample ${index + 1} of ${total} — ${current.id}`}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="h-[calc(90vh-7rem)] overflow-hidden">
          {onBoxing ? (
            <BoxStep
              orderKey={order.orderKey ?? current.id}
              orderLabel={order.orderLabel}
              clientId={order.clientId}
              sampleIds={order.samples.map(s => s.id)}
            />
          ) : (
            <ReceiveWizard
              key={current.uid}
              parent={{ uid: current.uid, sample_id: current.id, status: current.review_state ?? null }}
              onClose={onClose}
            />
          )}
        </div>

        <footer className="flex justify-between gap-2 px-6 py-3 border-t bg-muted/20">
          <Button
            type="button"
            variant="outline"
            disabled={index === 0}
            onClick={() => setIndex(i => Math.max(0, i - 1))}
          >
            Back
          </Button>
          {onBoxing ? (
            <Button type="button" onClick={onClose}>Done</Button>
          ) : (
            <Button type="button" onClick={() => setIndex(i => i + 1)}>
              {index === total - 1 ? 'Continue to boxing' : 'Next sample'}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
