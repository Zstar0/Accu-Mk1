# Document spaces: design

**Date:** 2026-10-06
**Status:** draft for Handler review (conversational design approved 2026-10-05; the written spec is this file)
**Scope:** Accu-Mk1 only (backend, web frontend, the `mk1-publish-document` skill) plus the four `documents_*` tools in labmanager-mcp. One implementation plan, one PR.
**Builds on:** the Documents library (spec 2026-09-15), user groups and the board access pattern (planning boards spec 2026-09-26, merged in #282), document threads via flags (#222), and the document annotations chain (#273 to #276, open at the time of writing).

## 1. Purpose

Every active Mk1 login can read every controlled document today. That was fine while the library held lab SOPs and a few agent-built reports. It stops being fine the moment accounting, leadership or a customer-facing project publishes there, which the New-document dialog (#276) and in-app edit mode (#275) are about to make routine.

A **space** is the first level of the Documents page and the unit of access. Documents are nested in spaces: General, Analytical, Accounting, Leadership, whatever the lab needs. A space is either visible to the whole company or restricted to named user groups. Categories (ART, SOP) stay exactly as they are: a category says what kind of document this is, a space says who it is for.

The access model is the one boards already use, so the rules, the 404 behaviour, the group lookups and the flag visibility seams are reused rather than reinvented.

## 2. Non-goals

- No per-document access control. A document inherits its space. If a real case appears for one document that must differ from its space, that is a follow-on (section 12).
- No write grants for standard users. Writers stay what they are today: admins, per-agent tokens, the internal service token. Edit mode and the New-document dialog are admin-only already.
- No public or unauthenticated access. Unchanged from the library spec.
- No change to codes, revisions, categories, dedupe, theming or storage.
- No nested spaces. One level.

## 3. Concepts

| Term | Meaning |
|---|---|
| Space | A named container with a slug, a visibility and zero or more group grants. Every document code belongs to exactly one space. |
| Company space | `visibility = company`. Readable by every active login. |
| Restricted space | `visibility = restricted`. Readable only by members of a granted group and by admins. |
| Grant | One row linking a space to a user group. Grants are read grants. |
| General | The seeded default space, company visibility, slug `general`. Every existing document is backfilled into it. It cannot be deleted or made restricted. |
| Hidden | A document, comment, attachment or flag the caller may not see. Hidden answers exactly like missing: same 404, same body. |

## 4. Data model

Two new tables and one new column. No `lims_` prefix: documents are not sample-hierarchy entities.

### 4.1 `document_spaces`

| column | type | notes |
|---|---|---|
| id | int pk | |
| slug | str(60) unique | immutable; `[a-z0-9-]`, set at create, never changed |
| name | str(120) | display |
| description | text null | |
| visibility | str(20) | `company` or `restricted`; CHECK constraint |
| is_active | bool default true | inactive hides the space from pickers and the first-level grid; its documents stay readable per the rules |
| sort_order | int default 0 | grid order; General pinned first regardless |
| created_at, updated_at | datetime | |

Seed at boot, idempotent by slug: `general` / "General" / company / sort_order 0.

### 4.2 `document_space_grants`

| column | type | notes |
|---|---|---|
| id | int pk | |
| space_id | int fk `document_spaces.id` ondelete cascade | |
| group_id | int fk `user_groups.id` ondelete cascade | |

Unique `(space_id, group_id)`. Index on `group_id`. Grants on a company space are allowed but inert (they matter only if the space is later restricted).

### 4.3 `documents.space_id`

`space_id INTEGER REFERENCES document_spaces(id) ON DELETE RESTRICT`, index `ix_documents_space_id`.

Invariant: **every revision of a code carries the same `space_id`.** The space is a property of the code; it is stored on each row so list and gate queries need no join. Moving a code moves all its rows in one transaction.

### 4.4 Migration

The repo has no Alembic on master. Boot order inside `init_db()`:

1. `create_all` creates `document_spaces` and `document_space_grants`.
2. `_run_migrations` adds `ALTER TABLE documents ADD COLUMN IF NOT EXISTS space_id INTEGER REFERENCES document_spaces(id)` and the index, both idempotent.
3. `documents.service.seed_spaces(db)` upserts General and runs `UPDATE documents SET space_id = <general> WHERE space_id IS NULL`. Idempotent; a no-op after the first boot.

The column stays nullable in the DDL (the ALTER cannot be NOT NULL before the backfill). The service enforces the invariant: a NULL read is treated as General, a write never leaves NULL. One test pins both.

Rollback: redeploy the previous image. The tables and column are inert to code that does not know them.

## 5. Access rules

One module, `backend/documents/access.py`, answers every question. Routes, the comment routes, the flag seam and the agent-token check call it; nothing re-derives the rule. It mirrors `boards/access.py` line for line so the two stay recognisable.

```
can_view_space(db, user, space) -> bool
    admin                             -> True
    space.visibility == 'company'     -> user.is_active
    else                              -> any grant.group_id in groups.access.user_group_ids(db, user)

visible_space_ids(db, user) -> Select
    admin -> all spaces
    else  -> company spaces UNION spaces granted to the user's active groups

can_view_document(db, user, doc) -> bool
    can_view_space(db, user, doc.space)      (NULL space_id reads as General)

require_view(db, user, doc) -> None
    raises NotFoundError (404, "document not found") when not viewable; never 403
```

`user_group_ids` already counts active groups only (spec 4.8 ruling, merged in #282), so deactivating a group suspends its space grants with no extra code.

### 5.1 Who may do what

| Action | Who |
|---|---|
| Read list, detail, revisions, content, comments, attachments, export | anyone `can_view_document` |
| Publish a new document into a space | admin bearer: any space. Agent token: spaces on its allow-list (section 7). Internal service token: any space. |
| Revise, retitle, activate, retire | same as today, additionally gated by `can_view_document` (a writer cannot touch a code it cannot see; the answer is 404) |
| Move a code to another space | admin bearer only; `PATCH /api/documents/{id}` with `space_id` |
| Create, rename, describe, reorder, change visibility, set grants, deactivate a space | admin bearer only; the internal service token too (operator scripts) |
| Delete a space | admin only, and only when it holds no documents and is not General |

Agent tokens never administer spaces, matching "agents archive, never delete".

### 5.2 Existence must not leak

- Every per-document route answers 404 for hidden exactly as for missing. This includes `GET /documents/{id}`, `/content`, `/comments`, `/comments/export`, `PUT /content` (#275), the comment-by-id routes and `GET /documents/comment-attachments/{id}` (#273), where the document is reached through the comment or attachment row.
- `GET /documents/comments` (the cross-document index) and `GET /documents` filter by `visible_space_ids`. `revision_count` and `total` count visible rows only.
- The identical-bytes dedupe answers 409 naming an existing code. Today it is scoped to the category. It becomes scoped to **category and space**, so a duplicate inside a hidden space is never named. The explicit-code path (revise) is already a point operation and is gated by `require_view`.
- `mint_code` stays global per prefix. Codes carry no content.
- The space grid shows a user only the spaces they can see; restricted spaces they are not granted do not appear, not even as locked cards.

## 6. Flag integration

Document threads anchor on the code (#222). On master the registry has the visibility seams boards use, so the document entity gains the same four hooks, implemented in `documents/flag_entity.py` beside the existing resolvers:

| seam | behaviour |
|---|---|
| `can_raise(db, user, eid)` | the latest revision of the code exists and `can_view_document` |
| `can_view(db, user, eid)` | `can_view_document` on the latest revision |
| `visible_entity_ids(db, user)` | Select of codes whose `space_id` is in `visible_space_ids` |
| `search_scoped(db, user, q)` | the existing `_document_search`, filtered by visible spaces |
| `audience(db, eid)` | everyone for a company space; the granted groups plus admins for a restricted one; admins only when the code no longer resolves |

With these set, the flag core already does the rest: point reads 404, lists and digest filtered, SSE audience stamped, Slack recipients re-checked, Ready to Publish masks the title, assign and mention guards refuse non-viewers. Nothing new is written in `flags/`.

Document comments (#273) are not flags; they are gated directly by `require_view` on the document.

## 7. Agents and the publish skill

### 7.1 Per-agent space allow-list

`MK1_DOCUMENT_AGENT_TOKENS` keeps its `name:token` entries. Each entry gains an optional third segment:

```
jarvis:<token>:general+analytical,tars:<token>
```

- Absent third segment: the token may write to General only. This is exactly what every existing token can do on the day spaces deploy, because every document is in General.
- Listed slugs: the token may publish and revise in those spaces, company or restricted.
- Reads by an agent token: the token is a writer credential, reads use the bot's bearer, and the bot account is a standard user. Grant the bot's group on a restricted space when its reads should extend there.
- A write outside the allow-list answers 404 for an existing code and 400 "space not allowed for this agent" for a new document. The 400 names only the slug the caller asked for.

Parsing stays in `_agent_tokens()`; a malformed third segment drops the entry with a log line, never half-accepts it.

### 7.2 API surface for agents

- `POST /api/documents` accepts `space` (slug) or `space_id`; default General.
- `GET /api/document-spaces` lists the spaces the caller can see (bearer) or that the token may write to (agent token).
- Revise, retitle, retire are unchanged except for the gate.

### 7.3 Skill and MCP

- `mk1-publish-document`: new `--space <slug>` flag, default `general`; prints the space in the result line.
- labmanager-mcp: `documents_create` and `documents_revise` gain `space: str = "general"`; `documents_list` gains `space`; new `documents_spaces()` lists what the bot can see or write. Descriptions tell the model that a refused space is a configuration matter for the Handler, not something to retry.

## 8. API

Router prefix `/api`, mounted with the documents router. Auth dependencies: read = `get_current_user`; space administration = `require_document_admin_writer` (admins and the internal token; agent tokens 403).

### 8.1 Spaces

| verb | path | behaviour |
|---|---|---|
| GET | `/document-spaces` | visible spaces with `document_count` (visible, latest-per-code) and the caller's `can_write` |
| POST | `/document-spaces` | create; body `slug, name, description, visibility, sort_order`; 409 on slug |
| PUT | `/document-spaces/{id}` | rename, describe, reorder, `visibility`, `is_active`; slug immutable (400); General refuses `restricted` and `is_active=false` (400) |
| PUT | `/document-spaces/{id}/grants` | replace the grant list; body `group_ids`; unknown or inactive group 400 |
| DELETE | `/document-spaces/{id}` | 204 when empty; 409 when it holds documents; 400 for General |

### 8.2 Documents (changes only)

| verb | path | change |
|---|---|---|
| GET | `/documents` | new `space_id` filter; list restricted to `visible_space_ids`; `DocumentOut` gains `space_id`, `space_slug`, `space_name` (declare them on `DocumentOut` AND `_doc_out`, the `response_model` strip trap) |
| GET | `/documents/{id}`, `/content`, `/comments`, `/comments/export` | `require_view` |
| POST | `/documents` | `space` or `space_id`; agent allow-list check; dedupe scoped by category and space |
| PATCH | `/documents/{id}` | admin may set `space_id`; moves every revision of the code in one transaction; `updated_by` set; log `documents.space_moved code from to` |
| PUT | `/documents/{id}/content` (#275) | `require_view` before the existing draft check |
| GET | `/documents/comments`, `/documents/comments/{id}`, `/documents/comment-attachments/{id}` (#273) | gate through the comment's document |

All comment mutations (#273) resolve the document first and `require_view` it before the actor check, so a hidden document never confirms itself through a 403.

## 9. Frontend

### 9.1 Documents page, first level

`#reports/documents` renders a **space grid**: one card per visible space, General first, then `sort_order`. Card: name, description, visible document count, a Lock badge when restricted, a Globe badge when company. Clicking a card opens the existing list scoped to that space at `#reports/documents?space=<slug>`, with a breadcrumb "Documents / <Space>" that returns to the grid.

The existing list, filters, columns, Threads column and pagination are unchanged. The category select stays; it filters within the space.

Deep links keep working: `#reports/documents?id=<n>` opens the viewer directly. A hidden or missing id shows the existing not-found state. The viewer header shows the space as a chip beside the category.

### 9.2 Admin affordances

- RetitleDialog gains a "Space" select for admins (the move). The confirm copy says every revision moves.
- New-document dialog (#276) gains a "Space" select, default General, listing spaces the admin can see.
- Settings, Documents pane: a **Spaces** section above Categories. Create form (slug, name, description, visibility), per-space row with rename, visibility toggle, active switch, reorder, Delete when empty, and a Groups editor for restricted spaces reusing the GroupsPane member-picker pattern (multi-select of active groups). A one-line reminder on restricted spaces: visibility is per space, not per document.

### 9.3 Boards

An `entity` node that points at a document the viewer cannot see renders the code with a "Restricted" label and no preview; the side-panel preview's 404 already produces the not-found state. No board-side masking beyond that in v1.

### 9.4 State and data

TanStack Query: `useDocumentSpaces()` under `['documents', 'spaces']`, invalidated by the space mutations and by `useDocuments` writes that change a count. UI store: the selected space slug rides the hash, not the store. No new Zustand state.

## 10. Security

Threat model:

- What breaks if this is wrong: a leadership or accounting document, its comments, its attachments or a flag titled with its content becomes readable by any staff login. That is the failure to design against.
- Attacker path: a standard user with a valid JWT enumerating `/api/documents/<id>`, `/content`, `/comments`, `/comment-attachments/<id>`, `/documents/comments?…`, `/api/flags?...entity_type=document`, `/api/flags/<id>`, or holding an SSE connection; a bot bearer doing the same; an agent token publishing into a space it was not given.
- Rollback: additive tables and one column; the gates are pure narrowing. Redeploying the previous image restores prior behaviour with no data migration.

Controls:

- 404 for hidden on every route; existence is never confirmed. One helper (`documents.access`) for point reads, one subquery (`visible_space_ids`) for lists, tested per route with outsider, member and admin.
- Dedupe scoped by space so a 409 cannot name a hidden code.
- Flag visibility through the registry seams, which already cover lists, digest, SSE audience, Slack and Ready to Publish for boards; the document entity reuses them unchanged.
- Agent tokens write only to allow-listed spaces; a refusal names only what the caller sent.
- Space administration is admin and internal-token only. Agent tokens cannot widen visibility.
- General cannot be restricted or deactivated, so the backfilled corpus can never vanish from the lab by a settings click.
- Group deactivation suspends grants (spec 4.8 ruling, already on master).
- Residual, accepted: an id's existence can be inferred from the id sequence; titles, content, comments and attachments are never disclosed. Same residual boards accepted.

## 11. Testing

Backend (SQLite in the suite, then the Postgres stack):

- `test_documents_access.py`: every rule in section 5 for outsider, member, admin, deactivated-group member, inactive user, NULL `space_id`.
- `test_documents_routes.py` additions: each route in 8.2 with outsider 404 identical to a missing id, member 200, admin 200; the move keeps all revisions together; dedupe across spaces does not name the hidden code; agent allow-list accept and refuse; General refuses restricted and deactivate.
- `test_documents_spaces_routes.py`: 8.1 end to end, including delete-when-empty and slug immutability.
- `test_flags_documents.py` additions: hidden document flag is 404 and absent from All open, Activity, Search and the digest; SSE audience for a restricted space; assign to a non-viewer is 400.
- Migration test: boot twice on a database holding pre-space documents; both boots leave every row in General and the seed idempotent.

Frontend (vitest): space grid renders only visible spaces with General first; card click sets the hash; breadcrumb returns; RetitleDialog shows the Space select to admins only; Settings Spaces section create, grants editor, General guards; `DocumentOut` fields present in the API client types.

Stack: a devbox accumark-stack on the branch, Postgres golden, with a restricted space, a granted group, a member, an outsider and an admin. Playwright `e2e/document-spaces.spec.ts`: grid per role, list scoped, direct id deep link hidden for the outsider, move by admin, flag thread on a restricted document invisible to the outsider, agent publish into an allowed and a refused space through the skill script. Evidence under `docs/superpowers/e2e/<date>-document-spaces/`. SQLite green is not done; the gate is the stack run.

Gate idiom: backend failure-set diff against the pre-work commit (never raw counts); `npm run typecheck` clean; vitest zero net-new; eslint and prettier clean on touched files.

## 12. Rollout and sequencing

One PR, after the annotations chain (#273 to #276) merges, because the gate must cover the comment, attachment and `PUT /content` routes those PRs add. If the Handler wants spaces first, the spaces PR gates the routes that exist on master and each annotations PR adds `require_view` to its new routes when it rebases; the routes are listed in section 8.2 so nothing is missed.

Deploy: ordinary Mk1 release. Boot creates the tables, adds the column, seeds General and backfills. No env change is required on day one; the agent allow-list segment is optional. After hours, per the standing rule. Post-deploy smoke: the grid shows General with the full count for a standard login, an admin creates a restricted space and grants a group, a member sees it, an outsider gets 404 on a direct id.

Follow-ons, not in this spec:

1. Write grants for standard users once non-admin authoring exists.
2. A per-document override, only if a real case appears.
3. Space-level default category and default author.
4. Boards entity search scoped by document visibility (today the search returns codes; codes are not sensitive).

## 13. Decisions taken in this spec that the Handler may overrule

- Grants are read grants only; writers stay admins, agent tokens and the internal token.
- The space is a property of the code, stored on every revision, moved together.
- General is seeded, company, undeletable, cannot be restricted or deactivated.
- An agent token without an allow-list writes to General only.
- Restricted spaces the caller is not granted are absent from the grid, not shown locked.
- Space administration lives in Settings, Documents pane, above Categories.
- Sequencing after the annotations chain.
