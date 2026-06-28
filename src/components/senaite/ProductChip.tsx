import { FlaskConical, CheckCircle2 } from 'lucide-react'
import type { OrderedProduct } from '@/lib/api'
import type { ProductCompletion } from '@/lib/product-completion'

/**
 * One ordered-product chip, shared by the Order Details card and the sticky
 * header. `compact` shrinks it to a single truncating line for the header.
 * When `completion.met`, a green check renders; hovering the check shows the
 * contributing vial(s).
 */
export function ProductChip({
  product,
  completion,
  compact = false,
}: {
  product: OrderedProduct
  completion?: ProductCompletion | null
  compact?: boolean
}) {
  const met = completion?.met === true
  const checkTitle = met
    ? completion!.vials.length > 0
      ? `Complete — ${product.key === 'variance' ? 'locked vials' : 'promoted from'}: ${completion!.vials.join(', ')}`
      : 'Complete'
    : undefined
  return (
    <span
      title={product.label}
      className={
        'inline-flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-300 whitespace-nowrap ' +
        (compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs')
      }
    >
      <FlaskConical size={compact ? 11 : 12} className="shrink-0" />
      <span className={compact ? 'max-w-[16ch] truncate' : undefined}>{product.label}</span>
      {met && (
        <span title={checkTitle} className="inline-flex shrink-0" data-testid="product-check">
          <CheckCircle2 size={compact ? 12 : 13} className="text-emerald-400" />
        </span>
      )}
    </span>
  )
}
