# Planning Boards: design

Infinite-canvas boards inside Accu-Mk1: a company map, an org chart, training walk-throughs,
and restricted executive boards. Brainstormed 2026-09-26; plan brief approved the same day.
Hindsight initiative page `kp-53c2e0e5e0ff461cae4e0e5f390b028c`.

## 1. Purpose

Give the business one zoomable view: departments, the people in them, the systems we run,
the SOPs behind each department, and the open work, in a single spatial layout that the
brain can hold. Some boards are for every staff login (org chart, training). Some are for a
small group (executive planning).

Design stance: **a board is a spatial index over things Mk1 already tracks, plus a few
generic objects for arranging them.** Nothing on a board is a copy of data that lives
elsewhere. Tasks are flags. SOPs are documents. People are users. The board adds "where" to
"what", and a group-based visibility boundary that Mk1 did not have before.

Reuse, verified against `origin/master` `bdc11fed` (v1.28.0):

- `@xyflow/react`, `@dagrejs/dagre`, `@dnd-kit/*` are installed. Template canvas:
  `src/components/preferences/panes/workflow/GraphCanvas.tsx` (+ `layout.ts`).
- Flag system: opaque `(entity_type, entity_id)` anchors, registry `backend/flags/seams.py`
  (`EntitySpec`, `register_entity`, `register_mk1_entities`), routes `backend/flags/routes.py`,
  SSE bus `backend/flags/bus.py` whose `_visible_to(user_id, event)` is documented as the
  single swap point for per-user scoping, permissions `backend/flags/permissions.py` whose
  docstring reserves "user-group permissions" as a future swap.
- Documents library: `documents.code` (`SOP-0001`) is the stable reference; flags on documents
  anchor on the code; `DocumentViewer.tsx` renders a sandboxed `srcDoc` frame.
- Users: `User(email, role 'admin'|'standard', is_active, first_name, last_name)`. No
  department, manager, or group data exists.
- Page registration: `ui-store.ts` `ActiveSection`, `hash-navigation.ts` `VALID_SECTIONS`,
  `MainWindowContent.tsx` switch, `AppSidebar.tsx` `navItems`. Settings panes register in
  `src/components/preferences/panes.tsx`.
- Backend module shape: `backend/<pkg>/{models,schemas,service,routes}.py`; `database.py`
  `init_db()` imports models then runs `_run_migrations()` (idempotent DDL, no alembic) then
  `create_all`. Non-LIMS tables carry their own prefix (`flag_`, `documents`), never `lims_`.

## 2. Non-goals

- Not a drawing tool. No free shapes, pen, or arbitrary connectors beyond typed edges.
- No multiplayer cursors or CRDT. One editor at a time per node is enough (optimistic lock).
- No iframes of external sites. Tauri `frame-src` is a fixed allow-list
  (`src-tauri/tauri.conf.json:33`); most admin consoles refuse framing anyway.
- No new task model, document model, or department table. Flags, documents, and board frames
  already cover them.
- No per-user completion tracking for training boards in this spec (listed in §12).
- No change to the flag SSE wire contract beyond one server-side-only field that is stripped
  before framing (§6.4).

## 3. Concepts

- **Board**: a named canvas with a `kind` (display hint: `map`, `org`, `training`, `custom`)
  and a `visibility`: `company` (every active user can view) or `restricted` (only granted
  groups and admins can view).
- **Group**: a named set of users, admin-managed. Groups are the unit of access for boards
  and, through board nodes, for flags. Admins are implicitly members of every group for
  visibility purposes.
- **Node**: one object on a board. Two families:
  - Generic objects, no Mk1 record behind them: `frame`, `text`, `note`, `link`.
  - Live objects: `entity` (a registered flag entity such as `document`, `sample`, `order`,
    `worksheet`), `person` (a user), `widget` (a mounted Mk1 report component).
- **Edge**: a typed line between two nodes on the same board: `related`, `reports_to`,
  `depends_on`, `next`.
- **`board_node`**: the one new flag entity type. Any node's id is a flag anchor, so a
  department frame, a sticky note, or a system link can carry tasks and threads. A node of
  kind `entity` is NOT anchored as `board_node`; flags on it anchor on the underlying entity
  (`document` + code, `sample` + id) so the same thread shows on the board, in the library
  viewer, and in the flag flyout.
- **Flag visibility**: a flag is visible to a user iff its anchor entity is visible to that
  user. Legacy anchors and unanchored general tasks stay visible to all staff. `board_node`
  anchors defer to the board.

## 4. Data model

All new tables are created by `Base.metadata.create_all` on boot (models imported in
`database.init_db()`); later column additions go into `_run_migrations()`. JSON columns use
the repo idiom `JSONB().with_variant(JSON(), "sqlite")`. User references are plain integer
columns with no FK, matching the flags module, except where noted.

### 4.1 `user_groups`

| column | type | notes |
|---|---|---|
| id | int pk | |
| slug | str(60) unique | immutable; `[a-z0-9-]`, set at create, never changed |
| name | str(120) | display |
| description | text null | |
| is_active | bool default true | deactivate hides from pickers; grants keep working |
| created_at | datetime | |

### 4.2 `user_group_members`

| column | type | notes |
|---|---|---|
| id | int pk | |
| group_id | int fk `user_groups.id` ondelete cascade | |
| user_id | int | no FK, flags convention |

Unique `(group_id, user_id)`. Index on `user_id`.

Helper: `groups.access.user_group_ids(db, user) -> frozenset[int]`, one query, cached on
the request-scoped user object when present. `groups.access.is_admin(user)`.

### 4.3 `board_boards`

| column | type | notes |
|---|---|---|
| id | int pk | |
| slug | str(60) unique | immutable; used in hashes and deep links |
| name | str(120) | |
| kind | str(20) | `map` / `org` / `training` / `custom`; display hint only |
| visibility | str(20) | `company` / `restricted`; CHECK constraint |
| created_by | int | user id |
| default_viewport | JSON null | `{x, y, zoom}` applied to first-time viewers |
| created_at, updated_at | datetime | |

### 4.4 `board_grants`

| column | type | notes |
|---|---|---|
| id | int pk | |
| board_id | int fk `board_boards.id` ondelete cascade | |
| group_id | int fk `user_groups.id` ondelete cascade | |
| can_edit | bool default false | |

Unique `(board_id, group_id)`. A company board's grants only decide who can EDIT; viewing is
universal. A restricted board's grants decide both.

### 4.5 `board_nodes`

| column | type | notes |
|---|---|---|
| id | int pk | the `board_node` flag anchor id (stringified) |
| board_id | int fk `board_boards.id` ondelete cascade | |
| kind | str(20) | `frame` / `text` / `note` / `link` / `entity` / `person` / `widget` |
| label | str(200) | display title; for `entity` kind a cached copy of the registry label |
| parent_id | int fk `board_nodes.id` ondelete set null, null | frame containment (xyflow `parentId`) |
| x, y | float | position; relative to parent when `parent_id` is set (xyflow semantics) |
| w, h | float null | frames and notes are resizable; null = auto |
| z | int default 0 | stacking |
| entity_type | str(50) null | set only for `entity` kind |
| entity_id | str(200) null | set only for `entity` kind |
| data | JSON null | per-kind payload, §4.7 |
| version | int default 1 | optimistic lock; every PATCH must send the version it read |
| created_by, updated_by | int | |
| created_at, updated_at | datetime | |

Indexes: `(board_id)`, `(entity_type, entity_id)` for the "on boards" reverse lookup,
`(parent_id)`. A frame's children are nodes whose `parent_id` is the frame. One level of
nesting is enough for v1; the API rejects a `parent_id` that itself has a parent.

### 4.6 `board_edges`

| column | type | notes |
|---|---|---|
| id | int pk | |
| board_id | int fk `board_boards.id` ondelete cascade | |
| source_id, target_id | int fk `board_nodes.id` ondelete cascade | must be on the same board |
| kind | str(20) | `related` / `reports_to` / `depends_on` / `next` |
| label | str(120) null | |

Unique `(board_id, source_id, target_id, kind)`.

### 4.7 Node `data` by kind (Pydantic discriminated union in `schemas.py`)

| kind | data | validation |
|---|---|---|
| frame | `{color}` | color from a fixed palette of 8 tokens |
| text | `{size}` | `sm` / `md` / `lg` |
| note | `{markdown}` | max 20 000 chars; rendered with the flag comment pipeline (markdown-it + DOMPurify) |
| link | `{url, description?}` | `http(s)://` only, max 2048; no `javascript:` or `data:` |
| entity | `{}` | `entity_type` must be `seams.is_registered`; `resolve_context` must return non-None at create (same rule as `must_exist`) |
| person | `{user_id}` | user exists and `is_active` |
| widget | `{key}` | key in the server allow-list `boards.widgets.ALLOWED` (v1: empty list; §12) |

### 4.8 Deletion rules

- Deleting a node with an OPEN flag anchored on it (`board_node` + that id) is a 409 naming the
  flag count. Resolved and closed flags become orphans whose registry `context` resolves to
  None and whose label renders "Deleted board item". Same class of rule as `must_exist`.
- Deleting a board requires zero open flags across its nodes (409 otherwise). Cascade removes
  nodes, edges, grants.
- Deleting a group cascades grants and memberships. A restricted board left with zero grants
  is visible to admins only, which is the safe direction.
- Deactivating a group (`is_active=false`) is the soft path and is what the UI offers first.

## 5. Access rules

One module, `backend/boards/access.py`, answers every question; routes and the flag seam call
it, nothing else re-derives the rule.

```
can_view_board(db, user, board) -> bool
    admin                         -> True
    board.visibility == 'company' -> user.is_active
    else                          -> any grant.group_id in user_group_ids(user)

can_edit_board(db, user, board) -> bool
    admin -> True
    else  -> any grant with can_edit for a group the user is in

visible_board_ids(db, user) -> Select
    admin -> all boards
    else  -> company boards UNION boards granted to the user's groups
```

Board administration (create, delete, change visibility, set grants) is admin-only in v1.
Content editing (nodes, edges, name, kind, default viewport) requires `can_edit_board`.

## 6. Flag integration

### 6.1 Registering `board_node`

Inside `register_mk1_entities()` (host closures, lazy imports, per
`docs/developer/flags-add-entity.md`):

```python
register_entity("board_node",
    label=_board_node_label,                 # "<board name> > <node label>"
    deep_link=lambda eid: "/#boards/board",  # legacy form; real nav rides context.deep_link
    can_flag=_board_node_can_flag,           # can_edit_board
    can_view=_board_node_can_view,           # NEW seam, §6.2
    visible_entity_ids=_board_node_visible_ids,  # NEW seam, §6.2
    context=_board_node_context,             # {label, deep_link:{kind:'board_node', id:'<slug>:<node_id>'}, board_slug, node_kind}
    contexts=_board_node_contexts,           # batch, one query
    descendants=_board_node_descendants,     # frame -> children: ('board_node', id) for generic children, (entity_type, entity_id) for entity children
    search_scoped=_board_node_search,        # ILIKE label within visible_board_ids(user), §6.2
    snapshot=lambda db, eid: {"board": slug, "kind": kind},
    must_exist=True)
```

`deep_link.kind = 'board_node'` with `id = "<board_slug>:<node_id>"`. Frontend
`flag-entity.ts` gains `ENTITY_META.board_node` (icon `Map`) and a `navigateToDeepLink`
case that calls `navigateToBoardNode(slug, nodeId)`.

Flag types can be scoped to `board_node` through the existing `flag_types.entity_types`
vocabulary; no change to the type catalog.

`can_flag` for `board_node` returns False when the node is of kind `entity`; flags on those
belong on the underlying entity, and `create_flag` answers 400 naming that anchor.

### 6.2 New optional seams on `EntitySpec`

```python
can_view: Optional[Callable[[Session, object, str], bool]] = None
visible_entity_ids: Optional[Callable[[Session, object], Optional[Select]]] = None
search_scoped: Optional[Callable[[Session, object, str], list]] = None
```

- `can_view(db, user, entity_id)`: point check. Unset means visible to all staff.
- `visible_entity_ids(db, user)`: a `Select` of the entity_ids (as strings) of this type the
  user may see, or `None` meaning "all". Lets list queries stay in SQL.
- `search_scoped(db, user, q)`: typeahead that needs the user. `resolve_entity_search`
  prefers it when defined and falls back to `search`. One additive branch.

Helpers in `seams.py`:

```python
def can_view_entity(db, user, entity_type, entity_id) -> bool
def visibility_clause(db, user) -> ColumnElement
    # AND over registered types that define visible_entity_ids:
    #   (FlagFlag.entity_type != T) OR (FlagFlag.entity_id IN <subselect>)
    # for each such T; types without the seam add nothing. Unanchored flags pass.
```

`_board_node_visible_ids` =
`select(cast(BoardNode.id, String)).where(BoardNode.board_id.in_(visible_board_ids(db, user)))`.

### 6.3 Enforcement points (all server-side)

| path | change |
|---|---|
| `service.list_flags`, `list_unread`, `summary`, `search_flags`, `list_activity` (flag join) | add `.where(seams.visibility_clause(db, user))` |
| `routes.get_flag` and every `/{flag_id}/...` route (read, comments, assign, status, due, watchers, links, attachments) | first call `service.get_visible_flag(db, user, flag_id)`, which raises `NotFoundError` when `can_view_entity` is false. 404, never 403: do not confirm existence |
| `routes.get_attachment` | load the owning flag, same visibility check |
| `routes.get_flag` entity links | for each link, if `can_view_entity` is false: `entity=None`, label "Restricted" |
| `service.create_flag`, `assign`, `add_watcher`, `add_comment` mentions | 400 `"user <id> cannot see this flag"` when the target user fails `can_view_entity` on the anchor |
| `create_flag` | `can_flag` for `board_node` = `can_edit_board`; viewers can comment and watch but not raise |
| `/entity-search` | `board_node` scoped to visible boards (§6.2) |
| `/watches` | unchanged: `board_node` registers no `state` seam, so arming a watch already 400s |
| recurring flags | admin-only already; a recurrence targeting a `board_node` is allowed |

Every function above takes `user`, not `user_id`, where it does not already. `list_flags`
and friends currently take `user_id`; add a `user` kwarg and derive `user_id` from it
(additive, callers updated in the same commit).

### 6.4 SSE stream

The bus stays broadcast-all internally. `service._audit` (the producer, which has a db
session) stamps each event with `audience`:

```
audience: None                       # visible to everyone (legacy anchors, general tasks)
audience: {"groups": [1, 7]}          # restricted board: granted group ids
```

`Subscription` gains `group_ids: frozenset[int]` and `is_admin: bool`, loaded at subscribe
time in the stream route (one query). `FlagEventBus._visible_to(sub, event)` returns True
when `audience is None`, `sub.is_admin`, or `audience.groups` intersects `sub.group_ids`.
The stream route deletes `audience` from the dict before framing, so the wire contract is
unchanged. Group membership changes take effect on the next reconnect; the Groups pane says
so ("changes apply when the app reconnects").

### 6.5 Slack DMs and digests

Recipients are assignee, mentioned users, and watchers, all of which pass the §6.3 target
guard, so a DM never names a flag the recipient cannot open. The morning digest builds from
`list_flags(user=...)`, which now carries the clause. No Slack-side change.

### 6.6 Unanchored group-restricted tasks (decision pending)

The plan left open whether an unanchored general task may be restricted to one group via a
nullable `flag_flags.group_id`. The machinery above supports it at one place: `audience` and
`visibility_clause` would also consult that column. **Not built in this spec.** If the
Handler wants it, it is a one-column, one-clause addition to slice 2 and this section is
amended.

## 7. API

All routes require `get_current_user`. Boards a user cannot view are 404 on every route.
Errors follow the flags module's `_http` mapping (NotFound → 404, BadRequest → 400,
Conflict → 409).

### 7.1 Groups (`/api/groups`)

| route | who | notes |
|---|---|---|
| `GET /api/groups` | any user | active groups, id + slug + name only (needed for share pickers) |
| `GET /api/groups/mine` | any user | the caller's group ids and slugs |
| `POST /api/groups` | admin | `{slug, name, description}` |
| `PUT /api/groups/{id}` | admin | name, description, is_active; slug immutable (400 if sent and different) |
| `DELETE /api/groups/{id}` | admin | hard delete only when the group has no grants and no members; otherwise 409 with "deactivate instead" |
| `GET /api/groups/{id}/members` | admin | |
| `PUT /api/groups/{id}/members` | admin | replace list `{user_ids: [...]}` |

### 7.2 Boards (`/api/boards`)

| route | who | notes |
|---|---|---|
| `GET /api/boards` | any user | visible boards with `can_edit` per board |
| `POST /api/boards` | admin | `{slug, name, kind, visibility}`; `visibility='restricted'` is rejected with 400 until `boards.RESTRICTED_BOARDS_ENABLED` is flipped by slice 2 (§11) |
| `GET /api/boards/{slug}` | viewer | board + all nodes + all edges + `can_edit` in one payload; node `entity` kinds carry a resolved `context` via `seams.resolve_contexts` (batched) |
| `PATCH /api/boards/{slug}` | editor | name, kind, default_viewport; `visibility` only by admin |
| `DELETE /api/boards/{slug}` | admin | 409 if any node has open flags |
| `PUT /api/boards/{slug}/grants` | admin | replace `[{group_id, can_edit}]` |
| `GET /api/boards/for-entity?entity_type=&entity_id=` | any user | visible boards and node ids referencing that entity (the "on boards" list in the side panel and, later, in the document viewer) |

### 7.3 Nodes and edges

| route | who | notes |
|---|---|---|
| `POST /api/boards/{slug}/nodes` | editor | body per §4.7; returns the node |
| `PATCH /api/boards/{slug}/nodes/{id}` | editor | partial; must include `version`; mismatch → 409 with the current row |
| `PATCH /api/boards/{slug}/nodes/positions` | editor | bulk `[{id, x, y, parent_id?, version}]` for multi-drag; all-or-nothing, 409 lists the stale ids |
| `DELETE /api/boards/{slug}/nodes/{id}` | editor | §4.8; children of a deleted frame get `parent_id=null` and absolute coordinates |
| `POST /api/boards/{slug}/edges` | editor | source and target must be on this board |
| `PATCH /api/boards/{slug}/edges/{id}` | editor | kind, label |
| `DELETE /api/boards/{slug}/edges/{id}` | editor | |

## 8. Frontend

### 8.1 Navigation

- `ActiveSection` gains `'boards'`; `BoardsSubSection = 'list' | 'board'`.
- Hashes: `#boards/list`, `#boards/board?id=<slug>`, `#boards/board?id=<slug>&node=<id>`.
  `parseNavHash` gains a one-shot `nodeId` exactly like `flagId` (selects and centers the
  node, never re-emitted by `buildHash`).
- `ui-store` gains `navigateToBoard(slug)` and `navigateToBoardNode(slug, nodeId)`.
- `MainWindowContent`: `case 'boards'` → `BoardsPage` or `BoardPage`.
- `AppSidebar`: top-level item "Boards" (icon `Map`). Rendered when the user is admin OR
  `useVisibleBoards()` returns at least one board. No sub-items; the list page is the entry.

### 8.2 Boards list: `src/components/boards/BoardsPage.tsx`

Cards: name, kind badge, visibility badge, node count, open-flag count (one `all_open` fetch
filtered to the board's anchors), "Open". Admin sees "New board" and per-board "Share"
(grants) and "Delete".

### 8.3 Canvas: `src/components/boards/BoardCanvas.tsx`

Lazy-loaded like `GraphCanvas`. `ReactFlow` with `Background`, `MiniMap`, `Controls`,
`NodeResizer` on frames and notes, `nodeTypes` = one component per kind:

- `FrameNode`: dashed colored container, title, rollup pills (blocking count in danger
  color, other open count in warning color) from the board-wide flag map. Children are
  xyflow child nodes (`parentId`, `extent: 'parent'`), so they move with the frame.
- `TextNode`: label at `sm|md|lg`.
- `NoteNode`: rendered markdown, click to edit in the side panel.
- `LinkNode`: generic link icon (no third-party favicon fetch), title, hostname. Click opens
  via the Tauri opener plugin on desktop, `window.open` on web.
- `EntityNode`: icon from `entityMeta`, label from `context.label`, `FlagIndicator` for the
  underlying entity. Click selects; double-click deep-links via `navigateToDeepLink`.
- `PersonNode`: `FlagAvatar` + name + "N assigned" pill (open flags where `assignee_id` =
  user, from the same `all_open` fetch).
- `WidgetNode`: placeholder in v1 ("widgets arrive in a later release"); §12.

Zoom-semantic rendering: `useStore(s => s.transform[2])`; below 0.5 zoom, frames render only
title + pills and child nodes hide their body text. Cmd+K opens a `cmdk` palette listing the
board's nodes; selecting one calls `fitView({nodes:[id]})`.

Auto-layout: "Layout" button runs dagre (existing `layout.ts` pattern) over the selected
frame's children using `reports_to` edges top-down, or over the whole board when nothing is
selected. Manual placement otherwise.

### 8.4 Side panel: `src/components/boards/BoardSidePanel.tsx`

Opens on node select (right, 380 px, `react-resizable-panels` already installed).

- Header: kind icon, label (editable for generic kinds), kind-specific meta.
- Open flags on this node: `useEntityFlags` for `(board_node, id)` or for the underlying
  entity when kind is `entity`; rows use `FlagCard`; frames pass `includeDescendants`.
- "Raise flag on <label>": `RaiseFlagButton` preset to the anchor. Hidden when the user
  cannot edit the board (matches `can_flag`). One-line hint below it on restricted boards:
  "Visible to <group names> and admins."
- Kind sections: `note` markdown editor with preview; `link` url + description; `entity`
  document preview (`DocumentViewer` frame) for `document`, `navigateToDeepLink` button for
  the rest; `person` name, email, groups.
- "On boards": `GET /api/boards/for-entity` for `entity` kinds.
- Delete node (editors), with the §4.8 409 surfaced as a toast naming the open flags.

### 8.5 Add palette

"Add" button opens a `cmdk` palette: Frame, Text, Note, Link, Person (typeahead over
`/worksheets/users`), Entity (type picker, then `/entity-search` typeahead), Widget (hidden
in v1). New nodes drop at the viewport center; if a frame is selected they drop inside it.
"Add from library" is the Entity path with `document` preselected.

### 8.6 Attention dock

Right-side collapsible list of open flags anchored on this board's nodes (and on entity
nodes' underlying entities) that are blocking or past due, sorted overdue-first. "Locate"
calls `fitView` on the anchor node. Data: the one board-wide `all_open` fetch, mapped by
anchor. Live via the existing SSE glue invalidating `flagKeys`.

### 8.7 Persistence

- Drag end → debounced (250 ms) `PATCH .../positions` with versions. 409 → refetch the
  board, toast "Board changed elsewhere, reloaded".
- Field edits → per-node `PATCH` with `version`.
- Viewport → `localStorage` key `boards:viewport:<slug>` (existing view-state pattern).
  First visit uses `default_viewport`; editors get "Set as default view".
- TanStack Query keys: `['boards']`, `['boards', slug]`, `['boards','for-entity',type,id]`.

### 8.8 Settings: Groups pane

`src/components/preferences/panes/GroupsPane.tsx`, registered in `panes.tsx` as `groups`
(icon `Users`). Admin-only pane: list groups, create, rename, deactivate, edit members
(user picker over `/worksheets/users`). Delete only when unused (409 otherwise). Note under
the members editor: "Stream visibility changes apply when the app reconnects."

### 8.9 Gating

Every board route is gated server-side (§5). The sidebar item and the Add/Raise controls are
convenience hiding only. `useAuthStore` role checks stay for admin-only buttons.

## 9. Security

Threat model (per the workspace doctrine):

- What breaks if this is wrong: an executive board's notes, or a flag titled with sensitive
  content, becomes readable by any staff login. That is the failure to design against.
- Attacker path: a `standard` user with a valid JWT enumerating `/api/boards/<slug>`,
  `/api/flags?tab=all_open`, `/api/flags/<id>`, `/api/flags/attachments/<id>`,
  `/api/flags/entity-search`, or holding an SSE connection.
- Rollback: boards are additive tables and one registry entry; the visibility clause is a
  pure narrowing. Reverting the release restores prior behavior with no data migration.

Controls:

- 404 for invisible boards and flags on every route; existence is never confirmed.
- Visibility is computed in SQL for lists and in one helper for point reads. There is one
  implementation (`boards.access` + `seams.visibility_clause`), tested per route.
- Assign, watcher, and mention guards prevent pulling a non-viewer into a restricted thread.
- SSE audience stamped by the producer with a db session; the bus never touches the db.
- Link URLs restricted to `http(s)`; opened externally, never framed. No favicon fetches to
  third parties.
- Note markdown goes through the existing markdown-it + DOMPurify pipeline (XSS suite already
  covers it; add the note component to that suite).
- Group and board administration is admin-only. Board editors cannot widen visibility.
- No secrets belong on a board. The Groups pane and the restricted-board share dialog carry a
  one-line reminder. Flags on restricted nodes are restricted, but flag TITLES still transit
  Slack DMs to their participants; participants are viewers by construction.

The re-review trigger recorded in the 2026-07-01 flag security review is addressed by §6.3
and §6.4; a fresh review pass is part of slice 2's gate (§11).

## 10. Testing

Backend (`pytest`, SQLite fixtures as in `backend/flags/tests`, plus one stack run on
Postgres before merge because SQLite green is not proof):

- Groups: CRUD, immutable slug, delete-vs-deactivate 409, membership replace.
- Boards access matrix: for each of {admin, member-with-edit, member-view-only, non-member,
  inactive user} × {company, restricted}: list, get, patch, node create, node delete. Expect
  the §5 table exactly; invisible = 404.
- Node validation per kind (§4.7), parent depth 1, cross-board edge 400, version 409,
  positions all-or-nothing.
- Deletion rules (§4.8): node with open flag 409, resolved flag becomes orphan with label
  "Deleted board item", board delete 409.
- Flag visibility, one test per row of §6.3, each with non-member, member, admin. Includes
  `all_open` excluding the restricted flag, detail 404, attachment 404, entity-search
  excluding restricted nodes, assign 400, mention 400, entity link label "Restricted".
- SSE: publish a restricted-anchor event to three subscriptions (non-member, member, admin);
  assert delivery to the last two only and that `audience` is absent from the framed data.
- Registry: `board_node` context, contexts batch equals per-id loop, descendants for a frame
  containing a document node yields both `board_node` and `document` pairs, `must_exist`.
- Legacy: existing flag tests unchanged; the clause on a db with no boards is a no-op
  (pin with a query-count test on `list_flags`).

Frontend (`vitest`): node data mapping to xyflow nodes (parentId, extent), hash parse with
`&node=`, sidebar gating hook, side panel raise-button hiding for viewers, zoom-semantic
threshold, positions debounce and 409 handling.

Stack (accumark-stack sandbox from the golden, worktree mounted): create group `exec`; company
board "Org chart" with 3 people and `reports_to` edges; restricted board "Exec map" granted to
`exec` with 2 frames, 2 SOP nodes, a note, a link. Prove with two browsers: a non-member
`standard` login sees Org chart only, 404 on the Exec map routes, never sees a flag raised on
an Exec frame in All Open, activity, search, or its SSE stream; the member and admin do. A
flag raised on the SOP node appears on the board, in the library viewer header, and in the
flyout. Desktop build: a link node opens externally and no iframe is attempted.

Gates: `npm run check:all`; backend failure-set diff versus master (never zero-failures);
ONE pytest suite at a time (host dev Postgres deadlock rule).

## 11. Rollout

1. **Groups + boards backend**: §4, §5, §7, `board_node` registration with the new seams
   defined but the flag read paths untouched, Groups pane. Ships with
   `RESTRICTED_BOARDS_ENABLED = False`, so only company boards can exist.
2. **Flag visibility enforcement**: §6.3, §6.4, §6.5, tests, security review pass. Flips
   `RESTRICTED_BOARDS_ENABLED`.
3. **Canvas**: §8.1 through §8.5, §8.7, §8.9.
4. **Live layer**: §8.6 dock, frame rollups, zoom-semantic rendering, Cmd+K, dagre layout.
5. **Widgets and training**: `widget` allow-list (system health from the deploy-skill health
   URLs, SLA, throughput), training walk mode (§12).

Slices 2 and 3 can proceed in parallel worktrees once 1 merges. Each slice is its own plan
and PR. Deploy follows the `accumark-deploy` skill; boards need no env change.

## 12. Follow-on slices (not in this spec)

- Training walk mode: follow `next` edges, `fitView` per step, spacebar advances;
  `board_node_progress(user_id, node_id, done_at)` for per-user completion.
- `flag_flags.group_id` for restricted unanchored tasks (§6.6).
- `embed` node kind for allow-listed origins (Grafana with `allow_embedding`, internal report
  pages), one `frame-src` entry per origin in `tauri.conf.json`.
- Document viewer "On boards" strip using `/api/boards/for-entity`.
- Groups as a scoping vocabulary for document categories.
- Multiple parent levels (frames inside frames) if a board outgrows one level.
- Board templates (seed an org chart from users) if boards are created often.

## 13. Decisions taken in this spec that the Handler may overrule

- Company boards: view = every active user, edit = granted groups + admins.
- Board creation, deletion, visibility, and grants are admin-only in v1.
- `flag_flags.group_id` not built (§6.6).
- Parent nesting depth is one level.
- Widget node kind ships as a placeholder in v1.
