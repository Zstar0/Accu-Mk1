import { Layers } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { Button } from '@/components/ui/button'

interface Props {
  /** The sample ID to display (e.g. "P-0134" or "P-0134-S02"). */
  id: string
  /** If set, this is a sub-sample; render "↳ child of {parentId}" with a button.
   *  When omitted, the parent linkage is auto-derived from the id pattern
   *  (e.g. "P-0134-S02" → parentId="P-0134", vialSequence=2). */
  parentId?: string
  /** Vial sequence (1, 2, ...) — shown next to the parent linkage if provided.
   *  Auto-derived from the id pattern when not passed explicitly. */
  vialSequence?: number
  /** If set on a parent, render "(N vials)" hint. */
  hasChildren?: number
  /** Stack the parent linkage on a new line below the sample ID instead of
   *  rendering inline. Use in tight tabular contexts (worksheet rows, etc.)
   *  where the inline layout otherwise wraps onto 3+ lines. */
  stacked?: boolean
  /** Variance replicate vial — renders the small sky Layers icon next to the
   *  id (variance = sky/Layers convention, see SenaiteDashboard). */
  variance?: boolean
}

const SUB_SAMPLE_RE = /^(.+)-S(\d+)$/

export function SampleIdBadge({ id, parentId, vialSequence, hasChildren, stacked, variance }: Props) {
  const navigateToSample = useUIStore(state => state.navigateToSample)

  // Auto-derive parent linkage from the ID pattern when not provided.
  // E.g. "PB-0134-S02" → parentId="PB-0134", vialSequence=2.
  const derived = !parentId ? id.match(SUB_SAMPLE_RE) : null
  const effectiveParentId = parentId ?? derived?.[1]
  const effectiveVialSequence =
    vialSequence ?? (derived?.[2] ? parseInt(derived[2], 10) : undefined)

  const handleParentClick = (e: React.MouseEvent) => {
    // Stop propagation so this badge can be safely dropped inside outer
    // clickable cards/rows without the parent-link click bubbling to them.
    e.stopPropagation()
    if (effectiveParentId) {
      navigateToSample(effectiveParentId)
    }
  }

  const parentLink = effectiveParentId && (
    <span className={stacked ? 'block text-[10px] text-muted-foreground whitespace-nowrap' : 'text-muted-foreground'}>
      ↳ child of{' '}
      <Button
        variant="ghost"
        size="sm"
        className="h-auto p-0 underline hover:text-foreground text-muted-foreground"
        onClick={handleParentClick}
      >
        {effectiveParentId}
      </Button>
      {effectiveVialSequence != null && (
        <span className={stacked ? 'ml-1' : 'ml-1 text-xs'}>(vial {effectiveVialSequence})</span>
      )}
    </span>
  )

  const varianceIcon = variance && (
    <Layers
      className="inline h-3 w-3 shrink-0 text-sky-500"
      aria-label="Variance replicate vial"
      role="img"
    />
  )

  if (stacked) {
    return (
      <span className="font-mono text-sm leading-tight">
        <span className="block whitespace-nowrap">
          {id}
          {varianceIcon && <span className="ml-1">{varianceIcon}</span>}
        </span>
        {parentLink}
        {hasChildren != null && hasChildren > 0 && (
          <span className="block text-[10px] text-muted-foreground">({hasChildren} vials)</span>
        )}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 font-mono text-sm">
      <span>{id}</span>
      {varianceIcon}
      {parentLink}
      {hasChildren != null && hasChildren > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">({hasChildren} vials)</span>
      )}
    </span>
  )
}
