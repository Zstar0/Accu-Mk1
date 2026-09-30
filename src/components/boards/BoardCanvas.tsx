import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type Edge,
  type Node,
  type NodeChange,
  type Viewport,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { BoardDetail } from '@/lib/api-boards'
import {
  useCreateEdge,
  useCreateNode,
  useDeleteEdge,
  usePatchPositions,
} from '@/services/boards'
import { useUIStore } from '@/store/ui-store'
import { nodeTypes } from './nodes'
import { BoardToolDrawer } from './BoardToolDrawer'
import {
  DRAWER_MIME,
  defaultNodeCreate,
  dropTargetFor,
  edgeIdsToDelete,
  isDrawerKind,
  parseViewport,
  resolveParentOnDrop,
  toFlowEdges,
  toFlowNodes,
  toFrameRects,
  toPositionItems,
  type BoardFlowNode,
  type DrawerKind,
} from './board-mapping'

export interface BoardCanvasProps {
  board: BoardDetail
  canEdit: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
  /** Link, person and entity kinds need the palette's next step to finish the item. */
  onRequestAdd?: (req: AddRequest) => void
}

export interface AddRequest {
  kind: DrawerKind
  dropAt: XYPosition
  parentId: number | null
}

const VIEWPORT_KEY = (slug: string) => `boards:viewport:${slug}`

function readViewport(
  slug: string,
  fallback: Viewport | null
): Viewport | undefined {
  try {
    const stored = parseViewport(
      window.localStorage.getItem(VIEWPORT_KEY(slug))
    )
    if (stored) return stored
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
  onRequestAdd,
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
  const deleteEdge = useDeleteEdge(board.slug)
  const createNode = useCreateNode(board.slug)
  const { fitView, screenToFlowPosition } = useReactFlow()
  const flowRef = useRef<HTMLDivElement>(null)
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
      const frames = toFrameRects(nodes)
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

  // Edges delete through the API; returning false means xyflow never removes
  // anything locally, and nodes are only ever deleted from the side panel.
  const handleBeforeDelete = useCallback(
    async ({ edges: doomed }: { edges: Edge[] }) => {
      if (canEdit) edgeIdsToDelete(doomed).forEach(id => deleteEdge.mutate(id))
      return false
    },
    [canEdit, deleteEdge]
  )

  // Drawer placement: frame, text and note are created straight away; the rest need the
  // palette's next step, so the page opens it at this drop point.
  const placeAt = (kind: DrawerKind, at: XYPosition) => {
    if (!canEdit) return
    const { position, parentId } = dropTargetFor(kind, at, toFrameRects(nodes))
    if (kind === 'frame' || kind === 'text' || kind === 'note')
      createNode.mutate({
        ...defaultNodeCreate(kind),
        x: position.x,
        y: position.y,
        parent_id: parentId,
      })
    else onRequestAdd?.({ kind, dropAt: position, parentId })
  }

  const placeAtCenter = (kind: DrawerKind) => {
    const r = flowRef.current?.getBoundingClientRect()
    if (!r) return
    placeAt(
      kind,
      screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    )
  }

  return (
    <>
      <ReactFlow
        ref={flowRef}
        onDragOver={e => {
          if (!canEdit || !e.dataTransfer.types.includes(DRAWER_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={e => {
          const kind = e.dataTransfer.getData(DRAWER_MIME)
          if (!canEdit || !isDrawerKind(kind)) return
          e.preventDefault()
          placeAt(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
        }}
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
        edgesFocusable
        deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
        onBeforeDelete={handleBeforeDelete}
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
      {/* Renders into the wrapper div, beside (not inside) the flow; placeAtCenter needs useReactFlow. */}
      <BoardToolDrawer canEdit={canEdit} onPlace={placeAtCenter} />
    </>
  )
}

export default function BoardCanvas(props: BoardCanvasProps) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  )
}
