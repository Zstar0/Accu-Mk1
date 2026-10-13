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
import { useTheme } from '@/hooks/use-theme'
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
  pullThrough,
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
  const { fitView, screenToFlowPosition, getInternalNode, getViewport } =
    useReactFlow()
  // Pull-through: where the pointer grabbed the dragged child (canvas units) and the frame it popped out of.
  const grabRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const poppedRef = useRef<{ id: string; from: string } | null>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  // Read once into state (React Compiler: no impure reads during render).
  const [initialViewport] = useState(() =>
    readViewport(board.slug, board.default_viewport)
  )
  // xyflow styles its own Controls, MiniMap and Background per colorMode; 'system' tracks the OS like the app does.
  const { theme } = useTheme()
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

  const handleDragStart = useCallback(
    (e: MouseEvent | TouchEvent, n: Node) => {
      onSelect(Number(n.id))
      grabRef.current = null
      poppedRef.current = null
      const abs = getInternalNode(n.id)?.internals.positionAbsolute
      if (!n.parentId || !abs || !('clientX' in e)) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      grabRef.current = { id: n.id, dx: p.x - abs.x, dy: p.y - abs.y }
    },
    [onSelect, getInternalNode, screenToFlowPosition]
  )

  // A child dragged against its frame edge leans toward the pointer, then pops out past POP_AT
  // (spec 8.7): xyflow re-reads parentId/extent every move, so clearing them un-clamps the node live.
  const handleDrag = useCallback(
    (e: MouseEvent | TouchEvent, n: Node) => {
      const grab = grabRef.current
      if (!grab || grab.id !== n.id || !n.parentId || !('clientX' in e)) return
      const abs = getInternalNode(n.id)?.internals.positionAbsolute
      if (!abs) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const wanted = { x: p.x - grab.dx, y: p.y - grab.dy }
      const { stretch, pop } = pullThrough(wanted, abs, getViewport().zoom)
      if (pop) {
        poppedRef.current = { id: n.id, from: n.parentId }
        grabRef.current = null
      }
      setNodes(ns =>
        ns.map(x => {
          if (x.id !== n.id) return x
          const { translate: _t, ...style } = (x.style ?? {}) as Record<
            string,
            unknown
          >
          if (pop)
            return {
              ...x,
              parentId: undefined,
              extent: undefined,
              position: wanted,
              style,
            }
          const lean = stretch.x || stretch.y
          if (!lean && _t === undefined) return x
          return {
            ...x,
            style: lean
              ? { ...style, translate: `${stretch.x}px ${stretch.y}px` }
              : style,
          }
        })
      )
    },
    [getInternalNode, screenToFlowPosition, getViewport, setNodes]
  )

  const handleDragStop = useCallback(
    (_: unknown, _node: Node, dragged: Node[]) => {
      const popped = poppedRef.current
      grabRef.current = null
      poppedRef.current = null
      // Spring back if it was leaning and did not pop.
      setNodes(ns =>
        ns.map(x => {
          if (x.style?.translate === undefined) return x
          const { translate: _t, ...style } = x.style
          return { ...x, style }
        })
      )
      if (!canEdit) return
      // A node that just popped out must not be re-adopted by the frame it left.
      const frames = toFrameRects(nodes).filter(f => f.id !== popped?.from)
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
    [canEdit, nodes, rows, patchPositions, setNodes]
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

  const edgeBusy =
    createEdge.isPending || patchEdge.isPending || deleteEdge.isPending

  // mutateAsync throughout: a per-call mutate(vars, { onSuccess }) is dropped as soon as the
  // same hook mutates again, and the hooks already toast on error.
  const retype = (kind: EdgeKind) => {
    if (!pickedEdge || kind === pickedKind || edgeBusy) return
    const id = Number(pickedEdge.id)
    if ((kind === 'reports_to') === (pickedKind === 'reports_to'))
      return patchEdge.mutate({ id, data: { kind } })
    // Into or out of a reporting line the stored ends swap, which PATCH cannot do:
    // store the new line, then drop the old one, so the drawn line stays where it is.
    createEdge
      .mutateAsync({
        ...edgeCreateFor(
          Number(pickedEdge.source),
          Number(pickedEdge.target),
          kind
        ),
        label: (pickedEdge.data?.label as string | null | undefined) ?? null,
      })
      .then(
        () => deleteEdge.mutate(id),
        () => undefined
      )
  }

  const selectedFrame =
    selectedId != null && rows.get(selectedId)?.kind === 'frame'
      ? String(selectedId)
      : null

  // Auto-layout (spec 8.3): the selected frame's items, else the top-level items. An org
  // board arranges by its reporting lines only; any other board uses every line.
  const runLayout = () => {
    if (patchPositions.isPending) return
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
      board.kind === 'org'
        ? edges.filter(e => e.data?.kind === 'reports_to')
        : edges,
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
    const w = frame?.w ?? FRAME_DEFAULT.width
    const h = frame?.h ?? FRAME_DEFAULT.height
    // Grow the frame first (never shrink it) so the items are never stored outside it;
    // a failed resize skips the move.
    const grow =
      frame && size && (size.width > w || size.height > h)
        ? patchNode.mutateAsync(
            resizePatch(frame, {
              width: Math.max(w, size.width),
              height: Math.max(h, size.height),
            })
          )
        : Promise.resolve()
    grow
      .then(() => patchPositions.mutateAsync(items))
      .then(
        saved =>
          toast.success('Layout applied', {
            action: {
              label: 'Undo',
              onClick: () =>
                patchPositions.mutate(undoPositionItems(rows, saved)),
            },
          }),
        () => undefined
      )
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
        onNodeDragStart={handleDragStart}
        onNodeDrag={handleDrag}
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
        colorMode={theme}
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
              disabled={patchPositions.isPending}
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
              disabled={edgeBusy}
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
