import { FolderOpen, Globe, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { DocumentSpace } from '@/lib/api-documents'

/** The first level of the Documents page (spec 2026-10-06 section 9.1): one card per
 *  space the caller can see. The server already filtered by visibility, so a
 *  restricted space here is one the viewer is granted. */
export function SpacesGrid({
  spaces,
  onOpen,
}: {
  spaces: DocumentSpace[]
  onOpen: (slug: string) => void
}) {
  if (spaces.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
        <FolderOpen className="h-8 w-8" />
        <p className="text-sm">No spaces you can see.</p>
      </div>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {spaces.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onOpen(s.slug)}
          className="flex flex-col gap-2 rounded-md border p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{s.name}</span>
            <Badge
              variant={s.visibility === 'restricted' ? 'secondary' : 'outline'}
            >
              {s.visibility === 'restricted' ? (
                <Lock className="mr-1 h-3 w-3" aria-hidden />
              ) : (
                <Globe className="mr-1 h-3 w-3" aria-hidden />
              )}
              {s.visibility === 'restricted' ? 'Restricted' : 'Company'}
            </Badge>
          </div>
          {s.description && (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {s.description}
            </p>
          )}
          <span className="mt-auto text-xs text-muted-foreground tabular-nums">
            {s.document_count} doc{s.document_count === 1 ? '' : 's'}
          </span>
        </button>
      ))}
    </div>
  )
}
