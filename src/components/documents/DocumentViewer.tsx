import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

/** Placeholder — replaced wholesale in Task 8. */
export function DocumentViewer({ id }: { id: number }) {
  const clear = useUIStore(s => s.clearDocumentViewer)
  return (
    <div className="p-4">
      <Button variant="outline" size="sm" onClick={clear}>
        Back to documents
      </Button>
      <p className="mt-4 text-sm text-muted-foreground">Document #{id}</p>
    </div>
  )
}
