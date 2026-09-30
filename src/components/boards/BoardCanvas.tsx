import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  Panel,
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
import { Network } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { BoardDetail, EdgeKind } from '@/lib/api-boards'
import {
  useCreateEdge,
  useCreateNode,
  useDeleteEdge,
  usePatchEdge,
  usePatchNode,
  usePatchPositions,
} from '@/services/boards'
import { useUIStore } from '@/store/ui-store'
import { nodeTypes } from './nodes'
import { BoardToolDrawer } from './BoardToolDrawer'
import { layoutScope } from './board-layout'
import {
  DRAWER_MIME,
  EDGE_KINDS,
  FRAME_DEFAULT,
  NODE_DEFAULT,
  defaultNodeCreate,
  dropTargetFor,
  edgeCreateFor,
  edgeIdsToDelete,
  isDrawerKind,
  parseViewport,
  resizePatch,
  resolveParentOnDrop,
  toFlowEdges,
  toFlowNodes,
  toFrameRects,
  toPositionItems,
  undoPositionItems,
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
  const patchNode = usePatchNode(board.slug)
  const createEdge = useCreateEdge(board.slug)
  const patchEdge = usePatchEdge(board.slug)
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
      // An org board's lines are reporting lines: drag from the manager to the report.
      createEdge.mutate(
        edgeCreateFor(
          Number(c.source),
          Number(c.target),
          board.kind === 'org' ? 'reports_to' : 'related'
        )
      )
    },
    [canEdit, createEdge, board.kind]
  )

  // The kind picker acts on the one selected line.
  const picked = edges.filter(e => e.selected)
  const pickedEdge = picked.length === 1 ? picked[0] : undefined
  const pickedKind = pickedEdge?.data?.kind as EdgeKind | undefined

  const retype = (kind: EdgeKind) => {
    if (!pickedEdge || kind === pickedKind) return
    const id = Number(pickedEdge.id)
    if ((kind === 'reports_to') === (pickedKind === 'reports_to'))
      return patchEdge.mutate({ id, data: { kind } })
    // Into or out of a reporting line the stored ends swap, which PATCH cannot do:
    // store the new line, then drop the old one, so the drawn line stays where it is.
    createEdge.mutate(
      {
        ...edgeCreateFor(
          Number(pickedEdge.source),
          Number(pickedEdge.target),
          kind
        ),
        label: (pickedEdge.data?.label as string | null | undefined) ?? null,
      },
      { onSuccess: () => deleteEdge.mutate(id) }
    )
  }

  const selectedFrame =
    selectedId != null && rows.get(selectedId)?.kind === 'frame'
      ? String(selectedId)
      : null

  // Auto-layout (spec 8.3): the selected frame's items, else the top-level items.
  const runLayout = () => {
    const { moved, size } = layoutScope(
      nodes.map(n => {
        const d = n.type === 'frame' ? FRAME_DEFAULT : NODE_DEFAULT
        return {
          id: n.id,
          parentId: n.parentId,
          position: n.position,
          width: Number(n.measured?.width ?? n.style?.width ?? d.width),
          height: Number(n.measured?.height ?? n.style?.height ?? d.height),
        }
      }),
      edges,
      selectedFrame
    )
    const items = toPositionItems(
      rows,
      moved.map(m => ({ ...m, parentId: selectedFrame ?? undefined }))
    )
    if (!items.length) {
      toast.info(
        'Nothing to arrange. Connect items first: Layout orders connected items top-down.'
      )
      return
    }
    const frame = selectedFrame ? rows.get(Number(selectedFrame)) : undefined
    if (frame && size) {
      const w = frame.w ?? FRAME_DEFAULT.width
      const h = frame.h ?? FRAME_DEFAULT.height
      // Grow the frame to hold its items; never shrink it.
      if (size.width > w || size.height > h)
        patchNode.mutate(
          resizePatch(frame, {
            width: Math.max(w, size.width),
            height: Math.max(h, size.height),
          })
        )
    }
    patchPositions.mutate(items, {
      onSuccess: saved =>
        toast.success('Layout applied', {
          action: {
            label: 'Undo',
            onClick: () =>
              patchPositions.mutate(undoPositionItems(rows, saved)),
          },
        }),
    })
  }

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
        {canEdit && (
          <Panel position="top-right">
            <Button
              size="sm"
              variant="outline"
              onClick={runLayout}
              title="Arrange connected items top-down"
            >
              <Network className="mr-1 h-4 w-4" />
              {selectedFrame ? 'Layout frame' : 'Layout'}
            </Button>
          </Panel>
        )}
        {canEdit && pickedEdge && (
          <Panel position="top-center">
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              aria-label="Line kind"
              className="bg-background"
              value={pickedKind}
              onValueChange={v => v && retype(v as EdgeKind)}
            >
              {/* flex-none: the group's items share width equally by default and the labels collide. */}
              {EDGE_KINDS.map(k => (
                <ToggleGroupItem
                  key={k.kind}
                  value={k.kind}
                  className="flex-none px-3"
                >
                  {k.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Panel>
        )}
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
