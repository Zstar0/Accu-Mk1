// src/components/documents/annotations/CommentsPanel.tsx
import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTheme } from '@/hooks/use-theme'
import type {
  CommentLabel,
  CommentStatusFilter,
  DocumentComment,
} from '@/lib/api-document-comments'
import {
  useCreateComment,
  useDeleteComment,
  usePatchComment,
  useSetCommentStatus,
} from '@/services/document-comments'
import type { BridgeHeading } from './bridge-messages'
import { CommentCard, type CardActions } from './CommentCard'
import { ContentsTab } from './ContentsTab'

interface Props {
  docId: number
  currentRevision: number
  comments: DocumentComment[]
  labels: CommentLabel[]
  filter: CommentStatusFilter
  onFilterChange: (f: CommentStatusFilter) => void
  unanchoredIds: ReadonlySet<string>
  selectedId: string | null
  onSelect: (id: string) => void
  onGlobalComment: () => void
  headings: BridgeHeading[]
  onNavigateHeading: (id: string) => void
  me: { id?: number | null } | null
  isAdmin: boolean
  onApply?: (c: DocumentComment) => void
}

export function CommentsPanel(p: Props) {
  const { theme } = useTheme()
  const dark =
    theme === 'dark' ||
    (theme === 'system' &&
      (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false))
  const create = useCreateComment(p.docId)
  const patch = usePatchComment(p.docId)
  const remove = useDeleteComment(p.docId)
  const setStatus = useSetCommentStatus(p.docId)
  const labelMap = useMemo(
    () => new Map(p.labels.map(l => [l.id, l])),
    [p.labels]
  )
  const sorted = useMemo(
    () => [...p.comments].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
    [p.comments]
  )
  const placed = sorted.filter(c => !p.unanchoredIds.has(String(c.id)))
  const lost = sorted.filter(c => p.unanchoredIds.has(String(c.id)))

  const actions: CardActions = {
    reply: async (c, body) => {
      await create.mutateAsync({ parent_id: c.id, body })
    },
    resolve: c => setStatus.mutate({ id: c.id, status: 'resolved' }),
    reopen: c => setStatus.mutate({ id: c.id, status: 'open' }),
    edit: async (c, body) => {
      await patch.mutateAsync({ id: c.id, body: { body } })
    },
    remove: c => {
      if (
        window.confirm(
          `Delete comment ${c.number ?? ''}${c.replies.length ? ' and its replies' : ''}?`
        )
      )
        remove.mutate(c.id)
    },
    apply: p.onApply,
  }
  const canEdit = (c: DocumentComment) =>
    p.isAdmin || (p.me?.id != null && c.author_user_id === p.me.id)
  const card = (c: DocumentComment, isLost: boolean) => (
    <CommentCard
      key={c.id}
      c={c}
      currentRevision={p.currentRevision}
      labels={labelMap}
      lost={isLost}
      selected={p.selectedId === String(c.id)}
      canEdit={canEdit(c)}
      isAdmin={p.isAdmin}
      dark={dark}
      onFocus={() => {
        if (!isLost) p.onSelect(String(c.id))
        else toast.message('This comment lost its place on this revision')
      }}
      actions={actions}
    />
  )

  return (
    <Tabs defaultValue="comments" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <TabsList>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="contents">Contents</TabsTrigger>
        </TabsList>
        <Select
          value={p.filter}
          onValueChange={v => p.onFilterChange(v as CommentStatusFilter)}
        >
          <SelectTrigger
            className="ml-auto h-7 w-[110px] text-xs"
            aria-label="Filter comments"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={p.onGlobalComment}>
          <Globe className="mr-1 h-3.5 w-3.5" />
          Global comment
        </Button>
      </div>
      <TabsContent
        value="comments"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
      >
        {placed.length === 0 && lost.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {p.filter === 'all' ? 'No comments.' : `No ${p.filter} comments.`}
          </p>
        )}
        {placed.map(c => card(c, false))}
        {lost.length > 0 && (
          <section
            aria-label="Lost its place"
            className="space-y-2 border-t pt-2"
          >
            <h4 className="text-xs font-medium text-muted-foreground">
              Lost its place on this revision
            </h4>
            {lost.map(c => card(c, true))}
          </section>
        )}
      </TabsContent>
      <TabsContent value="contents" className="min-h-0 flex-1 overflow-y-auto">
        <ContentsTab headings={p.headings} onNavigate={p.onNavigateHeading} />
      </TabsContent>
    </Tabs>
  )
}
