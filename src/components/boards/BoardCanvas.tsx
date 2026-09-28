import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { BoardDetail } from '@/lib/api-boards'
import { useCreateEdge, usePatchPositions } from '@/services/boards'
import { useUIStore } from '@/store/ui-store'
import { nodeTypes } from './nodes'
import {
  FRAME_DEFAULT,
  resolveParentOnDrop,
  toFlowEdges,
  toFlowNodes,
  toPositionItems,
  type BoardFlowNode,
  type FrameRect,
} from './board-mapping'

export interface BoardCanvasProps {
  board: BoardDetail
  canEdit: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
}

const VIEWPORT_KEY = (slug: string) => `boards:viewport:${slug}`

function readViewport(
  slug: string,
  fallback: Viewport | null
): Viewport | undefined {
  try {
    const raw = window.localStorage.getItem(VIEWPORT_KEY(slug))
    if (raw) return JSON.parse(raw) as Viewport
  } catch {
    /* private mode or blocked storage: fall through */
  }
  return fallback ?? undefined
}

function CanvasInner({
  board,
  canEdit,
  selectedId,
  onSelect,
}: BoardCanvasProps) {
  const rows = useMemo(
    () => new Map(board.nodes.map(n => [n.id, n])),
    [board.nodes]
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<BoardFlowNode>(
    toFlowNodes(board.nodes, canEdit, board.slug)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    toFlowEdges(board.edges)
  )
  const patchPositions = usePatchPositions(board.slug)
  const createEdge = useCreateEdge(board.slug)
  const { fitView } = useReactFlow()
  // Read once into state (React Compiler: no impure reads during render).
  const [initialViewport] = useState(() =>
    readViewport(board.slug, board.default_viewport)
  )
  const pendingNode = useUIStore(s => s.pendingBoardNode)
  const consumePendingBoardNode = useUIStore(s => s.consumePendingBoardNode)

  // Server is the source of truth: refresh local graph when the query data changes.
  useEffect(() => {
    setNodes(toFlowNodes(board.nodes, canEdit, board.slug))
    setEdges(toFlowEdges(board.edges))
  }, [board.nodes, board.edges, board.slug, canEdit, setNodes, setEdges])

  // One-shot deep link: select and centre the node named by the hash. Keyed on the
  // store value so a second deep link into the already-open board also lands.
  useEffect(() => {
    if (!pendingNode) return
    const id = consumePendingBoardNode()
    if (!id) return
    onSelect(Number(id))
    void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.5 })
  }, [pendingNode, consumePendingBoardNode, fitView, onSelect])

  // Selection has ONE source of truth, `selectedId`: xyflow's own select changes are
  // dropped and the `selected` flag is derived here, so the side panel's close also deselects.
  const handleNodesChange = useCallback(
    (changes: NodeChange<BoardFlowNode>[]) =>
      onNodesChange(changes.filter(c => c.type !== 'select')),
    [onNodesChange]
  )
  const shown = useMemo(
    () =>
      nodes.map(n => {
        // Keep identity when the flag is unchanged so xyflow does not re-adopt every node per drag frame.
        const want = selectedId != null && n.id === String(selectedId)
        return (n.selected ?? false) === want ? n : { ...n, selected: want }
      }),
    [nodes, selectedId]
  )

  const handleDragStop = useCallback(
    (_: unknown, _node: Node, dragged: Node[]) => {
      if (!canEdit) return
      const frames: FrameRect[] = nodes
        .filter(n => n.type === 'frame')
        .map(n => ({
          id: n.id,
          position: n.position,
          width: Number(
            n.measured?.width ?? n.style?.width ?? FRAME_DEFAULT.width
          ),
          height: Number(
            n.measured?.height ?? n.style?.height ?? FRAME_DEFAULT.height
          ),
        }))
      const moved = dragged.map(n => {
        // Frames never nest: a dragged frame is resolved against no frames.
        const resolved = resolveParentOnDrop(
          {
            id: n.id,
            position: n.position,
            parentId: n.parentId,
            width: n.measured?.width,
            height: n.measured?.height,
          },
          n.type === 'frame' ? [] : frames
        )
        return {
          id: n.id,
          position: resolved.position,
          parentId: resolved.parentId ?? undefined,
        }
      })
      const items = toPositionItems(rows, moved)
      if (items.length) patchPositions.mutate(items)
    },
    [canEdit, nodes, rows, patchPositions]
  )

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || !c.source || !c.target || c.source === c.target) return
      createEdge.mutate({
        source_id: Number(c.source),
        target_id: Number(c.target),
        kind: 'related',
      })
    },
    [canEdit, createEdge]
  )

  return (
    <ReactFlow
      nodes={shown}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, n) => onSelect(Number(n.id))}
      // Drag selects first, so xyflow's drag set is only this node (selection stays controlled).
      selectNodesOnDrag={false}
      onNodeDragStart={(_, n) => onSelect(Number(n.id))}
      onNodeDragStop={handleDragStop}
      onConnect={handleConnect}
      onPaneClick={() => onSelect(null)}
      onMoveEnd={(_, vp) => {
        try {
          window.localStorage.setItem(
            VIEWPORT_KEY(board.slug),
            JSON.stringify(vp)
          )
        } catch {
          /* ignore */
        }
      }}
      nodesDraggable={canEdit}
      nodesConnectable={canEdit}
      elementsSelectable
      // Delete goes through the API (a later task); never a local-only Backspace removal.
      deleteKeyCode={null}
      defaultViewport={initialViewport}
      fitView={!initialViewport}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export default function BoardCanvas(props: BoardCanvasProps) {
  return (
    <div className="h-full w-full overflow-hidden bg-background">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  )
}
