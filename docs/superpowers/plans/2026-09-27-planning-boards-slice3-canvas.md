# Planning Boards Slice 3: Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the boards UI: a boards list, an infinite-canvas page on the installed `@xyflow/react` with every v1 node kind, typed edges, persistence with optimistic versions, a side panel that reuses the flag components, an add palette, and the `board_node` deep link, all gated the way the backend already is.

**Architecture:** One new section `boards` in the hash router (`#boards/list`, `#boards/board?id=<slug>&node=<id>`), one API client (`src/lib/api-boards.ts`) plus TanStack hooks (`src/services/boards.ts`) mirroring the groups pair from slice 1, and a lazily loaded canvas (`src/components/boards/BoardCanvas.tsx`) modeled on the existing `GraphCanvas.tsx`. Nodes map one-to-one from the API's `NodeOut` rows to xyflow nodes (`parentId` for frames, `extent: 'parent'`), edges likewise. Persistence is per-node PATCH with `version`, positions through the all-or-nothing batch, viewport in `localStorage`. The side panel composes existing flag pieces (`useEntityFlags`, `FlagCard`, `RaiseFlagButton`, `DocumentViewer`). The live layer (rollup badges, attention dock, zoom-semantic rendering, Cmd+K, dagre layout) is slice 4 by spec §11 and is NOT built here; widgets remain a placeholder.

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind 4 + shadcn/Radix; `@xyflow/react` 12; TanStack Query; zustand ui-store; react-i18next flat keys; vitest + testing-library; Playwright real-stack E2E.

**Spec:** `docs/superpowers/specs/2026-09-26-planning-boards-design.md` §8.1 to §8.5, §8.7, §8.9 (this slice), §4.7 (node data per kind), §7.3 (node/edge API), §3 (concepts). Slice 4 owns §8.3's rollup pills and zoom-semantic rendering, §8.6, and the dagre layout button; slice 5 owns widgets.

## Global Constraints

- Worktree `C:/tmp/Accu-Mk1-boards`. Branch: `feat/planning-boards-s3`, cut from `feat/planning-boards` (slice 1 tip `2184626a`). Slice 3 does not depend on slice 2 at the code level (it talks to the boards API and the flag components only); PRs stack on `feat/planning-boards` and are retargeted to `master` before merging.
- Frontend commands from `C:/tmp/Accu-Mk1-boards`: `npx vitest run <files>`, `npm run typecheck`, `npx eslint <files> --max-warnings 0`, `npx prettier --check <files>`. The repo-wide `format:check` and `test:run` carry pre-existing failures (ledgered in slice 1); the gate is zero findings in touched files and no increase repo-wide.
- No new dependencies. `@xyflow/react`, `@dagrejs/dagre`, `@dnd-kit/*`, `cmdk`, `react-resizable-panels`, `markdown-it`, `dompurify` are already installed.
- Hash format is the repo's `#<section>/<sub>?id=<x>` with one-shot extra params; `node` joins `flag` as a one-shot param that `buildHash` never re-emits.
- Every board write goes through the API with the node's current `version`; a 409 refetches the board and toasts "Board changed elsewhere, reloaded". No client-side merging.
- `link` nodes open externally (Tauri opener plugin when `window.__TAURI__` is present, `window.open(url, '_blank', 'noopener')` otherwise). Never an iframe. No third-party favicon fetch.
- `note` markdown renders through the existing flag comment pipeline (`comment-markdown.ts`: markdown-it + DOMPurify), never `dangerouslySetInnerHTML` with raw text.
- The sidebar item shows when the user is admin or `useVisibleBoards()` returns at least one board; every route is gated server-side anyway.
- Copy: feature pages in this repo hard-code English (`DocumentsPage`, dashboards); the boards pages do the same. Only settings panes use `useTranslation()`. Recorded in spec §14 by Task 6.
- No em dashes anywhere. Pathspec commits with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push (the controller pushes for the E2E stack and the PR). Files stay LF.
- React Compiler is on: never read `localStorage`, `Date`, or any impure source inside render memoization; read once into state (the slice 1 ledger and memory both carry the bug this caused before).

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite a person using this software. Each has a pinned test in the owning task:

1. Dragging a node into a frame and then dragging the frame must keep the node inside it, and the saved coordinates must be relative to the frame (Task 3: `test_drop_into_frame_saves_relative_position`).
2. A stale version (another editor saved first) must not silently overwrite: the client sees a 409, reloads, and the user's last drag is discarded with a toast, never a spinner or a crash (Task 3: `test_stale_version_reloads_board_and_toasts`).
3. A viewer (no edit grant) must see a read-only canvas: no drag, no add button, no delete, no raise-flag, and the side panel still opens (Task 4: `test_viewer_sees_read_only_panel`).
4. A `link` node with a `javascript:` URL can never reach the DOM as an href, even if the API had let it through (Task 3: `test_link_node_renders_http_only`).
5. Deep link `#boards/board?id=<slug>&node=<id>` opens the board, selects and centers that node once, and a later hash rebuild drops `node` (Task 1: `test_node_param_is_one_shot`).

## File structure

Create:

- `src/lib/api-boards.ts`: types mirrored from `backend/boards/schemas.py` (`Board`, `BoardDetail`, `BoardNode`, `BoardEdge`, `Grant`, `NodeCreate`, `NodePatch`, `PositionItem`, `EdgeCreate`) and one function per route.
- `src/services/boards.ts`: `boardKeys`, `useBoards`, `useVisibleBoards` (alias with `select`), `useBoard(slug)`, `useBoardsForEntity`, mutations (`useCreateBoard`, `usePatchBoard`, `useDeleteBoard`, `useReplaceGrants`, `useCreateNode`, `usePatchNode`, `usePatchPositions`, `useDeleteNode`, `useCreateEdge`, `usePatchEdge`, `useDeleteEdge`) with 409 handling in one place.
- `src/components/boards/BoardsPage.tsx`: list + new board dialog (admin) + share dialog (grants) + delete.
- `src/components/boards/BoardPage.tsx`: shell for one board (header, canvas, side panel); lazy-loads the canvas.
- `src/components/boards/BoardCanvas.tsx`: ReactFlow wiring, node/edge mapping, persistence, viewport.
- `src/components/boards/nodes/{FrameNode,TextNode,NoteNode,LinkNode,EntityNode,PersonNode,WidgetNode}.tsx` and `nodes/index.ts` (`nodeTypes`).
- `src/components/boards/BoardSidePanel.tsx`, `src/components/boards/AddNodePalette.tsx`, `src/components/boards/board-mapping.ts` (pure: API rows to xyflow nodes/edges and back), `src/components/boards/open-external.ts`.
- Tests under `src/components/boards/__tests__/`.
- `e2e/planning-boards-slice3.spec.ts` and evidence under `docs/superpowers/evidence/2026-09-27-planning-boards-slice3/`.

Modify:

- `src/store/ui-store.ts` (`ActiveSection` + `BoardsSubSection`, `navigateToBoard`, `navigateToBoardNode`, `pendingBoardNode`), `src/lib/hash-navigation.ts` (`boards` in `VALID_SECTIONS`, one-shot `node`), `src/components/layout/MainWindowContent.tsx` (`case 'boards'`), `src/components/layout/AppSidebar.tsx` (Boards item), `src/components/flags/flag-entity.ts` (`ENTITY_META.board_node`, deep-link case), `locales/{en,ar,fr}.json`, `CHANGELOG.md`, `docs/superpowers/specs/...` §14.

---

### Task 1: Navigation, API client, hooks, deep link

**Files:**
- Create: `src/lib/api-boards.ts`, `src/services/boards.ts`, `src/components/boards/BoardsPage.tsx` (placeholder page so the route renders; Task 2 fills it), `src/components/boards/BoardPage.tsx` (placeholder; Task 3 fills it)
- Modify: `src/store/ui-store.ts`, `src/lib/hash-navigation.ts`, `src/components/layout/MainWindowContent.tsx`, `src/components/layout/AppSidebar.tsx`, `src/components/layout/__tests__/AppSidebar.test.tsx` (mock the new hook), `src/components/flags/flag-entity.ts`
- Test: `src/components/boards/__tests__/navigation.test.tsx`, `src/components/boards/__tests__/api-boards.test.ts`

**Interfaces:**
- `ui-store`: `ActiveSection` gains `'boards'`; `export type BoardsSubSection = 'overview' | 'board'` joins `ActiveSubSection`; state `boardTargetSlug: string | null`, `pendingBoardNode: string | null`; actions `navigateToBoards()`, `navigateToBoard(slug: string)`, `navigateToBoardNode(slug: string, nodeId: string)`, `setPendingBoardNode(nodeId: string | null)`, `consumePendingBoardNode(): string | null`. `navigateTo` clears `boardTargetSlug` (like `documentViewerTargetId`).
- Hash: `#boards/overview`, `#boards/board?id=<slug>`, one-shot `&node=<id>`.
- `api-boards.ts`: types `Board`, `BoardDetail`, `BoardNode`, `BoardEdge`, `Grant`, `NodeKind`, `EdgeKind`, `NodeCreate`, `NodePatch`, `PositionItem`, `EdgeCreate`, `EdgePatch`, `EntityBoardRef`, `BoardCreate`, `BoardPatch`; functions `listBoards`, `getBoard(slug)`, `createBoard`, `patchBoard(slug, data)`, `deleteBoard(slug)`, `replaceGrants(slug, grants)`, `boardsForEntity(type, id)`, `createNode(slug, data)`, `patchNode(slug, id, data)`, `patchPositions(slug, items)`, `deleteNode(slug, id)`, `createEdge(slug, data)`, `patchEdge(slug, id, data)`, `deleteEdge(slug, id)`; `isStale(err)` helper.
- `services/boards.ts`: `boardKeys`, `useBoards()`, `useBoardsNavVisible()`, `useBoard(slug)`, `useBoardsForEntity(type, id)`, and mutations listed in the file map; every node/edge mutation invalidates `boardKeys.detail(slug)`; a 409 anywhere invalidates the board and toasts "Board changed elsewhere, reloaded".
- `flag-entity.ts`: `ENTITY_META.board_node`; `navigateToDeepLink` case `'board_node'` parses `"<slug>:<nodeId>"`.

- [ ] **Step 1: Write the failing tests**

`src/components/boards/__tests__/api-boards.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiFetch: h.apiFetch }))

import {
  createNode, deleteNode, getBoard, isStale, listBoards, patchPositions,
} from '@/lib/api-boards'

describe('api-boards', () => {
  beforeEach(() => h.apiFetch.mockReset())

  it('hits the documented paths with the documented bodies', async () => {
    h.apiFetch.mockResolvedValue([])
    await listBoards()
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards')
    await getBoard('org')
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org')
    await createNode('org', { kind: 'frame', label: 'Marketing', x: 1, y: 2, data: { color: 'purple' } })
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org/nodes', {
      method: 'POST',
      body: JSON.stringify({ kind: 'frame', label: 'Marketing', x: 1, y: 2, data: { color: 'purple' } }),
    })
    await patchPositions('org', [{ id: 3, x: 10, y: 20, version: 1 }])
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org/nodes/positions', {
      method: 'PATCH',
      body: JSON.stringify([{ id: 3, x: 10, y: 20, version: 1 }]),
    })
    await deleteNode('org', 3)
    expect(h.apiFetch).toHaveBeenLastCalledWith('/api/boards/org/nodes/3', { method: 'DELETE' })
  })

  it('recognises a stale-version failure from apiFetch error text', () => {
    expect(isStale(new Error('PATCH /api/boards/org/nodes/3 failed: 409'))).toBe(true)
    expect(isStale(new Error('PATCH /api/boards/org/nodes/3 failed: 400'))).toBe(false)
    expect(isStale('nope')).toBe(false)
  })
})
```

`src/components/boards/__tests__/navigation.test.tsx`:

```tsx
import { render, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useHashNavigation } from '@/lib/hash-navigation'
import { useUIStore } from '@/store/ui-store'
import { navigateToDeepLink } from '@/components/flags/flag-entity'

function Probe() {
  useHashNavigation()
  return null
}

describe('boards navigation', () => {
  beforeEach(() => {
    window.location.hash = ''
    useUIStore.setState({
      activeSection: 'dashboard', activeSubSection: 'orders',
      boardTargetSlug: null, pendingBoardNode: null,
    })
  })

  it('parses #boards/board?id=<slug>&node=<id> and the node param is one-shot', async () => {
    window.location.hash = '#boards/board?id=org&node=42'
    render(<Probe />)
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')) })
    const s = useUIStore.getState()
    expect(s.activeSection).toBe('boards')
    expect(s.activeSubSection).toBe('board')
    expect(s.boardTargetSlug).toBe('org')
    expect(s.pendingBoardNode).toBe('42')
    expect(useUIStore.getState().consumePendingBoardNode()).toBe('42')
    expect(useUIStore.getState().consumePendingBoardNode()).toBeNull()
    act(() => useUIStore.getState().navigateToBoard('org'))
    expect(window.location.hash).toBe('#boards/board?id=org')
  })

  it('navigateTo clears the board target and the list route is #boards/overview', () => {
    render(<Probe />)
    act(() => useUIStore.getState().navigateToBoard('org'))
    expect(useUIStore.getState().boardTargetSlug).toBe('org')
    act(() => useUIStore.getState().navigateTo('boards', 'overview'))
    expect(useUIStore.getState().boardTargetSlug).toBeNull()
    expect(window.location.hash).toBe('#boards/overview')
  })

  it('a board_node deep link opens the board with the node pending', () => {
    expect(navigateToDeepLink({ kind: 'board_node', id: 'exec:7' })).toBe(true)
    const s = useUIStore.getState()
    expect(s.activeSection).toBe('boards')
    expect(s.boardTargetSlug).toBe('exec')
    expect(s.pendingBoardNode).toBe('7')
    expect(navigateToDeepLink({ kind: 'board_node', id: 'malformed' })).toBe(false)
  })
})
```

If `useHashNavigation` applies the hash on mount rather than on `hashchange`, keep the `hashchange` dispatch (harmless) and rely on the mount behavior; the assertions are the same.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/components/boards/__tests__/api-boards.test.ts src/components/boards/__tests__/navigation.test.tsx
```

Expected: module `@/lib/api-boards` not found; store actions undefined.

- [ ] **Step 3: API client**

`src/lib/api-boards.ts`:

```ts
/** Planning boards API client (spec 2026-09-26 §7.2, §7.3). Sibling of api-groups.ts. */
import { apiFetch } from '@/lib/api'

export type NodeKind = 'frame' | 'text' | 'note' | 'link' | 'entity' | 'person' | 'widget'
export type EdgeKind = 'related' | 'reports_to' | 'depends_on' | 'next'
export type BoardKind = 'map' | 'org' | 'training' | 'custom'
export type BoardVisibility = 'company' | 'restricted'

export interface Board {
  id: number
  slug: string
  name: string
  kind: BoardKind
  visibility: BoardVisibility
  created_by: number | null
  default_viewport: { x: number; y: number; zoom: number } | null
  node_count: number
  can_edit: boolean
  created_at: string
  updated_at: string
}

export interface EntityContextLite {
  entity_type: string
  entity_id: string
  label: string
  deep_link?: { kind: string; id: string }
  board_slug?: string | null
  node_kind?: string | null
}

export interface BoardNode {
  id: number
  board_id: number
  kind: NodeKind
  label: string
  parent_id: number | null
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
  entity_type: string | null
  entity_id: string | null
  data: Record<string, unknown> | null
  version: number
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
  context?: EntityContextLite | null
}

export interface BoardEdge {
  id: number
  board_id: number
  source_id: number
  target_id: number
  kind: EdgeKind
  label: string | null
}

export interface Grant {
  group_id: number
  group_slug: string
  group_name: string
  can_edit: boolean
}

export interface BoardDetail extends Board {
  nodes: BoardNode[]
  edges: BoardEdge[]
  grants: Grant[]
}

export interface BoardCreate {
  slug: string
  name: string
  kind?: BoardKind
  visibility?: BoardVisibility
}

export interface BoardPatch {
  name?: string
  kind?: BoardKind
  visibility?: BoardVisibility
  default_viewport?: { x: number; y: number; zoom: number } | null
}

export interface NodeCreate {
  kind: NodeKind
  label?: string
  parent_id?: number | null
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  z?: number
  entity_type?: string
  entity_id?: string
  data?: Record<string, unknown>
}

export interface NodePatch {
  version: number
  label?: string
  parent_id?: number | null
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  z?: number
  data?: Record<string, unknown>
}

export interface PositionItem {
  id: number
  x: number
  y: number
  parent_id?: number | null
  version: number
}

export interface EdgeCreate {
  source_id: number
  target_id: number
  kind?: EdgeKind
  label?: string | null
}

export interface EdgePatch {
  kind?: EdgeKind
  label?: string | null
}

export interface EntityBoardRef {
  board_id: number
  board_slug: string
  board_name: string
  node_id: number
  node_label: string
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export function listBoards(): Promise<Board[]> {
  return apiFetch<Board[]>('/api/boards')
}
export function getBoard(slug: string): Promise<BoardDetail> {
  return apiFetch<BoardDetail>(`/api/boards/${encodeURIComponent(slug)}`)
}
export function createBoard(data: BoardCreate): Promise<Board> {
  return apiFetch<Board>('/api/boards', json('POST', data))
}
export function patchBoard(slug: string, data: BoardPatch): Promise<Board> {
  return apiFetch<Board>(`/api/boards/${encodeURIComponent(slug)}`, json('PATCH', data))
}
export function deleteBoard(slug: string): Promise<void> {
  return apiFetch<undefined>(`/api/boards/${encodeURIComponent(slug)}`, { method: 'DELETE' })
}
export function replaceGrants(slug: string, grants: { group_id: number; can_edit: boolean }[]): Promise<Grant[]> {
  return apiFetch<Grant[]>(`/api/boards/${encodeURIComponent(slug)}/grants`, json('PUT', grants))
}
export function boardsForEntity(entityType: string, entityId: string): Promise<EntityBoardRef[]> {
  const q = new URLSearchParams({ entity_type: entityType, entity_id: entityId })
  return apiFetch<EntityBoardRef[]>(`/api/boards/for-entity?${q.toString()}`)
}
export function createNode(slug: string, data: NodeCreate): Promise<BoardNode> {
  return apiFetch<BoardNode>(`/api/boards/${encodeURIComponent(slug)}/nodes`, json('POST', data))
}
export function patchNode(slug: string, id: number, data: NodePatch): Promise<BoardNode> {
  return apiFetch<BoardNode>(`/api/boards/${encodeURIComponent(slug)}/nodes/${id}`, json('PATCH', data))
}
export function patchPositions(slug: string, items: PositionItem[]): Promise<BoardNode[]> {
  return apiFetch<BoardNode[]>(`/api/boards/${encodeURIComponent(slug)}/nodes/positions`, json('PATCH', items))
}
export function deleteNode(slug: string, id: number): Promise<void> {
  return apiFetch<undefined>(`/api/boards/${encodeURIComponent(slug)}/nodes/${id}`, { method: 'DELETE' })
}
export function createEdge(slug: string, data: EdgeCreate): Promise<BoardEdge> {
  return apiFetch<BoardEdge>(`/api/boards/${encodeURIComponent(slug)}/edges`, json('POST', data))
}
export function patchEdge(slug: string, id: number, data: EdgePatch): Promise<BoardEdge> {
  return apiFetch<BoardEdge>(`/api/boards/${encodeURIComponent(slug)}/edges/${id}`, json('PATCH', data))
}
export function deleteEdge(slug: string, id: number): Promise<void> {
  return apiFetch<undefined>(`/api/boards/${encodeURIComponent(slug)}/edges/${id}`, { method: 'DELETE' })
}

/** apiFetch throws `Error("<METHOD> <path> failed: <status>")`; 409 is the optimistic-lock miss. */
export function isStale(err: unknown): boolean {
  return err instanceof Error && /failed: 409$/.test(err.message)
}
```

Note the test's `toHaveBeenLastCalledWith('/api/boards')` expects a single argument for GETs; do not pass an empty init object to `apiFetch` on reads.

- [ ] **Step 4: Hooks**

`src/services/boards.ts`:

```ts
/** TanStack Query hooks for planning boards. Mirrors services/groups.ts. One place handles 409. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAuthStore } from '@/store/auth-store'
import {
  boardsForEntity, createBoard, createEdge, createNode, deleteBoard, deleteEdge, deleteNode,
  getBoard, isStale, listBoards, patchBoard, patchEdge, patchNode, patchPositions, replaceGrants,
  type BoardCreate, type BoardPatch, type EdgeCreate, type EdgePatch, type NodeCreate,
  type NodePatch, type PositionItem,
} from '@/lib/api-boards'

export const boardKeys = {
  all: ['boards'] as const,
  list: ['boards', 'list'] as const,
  detail: (slug: string) => ['boards', 'detail', slug] as const,
  forEntity: (type: string, id: string) => ['boards', 'for-entity', type, id] as const,
}

export function useBoards() {
  return useQuery({ queryKey: boardKeys.list, queryFn: listBoards, staleTime: 30_000 })
}

/** Sidebar gate (spec §8.1): admins always, everyone else when at least one board is visible. */
export function useBoardsNavVisible(): boolean {
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const boards = useBoards()
  return isAdmin || (boards.data?.length ?? 0) > 0
}

export function useBoard(slug: string | null) {
  return useQuery({
    queryKey: boardKeys.detail(slug ?? ''),
    queryFn: () => getBoard(slug as string),
    enabled: slug != null,
    staleTime: 10_000,
  })
}

export function useBoardsForEntity(type: string | null, id: string | null) {
  return useQuery({
    queryKey: boardKeys.forEntity(type ?? '', id ?? ''),
    queryFn: () => boardsForEntity(type as string, id as string),
    enabled: type != null && id != null,
    staleTime: 30_000,
  })
}

function useBoardMutation<TArgs, TOut>(
  slug: string | null,
  fn: (args: TArgs) => Promise<TOut>,
  successMessage?: string
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (slug) qc.invalidateQueries({ queryKey: boardKeys.detail(slug) })
      qc.invalidateQueries({ queryKey: boardKeys.list })
      if (successMessage) toast.success(successMessage)
    },
    onError: (e: Error) => {
      if (isStale(e)) {
        if (slug) qc.invalidateQueries({ queryKey: boardKeys.detail(slug) })
        toast.error('Board changed elsewhere, reloaded')
        return
      }
      toast.error(e.message)
    },
  })
}

export function useCreateBoard() {
  return useBoardMutation<BoardCreate, unknown>(null, createBoard, 'Board created')
}
export function usePatchBoard(slug: string) {
  return useBoardMutation<BoardPatch, unknown>(slug, data => patchBoard(slug, data), 'Board updated')
}
export function useDeleteBoard() {
  return useBoardMutation<string, void>(null, deleteBoard, 'Board deleted')
}
export function useReplaceGrants(slug: string) {
  return useBoardMutation<{ group_id: number; can_edit: boolean }[], unknown>(
    slug, grants => replaceGrants(slug, grants), 'Sharing updated')
}
export function useCreateNode(slug: string) {
  return useBoardMutation<NodeCreate, unknown>(slug, data => createNode(slug, data))
}
export function usePatchNode(slug: string) {
  return useBoardMutation<{ id: number; data: NodePatch }, unknown>(
    slug, ({ id, data }) => patchNode(slug, id, data))
}
export function usePatchPositions(slug: string) {
  return useBoardMutation<PositionItem[], unknown>(slug, items => patchPositions(slug, items))
}
export function useDeleteNode(slug: string) {
  return useBoardMutation<number, void>(slug, id => deleteNode(slug, id))
}
export function useCreateEdge(slug: string) {
  return useBoardMutation<EdgeCreate, unknown>(slug, data => createEdge(slug, data))
}
export function usePatchEdge(slug: string) {
  return useBoardMutation<{ id: number; data: EdgePatch }, unknown>(
    slug, ({ id, data }) => patchEdge(slug, id, data))
}
export function useDeleteEdge(slug: string) {
  return useBoardMutation<number, void>(slug, id => deleteEdge(slug, id))
}
```

- [ ] **Step 5: Store, hash, layout, sidebar, deep link**

`src/store/ui-store.ts`:
- `ActiveSection` gains `| 'boards'`.
- Add `export type BoardsSubSection = 'overview' | 'board'` and include it in the `ActiveSubSection` union.
- State fields: `boardTargetSlug: string | null` and `pendingBoardNode: string | null` (initial `null`).
- Actions (same `set(..., undefined, '<name>')` style as `navigateToDocument`):

```ts
navigateToBoards: () =>
  set(state => ({ activeSection: 'boards', activeSubSection: 'overview', boardTargetSlug: null,
                  navigationKey: state.navigationKey + 1 }), undefined, 'navigateToBoards'),
navigateToBoard: slug =>
  set(state => ({ activeSection: 'boards', activeSubSection: 'board', boardTargetSlug: slug,
                  navigationKey: state.navigationKey + 1 }), undefined, 'navigateToBoard'),
navigateToBoardNode: (slug, nodeId) =>
  set(state => ({ activeSection: 'boards', activeSubSection: 'board', boardTargetSlug: slug,
                  pendingBoardNode: nodeId, navigationKey: state.navigationKey + 1 }),
      undefined, 'navigateToBoardNode'),
setPendingBoardNode: nodeId => set({ pendingBoardNode: nodeId }, undefined, 'setPendingBoardNode'),
consumePendingBoardNode: () => {
  const id = get().pendingBoardNode
  if (id != null) set({ pendingBoardNode: null }, undefined, 'consumePendingBoardNode')
  return id
},
```
- `navigateTo` also resets `boardTargetSlug: null`.

`src/lib/hash-navigation.ts`:
- Add `'boards'` to `VALID_SECTIONS`.
- `ParsedNav` gains `nodeId: string | null`; in the query block read `params.get('node')`.
- In `applyNavToStore`, before the generic `else`: `else if (section === 'boards' && subSection === 'board' && targetId) { store.navigateToBoard(targetId) }`; after the chain, next to the `flagId` block: `if (nodeId != null) store.setPendingBoardNode(nodeId)`.
- `buildHash`'s parameter type gains `boardTargetSlug: string | null`; add the branch `if (state.activeSection === 'boards' && state.activeSubSection === 'board' && state.boardTargetSlug) hash += `?id=${encodeURIComponent(state.boardTargetSlug)}``. Never write `node`.
- Add `boardTargetSlug` to the subscriber's list of fields that trigger `pushState`.

`src/components/layout/MainWindowContent.tsx`: import `BoardsPage` and `BoardPage` from `@/components/boards/...`; read `const boardTargetSlug = useUIStore(state => state.boardTargetSlug)`; add

```tsx
      case 'boards':
        if (activeSubSection === 'board' && boardTargetSlug) return <BoardPage slug={boardTargetSlug} />
        return <BoardsPage />
```

`src/components/layout/AppSidebar.tsx`: import `Map` from lucide and `useBoardsNavVisible` from `@/services/boards`; add `{ id: 'boards', label: 'Boards', icon: Map }` to `navItems` after the reports item; in the component `const boardsVisible = useBoardsNavVisible()`; in the render loop, before the `adminOnly` check: `if (item.id === 'boards' && !boardsVisible) return null`. The existing no-sub-items click handler (`navigateTo(item.id, 'overview')`) already lands on the list.

`src/components/layout/__tests__/AppSidebar.test.tsx`: add `vi.mock('@/services/boards', () => ({ useBoardsNavVisible: () => true }))` next to the existing store mocks, and one assertion that a "Boards" button renders.

Placeholders so the route compiles (replaced in Tasks 2 and 3):

`src/components/boards/BoardsPage.tsx`:
```tsx
export function BoardsPage() {
  return <div className="p-4 text-sm text-muted-foreground">Boards</div>
}
```
`src/components/boards/BoardPage.tsx`:
```tsx
export function BoardPage({ slug }: { slug: string }) {
  return <div className="p-4 text-sm text-muted-foreground">Board {slug}</div>
}
```

`src/components/flags/flag-entity.ts`: import `Map` from lucide; add `board_node: { Icon: Map, label: 'Board item', canDeepLink: false }` to `ENTITY_META`; in `navigateToDeepLink` add

```ts
    case 'board_node': {
      const sep = deepLink.id.indexOf(':')
      if (sep <= 0 || sep === deepLink.id.length - 1) return false
      store.closeFlagsFlyout()
      store.navigateToBoardNode(deepLink.id.slice(0, sep), deepLink.id.slice(sep + 1))
      return true
    }
```

- [ ] **Step 6: Run to verify pass**

```bash
npx vitest run src/components/boards/__tests__ src/components/layout/__tests__/AppSidebar.test.tsx src/components/flags/__tests__ && npm run typecheck && npx eslint src/lib/api-boards.ts src/services/boards.ts src/store/ui-store.ts src/lib/hash-navigation.ts src/components/layout/MainWindowContent.tsx src/components/layout/AppSidebar.tsx src/components/flags/flag-entity.ts src/components/boards --max-warnings 0 && npx prettier --check src/lib/api-boards.ts src/services/boards.ts src/components/boards
```

Expected: all green. If `navigation.test.tsx` cannot drive `useHashNavigation` in jsdom (pushState is available in jsdom; `HashChangeEvent` exists), fall back to calling the store actions directly and asserting the hash through `window.location.hash`, and say so in the report.

- [ ] **Step 7: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add src/lib/api-boards.ts src/services/boards.ts src/components/boards src/store/ui-store.ts src/lib/hash-navigation.ts src/components/layout/MainWindowContent.tsx src/components/layout/AppSidebar.tsx src/components/layout/__tests__/AppSidebar.test.tsx src/components/flags/flag-entity.ts
git commit -m "feat(boards): boards section, hash routing with one-shot node param, API client, hooks, deep link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/lib/api-boards.ts src/services/boards.ts src/components/boards src/store/ui-store.ts src/lib/hash-navigation.ts src/components/layout/MainWindowContent.tsx src/components/layout/AppSidebar.tsx src/components/layout/__tests__/AppSidebar.test.tsx src/components/flags/flag-entity.ts
```

---

### Task 2: Boards list page

**Files:**
- Replace: `src/components/boards/BoardsPage.tsx`
- Create: `src/components/boards/ShareBoardDialog.tsx`, `src/components/boards/__tests__/BoardsPage.test.tsx`

**Interfaces:**
- `BoardsPage()`: cards from `useBoards()`; each card shows name, kind badge, visibility badge, node count, "Open" (calls `navigateToBoard(slug)`), and for admins "Share" and "Delete". Admins see a "New board" form (slug, name, kind, visibility).
- `ShareBoardDialog({ slug, open, onOpenChange })`: lists groups from `useGroups()` with a view/edit choice per group, saves through `useReplaceGrants(slug)`.

- [ ] **Step 1: Write the failing test**

`src/components/boards/__tests__/BoardsPage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'standard',
  boards: [
    { id: 1, slug: 'org', name: 'Org chart', kind: 'org', visibility: 'company', created_by: 1,
      default_viewport: null, node_count: 12, can_edit: true, created_at: '', updated_at: '' },
    { id: 2, slug: 'exec', name: 'Exec map', kind: 'map', visibility: 'restricted', created_by: 1,
      default_viewport: null, node_count: 3, can_edit: false, created_at: '', updated_at: '' },
  ],
  create: vi.fn(), remove: vi.fn(), navigateToBoard: vi.fn(),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: h.role } }),
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: (sel: (s: { navigateToBoard: typeof h.navigateToBoard }) => unknown) =>
    sel({ navigateToBoard: h.navigateToBoard }),
}))
vi.mock('@/services/boards', () => ({
  useBoards: () => ({ data: h.boards, isLoading: false, isError: false }),
  useCreateBoard: () => ({ mutate: h.create, isPending: false }),
  useDeleteBoard: () => ({ mutate: h.remove, isPending: false }),
  useReplaceGrants: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/services/groups', () => ({
  useGroups: () => ({ data: [], isLoading: false }),
}))

import { BoardsPage } from '@/components/boards/BoardsPage'

describe('BoardsPage', () => {
  beforeEach(() => { h.role = 'admin'; h.create.mockReset(); h.remove.mockReset(); h.navigateToBoard.mockReset() })

  it('lists boards with kind, visibility and node count, and opens one', async () => {
    render(<BoardsPage />)
    expect(screen.getByText('Org chart')).toBeInTheDocument()
    expect(screen.getByText('Exec map')).toBeInTheDocument()
    expect(screen.getByText('restricted')).toBeInTheDocument()
    expect(screen.getByText('12 items')).toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Open' })[0] as HTMLElement)
    expect(h.navigateToBoard).toHaveBeenCalledWith('org')
  })

  it('admin can create a board', async () => {
    const user = userEvent.setup()
    render(<BoardsPage />)
    await user.type(screen.getByLabelText('Slug'), 'company-map')
    await user.type(screen.getByLabelText('Name'), 'Company map')
    await user.click(screen.getByRole('button', { name: 'Create board' }))
    expect(h.create).toHaveBeenCalledWith(
      { slug: 'company-map', name: 'Company map', kind: 'map', visibility: 'company' },
      expect.anything()
    )
  })

  it('non-admin sees no create form, share or delete', () => {
    h.role = 'standard'
    render(<BoardsPage />)
    expect(screen.queryByLabelText('Slug')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/components/boards/__tests__/BoardsPage.test.tsx
```

Expected: the placeholder renders only "Boards".

- [ ] **Step 3: Implement**

`src/components/boards/ShareBoardDialog.tsx`:

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useGroups } from '@/services/groups'
import { useReplaceGrants } from '@/services/boards'
import type { Grant } from '@/lib/api-boards'

type Level = 'none' | 'view' | 'edit'

/** Admin-only: which groups may view (restricted boards) or edit (any board). */
export function ShareBoardDialog({
  slug, grants, open, onOpenChange,
}: { slug: string; grants: Grant[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const groups = useGroups()
  const replace = useReplaceGrants(slug)
  const [levels, setLevels] = useState<Record<number, Level>>(() =>
    Object.fromEntries(grants.map(g => [g.group_id, g.can_edit ? 'edit' : 'view'])))
  const levelOf = (id: number): Level => levels[id] ?? 'none'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Share board</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Groups with view access can see a restricted board. Groups with edit access can change any board they can see.
        </p>
        <div className="divide-y rounded-md border">
          {(groups.data ?? []).map(g => (
            <div key={g.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span><span className="font-mono text-xs">{g.slug}</span> {g.name}</span>
              <select
                aria-label={`${g.slug} access`}
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={levelOf(g.id)}
                onChange={e => setLevels(prev => ({ ...prev, [g.id]: e.target.value as Level }))}
              >
                <option value="none">No access</option>
                <option value="view">View</option>
                <option value="edit">Edit</option>
              </select>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={replace.isPending}
            onClick={() =>
              replace.mutate(
                Object.entries(levels)
                  .filter(([, lv]) => lv !== 'none')
                  .map(([id, lv]) => ({ group_id: Number(id), can_edit: lv === 'edit' })),
                { onSuccess: () => onOpenChange(false) }
              )
            }
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

`src/components/boards/BoardsPage.tsx`:

```tsx
import { useState } from 'react'
import { Loader2, Map as MapIcon, Plus } from 'lucide-react'
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
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }
  if (boards.isError || !boards.data) {
    return <p className="p-4 text-sm text-destructive">Could not load boards.</p>
  }
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Boards</h1>
        <p className="text-sm text-muted-foreground">
          Company maps, org charts and training boards. Restricted boards are visible to their groups and admins only.
        </p>
      </div>
      {boards.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No boards yet.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {boards.data.map(b => <BoardCard key={b.id} board={b} isAdmin={isAdmin} />)}
      </div>
      {isAdmin && <NewBoardForm />}
    </div>
  )
}

function BoardCard({ board, isAdmin }: { board: Board; isAdmin: boolean }) {
  const navigateToBoard = useUIStore(s => s.navigateToBoard)
  const remove = useDeleteBoard()
  const [share, setShare] = useState(false)
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <MapIcon className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{board.name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">{board.kind}</Badge>
        <Badge variant={board.visibility === 'restricted' ? 'destructive' : 'outline'}>{board.visibility}</Badge>
        <span className="text-muted-foreground">{board.node_count} items</span>
        {board.can_edit && <span className="text-muted-foreground">editor</span>}
      </div>
      <div className="mt-auto flex items-center gap-2">
        <Button size="sm" onClick={() => navigateToBoard(board.slug)}>Open</Button>
        {isAdmin && (
          <>
            <Button size="sm" variant="outline" onClick={() => setShare(true)}>Share</Button>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending}
                    onClick={() => remove.mutate(board.slug)}>Delete</Button>
          </>
        )}
      </div>
      {isAdmin && share && (
        <ShareBoardDialog slug={board.slug} grants={[]} open={share} onOpenChange={setShare} />
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
        create.mutate({ slug: slug.trim(), name: name.trim(), kind, visibility },
          { onSuccess: () => { setSlug(''); setName('') } })
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="board-new-slug" className="text-xs">Slug</Label>
        <Input id="board-new-slug" value={slug} onChange={e => setSlug(e.target.value.toLowerCase())}
               placeholder="company-map" maxLength={60} className="h-8 font-mono text-xs" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="board-new-name" className="text-xs">Name</Label>
        <Input id="board-new-name" value={name} onChange={e => setName(e.target.value)}
               placeholder="Company map" className="h-8 text-xs" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="board-new-kind" className="text-xs">Kind</Label>
        <select id="board-new-kind" className="h-8 rounded-md border bg-background px-2 text-xs"
                value={kind} onChange={e => setKind(e.target.value as BoardKind)}>
          <option value="map">map</option><option value="org">org</option>
          <option value="training">training</option><option value="custom">custom</option>
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="board-new-vis" className="text-xs">Visibility</Label>
        <select id="board-new-vis" className="h-8 rounded-md border bg-background px-2 text-xs"
                value={visibility} onChange={e => setVisibility(e.target.value as BoardVisibility)}>
          <option value="company">company</option><option value="restricted">restricted</option>
        </select>
      </div>
      <Button type="submit" size="sm" disabled={!valid || create.isPending}>
        <Plus className="mr-1 h-4 w-4" />Create board
      </Button>
    </form>
  )
}
```

The share dialog receives `grants={[]}` from the list (the list payload has no grants); Task 3's board page passes the real grants. If the shadcn `Dialog` export names differ, read `src/components/ui/dialog.tsx` and match.

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/components/boards/__tests__/BoardsPage.test.tsx && npm run typecheck && npx eslint src/components/boards --max-warnings 0 && npx prettier --check src/components/boards
```

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add src/components/boards/BoardsPage.tsx src/components/boards/ShareBoardDialog.tsx src/components/boards/__tests__/BoardsPage.test.tsx
git commit -m "feat(boards): boards list page with create, share and delete for admins

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/BoardsPage.tsx src/components/boards/ShareBoardDialog.tsx src/components/boards/__tests__/BoardsPage.test.tsx
```

---

### Task 3: Canvas core, mapping, persistence, node components, page shell

**Files:**
- Create: `src/components/boards/board-mapping.ts`, `src/components/boards/open-external.ts`, `src/components/boards/BoardCanvas.tsx`, `src/components/boards/nodes/{index.ts,FrameNode.tsx,TextNode.tsx,NoteNode.tsx,LinkNode.tsx,EntityNode.tsx,PersonNode.tsx,WidgetNode.tsx}`, `src/components/boards/__tests__/board-mapping.test.ts`, `src/components/boards/__tests__/LinkNode.test.tsx`, `src/components/boards/__tests__/boards-service.test.tsx`
- Replace: `src/components/boards/BoardPage.tsx`

**Interfaces:**
- `board-mapping.ts` (pure, no xyflow runtime):
  - `toFlowNodes(nodes: BoardNode[], canEdit: boolean): Node<BoardNodeData>[]` where `BoardNodeData = { row: BoardNode; canEdit: boolean } & Record<string, unknown>`; frames become `type: 'frame'` with `style: { width: w ?? 360, height: h ?? 220 }`, children get `parentId: String(parent_id)` and `extent: 'parent'`; `draggable: canEdit`.
  - `toFlowEdges(edges: BoardEdge[]): Edge[]` with `type: 'default'`, `label` for `reports_to`/`depends_on`/`next`, `markerEnd: { type: 'arrowclosed' }`.
  - `resolveParentOnDrop(node: { id: string; position: XYPosition; parentId?: string; width?: number; height?: number }, frames: { id: string; position: XYPosition; width: number; height: number }[]): { parentId: string | null; position: XYPosition }`: a parentless node whose center lands inside a frame gets that frame and a position relative to it; a node already inside a frame keeps it (xyflow positions are already relative).
  - `toPositionItems(rows: Map<number, BoardNode>, moved: { id: string; position: XYPosition; parentId?: string }[]): PositionItem[]` with the row's `version` and `parent_id` when the parent changed.
- `open-external.ts`: `openExternal(url: string): void` (http/https only; Tauri opener when present, else `window.open(url, '_blank', 'noopener')`); `isSafeHttpUrl(url: string): boolean`.
- `BoardCanvas({ board, canEdit, selectedId, onSelect })` default export, lazy-loaded by `BoardPage`.
- `BoardPage({ slug })`: header (name, badges, Share for admins, "Set as default view" for editors, Add button placeholder wired in Task 5), `ResizablePanelGroup` with the canvas and the side panel (Task 4 fills the panel; until then a minimal panel showing the selected node's label).

- [ ] **Step 1: Write the failing tests**

`src/components/boards/__tests__/board-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveParentOnDrop, toFlowNodes, toPositionItems } from '@/components/boards/board-mapping'
import type { BoardNode } from '@/lib/api-boards'

const row = (o: Partial<BoardNode>): BoardNode => ({
  id: 1, board_id: 1, kind: 'text', label: 'T', parent_id: null, x: 0, y: 0, w: null, h: null, z: 0,
  entity_type: null, entity_id: null, data: null, version: 1, created_by: null, updated_by: null,
  created_at: '', updated_at: '', ...o,
})

describe('board-mapping', () => {
  it('frames get sizes, children get parentId and extent, drag follows canEdit', () => {
    const nodes = toFlowNodes([row({ id: 1, kind: 'frame', w: 400, h: 200 }), row({ id: 2, parent_id: 1, x: 10, y: 5 })], false)
    const frame = nodes.find(n => n.id === '1')!
    const child = nodes.find(n => n.id === '2')!
    expect(frame.type).toBe('frame')
    expect(frame.style).toEqual({ width: 400, height: 200 })
    expect(child.parentId).toBe('1')
    expect(child.extent).toBe('parent')
    expect(child.position).toEqual({ x: 10, y: 5 })
    expect(child.draggable).toBe(false)
  })

  it('a node dropped inside a frame saves a relative position (Review Focus 1)', () => {
    const frames = [{ id: '1', position: { x: 100, y: 50 }, width: 400, height: 200 }]
    const dropped = resolveParentOnDrop({ id: '2', position: { x: 130, y: 60 }, width: 40, height: 20 }, frames)
    expect(dropped).toEqual({ parentId: '1', position: { x: 30, y: 10 } })
    const outside = resolveParentOnDrop({ id: '3', position: { x: 900, y: 900 }, width: 40, height: 20 }, frames)
    expect(outside).toEqual({ parentId: null, position: { x: 900, y: 900 } })
    const already = resolveParentOnDrop({ id: '4', position: { x: 5, y: 5 }, parentId: '1' }, frames)
    expect(already).toEqual({ parentId: '1', position: { x: 5, y: 5 } })
  })

  it('position items carry the row version and a changed parent', () => {
    const rows = new Map([[2, row({ id: 2, version: 3 })]])
    expect(toPositionItems(rows, [{ id: '2', position: { x: 1, y: 2 }, parentId: '1' }]))
      .toEqual([{ id: 2, x: 1, y: 2, parent_id: 1, version: 3 }])
    expect(toPositionItems(rows, [{ id: '2', position: { x: 1, y: 2 } }]))
      .toEqual([{ id: 2, x: 1, y: 2, version: 3 }])
  })
})
```

`src/components/boards/__tests__/LinkNode.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }))
const h = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/components/boards/open-external', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, openExternal: h.open }
})

import { LinkNode } from '@/components/boards/nodes/LinkNode'

const data = (url: string) => ({
  row: { id: 9, board_id: 1, kind: 'link' as const, label: 'Kinsta', parent_id: null, x: 0, y: 0, w: null, h: null, z: 0,
         entity_type: null, entity_id: null, data: { url }, version: 1, created_by: null, updated_by: null,
         created_at: '', updated_at: '' },
  canEdit: true,
})

describe('LinkNode', () => {
  it('renders an http(s) link and opens it externally', () => {
    render(<LinkNode data={data('https://accumarklabs.com')} />)
    screen.getByRole('button', { name: /accumarklabs\.com/ }).click()
    expect(h.open).toHaveBeenCalledWith('https://accumarklabs.com')
    expect(document.querySelector('a[href]')).toBeNull()
  })

  it('never renders a javascript: url as a target (Review Focus 4)', () => {
    render(<LinkNode data={data('javascript:alert(1)')} />)
    const btn = screen.getByRole('button')
    expect(btn).toBeDisabled()
    btn.click()
    expect(h.open).not.toHaveBeenCalled()
    expect(document.querySelector('a[href]')).toBeNull()
  })
})
```

`src/components/boards/__tests__/boards-service.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const h = vi.hoisted(() => ({ patchPositions: vi.fn(), toastError: vi.fn() }))
vi.mock('@/lib/api-boards', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, patchPositions: h.patchPositions }
})
vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn() } }))
vi.mock('@/store/auth-store', () => ({ useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: 'standard' } }) }))

import { boardKeys, usePatchPositions } from '@/services/boards'

describe('usePatchPositions', () => {
  beforeEach(() => { h.patchPositions.mockReset(); h.toastError.mockReset() })

  it('a 409 invalidates the board and toasts (Review Focus 2)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    h.patchPositions.mockRejectedValue(new Error('PATCH /api/boards/org/nodes/positions failed: 409'))
    const { result } = renderHook(() => usePatchPositions('org'), { wrapper })
    result.current.mutate([{ id: 1, x: 0, y: 0, version: 1 }])
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Board changed elsewhere, reloaded'))
    expect(spy).toHaveBeenCalledWith({ queryKey: boardKeys.detail('org') })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/components/boards/__tests__/board-mapping.test.ts src/components/boards/__tests__/LinkNode.test.tsx src/components/boards/__tests__/boards-service.test.tsx
```

Expected: modules not found (`board-mapping`, `nodes/LinkNode`); the service test passes already if Task 1 landed (keep it as the pin).

- [ ] **Step 3: Pure helpers**

`src/components/boards/open-external.ts`:

```ts
/** Link nodes open OUTSIDE the app (spec §8.3, §9): never an iframe, never a javascript: URL. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0
  } catch {
    return false
  }
}

export function openExternal(url: string): void {
  if (!isSafeHttpUrl(url)) return
  const tauri = (window as unknown as { __TAURI__?: { opener?: { openUrl?: (u: string) => Promise<void> } } }).__TAURI__
  if (tauri?.opener?.openUrl) {
    void tauri.opener.openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener')
}
```

If the desktop build exposes the opener differently (check `src-tauri/capabilities/*.json` and any existing `@tauri-apps/plugin-opener` import in `src/`), use that import instead of the global and say so in the report.

`src/components/boards/board-mapping.ts`:

```ts
import type { Edge, Node, XYPosition } from '@xyflow/react'
import type { BoardEdge, BoardNode, PositionItem } from '@/lib/api-boards'

export const FRAME_DEFAULT = { width: 360, height: 220 }
export const NODE_DEFAULT = { width: 180, height: 56 }

export interface BoardNodeData extends Record<string, unknown> {
  row: BoardNode
  canEdit: boolean
}
export type BoardFlowNode = Node<BoardNodeData>

export function toFlowNodes(rows: BoardNode[], canEdit: boolean): BoardFlowNode[] {
  return [...rows]
    .sort((a, b) => (a.kind === 'frame' ? 0 : 1) - (b.kind === 'frame' ? 0 : 1) || a.z - b.z || a.id - b.id)
    .map(row => {
      const isFrame = row.kind === 'frame'
      const node: BoardFlowNode = {
        id: String(row.id),
        type: row.kind,
        position: { x: row.x, y: row.y },
        data: { row, canEdit },
        draggable: canEdit,
        selectable: true,
        zIndex: isFrame ? 0 : 1,
      }
      if (isFrame) {
        node.style = { width: row.w ?? FRAME_DEFAULT.width, height: row.h ?? FRAME_DEFAULT.height }
      } else if (row.w != null || row.h != null) {
        node.style = { width: row.w ?? NODE_DEFAULT.width, height: row.h ?? NODE_DEFAULT.height }
      }
      if (row.parent_id != null) {
        node.parentId = String(row.parent_id)
        node.extent = 'parent'
      }
      return node
    })
}

const EDGE_LABEL: Record<BoardEdge['kind'], string | undefined> = {
  related: undefined, reports_to: 'reports to', depends_on: 'depends on', next: 'next',
}

export function toFlowEdges(rows: BoardEdge[]): Edge[] {
  return rows.map(e => ({
    id: String(e.id),
    source: String(e.source_id),
    target: String(e.target_id),
    label: e.label ?? EDGE_LABEL[e.kind],
    markerEnd: { type: 'arrowclosed' as const },
    data: { kind: e.kind },
  }))
}

export interface FrameRect { id: string; position: XYPosition; width: number; height: number }

/** A parentless node whose centre lands inside a frame joins it with a RELATIVE position. */
export function resolveParentOnDrop(
  node: { id: string; position: XYPosition; parentId?: string; width?: number; height?: number },
  frames: FrameRect[]
): { parentId: string | null; position: XYPosition } {
  if (node.parentId) return { parentId: node.parentId, position: node.position }
  const cx = node.position.x + (node.width ?? NODE_DEFAULT.width) / 2
  const cy = node.position.y + (node.height ?? NODE_DEFAULT.height) / 2
  for (const f of frames) {
    if (f.id === node.id) continue
    if (cx >= f.position.x && cx <= f.position.x + f.width && cy >= f.position.y && cy <= f.position.y + f.height) {
      return { parentId: f.id, position: { x: node.position.x - f.position.x, y: node.position.y - f.position.y } }
    }
  }
  return { parentId: null, position: node.position }
}

export function toPositionItems(
  rows: Map<number, BoardNode>,
  moved: { id: string; position: XYPosition; parentId?: string }[]
): PositionItem[] {
  const out: PositionItem[] = []
  for (const m of moved) {
    const row = rows.get(Number(m.id))
    if (!row) continue
    const item: PositionItem = { id: row.id, x: m.position.x, y: m.position.y, version: row.version }
    const newParent = m.parentId ? Number(m.parentId) : null
    if (newParent !== row.parent_id) item.parent_id = newParent
    out.push(item)
  }
  return out
}
```

- [ ] **Step 4: Node components**

All node components take `NodeProps<BoardFlowNode>` (type-only import from `@xyflow/react`) and read `data.row`. Handles: one target on the left, one source on the right, both hidden for frames. Keep each file small.

`src/components/boards/nodes/index.ts`:

```ts
import { FrameNode } from './FrameNode'
import { TextNode } from './TextNode'
import { NoteNode } from './NoteNode'
import { LinkNode } from './LinkNode'
import { EntityNode } from './EntityNode'
import { PersonNode } from './PersonNode'
import { WidgetNode } from './WidgetNode'

export const nodeTypes = {
  frame: FrameNode, text: TextNode, note: NoteNode, link: LinkNode,
  entity: EntityNode, person: PersonNode, widget: WidgetNode,
}
```

`FrameNode.tsx`:

```tsx
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BoardFlowNode } from '../board-mapping'

const COLOR: Record<string, string> = {
  slate: 'border-slate-400/70 bg-slate-500/5', red: 'border-red-400/70 bg-red-500/5',
  orange: 'border-orange-400/70 bg-orange-500/5', amber: 'border-amber-400/70 bg-amber-500/5',
  green: 'border-green-400/70 bg-green-500/5', teal: 'border-teal-400/70 bg-teal-500/5',
  blue: 'border-blue-400/70 bg-blue-500/5', purple: 'border-purple-400/70 bg-purple-500/5',
}

export function FrameNode({ data, selected }: NodeProps<BoardFlowNode>) {
  const color = String((data.row.data as { color?: string } | null)?.color ?? 'slate')
  return (
    <div className={cn('h-full w-full rounded-xl border-2 border-dashed', COLOR[color] ?? COLOR.slate)}>
      {data.canEdit && <NodeResizer minWidth={160} minHeight={100} isVisible={selected} />}
      <div className="px-3 py-2 text-sm font-medium">{data.row.label}</div>
    </div>
  )
}
```

`TextNode.tsx`:

```tsx
import type { NodeProps } from '@xyflow/react'
import type { BoardFlowNode } from '../board-mapping'

const SIZE: Record<string, string> = { sm: 'text-sm', md: 'text-lg', lg: 'text-2xl' }

export function TextNode({ data }: NodeProps<BoardFlowNode>) {
  const size = String((data.row.data as { size?: string } | null)?.size ?? 'md')
  return <div className={`px-2 py-1 font-semibold ${SIZE[size] ?? SIZE.md}`}>{data.row.label}</div>
}
```

`NoteNode.tsx` (markdown through the existing flag pipeline):

```tsx
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import type { BoardFlowNode } from '../board-mapping'

export function NoteNode({ data }: NodeProps<BoardFlowNode>) {
  const md = String((data.row.data as { markdown?: string } | null)?.markdown ?? '')
  return (
    <div className="w-[240px] rounded-md border bg-amber-50 p-2 text-xs shadow-sm dark:bg-amber-950/40">
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="mb-1 font-medium">{data.row.label}</div>
      <div className="prose prose-xs max-w-none" dangerouslySetInnerHTML={{ __html: renderCommentHtml(md, []) }} />
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  )
}
```

`LinkNode.tsx`:

```tsx
import { ExternalLink } from 'lucide-react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { isSafeHttpUrl, openExternal } from '../open-external'
import type { BoardFlowNode } from '../board-mapping'

export function LinkNode({ data }: Pick<NodeProps<BoardFlowNode>, 'data'>) {
  const url = String((data.row.data as { url?: string } | null)?.url ?? '')
  const safe = isSafeHttpUrl(url)
  let host = ''
  try { host = safe ? new URL(url).host : '' } catch { host = '' }
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs shadow-sm">
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
      <button
        type="button"
        className="text-left disabled:opacity-50"
        disabled={!safe}
        aria-label={`${data.row.label} ${host}`}
        onClick={() => openExternal(url)}
      >
        <div className="font-medium">{data.row.label}</div>
        <div className="text-muted-foreground">{host || 'invalid link'}</div>
      </button>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  )
}
```

`EntityNode.tsx`:

```tsx
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { entityMeta, navigateToDeepLink } from '@/components/flags/flag-entity'
import type { BoardFlowNode } from '../board-mapping'

export function EntityNode({ data }: NodeProps<BoardFlowNode>) {
  const { row } = data
  const meta = entityMeta(row.entity_type)
  const Icon = meta.Icon
  const label = row.context?.label ?? row.label
  const deep = row.context?.deep_link
  return (
    <div
      className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs shadow-sm"
      onDoubleClick={() => { if (deep) navigateToDeepLink(deep) }}
      title={deep ? 'Double-click to open' : undefined}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <Icon className="h-3.5 w-3.5 text-teal-600" />
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground">{meta.label}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  )
}
```

`PersonNode.tsx`:

```tsx
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import { useDirectoryUsers } from '@/services/groups'
import type { BoardFlowNode } from '../board-mapping'

export function PersonNode({ data }: NodeProps<BoardFlowNode>) {
  const userId = Number((data.row.data as { user_id?: number } | null)?.user_id)
  const directory = useDirectoryUsers()
  const u = directory.data?.find(x => x.id === userId)
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : data.row.label
  const initials = name.split(/\s+/).map(p => p[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'
  return (
    <div className="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-xs shadow-sm">
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <FlagAvatar initials={initials} color="#7F77DD" size={22} avatarUrl={u?.avatar_url ?? null} />
      <span className="font-medium">{name}</span>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )
}
```

`WidgetNode.tsx`:

```tsx
import type { NodeProps } from '@xyflow/react'
import type { BoardFlowNode } from '../board-mapping'

export function WidgetNode({ data }: NodeProps<BoardFlowNode>) {
  return (
    <div className="rounded-md border border-dashed bg-card px-3 py-2 text-xs text-muted-foreground">
      {data.row.label} (widgets arrive in a later release)
    </div>
  )
}
```

Check `FlagAvatar`'s `color` prop expectation (a CSS color string) against its file before using the literal.

- [ ] **Step 5: Canvas**

`src/components/boards/BoardCanvas.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
  useReactFlow, type Connection, type Node, type NodeChange, type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { BoardDetail } from '@/lib/api-boards'
import { useCreateEdge, usePatchPositions } from '@/services/boards'
import { useUIStore } from '@/store/ui-store'
import { nodeTypes } from './nodes'
import {
  resolveParentOnDrop, toFlowEdges, toFlowNodes, toPositionItems, type BoardFlowNode, type FrameRect,
} from './board-mapping'

export interface BoardCanvasProps {
  board: BoardDetail
  canEdit: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
}

const VIEWPORT_KEY = (slug: string) => `boards:viewport:${slug}`

function readViewport(slug: string, fallback: Viewport | null): Viewport | undefined {
  try {
    const raw = window.localStorage.getItem(VIEWPORT_KEY(slug))
    if (raw) return JSON.parse(raw) as Viewport
  } catch {
    /* private mode or blocked storage: fall through */
  }
  return fallback ?? undefined
}

function CanvasInner({ board, canEdit, selectedId, onSelect }: BoardCanvasProps) {
  const rows = useMemo(() => new Map(board.nodes.map(n => [n.id, n])), [board.nodes])
  const [nodes, setNodes, onNodesChange] = useNodesState<BoardFlowNode>(toFlowNodes(board.nodes, canEdit))
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(board.edges))
  const patchPositions = usePatchPositions(board.slug)
  const createEdge = useCreateEdge(board.slug)
  const { fitView, setViewport } = useReactFlow()
  // Read once into state (React Compiler: no impure reads during render).
  const [initialViewport] = useState(() => readViewport(board.slug, board.default_viewport))
  const consumePendingBoardNode = useUIStore(s => s.consumePendingBoardNode)
  const pendingHandled = useRef(false)

  // Server is the source of truth: refresh local graph when the query data changes.
  useEffect(() => {
    setNodes(toFlowNodes(board.nodes, canEdit))
    setEdges(toFlowEdges(board.edges))
  }, [board.nodes, board.edges, canEdit, setNodes, setEdges])

  useEffect(() => {
    if (initialViewport) setViewport(initialViewport)
  }, [initialViewport, setViewport])

  // One-shot deep link: select and centre the node named by the hash.
  useEffect(() => {
    if (pendingHandled.current) return
    const id = consumePendingBoardNode()
    if (!id) return
    pendingHandled.current = true
    onSelect(Number(id))
    void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.5 })
  }, [consumePendingBoardNode, fitView, onSelect])

  const handleNodesChange = useCallback((changes: NodeChange<BoardFlowNode>[]) => {
    onNodesChange(changes)
    const sel = changes.find(c => c.type === 'select' && c.selected)
    if (sel && sel.type === 'select') onSelect(Number(sel.id))
  }, [onNodesChange, onSelect])

  const handleDragStop = useCallback((_: unknown, _node: Node, dragged: Node[]) => {
    if (!canEdit) return
    const frames: FrameRect[] = nodes
      .filter(n => n.type === 'frame')
      .map(n => ({
        id: n.id, position: n.position,
        width: Number(n.style?.width ?? n.measured?.width ?? 360),
        height: Number(n.style?.height ?? n.measured?.height ?? 220),
      }))
    const moved = dragged.map(n => {
      const resolved = resolveParentOnDrop(
        { id: n.id, position: n.position, parentId: n.parentId, width: n.measured?.width, height: n.measured?.height },
        frames)
      return { id: n.id, position: resolved.position, parentId: resolved.parentId ?? undefined }
    })
    const items = toPositionItems(rows, moved)
    if (items.length) patchPositions.mutate(items)
  }, [canEdit, nodes, rows, patchPositions])

  const handleConnect = useCallback((c: Connection) => {
    if (!canEdit || !c.source || !c.target || c.source === c.target) return
    createEdge.mutate({ source_id: Number(c.source), target_id: Number(c.target), kind: 'related' })
  }, [canEdit, createEdge])

  return (
    <ReactFlow
      nodes={nodes.map(n => ({ ...n, selected: selectedId != null && n.id === String(selectedId) }))}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={handleDragStop}
      onConnect={handleConnect}
      onPaneClick={() => onSelect(null)}
      onMoveEnd={(_, vp) => {
        try { window.localStorage.setItem(VIEWPORT_KEY(board.slug), JSON.stringify(vp)) } catch { /* ignore */ }
      }}
      nodesDraggable={canEdit}
      nodesConnectable={canEdit}
      elementsSelectable
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
```

`onNodeDragStop`'s third argument is the array of dragged nodes in xyflow 12; confirm against `node_modules/@xyflow/react/dist/esm/types/component-props.d.ts` and adjust if the signature differs. If `onSelect` re-renders cause the `nodes.map(... selected ...)` spread to fight xyflow's own selection, drop the spread and rely on the `select` change instead; keep one mechanism.

- [ ] **Step 6: Page shell**

`src/components/boards/BoardPage.tsx`:

```tsx
import { lazy, Suspense, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { useBoard, usePatchBoard } from '@/services/boards'
import { ShareBoardDialog } from './ShareBoardDialog'
import { BoardSidePanel } from './BoardSidePanel'

const BoardCanvas = lazy(() => import('./BoardCanvas'))

/** One board (spec §8.1, §8.3, §8.4, §8.7). The canvas ships in its own chunk. */
export function BoardPage({ slug }: { slug: string }) {
  const board = useBoard(slug)
  const isAdmin = useAuthStore(s => s.user?.role === 'admin')
  const navigateToBoards = useUIStore(s => s.navigateToBoards)
  const patch = usePatchBoard(slug)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [share, setShare] = useState(false)

  if (board.isLoading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }
  if (board.isError || !board.data) {
    return (
      <div className="p-4 text-sm">
        <p className="text-destructive">Board not found.</p>
        <Button variant="link" onClick={navigateToBoards}>Back to boards</Button>
      </div>
    )
  }
  const b = board.data
  const canEdit = b.can_edit
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button size="sm" variant="ghost" onClick={navigateToBoards} aria-label="Back to boards">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="font-medium">{b.name}</span>
        <Badge variant="secondary">{b.kind}</Badge>
        <Badge variant={b.visibility === 'restricted' ? 'destructive' : 'outline'}>{b.visibility}</Badge>
        {!canEdit && <span className="text-xs text-muted-foreground">view only</span>}
        <span className="flex-1" />
        <div id="board-toolbar-slot" className="flex items-center gap-2" />
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => {
            let vp: { x: number; y: number; zoom: number } | null = null
            try { vp = JSON.parse(window.localStorage.getItem(`boards:viewport:${slug}`) ?? 'null') } catch { vp = null }
            if (vp) patch.mutate({ default_viewport: vp })
          }}>Set as default view</Button>
        )}
        {isAdmin && <Button size="sm" variant="outline" onClick={() => setShare(true)}>Share</Button>}
      </div>
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        <ResizablePanel defaultSize={72} minSize={40}>
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
            <BoardCanvas board={b} canEdit={canEdit} selectedId={selectedId} onSelect={setSelectedId} />
          </Suspense>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={28} minSize={20}>
          <BoardSidePanel board={b} selectedId={selectedId} onClose={() => setSelectedId(null)} />
        </ResizablePanel>
      </ResizablePanelGroup>
      {isAdmin && share && <ShareBoardDialog slug={slug} grants={b.grants} open={share} onOpenChange={setShare} />}
    </div>
  )
}
```

Until Task 4 lands, create `src/components/boards/BoardSidePanel.tsx` as a placeholder that renders the selected node's label (Task 4 replaces it):

```tsx
import type { BoardDetail } from '@/lib/api-boards'
export function BoardSidePanel({ board, selectedId }: { board: BoardDetail; selectedId: number | null; onClose: () => void }) {
  const node = board.nodes.find(n => n.id === selectedId)
  return <div className="p-3 text-sm text-muted-foreground">{node ? node.label : 'Select a node'}</div>
}
```

The "Set as default view" button reads `localStorage` in an event handler, not during render, which is allowed under the React Compiler rule.

- [ ] **Step 7: Run to verify pass**

```bash
npx vitest run src/components/boards/__tests__ && npm run typecheck && npx eslint src/components/boards --max-warnings 0 && npx prettier --check src/components/boards
```

Expected: all green. xyflow components are not rendered in vitest (jsdom lacks `DOMMatrixReadOnly`); `LinkNode.test.tsx` mocks `@xyflow/react`, and no test renders `BoardCanvas`.

- [ ] **Step 8: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add src/components/boards
git commit -m "feat(boards): canvas on @xyflow/react with node kinds, persistence, viewport, page shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards
```

---

### Task 4: Side panel

**Files:**
- Replace: `src/components/boards/BoardSidePanel.tsx`
- Create: `src/components/boards/DocumentPreviewFrame.tsx`, `src/components/boards/__tests__/BoardSidePanel.test.tsx`

**Interfaces:**
- `BoardSidePanel({ board, selectedId, onClose })`: header (kind icon, editable label for generic kinds, kind meta), "Open flags" list (`useEntityFlags` on `('board_node', id)` for generic kinds, on `(entity_type, entity_id)` for `entity` kinds; frames pass `includeDescendants: true`; rows are `FlagCard`), `RaiseFlagButton` preset to that anchor (editors only) with the restricted hint, kind sections (note editor, link fields, entity preview or open button, person info), "On boards" (`useBoardsForEntity` for entity kinds), Delete node (editors; 409 toast comes from the mutation hook).
- `DocumentPreviewFrame({ id })`: sandboxed `srcDoc` iframe of a document revision (`useDocumentContent`), themed the way `DocumentViewer` does it.

- [ ] **Step 1: Write the failing test**

`src/components/boards/__tests__/BoardSidePanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  patch: vi.fn(), remove: vi.fn(),
  flags: [{ id: 5, title: 'Plan Q4', status: 'open', type: 'task', kind: 'issue', entity_type: 'board_node', entity_id: '1' }],
}))
vi.mock('@/hooks/use-flags', () => ({
  useEntityFlags: () => ({ data: h.flags, isLoading: false }),
}))
vi.mock('@/components/flags/FlagCard', () => ({ FlagCard: ({ flag }: { flag: { title: string } }) => <div>{flag.title}</div> }))
vi.mock('@/components/flags/RaiseFlagButton', () => ({ RaiseFlagButton: ({ targetLabel }: { targetLabel?: string }) => <button>Raise flag on {targetLabel}</button> }))
vi.mock('@/services/boards', () => ({
  usePatchNode: () => ({ mutate: h.patch, isPending: false }),
  useDeleteNode: () => ({ mutate: h.remove, isPending: false }),
  useBoardsForEntity: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/services/groups', () => ({ useDirectoryUsers: () => ({ data: [], isLoading: false }) }))
vi.mock('@/components/boards/DocumentPreviewFrame', () => ({ DocumentPreviewFrame: () => <div>preview</div> }))

import { BoardSidePanel } from '@/components/boards/BoardSidePanel'
import type { BoardDetail } from '@/lib/api-boards'

const node = (o: Partial<BoardDetail['nodes'][number]>) => ({
  id: 1, board_id: 1, kind: 'frame' as const, label: 'Marketing', parent_id: null, x: 0, y: 0, w: null, h: null, z: 0,
  entity_type: null, entity_id: null, data: { color: 'purple' }, version: 2, created_by: null, updated_by: null,
  created_at: '', updated_at: '', ...o,
})
const board = (canEdit: boolean, nodes = [node({})]): BoardDetail => ({
  id: 1, slug: 'org', name: 'Org', kind: 'map', visibility: 'restricted', created_by: 1, default_viewport: null,
  node_count: nodes.length, can_edit: canEdit, created_at: '', updated_at: '', nodes, edges: [],
  grants: [{ group_id: 1, group_slug: 'exec', group_name: 'Exec', can_edit: true }],
})

describe('BoardSidePanel', () => {
  beforeEach(() => { h.patch.mockReset(); h.remove.mockReset() })

  it('editor sees flags, raise button with the restricted hint, and can rename', async () => {
    const user = userEvent.setup()
    render(<BoardSidePanel board={board(true)} selectedId={1} onClose={() => {}} />)
    expect(screen.getByText('Plan Q4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Raise flag on Marketing' })).toBeInTheDocument()
    expect(screen.getByText(/Visible to Exec and admins/)).toBeInTheDocument()
    const label = screen.getByLabelText('Label')
    await user.clear(label)
    await user.type(label, 'Marketing team')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(h.patch).toHaveBeenCalledWith({ id: 1, data: { version: 2, label: 'Marketing team' } }, expect.anything())
  })

  it('viewer sees a read-only panel (Review Focus 3)', () => {
    render(<BoardSidePanel board={board(false)} selectedId={1} onClose={() => {}} />)
    expect(screen.getByText('Marketing')).toBeInTheDocument()
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Raise flag/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete node' })).not.toBeInTheDocument()
  })

  it('note editor saves markdown with the version', async () => {
    const user = userEvent.setup()
    const n = node({ id: 3, kind: 'note', label: 'Q4', data: { markdown: 'old' }, version: 7 })
    render(<BoardSidePanel board={board(true, [n])} selectedId={3} onClose={() => {}} />)
    const ta = screen.getByLabelText('Markdown')
    await user.clear(ta)
    await user.type(ta, 'new text')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    expect(h.patch).toHaveBeenCalledWith({ id: 3, data: { version: 7, data: { markdown: 'new text' } } }, expect.anything())
  })

  it('delete asks the mutation with the node id', async () => {
    render(<BoardSidePanel board={board(true)} selectedId={1} onClose={() => {}} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete node' }))
    expect(h.remove).toHaveBeenCalledWith(1, expect.anything())
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/components/boards/__tests__/BoardSidePanel.test.tsx
```

Expected: the placeholder shows only the label.

- [ ] **Step 3: Implement**

`src/components/boards/DocumentPreviewFrame.tsx` (mirror the theming in `DocumentViewer.tsx`; read that file first and reuse the same helper names from `documents-utils`):

```tsx
import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useDocumentContent } from '@/services/documents'
import { resolveDocTheme, stampDocumentTheme } from '@/components/documents/documents-utils'

/** Sandboxed, read-only preview of a document revision for the board side panel. */
export function DocumentPreviewFrame({ id }: { id: number }) {
  const content = useDocumentContent(id)
  const html = useMemo(
    () => (content.data ? stampDocumentTheme(content.data, resolveDocTheme()) : ''),
    [content.data]
  )
  if (content.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  if (!content.data) return <p className="text-xs text-muted-foreground">No preview.</p>
  return (
    <iframe
      title="Document preview"
      sandbox="allow-scripts"
      srcDoc={html}
      className="h-56 w-full rounded-md border bg-white"
    />
  )
}
```

If `stampDocumentTheme`/`resolveDocTheme` have different names or signatures in `documents-utils.ts`, use the ones `DocumentViewer.tsx` calls and note it in the report.

`src/components/boards/BoardSidePanel.tsx`:

```tsx
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
import { useBoardsForEntity, useDeleteNode, usePatchNode } from '@/services/boards'
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

export function BoardSidePanel({ board, selectedId, onClose }: { board: BoardDetail; selectedId: number | null; onClose: () => void }) {
  const node = board.nodes.find(n => n.id === selectedId) ?? null
  if (!node) {
    return <div className="p-3 text-sm text-muted-foreground">Select a node to see its flags and details.</div>
  }
  return <NodePanel key={node.id} board={board} node={node} onClose={onClose} />
}

function NodePanel({ board, node, onClose }: { board: BoardDetail; node: BoardNode; onClose: () => void }) {
  const canEdit = board.can_edit
  const anchor = anchorOf(node)
  const flags = useEntityFlags(anchor.type, anchor.id, { includeDescendants: node.kind === 'frame' })
  const patch = usePatchNode(board.slug)
  const remove = useDeleteNode(board.slug)
  const [label, setLabel] = useState(node.label)
  const meta = node.kind === 'entity' ? entityMeta(node.entity_type) : null
  const groupNames = board.grants.map(g => g.group_name).join(', ')

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{node.kind}</span>
        <span className="font-medium">{node.context?.label ?? node.label}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-label="Close panel" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>

      {canEdit && GENERIC.has(node.kind) && (
        <div className="grid gap-1">
          <Label htmlFor={`node-label-${node.id}`} className="text-xs">Label</Label>
          <div className="flex gap-2">
            <Input id={`node-label-${node.id}`} value={label} onChange={e => setLabel(e.target.value)} className="h-8 text-xs" />
            <Button size="sm" variant="outline" disabled={patch.isPending || label.trim() === node.label || !label.trim()}
                    onClick={() => patch.mutate({ id: node.id, data: { version: node.version, label: label.trim() } })}>
              Save
            </Button>
          </div>
        </div>
      )}

      <section>
        <div className="mb-1 text-xs text-muted-foreground">
          Open flags{node.kind === 'frame' ? ' (including items inside)' : ''} ({flags.data?.length ?? 0})
        </div>
        <div className="space-y-2">
          {(flags.data ?? []).map(f => <FlagCard key={f.id} flag={f} />)}
          {flags.data?.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
        </div>
        {canEdit && (
          <div className="mt-2 space-y-1">
            <RaiseFlagButton entityType={anchor.type} entityId={anchor.id} targetLabel={node.label} variant="compact" />
            {board.visibility === 'restricted' && (
              <p className="text-xs text-muted-foreground">Visible to {groupNames || 'no groups'} and admins.</p>
            )}
          </div>
        )}
      </section>

      {node.kind === 'note' && <NoteEditor node={node} canEdit={canEdit} onSave={md => patch.mutate({ id: node.id, data: { version: node.version, data: { markdown: md } } })} pending={patch.isPending} />}
      {node.kind === 'link' && <LinkFields node={node} canEdit={canEdit} onSave={url => patch.mutate({ id: node.id, data: { version: node.version, data: { url } } })} pending={patch.isPending} />}
      {node.kind === 'entity' && meta && (
        <section className="space-y-2">
          <div className="text-xs text-muted-foreground">{meta.label}</div>
          {node.entity_type === 'document' && node.context?.deep_link?.kind === 'document' && (
            <DocumentPreviewFrame id={Number(node.context.deep_link.id)} />
          )}
          {node.context?.deep_link && node.context.deep_link.kind !== 'none' && (
            <Button size="sm" variant="outline" onClick={() => navigateToDeepLink(node.context!.deep_link!)}>Open</Button>
          )}
          <OnBoards type={node.entity_type} id={node.entity_id} current={board.slug} />
        </section>
      )}
      {node.kind === 'person' && <PersonInfo node={node} />}

      {canEdit && (
        <div className="mt-auto">
          <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending}
                  onClick={() => remove.mutate(node.id, { onSuccess: onClose })}>
            <Trash2 className="mr-1 h-4 w-4" />Delete node
          </Button>
        </div>
      )}
    </div>
  )
}

function NoteEditor({ node, canEdit, onSave, pending }: { node: BoardNode; canEdit: boolean; onSave: (md: string) => void; pending: boolean }) {
  const initial = String((node.data as { markdown?: string } | null)?.markdown ?? '')
  const [md, setMd] = useState(initial)
  if (!canEdit) return <pre className="whitespace-pre-wrap rounded-md border p-2 text-xs">{initial}</pre>
  return (
    <section className="grid gap-1">
      <Label htmlFor={`note-md-${node.id}`} className="text-xs">Markdown</Label>
      <Textarea id={`note-md-${node.id}`} value={md} onChange={e => setMd(e.target.value)} rows={8} className="text-xs" />
      <Button size="sm" variant="outline" disabled={pending || md === initial} onClick={() => onSave(md)}>Save note</Button>
    </section>
  )
}

function LinkFields({ node, canEdit, onSave, pending }: { node: BoardNode; canEdit: boolean; onSave: (url: string) => void; pending: boolean }) {
  const initial = String((node.data as { url?: string } | null)?.url ?? '')
  const [url, setUrl] = useState(initial)
  const safe = isSafeHttpUrl(initial)
  return (
    <section className="grid gap-1">
      <Label htmlFor={`link-url-${node.id}`} className="text-xs">URL</Label>
      {canEdit ? (
        <div className="flex gap-2">
          <Input id={`link-url-${node.id}`} value={url} onChange={e => setUrl(e.target.value)} className="h-8 text-xs" />
          <Button size="sm" variant="outline" disabled={pending || url === initial || !isSafeHttpUrl(url)} onClick={() => onSave(url.trim())}>Save</Button>
        </div>
      ) : (
        <span id={`link-url-${node.id}`} className="break-all text-xs">{initial}</span>
      )}
      <Button size="sm" variant="ghost" disabled={!safe} onClick={() => openExternal(initial)}>
        <ExternalLink className="mr-1 h-4 w-4" />Open externally
      </Button>
    </section>
  )
}

function PersonInfo({ node }: { node: BoardNode }) {
  const directory = useDirectoryUsers()
  const uid = Number((node.data as { user_id?: number } | null)?.user_id)
  const u = directory.data?.find(x => x.id === uid)
  return <section className="text-xs text-muted-foreground">{u ? u.email : `user ${uid}`}</section>
}

function OnBoards({ type, id, current }: { type: string | null; id: string | null; current: string }) {
  const refs = useBoardsForEntity(type, id)
  const others = (refs.data ?? []).filter(r => r.board_slug !== current)
  if (others.length === 0) return null
  return (
    <div className="text-xs text-muted-foreground">
      Also on: {others.map(r => `${r.board_name} > ${r.node_label}`).join(', ')}
    </div>
  )
}
```

Check `Textarea` exists under `src/components/ui/textarea.tsx` (it does per the listing) and `FlagCard`'s `flag` prop type (`FlagResponse`); if `useEntityFlags` returns a different element type, map it.

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/components/boards/__tests__ && npm run typecheck && npx eslint src/components/boards --max-warnings 0 && npx prettier --check src/components/boards
```

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add src/components/boards/BoardSidePanel.tsx src/components/boards/DocumentPreviewFrame.tsx src/components/boards/__tests__/BoardSidePanel.test.tsx
git commit -m "feat(boards): side panel with scoped flags, raise, note/link editors, document preview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/BoardSidePanel.tsx src/components/boards/DocumentPreviewFrame.tsx src/components/boards/__tests__/BoardSidePanel.test.tsx
```

---

### Task 5: Add palette

**Files:**
- Create: `src/components/boards/AddNodePalette.tsx`, `src/components/boards/__tests__/AddNodePalette.test.tsx`
- Modify: `src/components/boards/BoardPage.tsx` (Add button opens the palette; drop position from the canvas center)

**Interfaces:**
- `AddNodePalette({ board, open, onOpenChange, dropAt, parentId })`: a `CommandDialog` listing Frame, Text, Note, Link, Person, Document, Sample, Order, Worksheet. Generic kinds create immediately with a default label; Person shows a second step (directory typeahead via `useDirectoryUsers`); entity kinds show a second step using `useEntitySearch(entityType, q)` from `@/hooks/use-flags`; Link asks for a URL. Creates through `useCreateNode(board.slug)` at `dropAt` (or inside `parentId` when a frame is selected).

- [ ] **Step 1: Write the failing test**

`src/components/boards/__tests__/AddNodePalette.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ create: vi.fn(), search: [{ entity_id: 'SOP-0001', label: 'SOP-0001 · Sample check-in' }] }))
vi.mock('@/services/boards', () => ({ useCreateNode: () => ({ mutate: h.create, isPending: false }) }))
vi.mock('@/services/groups', () => ({ useDirectoryUsers: () => ({ data: [{ id: 10, email: 'd@x.t', first_name: 'Dennis', last_name: 'L' }], isLoading: false }) }))
vi.mock('@/hooks/use-flags', () => ({ useEntitySearch: () => ({ data: h.search, isLoading: false }) }))

import { AddNodePalette } from '@/components/boards/AddNodePalette'
import type { BoardDetail } from '@/lib/api-boards'

const board = { id: 1, slug: 'org', name: 'Org', kind: 'map', visibility: 'company', created_by: 1, default_viewport: null,
  node_count: 0, can_edit: true, created_at: '', updated_at: '', nodes: [], edges: [], grants: [] } as BoardDetail

describe('AddNodePalette', () => {
  beforeEach(() => h.create.mockReset())

  it('creates a frame at the drop point', async () => {
    render(<AddNodePalette board={board} open onOpenChange={() => {}} dropAt={{ x: 100, y: 50 }} parentId={null} />)
    await userEvent.setup().click(screen.getByText('Frame'))
    expect(h.create).toHaveBeenCalledWith(
      { kind: 'frame', label: 'New frame', x: 100, y: 50, w: 360, h: 220, parent_id: null, data: { color: 'slate' } },
      expect.anything()
    )
  })

  it('creates a document entity node from the typeahead', async () => {
    const user = userEvent.setup()
    render(<AddNodePalette board={board} open onOpenChange={() => {}} dropAt={{ x: 0, y: 0 }} parentId={7} />)
    await user.click(screen.getByText('Document'))
    await user.click(await screen.findByText('SOP-0001 · Sample check-in'))
    expect(h.create).toHaveBeenCalledWith(
      { kind: 'entity', label: '', entity_type: 'document', entity_id: 'SOP-0001', x: 0, y: 0, parent_id: 7, data: {} },
      expect.anything()
    )
  })

  it('creates a person node from the directory', async () => {
    const user = userEvent.setup()
    render(<AddNodePalette board={board} open onOpenChange={() => {}} dropAt={{ x: 0, y: 0 }} parentId={null} />)
    await user.click(screen.getByText('Person'))
    await user.click(await screen.findByText(/Dennis L/))
    expect(h.create).toHaveBeenCalledWith(
      { kind: 'person', label: 'Dennis L', x: 0, y: 0, parent_id: null, data: { user_id: 10 } },
      expect.anything()
    )
  })
})
```

- [ ] **Step 2: Run to verify failure**

Expected: module not found.

- [ ] **Step 3: Implement**

`src/components/boards/AddNodePalette.tsx`:

```tsx
import { useState } from 'react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useEntitySearch } from '@/hooks/use-flags'
import { useCreateNode } from '@/services/boards'
import { useDirectoryUsers } from '@/services/groups'
import type { BoardDetail, NodeCreate } from '@/lib/api-boards'
import { FRAME_DEFAULT } from './board-mapping'
import { isSafeHttpUrl } from './open-external'

type Step = 'kind' | 'person' | 'link' | 'entity'
const ENTITY_KINDS: { type: string; label: string }[] = [
  { type: 'document', label: 'Document' }, { type: 'sample', label: 'Sample' },
  { type: 'order', label: 'Order' }, { type: 'worksheet', label: 'Worksheet' },
]

export function AddNodePalette({ board, open, onOpenChange, dropAt, parentId }: {
  board: BoardDetail
  open: boolean
  onOpenChange: (o: boolean) => void
  dropAt: { x: number; y: number }
  parentId: number | null
}) {
  const create = useCreateNode(board.slug)
  const [step, setStep] = useState<Step>('kind')
  const [entityType, setEntityType] = useState<string>('document')
  const [q, setQ] = useState('')
  const [url, setUrl] = useState('')
  const directory = useDirectoryUsers()
  const hits = useEntitySearch(entityType, q)

  const submit = (data: NodeCreate) => {
    create.mutate({ ...data, x: dropAt.x, y: dropAt.y, parent_id: parentId }, {
      onSuccess: () => { onOpenChange(false); setStep('kind'); setQ(''); setUrl('') },
    })
  }

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) setStep('kind') }}>
      <DialogContent className="p-0">
        <DialogTitle className="sr-only">Add to board</DialogTitle>
        <Command>
          {step === 'kind' && (
            <>
              <CommandInput placeholder="Add to the board..." />
              <CommandList>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                <CommandGroup heading="Arrange">
                  <CommandItem onSelect={() => submit({ kind: 'frame', label: 'New frame', w: FRAME_DEFAULT.width, h: FRAME_DEFAULT.height, data: { color: 'slate' } })}>Frame</CommandItem>
                  <CommandItem onSelect={() => submit({ kind: 'text', label: 'Heading', data: { size: 'md' } })}>Text</CommandItem>
                  <CommandItem onSelect={() => submit({ kind: 'note', label: 'Note', data: { markdown: '' } })}>Note</CommandItem>
                  <CommandItem onSelect={() => setStep('link')}>Link</CommandItem>
                </CommandGroup>
                <CommandGroup heading="Live">
                  <CommandItem onSelect={() => setStep('person')}>Person</CommandItem>
                  {ENTITY_KINDS.map(k => (
                    <CommandItem key={k.type} onSelect={() => { setEntityType(k.type); setStep('entity') }}>{k.label}</CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </>
          )}
          {step === 'person' && (
            <>
              <CommandInput placeholder="Who?" />
              <CommandList>
                <CommandEmpty>No one matches.</CommandEmpty>
                <CommandGroup heading="People">
                  {(directory.data ?? []).map(u => {
                    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
                    return (
                      <CommandItem key={u.id} value={`${name} ${u.email}`}
                                   onSelect={() => submit({ kind: 'person', label: name, data: { user_id: u.id } })}>
                        {name} <span className="ml-2 text-xs text-muted-foreground">{u.email}</span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </CommandList>
            </>
          )}
          {step === 'entity' && (
            <>
              <CommandInput placeholder={`Search ${entityType}...`} value={q} onValueChange={setQ} />
              <CommandList>
                <CommandEmpty>{q.length < 2 ? 'Type at least two characters.' : 'No matches.'}</CommandEmpty>
                <CommandGroup heading={entityType}>
                  {(hits.data ?? []).map(hit => (
                    <CommandItem key={hit.entity_id} value={hit.label}
                                 onSelect={() => submit({ kind: 'entity', label: '', entity_type: entityType, entity_id: hit.entity_id, data: {} })}>
                      {hit.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </>
          )}
          {step === 'link' && (
            <form className="flex gap-2 p-3" onSubmit={e => { e.preventDefault(); if (isSafeHttpUrl(url)) submit({ kind: 'link', label: new URL(url).host, data: { url: url.trim() } }) }}>
              <input className="h-8 flex-1 rounded-md border bg-background px-2 text-xs" placeholder="https://..." value={url}
                     onChange={e => setUrl(e.target.value)} aria-label="Link URL" />
              <button type="submit" className="h-8 rounded-md border px-3 text-xs" disabled={!isSafeHttpUrl(url)}>Add link</button>
            </form>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
```

`cmdk` filters `CommandItem`s by their `value` (defaults to text content); the entity step passes `value={hit.label}` and drives the query through `onValueChange`, so cmdk's own filtering does not hide server hits. If `CommandInput` in `ui/command.tsx` does not forward `value`/`onValueChange`, wrap the `Command` with `shouldFilter={false}` on the entity step and read the input through an `onValueChange` prop it does forward; note the choice in the report.

`src/components/boards/BoardPage.tsx`: add `const [addOpen, setAddOpen] = useState(false)`; in the header, for editors, `<Button size="sm" onClick={() => setAddOpen(true)}><Plus className="mr-1 h-4 w-4" />Add</Button>` (import `Plus`); render `<AddNodePalette board={b} open={addOpen} onOpenChange={setAddOpen} dropAt={{ x: 120, y: 120 }} parentId={selectedFrameId} />` where `selectedFrameId` is `b.nodes.find(n => n.id === selectedId && n.kind === 'frame')?.id ?? null`. (Dropping at the viewport center needs the canvas's `screenToFlowPosition`; slice 4 refines this with the Cmd+K work. Record as a §14 note.)

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/components/boards/__tests__ && npm run typecheck && npx eslint src/components/boards --max-warnings 0 && npx prettier --check src/components/boards
```

- [ ] **Step 5: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add src/components/boards/AddNodePalette.tsx src/components/boards/BoardPage.tsx src/components/boards/__tests__/AddNodePalette.test.tsx
git commit -m "feat(boards): add palette for frames, text, notes, links, people and entities

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- src/components/boards/AddNodePalette.tsx src/components/boards/BoardPage.tsx src/components/boards/__tests__/AddNodePalette.test.tsx
```

---

### Task 6: Docs, changelog, spec amendments

**Files:**
- Modify: `CHANGELOG.md`, `docs/superpowers/specs/2026-09-26-planning-boards-design.md` (§14)

- [ ] **Step 1: Changelog**

Under `## Unreleased`, after the slice 1 and slice 2 subsections, add:

```markdown
### Planning boards, slice 3: the canvas
- **Boards page.** `#boards/overview` lists every board you can see; admins create boards, share them with groups (view or edit), and delete them.
- **The canvas.** `#boards/board?id=<slug>` opens an infinite canvas (React Flow): frames that hold other items, text, notes (markdown), links (open outside the app, never framed), people, and live entities (documents, samples, orders, worksheets) with their real labels. Drag to arrange, drop into a frame to group, connect handles to draw a relationship. Every save carries the item's version; if someone else saved first the board reloads and says so.
- **Side panel.** Selecting an item shows its open flags (frames include what is inside them), lets editors raise a flag on it, edit notes and links, preview a document, and see which other boards carry the same entity. Viewers get the same panel read-only.
- **Deep links.** A flag on a board item now opens the board with that item selected and centred (`?node=` in the hash, one-shot).
- Not yet: rollup badges on frames, the attention dock, zoom-level rendering, Cmd+K jump, auto-layout, widgets (slices 4 and 5).
```

- [ ] **Step 2: Spec §14**

Append:

```markdown
- Slice 3: the boards list route is `#boards/overview` (not `#boards/list`) so the sidebar's
  default sub-section works unchanged; the board route is `#boards/board?id=<slug>` with
  the one-shot `&node=<id>`. Feature pages use hard-coded English like every other Mk1 page
  (the i18n table in §8 applied only to the settings pane).
- Slice 3: new nodes drop at a fixed canvas offset (or inside the selected frame); dropping at
  the viewport centre and the Cmd+K palette land with slice 4.
- Slice 3: frame rollup pills, zoom-semantic rendering, the attention dock and dagre layout are
  slice 4 as §11 says; `FrameNode` renders title only in this slice.
```

- [ ] **Step 3: Commit**

```bash
cd /c/tmp/Accu-Mk1-boards
git add CHANGELOG.md docs/superpowers/specs/2026-09-26-planning-boards-design.md
git commit -m "docs(boards): slice 3 changelog and spec §14 amendments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- CHANGELOG.md docs/superpowers/specs/2026-09-26-planning-boards-design.md
```

---

### Task 7: Real-stack E2E with screenshots, then gates

**Files:**
- Create: `e2e/planning-boards-slice3.spec.ts`; evidence under `docs/superpowers/evidence/2026-09-27-planning-boards-slice3/`

Run by the controller against devbox stack `boards` with this branch mounted (the frontend is a vite dev server; it hot-reloads). Env as in the slice 1 spec.

- [ ] **Step 1: Write the spec**

`e2e/planning-boards-slice3.spec.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authenticate } from './fixtures/auth'

/**
 * Planning boards, slice 3: the canvas. Seeds a board through the API (a frame with a note
 * inside it, a link, a person, a document if the library has one), then drives the UI: opens
 * the boards page, opens the board, selects the frame, sees its flags, adds a text node via
 * the palette, drags it, reloads and sees it where it was dropped, and follows a board_node
 * deep link from the flag flyout.
 */
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'docs/superpowers/evidence/2026-09-27-planning-boards-slice3'
const RUN = Date.now().toString(36).slice(-4)
const SLUG = `map-${RUN}`

test.describe.configure({ mode: 'serial' })

async function token(request: APIRequestContext) {
  const r = await request.post(`${BACKEND_URL}/auth/login`, { data: { email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD } })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { access_token: string }).access_token
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name) })
}

let frameId = 0
let flagTitle = ''

test('seed a company map through the API', async ({ request }) => {
  const h = bearer(await token(request))
  const b = await request.post(`${BACKEND_URL}/api/boards`, { headers: h, data: { slug: SLUG, name: 'Company map', kind: 'map', visibility: 'company' } })
  expect(b.status(), await b.text()).toBe(201)
  const nodes = `${BACKEND_URL}/api/boards/${SLUG}/nodes`
  const frame = await request.post(nodes, { headers: h, data: { kind: 'frame', label: 'Marketing', x: 60, y: 60, w: 460, h: 280, data: { color: 'purple' } } })
  frameId = ((await frame.json()) as { id: number }).id
  await request.post(nodes, { headers: h, data: { kind: 'note', label: 'Q4 priorities', parent_id: frameId, x: 20, y: 60, data: { markdown: 'AccuVerify COA indexing is the SEO play.\n\n- Patent first\n- Newsletter consent live' } } })
  await request.post(nodes, { headers: h, data: { kind: 'link', label: 'accumarklabs.com', x: 620, y: 80, data: { url: 'https://accumarklabs.com' } } })
  const users = (await (await request.get(`${BACKEND_URL}/worksheets/users`, { headers: h })).json()) as { id: number }[]
  await request.post(nodes, { headers: h, data: { kind: 'person', label: 'Me', x: 620, y: 200, data: { user_id: users[0]!.id } } })
  const docs = (await (await request.get(`${BACKEND_URL}/api/documents?page_size=1`, { headers: h })).json()) as { items?: { code: string }[] }
  const code = docs.items?.[0]?.code
  if (code) await request.post(nodes, { headers: h, data: { kind: 'entity', entity_type: 'document', entity_id: code, x: 620, y: 300, data: {} } })
  flagTitle = `Plan Q4 campaign (${RUN})`
  const fl = await request.post(`${BACKEND_URL}/api/flags`, { headers: h, data: { entity_type: 'board_node', entity_id: String(frameId), type: 'task', title: flagTitle } })
  expect(fl.status()).toBe(201)
})

test('boards page lists the board and opens the canvas', async ({ page }) => {
  await authenticate(page)
  await page.goto('/#boards/overview')
  await expect(page.getByText('Company map')).toBeVisible({ timeout: 30_000 })
  await shot(page, '01-boards-list.png')
  await page.locator('div', { hasText: 'Company map' }).getByRole('button', { name: 'Open' }).first().click()
  await expect(page.locator('.react-flow__node-frame')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Marketing')).toBeVisible()
  await expect(page.getByText('Q4 priorities')).toBeVisible()
  await shot(page, '02-canvas-company-map.png')
})

test('selecting the frame shows its flags in the side panel', async ({ page }) => {
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  const frame = page.locator('.react-flow__node-frame').first()
  await expect(frame).toBeVisible({ timeout: 30_000 })
  await frame.click({ position: { x: 20, y: 12 } })
  await expect(page.getByText(flagTitle)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /Raise flag/ })).toBeVisible()
  await shot(page, '03-side-panel-frame-flags.png')
})

test('add a text node from the palette, drag it, reload, it stays', async ({ page }) => {
  await authenticate(page)
  await page.goto(`/#boards/board?id=${SLUG}`)
  await expect(page.locator('.react-flow__node-frame').first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByText('Text', { exact: true }).click()
  const text = page.locator('.react-flow__node-text', { hasText: 'Heading' })
  await expect(text).toBeVisible({ timeout: 10_000 })
  const before = await text.boundingBox()
  await text.hover()
  await page.mouse.down()
  await page.mouse.move(before!.x + 260, before!.y + 180, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  await page.reload()
  await expect(page.locator('.react-flow__node-frame').first()).toBeVisible({ timeout: 30_000 })
  const after = await page.locator('.react-flow__node-text', { hasText: 'Heading' }).boundingBox()
  expect(Math.abs(after!.x - (before!.x + 260))).toBeLessThan(40)
  expect(Math.abs(after!.y - (before!.y + 180))).toBeLessThan(40)
  await shot(page, '04-dragged-text-node-persisted.png')
})

test('a board_node flag deep-links to the board with the node selected', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')
  await page.locator('#flags-header-button').click()
  await page.getByRole('tab', { name: 'All open' }).click()
  const row = page.getByText(flagTitle).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const open = page.getByRole('button', { name: /Company map|Open/ }).first()
  if (await open.isVisible().catch(() => false)) await open.click()
  await expect(page.locator('.react-flow__node-frame').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(flagTitle)).toBeVisible({ timeout: 15_000 })
  await shot(page, '05-deep-link-from-flag.png')
})
```

The deep-link test depends on how the flag thread exposes the entity link (a chip or an "Open" control); read `FlagThread.tsx` for the control's accessible name before finalizing the locator, and if the thread offers no navigation control for `board_node`, navigate with `page.goto(\`/#boards/board?id=${SLUG}&node=${frameId}\`)` and assert the frame is selected (`.react-flow__node.selected`), recording that the flyout chip is a slice 4 item.

- [ ] **Step 2: Run (controller), commit the spec and evidence**

```bash
cd /c/tmp/Accu-Mk1-boards
git add e2e/planning-boards-slice3.spec.ts docs/superpowers/evidence/2026-09-27-planning-boards-slice3/
git commit -m "test(e2e): planning boards slice 3 canvas walkthrough with evidence screenshots

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- e2e/planning-boards-slice3.spec.ts docs/superpowers/evidence/2026-09-27-planning-boards-slice3/
```

- [ ] **Step 3: Gates**

```bash
cd /c/tmp/Accu-Mk1-boards
npx vitest run src/components/boards src/components/layout src/components/flags src/components/preferences && npm run typecheck && npx eslint src/components/boards src/lib/api-boards.ts src/services/boards.ts src/store/ui-store.ts src/lib/hash-navigation.ts src/components/layout/MainWindowContent.tsx src/components/layout/AppSidebar.tsx src/components/flags/flag-entity.ts e2e/planning-boards-slice3.spec.ts --max-warnings 0 && npx prettier --check src/components/boards src/lib/api-boards.ts src/services/boards.ts e2e/planning-boards-slice3.spec.ts && npx eslint . 2>&1 | tail -3
```

The repo-wide eslint count must not exceed master's 545. Backend suites are untouched by this slice; run the eight new backend files once to prove nothing drifted: `"$PY" -m pytest tests/test_boards_routes.py tests/test_boards_nodes.py tests/test_flags_board_node.py -q -p no:cacheprovider`.

- [ ] **Step 4: Report**

Per gate: command, summary line, pass/fail; anything skipped. The controller then runs the whole-branch review and opens the PR with the screenshots.

---

## Self-review notes

- Spec coverage: §8.1 (Task 1), §8.2 (Task 2), §8.3 minus rollups/zoom (Task 3), §8.4 (Task 4), §8.5 (Task 5), §8.7 (Task 3: positions batch, per-node PATCH with version, viewport localStorage, 409 handling in `services/boards.ts`), §8.9 (Tasks 1 and 4), §4.7 data shapes (Tasks 3 and 5), §7.3 routes (Task 1). Deliberately deferred to slice 4 per §11: §8.3 rollup pills and zoom-semantic rendering, §8.6, dagre; to slice 5: widgets.
- Deviations recorded in §14 (Task 6): `#boards/overview`, hard-coded English on feature pages, fixed drop offset.
- Name consistency: `boardKeys`, `useBoard`, `usePatchPositions`, `useCreateNode` (Task 1) used by Tasks 3 to 5; `toFlowNodes`/`toFlowEdges`/`resolveParentOnDrop`/`toPositionItems`/`FRAME_DEFAULT` (Task 3) used by Task 5; `isSafeHttpUrl`/`openExternal` (Task 3) used by Tasks 4 and 5; `consumePendingBoardNode`/`navigateToBoardNode` (Task 1) used by Task 3 and `flag-entity.ts`.
- Review Focus 1 to 5: Task 3 `board-mapping.test.ts` (1), `boards-service.test.tsx` (2), Task 4 `BoardSidePanel.test.tsx` (3), Task 3 `LinkNode.test.tsx` (4), Task 1 `navigation.test.tsx` (5).
- Risk the plan cannot remove: xyflow's `onNodeDragStop` signature and cmdk's `CommandInput` value forwarding are verified by the implementer against `node_modules` at build time; both have fallbacks written into their tasks.
