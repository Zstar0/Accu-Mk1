import { FlaskConical, CheckCircle2 } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { OrderedProduct } from '@/lib/api'
import type { ProductCompletion } from '@/lib/product-completion'
import { ROLE_COLOR_BADGE, roleColorForCode } from '@/lib/role-display'
import { useVialRoles } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'

/** The pre-colorization chip look — kept as the fallback for products with
 *  no fulfillment_role (kind-dim products before their role landed, stale
 *  wire rows) and for callers that don't resolve a color. */
const FALLBACK_CHIP_CLASSES =
  'border-violet-500/30 bg-violet-500/10 text-violet-300'

/**
 * Resolver hook: OrderedProduct -> the chip's color classes, from the
 * product's fulfillment_role via the vial-role catalog — the SAME source the
 * boxing lanes and RoleBadge use, so a product chip matches its bench color
 * everywhere (Handler request, 2026-08-28). Role-less products keep the
 * legacy violet. Lives here (not inside ProductChip) so the chip stays pure
 * and hook-free — callers without a QueryClient (tests, storybook-ish
 * renders) are unaffected.
 */
export function useProductColorClasses(): (p: OrderedProduct) => string {
  const { data: roles } = useVialRoles()
  const { data: departments } = useDepartments()
  return (p: OrderedProduct) =>
    p.fulfillment_role
      ? ROLE_COLOR_BADGE[
          roleColorForCode(p.fulfillment_role, roles, departments)
        ]
      : FALLBACK_CHIP_CLASSES
}

/**
 * Rich hover content for a product chip — the sectioned, `font-mono` card used
 * by every non-trivial hover in the app (see `SlaBreakdownTooltip` and the
 * "Rich hover tooltips" note in docs/developer/ui-patterns.md). Pure: receives
 * all data via props. Hosted inside a shadcn `TooltipContent`.
 *
 * Shows the product label (+ an "Add-on" marker), and — only when a completion
 * rule applies (`completion` non-null) — the Complete/Pending status and the
 * contributing vial(s).
 */
export function ProductChipTooltip({
  product,
  completion,
}: {
  product: OrderedProduct
  completion?: ProductCompletion | null
}) {
  const met = completion?.met === true
  const vials = completion?.vials ?? []
  // Variance is fulfilled by locking the set; everything else by promotion.
  const vialLabel =
    product.key === 'variance' ? 'Locked vials' : 'Promoted from'
  return (
    <div
      data-testid="product-chip-tooltip"
      className="flex flex-col gap-1.5 p-3 text-xs font-mono"
    >
      <div className="flex items-center gap-1.5 font-semibold border-b border-primary-foreground/20 pb-1.5">
        <FlaskConical size={12} className="shrink-0" />
        <span>{product.label}</span>
        {product.is_addon && (
          <span className="font-normal opacity-60">· Add-on</span>
        )}
      </div>
      {completion != null && (
        <div className="flex flex-col gap-0.5">
          {/* Green must read on the tooltip card, whose bg flips with the
              theme (dark card in light mode, light-gray card in dark mode —
              `--primary` in theme-variables.css). So invert the green: bright
              on the dark card, darker on the light one. */}
          <div
            className={
              met ? 'text-emerald-400 dark:text-emerald-700' : 'opacity-70'
            }
          >
            {met ? '✓ Complete' : 'Pending'}
          </div>
          {met && vials.length > 0 && (
            <div className="opacity-80">
              {vialLabel}:{' '}
              <span className="tabular-nums">{vials.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One ordered-product chip, shared by the Order Details card and the sticky
 * header. `compact` shrinks it to a single truncating line for the header.
 * When `completion.met`, a green check renders. Hovering anywhere on the chip
 * surfaces the styled `ProductChipTooltip` card (label + status + vials),
 * replacing the old native `title=` hints.
 */
export function ProductChip({
  product,
  completion,
  compact = false,
  xs = false,
  colorClasses,
}: {
  product: OrderedProduct
  completion?: ProductCompletion | null
  compact?: boolean
  /** Extra-small variant for dense surfaces (Order Status sample cards). */
  xs?: boolean
  /** Border/bg/text classes from useProductColorClasses(); omitted -> the
   *  legacy violet, so hook-less callers and tests render unchanged. */
  colorClasses?: string
}) {
  const met = completion?.met === true
  const sizeClasses = xs
    ? 'px-1 py-px text-[10px]'
    : compact
      ? 'px-1.5 py-0.5 text-[11px]'
      : 'px-2 py-1 text-xs'
  const iconSize = xs ? 9 : compact ? 11 : 12
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={
            'inline-flex items-center gap-1 rounded-md border whitespace-nowrap ' +
            (colorClasses ?? FALLBACK_CHIP_CLASSES) +
            ' ' +
            sizeClasses
          }
        >
          <FlaskConical size={iconSize} className="shrink-0" />
          <span
            className={
              xs
                ? 'max-w-[12ch] truncate'
                : compact
                  ? 'max-w-[16ch] truncate'
                  : undefined
            }
          >
            {product.label}
          </span>
          {met && (
            <span className="inline-flex shrink-0" data-testid="product-check">
              <CheckCircle2
                size={xs ? 10 : compact ? 12 : 13}
                className="text-emerald-400"
              />
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <ProductChipTooltip product={product} completion={completion} />
      </TooltipContent>
    </Tooltip>
  )
}
