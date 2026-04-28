import { useUIStore } from '@/store/ui-store'
import { Button } from '@/components/ui/button'

interface Props {
  /** The sample ID to display (e.g. "P-0134" or "P-0134-S02"). */
  id: string
  /** If set, this is a sub-sample; render "↳ child of {parentId}" with a button. */
  parentId?: string
  /** Vial sequence (1, 2, ...) — shown next to the parent linkage if provided. */
  vialSequence?: number
  /** If set on a parent, render "(N vials)" hint. */
  hasChildren?: number
}

export function SampleIdBadge({ id, parentId, vialSequence, hasChildren }: Props) {
  const navigateToSample = useUIStore(state => state.navigateToSample)

  const handleParentClick = () => {
    if (parentId) {
      navigateToSample(parentId)
    }
  }

  return (
    <span className="inline-flex items-center gap-1 font-mono text-sm">
      <span>{id}</span>
      {parentId && (
        <span className="text-muted-foreground">
          ↳ child of{' '}
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 underline hover:text-foreground text-muted-foreground"
            onClick={handleParentClick}
          >
            {parentId}
          </Button>
          {vialSequence != null && (
            <span className="ml-1 text-xs">(vial {vialSequence})</span>
          )}
        </span>
      )}
      {hasChildren != null && hasChildren > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">({hasChildren} vials)</span>
      )}
    </span>
  )
}
