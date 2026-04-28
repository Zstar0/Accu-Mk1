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
}

const SUB_SAMPLE_RE = /^(.+)-S(\d+)$/

export function SampleIdBadge({ id, parentId, vialSequence, hasChildren }: Props) {
  const navigateToSample = useUIStore(state => state.navigateToSample)

  // Auto-derive parent linkage from the ID pattern when not provided.
  // E.g. "PB-0134-S02" → parentId="PB-0134", vialSequence=2.
  const derived = !parentId ? id.match(SUB_SAMPLE_RE) : null
  const effectiveParentId = parentId ?? derived?.[1]
  const effectiveVialSequence =
    vialSequence ?? (derived?.[2] ? parseInt(derived[2], 10) : undefined)

  const handleParentClick = () => {
    if (effectiveParentId) {
      navigateToSample(effectiveParentId)
    }
  }

  return (
    <span className="inline-flex items-center gap-1 font-mono text-sm">
      <span>{id}</span>
      {effectiveParentId && (
        <span className="text-muted-foreground">
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
            <span className="ml-1 text-xs">(vial {effectiveVialSequence})</span>
          )}
        </span>
      )}
      {hasChildren != null && hasChildren > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">({hasChildren} vials)</span>
      )}
    </span>
  )
}
