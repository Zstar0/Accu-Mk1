import { useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Download, Loader2, Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTheme } from '@/hooks/use-theme'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { EntityFlagButton } from '@/components/flags/EntityFlagButton'
import { useDocument, useDocumentContent } from '@/services/documents'
import {
  DOC_STATUS_LABEL,
  documentDownloadName,
  formatDocDate,
  resolveDocTheme,
  stampDocumentTheme,
} from '@/components/documents/documents-utils'
import { RetitleDialog } from '@/components/documents/RetitleDialog'

/**
 * Renders one revision inside a sandboxed frame (spec §8.3). `srcdoc` +
 * `sandbox="allow-scripts"` (no allow-same-origin) gives the document an
 * opaque origin: its scripts run but cannot reach Mk1's session, storage,
 * cookies, or the API. Content is fetched with the normal bearer call, so no
 * token ever lands in a URL. There is deliberately no "open in window": a
 * top-level blob: URL is same-origin with Mk1 and would let document scripts
 * reach localStorage.
 */

/** Live `prefers-color-scheme` so the frame re-stamps when the OS flips while
 *  Mk1 is on 'system'. Server snapshot is `false` — nothing renders this on a
 *  server, it just keeps useSyncExternalStore honest. */
function usePrefersDark(): boolean {
  return useSyncExternalStore(
    cb => {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => false
  )
}

export function DocumentViewer({ id }: { id: number }) {
  const clear = useUIStore(s => s.clearDocumentViewer)
  const navigateToDocument = useUIStore(s => s.navigateToDocument)
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const { theme } = useTheme()
  const [editing, setEditing] = useState(false)

  const detail = useDocument(id)
  const content = useDocumentContent(id)

  const mode = resolveDocTheme(theme, usePrefersDark())
  const srcDoc = useMemo(
    () => (content.data ? stampDocumentTheme(content.data, mode) : ''),
    [content.data, mode]
  )

  const download = () => {
    if (!content.data || !detail.data) return
    const url = URL.createObjectURL(
      new Blob([content.data], { type: 'text/html' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = documentDownloadName(detail.data.code, detail.data.revision)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const doc = detail.data

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={clear}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Documents
        </Button>
        {doc && (
          <>
            <span className="font-mono text-xs text-muted-foreground">
              {doc.code}
            </span>
            <span className="truncate font-medium">{doc.title}</span>
            <Badge
              variant={
                doc.status === 'active'
                  ? 'default'
                  : doc.status === 'draft'
                    ? 'secondary'
                    : 'outline'
              }
            >
              {DOC_STATUS_LABEL[doc.status]}
            </Badge>
            <Badge variant="outline">{doc.category_name}</Badge>
            <span className="text-xs text-muted-foreground">
              effective {formatDocDate(doc.effective_date)} · by{' '}
              {doc.author ?? 'unknown author'}
              {doc.co_author ? ` with ${doc.co_author}` : ''} · updated{' '}
              {formatDocDate(doc.updated_at)}
              {doc.updated_by && doc.updated_by !== doc.author
                ? ` by ${doc.updated_by}`
                : ''}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {/* Threads anchor on the CODE, so they follow the document
                  across revisions. */}
              <EntityFlagButton entityType="document" entityId={doc.code} />
              {doc.revisions.length > 1 && (
                <Select
                  value={String(doc.id)}
                  onValueChange={v => navigateToDocument(Number(v))}
                >
                  <SelectTrigger
                    id="document-revision"
                    className="h-8 w-[170px] text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {doc.revisions.map(r => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        Rev {r.revision} · {DOC_STATUS_LABEL[r.status]} ·{' '}
                        {formatDocDate(r.created_at)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={download}
                disabled={!content.data}
              >
                <Download className="mr-1 h-4 w-4" />
                Download
              </Button>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="mr-1 h-4 w-4" />
                  Edit details
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {(detail.error || content.error) && (
        <p className="px-4 py-3 text-sm text-destructive">
          Could not load this document:{' '}
          {(detail.error ?? content.error)?.message}
        </p>
      )}

      {content.isLoading || detail.isLoading ? (
        <div
          role="status"
          aria-label="Loading document"
          className="flex flex-1 items-center justify-center"
        >
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : content.error ? null : (
        <iframe
          title={doc?.title ?? `Document ${id}`}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      )}

      {doc && (
        <RetitleDialog doc={doc} open={editing} onOpenChange={setEditing} />
      )}
    </div>
  )
}
