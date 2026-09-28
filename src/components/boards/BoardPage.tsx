import { lazy, Suspense, useState } from 'react'
import { ArrowLeft, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { useBoard, usePatchBoard } from '@/services/boards'
import { ShareBoardDialog } from './ShareBoardDialog'
import { BoardSidePanel } from './BoardSidePanel'
import { AddNodePalette } from './AddNodePalette'
import { parseViewport } from './board-mapping'

const BoardCanvas = lazy(() => import('./BoardCanvas'))

/** One board (spec §8.1, §8.3, §8.4, §8.7). The canvas ships in its own chunk. */
export function BoardPage({ slug }: { slug: string }) {
  const board = useBoard(slug)
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const navigateToBoards = useUIStore(s => s.navigateToBoards)
  const patch = usePatchBoard(slug)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [share, setShare] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  if (board.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (board.isError || !board.data) {
    return (
      <div className="p-4 text-sm">
        <p className="text-destructive">Board not found.</p>
        <Button variant="link" onClick={navigateToBoards}>
          Back to boards
        </Button>
      </div>
    )
  }
  const b = board.data
  const canEdit = b.can_edit
  const selectedFrameId =
    b.nodes.find(n => n.id === selectedId && n.kind === 'frame')?.id ?? null
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={navigateToBoards}
          aria-label="Back to boards"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="font-medium">{b.name}</span>
        <Badge variant="secondary">{b.kind}</Badge>
        <Badge
          variant={b.visibility === 'restricted' ? 'destructive' : 'outline'}
        >
          {b.visibility}
        </Badge>
        {!canEdit && (
          <span className="text-xs text-muted-foreground">view only</span>
        )}
        <span className="flex-1" />
        <div id="board-toolbar-slot" className="flex items-center gap-2" />
        {canEdit && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Add
          </Button>
        )}
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              let vp: { x: number; y: number; zoom: number } | null = null
              try {
                vp = parseViewport(
                  window.localStorage.getItem(`boards:viewport:${slug}`)
                )
              } catch {
                vp = null
              }
              if (vp) patch.mutate({ default_viewport: vp })
              else
                toast.info(
                  'Pan or zoom the board first, then set it as the default view'
                )
            }}
          >
            Set as default view
          </Button>
        )}
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setShare(true)}>
            Share
          </Button>
        )}
      </div>
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        <ResizablePanel defaultSize={72} minSize={40}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <BoardCanvas
              board={b}
              canEdit={canEdit}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </Suspense>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={28} minSize={20}>
          <BoardSidePanel
            board={b}
            selectedId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      {isAdmin && share && (
        <ShareBoardDialog slug={slug} open={share} onOpenChange={setShare} />
      )}
      {canEdit && (
        <AddNodePalette
          board={b}
          open={addOpen}
          onOpenChange={setAddOpen}
          dropAt={{ x: 120, y: 120 }}
          parentId={selectedFrameId}
        />
      )}
    </div>
  )
}
