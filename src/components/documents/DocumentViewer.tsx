import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  ArrowLeft,
  Download,
  FilePenLine,
  Loader2,
  MessageSquareText,
  MousePointerClick,
  Pencil,
  TextCursor,
} from 'lucide-react'
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
import {
  useCreateRevision,
  useDocument,
  documentKeys,
  useDocumentContent,
  useReplaceDraftContent,
} from '@/services/documents'
import {
  DOC_STATUS_LABEL,
  documentDownloadName,
  formatDocDate,
  resolveDocTheme,
} from '@/components/documents/documents-utils'
import { RetitleDialog } from '@/components/documents/RetitleDialog'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import {
  addDocumentCommentAttachment,
  type CommentLabel,
  type CommentStatusFilter,
} from '@/lib/api-document-comments'
import {
  useCommentLabels,
  useCreateComment,
  useDocumentComments,
  useSetCommentStatus,
} from '@/services/document-comments'
import {
  buildViewerSrcDoc,
  readThemeTokens,
} from '@/components/documents/documents-utils'
import {
  useDocumentBridge,
  type BridgeComment,
  type BridgeSelection,
} from './annotations/useDocumentBridge'
import { SelectionToolbar } from './annotations/SelectionToolbar'
import { SYNTHETIC_ELEMENT_QUOTE } from './annotations/bridge-messages'
import {
  CommentComposer,
  type ComposerMode,
} from './annotations/CommentComposer'
import { CommentsPanel } from './annotations/CommentsPanel'
import { EditModeBar } from './annotations/EditModeBar'
import { stripViewerInjection } from './annotations/stripViewerInjection'

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
  const [retitling, setRetitling] = useState(false)

  const detail = useDocument(id)
  const content = useDocumentContent(id)

  const mode = resolveDocTheme(theme, usePrefersDark())
  const doc = detail.data
  const user = useAuthStore(s => s.user)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [inputMethod, setInputMethod] = useState<'drag' | 'pinpoint'>('drag')
  const [filter, setFilter] = useState<CommentStatusFilter>('open')
  // null = follow the default (open when the document has open comments)
  const [panelPref, setPanelOpen] = useState<boolean | null>(null)
  const [narrow, setNarrow] = useState(
    () => window.matchMedia('(max-width: 767px)').matches
  )
  // Default-open only on wide screens (no Sheet over a phone on load).
  const panelOpen =
    panelPref ?? (!narrow && (detail.data?.open_comment_count ?? 0) > 0)
  const [selection, setSelection] = useState<BridgeSelection | null>(null)
  const [composer, setComposer] = useState<{
    mode: ComposerMode
    label: CommentLabel | null
  } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const commentsQ = useDocumentComments(id, 'all')
  const labelsQ = useCommentLabels()
  const createComment = useCreateComment(id)
  const labels = labelsQ.data ?? []
  const comments = useMemo(() => commentsQ.data?.items ?? [], [commentsQ.data])
  const panelComments = useMemo(
    () =>
      filter === 'all' ? comments : comments.filter(c => c.status === filter),
    [comments, filter]
  )
  const openCount =
    commentsQ.data?.open_count ?? detail.data?.open_comment_count ?? 0

  const srcDoc = useMemo(
    () =>
      content.data
        ? buildViewerSrcDoc(content.data, mode, readThemeTokens())
        : '',
    [content.data, mode]
  )

  // Only OPEN comments carry marks; resolved ones stay in the panel under the filter.
  const bridgeComments = useMemo<BridgeComment[]>(
    () =>
      comments.flatMap(c => {
        const anchor = c.anchor
        const number = c.number
        if (c.status !== 'open' || !anchor || number == null) return []
        const additional = (anchor.htmlAdditionalTargets ?? []).flatMap(t =>
          t.anchor ? [t.anchor] : []
        )
        return [
          {
            id: String(c.id),
            type: c.kind === 'suggestion' ? 'deletion' : 'comment',
            originalText: anchor.originalText,
            anchor: anchor.htmlAnchor ?? null,
            additionalAnchors: additional.length ? additional : null,
            number,
          } satisfies BridgeComment,
        ]
      }),
    [comments]
  )

  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  // The parent saves only what it asked for: a document's own scripts can
  // post a forged `serialized` message from inside the sandbox.
  const saveRequest = useRef<
    null | { kind: 'save' } | { kind: 'apply'; id: number }
  >(null)
  const inFlight = useRef(false)
  const queryClient = useQueryClient()
  const replaceContent = useReplaceDraftContent()
  const createRevision = useCreateRevision()
  const setCommentStatus = useSetCommentStatus(id)

  const guardLeave = () => !editMode || window.confirm('Discard unsaved edits?')
  useEffect(() => {
    if (!editMode) return
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [editMode])

  const saveSerialized = async (html: string): Promise<boolean> => {
    if (!doc || !content.data) {
      inFlight.current = false
      setSaving(false)
      return false
    }
    const clean = stripViewerInjection(html, content.data)
    try {
      if (doc.status === 'draft') {
        await replaceContent.mutateAsync({ id: doc.id, html: clean })
        exitEdit()
        queryClient.setQueryData(documentKeys.content(doc.id), clean)
        setFrameKey(k => k + 1)
      } else {
        const created = await createRevision.mutateAsync({
          code: doc.code,
          html: clean,
        })
        exitEdit()
        navigateToDocument(created.id)
      }
      return true
    } catch {
      return false
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const bridge = useDocumentBridge({
    iframeRef,
    documentKey: `${id}:${mode}:${frameKey}`,
    comments: bridgeComments,
    inputMethod,
    annotateActive: !editMode,
    onSelection: s => {
      setSelection(s)
      // A global composer keeps its draft when the frame clears its selection.
      if (!s) setComposer(c => (c?.mode === 'global' ? c : null))
    },
    onSelectionRect: r => setSelection(s => (s ? { ...s, rect: r } : s)),
    onMarkClick: markId => {
      setSelectedId(markId)
      setPanelOpen(true)
    },
    onSerialized: (html, appliedId) => {
      const request = saveRequest.current
      saveRequest.current = null
      if (!request) {
        console.warn('ignored unsolicited serialized message')
        return
      }
      void saveSerialized(html).then(ok => {
        if (
          ok &&
          request.kind === 'apply' &&
          appliedId &&
          String(request.id) === appliedId
        ) {
          setCommentStatus.mutate({ id: request.id, status: 'resolved' })
        }
      })
    },
    onApplyFailed: () => {
      saveRequest.current = null
      inFlight.current = false
      setSaving(false)
      toast.error('That suggestion lost its place in this revision')
    },
  })

  const enterEdit = () => {
    setEditMode(true)
    setSelection(null)
    setComposer(null)
    bridge.setEditMode(true)
  }
  function exitEdit() {
    saveRequest.current = null
    setEditMode(false)
    bridge.setEditMode(false)
  }
  const cancelEdit = () => {
    exitEdit()
    setFrameKey(k => k + 1)
  }

  // The iframe is the stage's first child, so frame coords are stage coords.
  const stageRect = selection?.rect ?? null

  const uploadImage = useCallback(
    async (blob: Blob, name: string) =>
      (await addDocumentCommentAttachment(id, blob, name)).id,
    [id]
  )

  const submitComment = async (
    v: { body: string; suggested_text?: string; label?: string | null },
    m: ComposerMode
  ) => {
    const anchor =
      m === 'global' || !selection
        ? null
        : {
            originalText:
              selection.pinpoint && SYNTHETIC_ELEMENT_QUOTE.test(selection.text)
                ? ''
                : selection.text,
            htmlAnchor: selection.anchor ?? undefined,
            elementContext: (selection.context ?? undefined) as
              | Record<string, unknown>
              | undefined,
          }
    const created = await createComment.mutateAsync({
      kind: m === 'suggestion' ? 'suggestion' : 'comment',
      body: v.body,
      suggested_text: m === 'suggestion' ? v.suggested_text : undefined,
      label: v.label ?? null,
      anchor,
    })
    if (anchor)
      bridge.createMark(
        String(created.id),
        m === 'suggestion' ? 'deletion' : 'comment'
      )
    bridge.cancelSelection()
    setComposer(null)
    setSelection(null)
    setPanelOpen(true)
  }
  const quickLabel = async (label: CommentLabel) => {
    if (createComment.isPending) return
    try {
      await submitComment({ body: '', label: label.id }, 'comment')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the comment')
    }
  }

  const panel = doc && (
    <CommentsPanel
      docId={id}
      currentRevision={doc.revision}
      comments={panelComments}
      labels={labels}
      filter={filter}
      onFilterChange={setFilter}
      unanchoredIds={bridge.unanchoredIds}
      selectedId={selectedId}
      onSelect={markId => {
        setSelectedId(markId)
        bridge.scrollTo(markId)
      }}
      onGlobalComment={() => {
        setSelection(null)
        setComposer({ mode: 'global', label: null })
      }}
      headings={bridge.headings}
      onNavigateHeading={bridge.scrollToFragment}
      me={user ? { id: user.id } : null}
      isAdmin={isAdmin}
      onApply={c => {
        if (!c.suggested_text) return
        if (inFlight.current || saveRequest.current) return
        inFlight.current = true
        setSaving(true)
        saveRequest.current = { kind: 'apply', id: c.id }
        bridge.applyReplacement(String(c.id), c.suggested_text)
      }}
    />
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (guardLeave()) clear()
          }}
        >
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
              <ToggleGroup
                type="single"
                value={inputMethod}
                onValueChange={v =>
                  v && setInputMethod(v as 'drag' | 'pinpoint')
                }
                aria-label="Annotation mode"
                size="sm"
              >
                <ToggleGroupItem value="drag" aria-label="Select">
                  <TextCursor className="h-4 w-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="pinpoint" aria-label="Pinpoint">
                  <MousePointerClick className="h-4 w-4" />
                </ToggleGroupItem>
              </ToggleGroup>
              <Button
                variant={panelOpen ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setPanelOpen(!panelOpen)}
              >
                <MessageSquareText className="mr-1 h-4 w-4" />
                Comments ({openCount})
              </Button>
              {/* Threads anchor on the CODE, so they follow the document
                  across revisions. */}
              <EntityFlagButton entityType="document" entityId={doc.code} />
              {doc.revisions.length > 1 && (
                <Select
                  value={String(doc.id)}
                  onValueChange={v => {
                    if (guardLeave()) navigateToDocument(Number(v))
                  }}
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
                  disabled={bridge.status !== 'ready' || editMode}
                  onClick={enterEdit}
                >
                  <FilePenLine className="mr-1 h-4 w-4" />
                  Edit
                </Button>
              )}
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetitling(true)}
                >
                  <Pencil className="mr-1 h-4 w-4" />
                  Edit details
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {editMode && (
        <EditModeBar
          saving={saving}
          onSave={() => {
            if (inFlight.current || saveRequest.current) return
            inFlight.current = true
            setSaving(true)
            saveRequest.current = { kind: 'save' }
            bridge.serialize()
          }}
          onCancel={cancelEdit}
        />
      )}

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
        <>
          <ResizablePanelGroup
            direction="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              id="document-frame"
              order={1}
              defaultSize={72}
              minSize={40}
            >
              <div className="flex h-full flex-col overflow-y-auto">
                {bridge.status === 'unavailable' && (
                  <p
                    role="status"
                    className="border-b bg-muted px-3 py-1 text-xs text-muted-foreground"
                  >
                    Annotation tools did not load
                    {bridge.unavailable?.kind === 'version-mismatch'
                      ? ` (bridge version ${bridge.unavailable.reported ?? 'none'})`
                      : ''}
                    . The document is shown read-only; global comments still
                    work.
                  </p>
                )}
                <div className="relative min-h-0 flex-1">
                  <iframe
                    key={frameKey}
                    ref={iframeRef}
                    title={doc?.title ?? `Document ${id}`}
                    sandbox="allow-scripts"
                    srcDoc={srcDoc}
                    className="block w-full border-0 bg-background"
                    style={{
                      height:
                        bridge.status === 'ready' ? bridge.height : '100%',
                    }}
                  />
                  {selection &&
                    !composer &&
                    bridge.status === 'ready' &&
                    stageRect && (
                      <SelectionToolbar
                        rect={stageRect}
                        labels={labels}
                        onComment={() =>
                          setComposer({ mode: 'comment', label: null })
                        }
                        onSuggest={() =>
                          setComposer({ mode: 'suggestion', label: null })
                        }
                        onLabel={quickLabel}
                        onThumbsUp={() => {
                          const l = labels.find(x => x.id === 'nice-work')
                          if (l) quickLabel(l)
                        }}
                      />
                    )}
                  {composer && (
                    <CommentComposer
                      open
                      rect={composer.mode === 'global' ? null : stageRect}
                      mode={composer.mode}
                      quote={
                        composer.mode === 'global'
                          ? ''
                          : (selection?.text ?? '')
                      }
                      labels={labels}
                      initialLabel={composer.label}
                      onSubmit={v => submitComment(v, composer.mode)}
                      onCancel={() => {
                        setComposer(null)
                        setSelection(null)
                        bridge.cancelSelection()
                      }}
                      uploadImage={uploadImage}
                    />
                  )}
                </div>
              </div>
            </ResizablePanel>
            {panelOpen && !narrow && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id="document-comments"
                  order={2}
                  defaultSize={28}
                  minSize={20}
                >
                  {panel}
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
          {narrow && (
            <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
              <SheetContent side="right" className="w-[92vw] p-0">
                {panel}
              </SheetContent>
            </Sheet>
          )}
        </>
      )}

      {doc && (
        <RetitleDialog doc={doc} open={retitling} onOpenChange={setRetitling} />
      )}
    </div>
  )
}
