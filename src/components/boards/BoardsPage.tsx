import { useState } from 'react'
import { Loader2, Map as MapIcon, Plus } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { useBoards, useCreateBoard, useDeleteBoard } from '@/services/boards'
import type { Board, BoardKind, BoardVisibility } from '@/lib/api-boards'
import { ShareBoardDialog } from './ShareBoardDialog'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/

/** Planning boards list (spec 2026-09-26 §8.2). */
export function BoardsPage() {
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const boards = useBoards()

  if (boards.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (boards.isError || !boards.data) {
    return (
      <p className="p-4 text-sm text-destructive">Could not load boards.</p>
    )
  }
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Boards</h1>
        <p className="text-sm text-muted-foreground">
          Company maps, org charts and training boards. Restricted boards are
          visible to their groups and admins only.
        </p>
      </div>
      {boards.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No boards yet.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {boards.data.map(b => (
          <BoardCard key={b.id} board={b} isAdmin={isAdmin} />
        ))}
      </div>
      {isAdmin && <NewBoardForm />}
    </div>
  )
}

function BoardCard({ board, isAdmin }: { board: Board; isAdmin: boolean }) {
  const navigateToBoard = useUIStore(s => s.navigateToBoard)
  const remove = useDeleteBoard()
  const [share, setShare] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <MapIcon className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{board.name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">{board.kind}</Badge>
        <Badge
          variant={
            board.visibility === 'restricted' ? 'destructive' : 'outline'
          }
        >
          {board.visibility}
        </Badge>
        <span className="text-muted-foreground">{board.node_count} items</span>
        {board.can_edit && (
          <span className="text-muted-foreground">editor</span>
        )}
      </div>
      <div className="mt-auto flex items-center gap-2">
        <Button size="sm" onClick={() => navigateToBoard(board.slug)}>
          Open
        </Button>
        {isAdmin && (
          <>
            <Button size="sm" variant="outline" onClick={() => setShare(true)}>
              Share
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </>
        )}
      </div>
      {isAdmin && share && (
        <ShareBoardDialog
          slug={board.slug}
          open={share}
          onOpenChange={setShare}
        />
      )}
      {isAdmin && (
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete board?</AlertDialogTitle>
              <AlertDialogDescription>
                Its items, connections and the flags raised on them will be
                removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(board.slug, {
                    onSuccess: () => setConfirmDelete(false),
                  })
                }
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function NewBoardForm() {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<BoardKind>('map')
  const [visibility, setVisibility] = useState<BoardVisibility>('company')
  const create = useCreateBoard()
  const valid = SLUG_RE.test(slug.trim()) && name.trim().length > 0
  return (
    <form
      className="grid items-end gap-3 rounded-md border border-dashed p-3 sm:grid-cols-[1fr_1fr_140px_140px_auto]"
      onSubmit={e => {
        e.preventDefault()
        if (!valid || create.isPending) return
        create.mutate(
          { slug: slug.trim(), name: name.trim(), kind, visibility },
          {
            onSuccess: () => {
              setSlug('')
              setName('')
            },
          }
        )
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="board-new-slug" className="text-xs">
          Slug
        </Label>
        <Input
          id="board-new-slug"
          value={slug}
          onChange={e => setSlug(e.target.value.toLowerCase())}
          placeholder="company-map"
          maxLength={60}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="board-new-name" className="text-xs">
          Name
        </Label>
        <Input
          id="board-new-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Company map"
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="board-new-kind" className="text-xs">
          Kind
        </Label>
        <select
          id="board-new-kind"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={kind}
          onChange={e => setKind(e.target.value as BoardKind)}
        >
          <option value="map">map</option>
          <option value="org">org</option>
          <option value="training">training</option>
          <option value="custom">custom</option>
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="board-new-vis" className="text-xs">
          Visibility
        </Label>
        <select
          id="board-new-vis"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={visibility}
          onChange={e => setVisibility(e.target.value as BoardVisibility)}
        >
          <option value="company">Company</option>
          <option value="restricted">Restricted</option>
        </select>
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />
        Create board
      </Button>
    </form>
  )
}
