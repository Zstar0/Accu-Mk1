import type { BoardDetail } from '@/lib/api-boards'
export function BoardSidePanel({
  board,
  selectedId,
}: {
  board: BoardDetail
  selectedId: number | null
  onClose: () => void
}) {
  const node = board.nodes.find(n => n.id === selectedId)
  return (
    <div className="p-3 text-sm text-muted-foreground">
      {node ? node.label : 'Select a node'}
    </div>
  )
}
