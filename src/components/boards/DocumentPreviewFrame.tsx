import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useDocumentContent } from '@/services/documents'
import {
  resolveDocTheme,
  stampDocumentTheme,
} from '@/components/documents/documents-utils'
import { useTheme } from '@/hooks/use-theme'
import { usePrefersDark } from '@/components/documents/DocumentViewer'

/** Sandboxed, read-only preview of a document revision for the board side panel. */
export function DocumentPreviewFrame({ id }: { id: number }) {
  const content = useDocumentContent(id)
  const { theme } = useTheme()
  const mode = resolveDocTheme(theme, usePrefersDark())
  const html = useMemo(
    () => (content.data ? stampDocumentTheme(content.data, mode) : ''),
    [content.data, mode]
  )
  if (content.isLoading)
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  if (!content.data)
    return (
      <p className="text-xs text-muted-foreground">
        {content.error
          ? 'This document is restricted or no longer exists.'
          : 'No preview.'}
      </p>
    )
  return (
    <iframe
      title="Document preview"
      sandbox="allow-scripts"
      srcDoc={html}
      className="h-56 w-full rounded-md border bg-white"
    />
  )
}
