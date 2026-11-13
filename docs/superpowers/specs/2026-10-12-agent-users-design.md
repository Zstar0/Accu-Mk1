# Agent users (machine principals with a key) - design

Date: 2026-10-12. Status: defaults approved in conversation, awaiting written-spec review.

## 1. Intent

Give every AI agent its own Mk1 identity that needs only a **username and a key**, so agents in
Paperclip (and Hermes) can read and write documents, and optionally use the lab tools, without a
human-style password login and without editing `backend/.env` and recreating the backend for each
new agent.

- **Who:** Mk1 admins create and manage agents; agents (Jarvis, Pia, Devon, ...) use them through
  labmanager-mcp.
- **Success:**
  - An admin creates an agent in Settings, copies its key once, and the agent works on the next
    request: no deploy, no restart, no password.
  - The agent can do exactly what its switches allow and is refused everything else.
  - Everything it writes is attributed to it, server-side.
  - Revoking it (deactivate or rotate) takes effect on the next request.

### Rulings (Handler, 2026-10-12)

1. A new kind of user for machines/agents, authenticated by username + key.
2. **Space access, one rule:** an agent can read and write exactly the document spaces it can see,
   i.e. General plus spaces granted to its groups. No separate write allow-list.
3. **Scope:** documents and document comments always. **An option per agent to use the lab tools
   as well.**

### Design call made here (Handler may overrule)

The lab tools include COA generation and **publication**, which change what customers receive.
The lab option is therefore two switches: **Lab tools** (raise and comment on flags) and **COA
publishing** (requires Lab tools). Both default off.

Amended (Handler, 2026-10-12): read-only Mk1 data is fine for every agent. The lab tools' reads
(samples, analyses, media, flags, reports, COA history) are open to every agent; the two switches
gate writes only.

### Out of scope

- Setting up the Paperclip connections (follows this release; see section 10).
- Migrating the env-token agents `jarvis` and `tars` (`MK1_DOCUMENT_AGENT_TOKENS`); they keep
  working unchanged. A later release moves them to agent users and retires the env var.
- Agents as admins, agents deleting documents, agents managing spaces/categories/users. Never.

## 2. Findings that shape the design

- **407 routes** depend on `get_current_user` (any active login, admin or standard). If an agent
  were "just a user" it would open all of them: samples, orders, customers, COAs. So agents must
  be **refused by default** and accepted only on an explicit list.
- `get_current_user` (auth.py) decodes a JWT `sub` to a `User` row. FastAPI's `APIRoute.matches`
  sets `scope["route"]`, so a dependency can read the matched **route template** (e.g.
  `/api/documents/{doc_id}`). That gives one choke point for the allow-list.
- User admin (`POST/PUT /auth/users`) already rejects any role other than `standard`/`admin`, so
  an agent cannot be created or promoted through it. `PUT` on an existing agent row still needs a
  guard.
- 10 backend files query `User` (auth, comments, lims_analyses, main, packaging_photos, slack
  notifier, sub_samples routes/service, workflow/stranded, one script). People-facing lists must
  not show agents; display-name lookups should still resolve them.
- Document writes go through `documents.routes.require_document_writer` (X-Service-Token or admin
  bearer), not `get_current_user`; it needs its own agent branch.
- labmanager-mcp logs in with email/password for reads and sends `X-Service-Token` for document
  writes. With a key it can send one header for everything.

## 3. Architecture

### 3.1 Identity

An agent is a `users` row with **`role = 'agent'`** (a third value beside `admin`/`standard`).
No column is added to `users`.

| Column | Agent value |
|---|---|
| `email` | `<username>@agent.invalid` (`.invalid` is reserved, never deliverable, never collides with a person) |
| `first_name` | display name, e.g. "Pia" |
| `last_name` | `NULL` |
| `hashed_password` | an unusable marker; no password ever verifies |
| `role` | `agent` (immutable) |
| `is_active` | the on/off switch |

- **Username** `^[a-z0-9][a-z0-9_-]{0,39}$` (same grammar as today's agent token names), unique
  among agents. Names used by `MK1_DOCUMENT_AGENT_TOKENS` (`jarvis`, `tars`) are refused until
  their migration, so one name never means two principals.
- Because it is a user, an agent can join **groups**, so space access is granted the same way as
  for people.

### 3.2 Credentials table

```
agent_credentials
  user_id             INTEGER PK, FK users(id) ON DELETE CASCADE
  key_hash            CHAR(64) NOT NULL     -- sha256 hex of the secret
  key_hint            VARCHAR(8) NOT NULL   -- first 6 chars of the secret, for the UI only
  lab_tools           BOOLEAN NOT NULL DEFAULT FALSE
  coa_publishing      BOOLEAN NOT NULL DEFAULT FALSE  -- only honoured with lab_tools
  created_at          TIMESTAMP NOT NULL
  created_by_user_id  INTEGER FK users(id) ON DELETE SET NULL
  rotated_at          TIMESTAMP
  last_used_at        TIMESTAMP
```

One row per agent, one live key per agent. Created by `create_all` (new table) and an idempotent
boot DDL twin like the documents tables.

### 3.3 Key format and verification

- Wire: `Authorization: Bearer mk1a.<username>.<secret>`. `secret = secrets.token_urlsafe(32)`
  (256 bits). The MCP is configured with the username and key separately and joins them.
- The `mk1a.` prefix routes it away from JWT decoding; a JWT never starts with it.
- Verify: look up the agent by username (role `agent`), then
  `secrets.compare_digest(sha256(secret), key_hash)`. Unknown name, wrong secret, inactive agent
  or missing credential row all answer the same `401 invalid agent key` (no enumeration).
- sha256 rather than bcrypt: the secret is 256 random bits, so stretching adds nothing and every
  request would pay for it.
- `last_used_at` is written at most once per 5 minutes per agent.
- The key is returned exactly once (create, rotate). It is never stored, logged, or returned
  again. Rotating replaces the hash; the old key stops working on the next request.

### 3.4 Where agents are accepted: one allow-list, deny by default

`backend/agents/access.py` holds `AGENT_ROUTES: dict[scope, set[(METHOD, route_template)]]` and is
the only place that answers "may this agent call this route".

- `get_current_user` gains the request. For an `mk1a.` bearer it resolves the agent, then accepts
  only if `(request.method, scope["route"].path)` is in the agent's enabled scopes; otherwise
  `403 agent keys cannot use this endpoint`. Every route not listed refuses agents, including all
  routes added later.
- **Fail closed without a route.** Resolving an agent key when there is no matched route (any
  direct call `get_current_user(token=..., db=...)` outside FastAPI's dependency injection) is
  refused. Today's direct callers, all in documents, get explicit agent handling instead
  (3.5): `documents/comment_routes.py:51`, `documents/routes.py:121`, `:149`, `:182`. The plan
  re-greps `backend/` for others.
- A JWT whose `sub` is an agent row is refused (agents never hold a JWT; defence in depth).
- Admin-only dependencies (`require_admin` and friends) never accept an agent.
- A boot-time/test assertion checks every template in `AGENT_ROUTES` exists in `app.routes`, so a
  renamed route fails loudly instead of silently dropping an agent's access.

**Scope `documents` (always on):**

| Method | Route template |
|---|---|
| GET | `/api/document-categories`, `/api/document-spaces`, `/api/documents`, `/api/documents/{doc_id}`, `/api/documents/{doc_id}/content` |
| POST | `/api/documents`, `/api/documents/{doc_id}/activate`, `/api/documents/{doc_id}/retire` |
| PATCH | `/api/documents/{doc_id}` |
| GET | `/api/documents/comment-labels`, `/api/documents/comments`, `/api/documents/comments/{comment_id}`, `/api/documents/{doc_id}/comments`, `/api/documents/{doc_id}/comments/export`, `/api/documents/comment-attachments/{attachment_id}` |
| POST | `/api/documents/{doc_id}/comments`, `/api/documents/{doc_id}/comment-attachments`, `/api/documents/comments/{comment_id}/resolve`, `/api/documents/comments/{comment_id}/reopen` |
| PATCH / DELETE | `/api/documents/comments/{comment_id}` (existing own-comment rules apply) |

Not listed, so refused: `DELETE /api/documents/{doc_id}` (draft delete), `PUT .../content` (human
edit path), category and space administration, space moves (`PATCH` with `space_id` keeps its
existing admin-login-only check).

**Scope `reads` (every agent) and scope `lab` (switch "Lab tools"):** exactly the routes
labmanager-mcp's lab tools call (`tools/reads.py`, `media.py`, `flags.py`, `flagging.py`,
`reports.py`, and the read half of `coa.py`). Every GET below is in `reads`; the two flag POSTs
are `lab`:

- Samples and analyses (GET): `/senaite/samples`, `/wizard/senaite/lookup`,
  `/api/lims-analyses`, `/api/lims-analyses/promotions`,
  `/api/lims-analyses/parent/{...}/native-analyses`, `/api/conformance/{sample_id}`.
- Sub-samples and media (GET): `/api/sub-samples`, `.../{sample_id}/chromatograms`,
  `.../variance-set`, `.../attachments`, `.../attachments/{attachment_id}`, `.../photo`.
- HPLC and explorer (GET): `/hplc/analyses/{analysis_id}`,
  `/hplc/analyses/by-sample-prep/{sample_prep_id}`, `/explorer/orders/{order_id}`,
  `/explorer/customers/{customer_id}`.
- Flags: GET `/api/flags`, GET `/api/flags/types` (reads); POST `/api/flags`,
  POST `/api/flags/{flag_id}/comments` (`lab`).
- Reports (GET): the `/reports/...` routes the reports tool lists (dashboard, throughput,
  turnaround, sla-performance, checkin-times, analyte-trends, purity-trend, ready-to-publish,
  sync-status, customers summary/list/orders/cohorts/at-risk/churn-signals/changes/{key}).
- COA history (GET): `/explorer/coa-generations`.

The implementation resolves each MCP path to its backend template (nginx strips one `/api`) and
the test in 3.4 pins them.

**Scope `coa` (switch "COA publishing", needs Lab tools):** POST
`/wizard/senaite/samples/{sample_id}/generate-coa`, `.../generate-vial-coas`, `.../publish-coa`.

Within an allowed route the agent is an ordinary **standard** user: every existing per-route rule
(ownership, visibility, state machines) applies unchanged. All lab and COA routes above already
accept a standard login (`Depends(get_current_user)`, checked).

**SENAITE identity.** Lab and COA routes that call SENAITE use `_get_senaite_auth(user)`: the
user's own SENAITE password if one is stored, else the shared SENAITE service account. Agents
never have a SENAITE password, so their SENAITE calls run as that shared account, exactly as the
current standard-role bot's do today. The switches grant nothing beyond what a standard login
already reaches; SENAITE's own audit shows the shared account, Mk1's records show the agent.

### 3.5 Documents: reads, writes, attribution

- **Reads:** `access.can_view_document(db, agent_user, doc)` exactly as for a standard login:
  company spaces plus spaces granted to the agent's groups. Hidden stays 404.
- **Writes: the agent is an `AgentWriter`, never a `User`.** Today every bearer that reaches
  `documents/routes.py` is an admin (`require_document_writer` returns `require_admin(user)`), and
  the downstream checks lean on that: `require_document_admin_writer` refuses only `AgentWriter`,
  the space-move check refuses only `None`/`AgentWriter`, `updated_by = writer.email`, and
  `_reader_for` returns the user. Returning the agent's `User` row would pass all of them as an
  admin (draft delete, category/space/grant CRUD, space moves). So for an `mk1a.` bearer,
  `require_document_writer` (and `_space_reader`, `require_comment_actor`) return
  `AgentWriter(name=<username>, spaces=<slugs it can see, computed per request>, user_id=<id>)`.
  Every existing agent deny keeps working unchanged, and `require_document_admin_user` (PUT
  content) refuses it like any non-login. Net effect: create, revise, patch metadata, activate and
  retire **in spaces it can see** (ruling 2); hidden code = 404, invisible target space = 400, as
  today for token agents.
- **Provenance:** `creator_kind='agent'`, `creator_ref=<username>`, `co_author=<username>`
  (existing readers keep working), `created_by_user_id=<agent user id>`. `requested_by` is never
  verified for an agent (the `author` it sends stays "supplied"). Source fields stay "reported".
- **Comments:** authored as `author_agent=<username>` (continuity with token-agent comments and
  the MCP's `author_agent` filter), `author_user_id` NULL.

### 3.6 Agents are not people

- `POST /auth/login` refuses role `agent` before any password check.
- `GET /auth/users` excludes agents (they have their own list). `PUT /auth/users/{id}` and
  `reset-password` refuse agent rows (role cannot change in either direction).
- People pickers and notifications exclude agents: assignee lists, Slack notifier, stranded-work
  owners, and the other `User` queries audited in the plan. Display-name lookups (comments,
  provenance, flags) still resolve agents, shown with an "agent" tag.
- **Groups are set on the agent, not in the group picker.** Groups are how an agent gets a
  restricted space, but the group member picker reads `/worksheets/users`, the same people
  directory as analyst assignment and planning boards, which excludes agents. So an agent's
  groups are chosen on its row in Settings > Agents (`PUT /admin/agents/{id}/groups`). Saving a
  group's members on the Groups page keeps any agent members (the editor starts from the full
  member list). The backend types `role` as `str`, so a third value is safe; the frontend types it
  as `string`.
- Excluded from people lists: `GET /auth/users`, `/worksheets/users`, and the AI-review staff-name
  scrub (`customer_review/names.py`), so agent names like "Devon" are never removed from
  customer text. Every other `User` query is a lookup by id and needs no change.

## 4. API (admin login only)

| Route | Does |
|---|---|
| `GET /admin/agents` | list: id, username, display name, active, lab_tools, coa_publishing, key_hint, created_at, created_by, rotated_at, last_used_at, group_ids |
| `POST /admin/agents` | `{username, display_name, lab_tools?, coa_publishing?}` -> 201 with the agent and **`key` (shown once)** |
| `PATCH /admin/agents/{id}` | `{display_name?, is_active?, lab_tools?, coa_publishing?}`; `coa_publishing` requires `lab_tools`; Lab tools off clears COA publishing; username cannot change (422) |
| `POST /admin/agents/{id}/rotate-key` | new key, shown once; the old one is dead immediately |
| `PUT /admin/agents/{id}/groups` | `{group_ids}`: replace the agent's group memberships (active groups only) |

Under `/admin/...` like Settings > Integrations; errors are `detail: {"code": ...}`.

No delete: an agent with history is deactivated, never removed (its documents and comments keep
pointing at it). Every create, toggle, deactivate and rotate is logged with the acting admin.

## 5. UI

Settings > **Agents** (admins), beside Users and Groups:

- Table: name, username, switches, key hint, last used, active.
- **New agent**: username, display name, Lab tools, COA publishing (with a warning line: "Can
  generate and publish COAs that customers receive"). On save, a one-time panel shows the key,
  a Copy button, and the two MCP settings (`LABMGR_MK1_AGENT_NAME`, `LABMGR_MK1_AGENT_KEY`).
  Closing it hides the key for good.
- Row actions: switches, deactivate/reactivate, rotate key (confirm; shows the new key once),
  and the agent's groups (checkboxes of active groups).

## 6. labmanager-mcp

- New optional config: `LABMGR_MK1_AGENT_NAME` + `LABMGR_MK1_AGENT_KEY`, where the key is the
  full value Mk1 showed (`mk1a.<name>.<secret>`). When both are set, every request (reads and
  document writes) sends `Authorization: Bearer <key>`; no `/auth/login`, no `X-Service-Token`.
  At start the MCP refuses a key whose embedded name differs from the configured name (the
  wrong-connection check), without echoing the key; values are stripped of whitespace. When
  unset, behaviour is unchanged (email/password + service token), so Jarvis/TARS keep working.
- A 403 "agent keys cannot use this endpoint" surfaces as: "this agent is not enabled for that
  (ask a Mk1 admin to turn on Lab tools / COA publishing)".
- Fix while there: reword the `documents_create/revise` description that trips Hermes' injection
  scanner (`system:` pattern).

## 7. Security

- Keys never in URLs, logs, error bodies or responses after creation. Failed agent auth logs the
  username only.
- Least privilege by construction: deny-by-default route list; never admin; COA publishing a
  separate switch; role immutable.
- Revocation is immediate (deactivate or rotate); no restart.
- Isolation between agents is only as strong as where their keys are stored. On the Paperclip
  host, agents that share an OS user with shell access could read each other's keys. That is a
  Paperclip-side check (section 10), not something Mk1 can enforce.

## 8. Rollout and rollback

- Additive: one new table; no change to existing rows; `MK1_DOCUMENT_AGENT_TOKENS` untouched.
- Rollback = redeploy the previous image. Agent rows stay but cannot authenticate (the old code
  reads an `mk1a.` bearer as a bad JWT -> 401; login fails on the unusable password).
- Deploy order: Mk1 first, then the MCP release, then Paperclip connections.

## 9. Testing

- Route matrix: iterate `app.routes` and send a **real agent key** to every route (not just
  inspect dependencies): 403 on every route outside its scopes, including all admin routes and
  explicitly `DELETE /api/documents/{doc_id}`, category CRUD, space CRUD and grants, `PUT
  /api/documents/{doc_id}/content`, and `PATCH /api/documents/{doc_id}` with `space_id`; accepted
  on each listed template. Every listed template exists.
- Keys: wrong secret, unknown name, inactive agent, rotated-away key all 401, same body; key
  never appears in logs or later responses.
- Login refuses agents; JWT for an agent row refused; user admin cannot edit/promote agents;
  `/auth/users` excludes agents; people pickers exclude, group pickers include.
- Documents: reads and writes limited to visible spaces; hidden = 404; provenance creator =
  agent/username, requester never verified; comment author = agent.
- Scopes: lab routes 403 without Lab tools; COA routes 403 without COA publishing, and
  `coa_publishing` without `lab_tools` is refused at PATCH.
- MCP: agent-key mode sends the bearer on reads and writes and never logs in; unset mode unchanged.
- Postgres boot (fresh + upgrade) for the new table; one browser pass of Settings > Agents
  (create, copy-once, rotate, deactivate).

## 10. After this ships: Paperclip setup (separate task)

Per agent: create it in Settings > Agents (General; add to groups for anything restricted;
switches as needed), put its username and key into that agent's own Paperclip connection, keep
the documents-only catalog unless Lab tools are on, and prove it is refused on another agent's
connection. Check first whether `claude_local` agents share an OS user on the Paperclip host
(section 7).
