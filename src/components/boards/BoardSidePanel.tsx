import { useState } from 'react'
import { ExternalLink, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { FlagCard } from '@/components/flags/FlagCard'
import { RaiseFlagButton } from '@/components/flags/RaiseFlagButton'
import { entityMeta, navigateToDeepLink } from '@/components/flags/flag-entity'
import { useEntityFlags } from '@/hooks/use-flags'
import {
  useBoardsForEntity,
  useDeleteNode,
  usePatchNode,
} from '@/services/boards'
import { useDirectoryUsers } from '@/services/groups'
import type { BoardDetail, BoardNode } from '@/lib/api-boards'
import { DocumentPreviewFrame } from './DocumentPreviewFrame'
import { isSafeHttpUrl, openExternal } from './open-external'

const GENERIC = new Set(['frame', 'text', 'note', 'link', 'person', 'widget'])

function anchorOf(node: BoardNode): { type: string; id: string } {
  return node.kind === 'entity' && node.entity_type && node.entity_id
    ? { type: node.entity_type, id: node.entity_id }
    : { type: 'board_node', id: String(node.id) }
}

export function BoardSidePanel({
  board,
  selectedId,
  onClose,
}: {
  board: BoardDetail
  selectedId: number | null
  onClose: () => void
}) {
  const node = board.nodes.find(n => n.id === selectedId) ?? null
  if (!node) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Select a node to see its flags and details.
      </div>
    )
  }
  return <NodePanel key={node.id} board={board} node={node} onClose={onClose} />
}

function NodePanel({
  board,
  node,
  onClose,
}: {
  board: BoardDetail
  node: BoardNode
  onClose: () => void
}) {
  const canEdit = board.can_edit
  const anchor = anchorOf(node)
  const flags = useEntityFlags(anchor.type, anchor.id, {
    includeDescendants: node.kind === 'frame',
  })
  const patch = usePatchNode(board.slug)
  const remove = useDeleteNode(board.slug)
  const [label, setLabel] = useState(node.label)
  const meta = node.kind === 'entity' ? entityMeta(node.entity_type) : null
  const groupNames = board.grants.map(g => g.group_name).join(', ')

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {node.kind}
        </span>
        <span className="font-medium">{node.context?.label ?? node.label}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          aria-label="Close panel"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {canEdit && GENERIC.has(node.kind) && (
        <div className="grid gap-1">
          <Label htmlFor={`node-label-${node.id}`} className="text-xs">
            Label
          </Label>
          <div className="flex gap-2">
            <Input
              id={`node-label-${node.id}`}
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={
                patch.isPending || label.trim() === node.label || !label.trim()
              }
              onClick={() => {
                const trimmed = label.trim()
                patch.mutate(
                  {
                    id: node.id,
                    data: { version: node.version, label: trimmed },
                  },
                  { onSuccess: () => setLabel(trimmed) }
                )
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      <section>
        <div className="mb-1 text-xs text-muted-foreground">
          Open flags{node.kind === 'frame' ? ' (including items inside)' : ''} (
          {flags.data?.length ?? 0})
        </div>
        <div className="space-y-2">
          {(flags.data ?? []).map(f => (
            <FlagCard key={f.id} flag={f} />
          ))}
          {flags.data?.length === 0 && (
            <p className="text-xs text-muted-foreground">None.</p>
          )}
        </div>
        {canEdit && (
          <div className="mt-2 space-y-1">
            <RaiseFlagButton
              entityType={anchor.type}
              entityId={anchor.id}
              targetLabel={node.label}
              variant="compact"
            />
            {board.visibility === 'restricted' && (
              <p className="text-xs text-muted-foreground">
                Visible to {groupNames || 'no groups'} and admins.
              </p>
            )}
          </div>
        )}
      </section>

      {node.kind === 'note' && (
        <NoteEditor
          node={node}
          canEdit={canEdit}
          onSave={(md, onSaved) =>
            patch.mutate(
              {
                id: node.id,
                data: { version: node.version, data: { markdown: md } },
              },
              { onSuccess: onSaved }
            )
          }
          pending={patch.isPending}
        />
      )}
      {node.kind === 'link' && (
        <LinkFields
          node={node}
          canEdit={canEdit}
          onSave={(url, onSaved) =>
            patch.mutate(
              { id: node.id, data: { version: node.version, data: { url } } },
              { onSuccess: onSaved }
            )
          }
          pending={patch.isPending}
        />
      )}
      {node.kind === 'entity' && meta && (
        <section className="space-y-2">
          <div className="text-xs text-muted-foreground">{meta.label}</div>
          {node.entity_type === 'document' &&
            node.context?.deep_link?.kind === 'document' && (
              <DocumentPreviewFrame id={Number(node.context.deep_link.id)} />
            )}
          <DeepLinkButton deepLink={node.context?.deep_link} />
          <OnBoards
            type={node.entity_type}
            id={node.entity_id}
            current={board.slug}
          />
        </section>
      )}
      {node.kind === 'person' && <PersonInfo node={node} />}

      {canEdit && (
        <div className="mt-auto">
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(node.id, { onSuccess: onClose })}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            Delete node
          </Button>
        </div>
      )}
    </div>
  )
}

function NoteEditor({
  node,
  canEdit,
  onSave,
  pending,
}: {
  node: BoardNode
  canEdit: boolean
  onSave: (md: string, onSaved: () => void) => void
  pending: boolean
}) {
  const initial = String(
    (node.data as { markdown?: string } | null)?.markdown ?? ''
  )
  const [md, setMd] = useState(initial)
  if (!canEdit)
    return (
      <pre className="whitespace-pre-wrap rounded-md border p-2 text-xs">
        {initial}
      </pre>
    )
  return (
    <section className="grid gap-1">
      <Label htmlFor={`note-md-${node.id}`} className="text-xs">
        Markdown
      </Label>
      <Textarea
        id={`note-md-${node.id}`}
        value={md}
        onChange={e => setMd(e.target.value)}
        rows={8}
        className="text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={pending || md === initial}
        onClick={() => onSave(md, () => setMd(md))}
      >
        Save note
      </Button>
    </section>
  )
}

function LinkFields({
  node,
  canEdit,
  onSave,
  pending,
}: {
  node: BoardNode
  canEdit: boolean
  onSave: (url: string, onSaved: () => void) => void
  pending: boolean
}) {
  const initial = String((node.data as { url?: string } | null)?.url ?? '')
  const [url, setUrl] = useState(initial)
  const safe = isSafeHttpUrl(initial)
  return (
    <section className="grid gap-1">
      <Label htmlFor={`link-url-${node.id}`} className="text-xs">
        URL
      </Label>
      {canEdit ? (
        <div className="flex gap-2">
          <Input
            id={`link-url-${node.id}`}
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending || url === initial || !isSafeHttpUrl(url)}
            onClick={() => {
              const trimmed = url.trim()
              onSave(trimmed, () => setUrl(trimmed))
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <span id={`link-url-${node.id}`} className="break-all text-xs">
          {initial}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!safe}
        onClick={() => openExternal(initial)}
      >
        <ExternalLink className="mr-1 h-4 w-4" />
        Open externally
      </Button>
    </section>
  )
}

function DeepLinkButton({
  deepLink,
}: {
  deepLink: { kind: string; id: string } | null | undefined
}) {
  if (!deepLink || deepLink.kind === 'none') return null
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => navigateToDeepLink(deepLink)}
    >
      Open
    </Button>
  )
}

function PersonInfo({ node }: { node: BoardNode }) {
  const directory = useDirectoryUsers()
  const uid = Number((node.data as { user_id?: number } | null)?.user_id)
  const u = directory.data?.find(x => x.id === uid)
  return (
    <section className="text-xs text-muted-foreground">
      {u ? u.email : `user ${uid}`}
    </section>
  )
}

function OnBoards({
  type,
  id,
  current,
}: {
  type: string | null
  id: string | null
  current: string
}) {
  const refs = useBoardsForEntity(type, id)
  const others = (refs.data ?? []).filter(r => r.board_slug !== current)
  if (others.length === 0) return null
  return (
    <div className="text-xs text-muted-foreground">
      Also on: {others.map(r => `${r.board_name} > ${r.node_label}`).join(', ')}
    </div>
  )
}
