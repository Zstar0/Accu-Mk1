# Document annotations, comments, and edit mode — design

**Date:** 2026-10-03
**Status:** design approved in chat by the Handler 2026-10-03 (approach B, agent participation, edit mode); implementation plan next
**Scope:** Accu-Mk1 backend + frontend, plus four tools in `labmanager-mcp`. Base: `origin/master` v1.31.2 (`e5852180`).
**Supersedes:** §2 non-goal "No in-app content editor" and §12.3 of `2026-09-15-documents-library-design.md`. Everything else in that spec stands.

## 1. Purpose

Give the Documents library (ART / SOP controlled documents) a review surface modeled on plannotator's HTML viewer, so people and agents can mark up a document where the words are instead of in a detached thread:

- **Anchored comments.** Select text or click an element in the rendered document and comment on it. Marks survive new revisions by re-anchoring on the quoted text.
- **Suggestions.** Select text and propose replacement text. An admin can apply a suggestion, which produces a draft revision.
- **Quick labels.** One-click preset comments ("Clarify this", "Verify this") that carry an instruction for the agent that revises the document.
- **Global comments** with no anchor, **image attachments** with a drawing step, **replies**, and **resolve**.
- **Contents sidebar** built from the document's headings.
- **Agent participation.** The same API lets a named agent read, create, reply to, and resolve comments. The lab MCP gains the tools.
- **Edit mode.** An admin edits the document text in place and saves it as the next draft revision, or replaces a draft's content.

Flags stay the high-level layer on a document (assignment, due date, "review this"). In-document marks are their own mechanism and never create flags. This was a Handler ruling: a thirty-comment review must not spray thirty micro-flags into the inbox.

## 2. Non-goals (v1)

- No live multi-user updates (SSE). React Query refetch on focus and after mutations.
- No label catalog editor in Settings. The catalog is a constant served by the API.
- No `@mentions` or notifications on document comments.
- No shift-click multi-target comments, no active-heading tracking in the TOC, no revision diff view, no vim mode, nothing from plannotator's live-app proxy or AI paths.
- No structural editing (tables, lists) beyond what the browser's native `contenteditable` offers. Text edits are the target.
- No MCP tool for agents to fetch attachment images (the HTTP route exists; the tool is a follow-on).
- The desktop (Tauri) build is not a release gate; it is unused in practice. The web build is.

## 3. Provenance and licensing

The viewer core is vendored from **backnotprop/plannotator** at tag `v0.27.25` (`@plannotator/ui` 0.49.0, `@plannotator/core` 0.25.9), dual-licensed MIT OR Apache-2.0. We take it under MIT.

`src/vendor/plannotator/` contains:

| file | upstream | notes |
|---|---|---|
| `LICENSE-MIT` | repo root | verbatim, required by MIT |
| `VENDORED.md` | — | upstream repo, tag, commit, package versions, this file list, and every `// accumark:` extension |
| `bridge-script.ts` | `packages/ui/components/html-viewer/bridge-script.ts` | the string constant injected into the frame; dependency-free; our three extensions fenced with `// accumark: <name>` … `// /accumark` |
| `html-anchor.ts` | `packages/core/html-anchor.ts` | anchor types, caps, fail-closed validators, `buildPersistedHtmlAnchor`, `projectHostThreads`; dependency-free |
| `html-anchor.test.ts` | `packages/core/html-anchor.test.ts` | ported from `bun:test` to vitest |
| `srcdoc.ts` | `packages/ui/components/html-viewer/srcdoc.ts` | theme-token payload, injection builder, `neutralizeMetaCsp`, `injectIntoHead`, `resolveBridgeScriptUrl` |
| `image-annotator/` | `packages/ui/components/ImageAnnotator/` | Canvas, Toolbar, strokeHistory, utils, types, index; the upstream `shortcuts` import is replaced by a local keydown handler |

One new runtime dependency: `perfect-freehand` (MIT, used by the image annotator). Nothing else from plannotator is installed. The parent-side viewer code (§7, §8) is ours.

The bridge is frozen at this commit. `BRIDGE_PROTOCOL_VERSION` is the drift check: the parent refuses a bridge that reports a different version (§7.3).

## 4. Data model

Two tables in `backend/documents/models.py` on the shared `Base`, created by `create_all` at boot, with idempotent DDL in `database._run_migrations()` for existing databases (that file is CRLF). No `lims_` prefix: these are not sample-hierarchy entities.

### 4.1 `document_comments`

One row per comment or reply. The identity is the document **code**, because comments span revisions; the row also records the revision it was made on.

| column | type | notes |
|---|---|---|
| id | int PK | |
| code | varchar(30), not null, indexed | the controlled-document code |
| document_id | FK → documents.id, not null, `ON DELETE CASCADE` | the revision the comment was made on; a discarded draft takes its comments with it |
| parent_id | FK → document_comments.id, nullable, `ON DELETE CASCADE` | a reply. One level only: a reply to a reply is a 400 |
| kind | varchar(12), not null | `comment` \| `suggestion`; CHECK |
| anchor | JSONB (JSON on SQLite), nullable | §5. Null = document-level. Replies carry no anchor; they inherit the parent's in the UI |
| label | varchar(40), nullable | an id from the label catalog (§4.3); unknown id = 400 |
| body | text, not null, default `''` | markdown-lite, same grammar as flag comments; may be empty for a label-only comment |
| suggested_text | text, nullable | required when `kind = 'suggestion'`, else must be null; CHECK |
| author_user_id | FK → users.id, nullable | |
| author_agent | varchar(40), nullable | the per-agent token name (same source as `documents.co_author`) |
| status | varchar(10), not null, default `open` | `open` \| `resolved`; CHECK |
| resolved_at | datetime, nullable | |
| resolved_by_user_id | FK → users.id, nullable | |
| resolved_by_agent | varchar(40), nullable | |
| created_at, updated_at, edited_at | datetime | `edited_at` set only by a body or suggestion PATCH |

Constraints: CHECK exactly one of `author_user_id` / `author_agent` is not null. Index `(code, status)`.

**Numbering.** Every top-level comment gets a stable `number`: its 1-based position by `created_at` (then `id`) among the code's top-level comments across all statuses. Deletes leave gaps. The number is the marker in the document and the way people and agents refer to a comment ("item 7"). It is computed on read, never stored.

### 4.2 `document_comment_attachments`

Same shape and lifecycle as `flag_attachments`.

| column | type | notes |
|---|---|---|
| id | int PK | |
| code | varchar(30), not null, indexed | an unlinked upload still has an owner scope |
| comment_id | FK → document_comments.id, nullable, `ON DELETE CASCADE` | null until a saved body references `{attachment:ID}` |
| uploaded_by_user_id | FK → users.id, nullable | |
| uploaded_by_agent | varchar(40), nullable | |
| filename, content_type, size_bytes | | |
| storage_key | varchar(500), not null | relative key returned by the storage seam |
| created_at | datetime | |

**Storage reuses the flag attachment seam**: `flags.seams.get_attachment_storage().save(f"documents/{code}", data, filename)`. In prod that is the S3 adapter in `main.py` under `MK1_FLAG_ATTACH_S3_PREFIX`, so bytes land at `<flag prefix>/documents/<CODE>/<uuid>.<ext>`, a prefix the app already writes to. No new storage class, no new env var. The same `_sniff_image` rule applies: png, jpeg, gif, webp only; 10 MB cap. **Import trap:** `flags/seams.py` already imports `documents.models` for the document entity registration, so `documents/` must import `flags.seams` and the sniff helper **lazily, inside the attachment service functions**, or boot dies on a circular import. Linking follows the flags pattern: saving a body claims every `{attachment:ID}` token whose row has the same `code` and `comment_id IS NULL`. A sibling sweep in `documents/` deletes unlinked rows past the same cutoff flags use, on the same scheduler hook; `flags/` does not learn about documents.

### 4.3 Label catalog

A constant in `backend/documents/labels.py`, served by `GET /api/documents/comment-labels`, validated on write. Shape mirrors plannotator's `QuickLabel`: `id` (kebab), `emoji`, `text`, `color` (one of plannotator's ten color keys), `tip` (optional instruction to the agent, included in the export). The initial set is adapted to lab documents:

| id | text | tip |
|---|---|---|
| `clarify-this` | ❓ Clarify this | This passage is ambiguous. Rewrite it so a new technician reads it one way. |
| `verify-this` | 🔍 Verify this | This reads as an assumption. Verify it against the method, the instrument output, or the data before the next revision, and say what you checked. |
| `out-of-date` | ⏳ Out of date | This no longer matches current practice or the current system. Update it to what is true today and note the change. |
| `needs-reference` | 📎 Needs reference | Cite the SOP, method, specification, or source this statement rests on. |
| `needs-example` | 🔬 Needs example | Too abstract. Add a worked example, sample values, or a specific scenario. |
| `out-of-scope` | 🚫 Out of scope | This does not belong in this document. Remove it, or move it to the document that owns it. |
| `needs-sign-off` | ✍️ Needs sign-off | This changes a controlled behaviour. Do not activate until the responsible person has approved it. |
| `match-format` | 🧬 Match existing format | Follow the structure and vocabulary of the lab's existing SOPs and artifacts instead of introducing a new layout. |
| `nice-work` | 👍 Nice work | (no tip) |

Making this editable in Settings is a follow-on; the route shape does not change when it is.

## 5. Anchor contract

`anchor` stores plannotator's `PersistedHtmlAnchor` verbatim, so the vendored viewer reads it back with no mapping layer:

```json
{
  "originalText": "the quoted text, ≤ 400 chars",
  "htmlAnchor": { "selector": "≤ 1024", "tagName": "≤ 64", "text": "≤ 400 (optional)", "point": { "x": 0, "y": 0 } },
  "htmlAdditionalTargets": [ { "label": "≤ 64", "text": "≤ 400", "anchor": { }, "context": { } } ],
  "elementContext": { "tag": "p", "path": "body > main > section > p", "heading": "h2 \"Runtime parameters\"", "text": "…" }
}
```

Rules:

- **Caps are the upstream caps**, enforced server-side by `backend/documents/anchors.py`, a Python port of `parseHtmlElementAnchor` and `parseHtmlElementContext`: at most 16 additional targets, element context ≤ 2 KiB, whole anchor ≤ 16 KiB of UTF-8 JSON, unknown keys dropped. Over a cap is a **400**, never a silent truncation. (The browser trims a draft with `buildPersistedHtmlAnchor` before posting, so UI writes pass; the server cap protects the API.)
- **Quote-only anchors are valid**: `{"originalText": "…"}` with no `htmlAnchor`. The bridge's restore ladder runs a document-wide text search before any element fallback, so a quote alone lands on the right place. This is how agents anchor (§9): they have no DOM.
- **Quote verification for quote-only anchors.** When an anchor has `originalText` and no `htmlAnchor`, the server extracts the text of the target revision's HTML (stdlib `html.parser`, script/style dropped), collapses whitespace runs to one space on both sides, and requires the quote to occur. Otherwise **400** `quote not found in <CODE> r<N>: "<quote>"`. Anchors that carry an `htmlAnchor` came from a real DOM range and are trusted as-is.
- **Document-level** = `anchor IS NULL`. Projected as a `GLOBAL_COMMENT` for the viewer.
- **Lost its place.** A stored anchor the bridge cannot restore on the revision being viewed is reported back as unanchored. The UI lists it under "Lost its place" with its quote and never guesses a position. It stays resolvable.
- Anchors are data. They are never rendered as HTML and never interpolated into selectors on the parent side; only the bridge, inside the sandbox, consumes `selector`.

## 6. API

The documents router is `/api`-mounted; paths keep `/api`. `{id}` is a revision row id, matching the existing document routes. Comment routes resolve the code from that revision and operate on the code.

### 6.1 Actors

A new dependency `require_comment_actor` returns a `User` for **any** logged-in bearer (not only admins), an `AgentWriter` for a per-agent `X-Service-Token`, and **403** `comments need a named author` for the bare internal service token (it has no name). No credentials = 401. `author_user_id` / `author_agent` and the `resolved_by_*` pair are derived from the actor; a body-supplied author is ignored.

| action | who |
|---|---|
| read comments, labels, export, attachments | any logged-in user, any agent |
| create comment / reply / suggestion, upload attachment | any named actor |
| resolve / reopen | any named actor |
| edit body or suggestion, delete | the author (same user id or same agent name) or an admin user |
| apply a suggestion, edit document content | admin **user** only (§10) |

### 6.2 Routes

| method | path | actor | behaviour |
|---|---|---|---|
| GET | `/api/documents/{id}/comments?status=open\|resolved\|all` | login | all top-level comments for the code of revision `{id}`, replies nested, newest-last by `created_at`. Default `open`. Each carries `number`, `document_id`, `revision`, `author` display (`"Forrest Parker"` or `"jarvis"`), `attachments[]`. |
| POST | `/api/documents/{id}/comments` | named | body `{parent_id?, kind, anchor?, label?, body, suggested_text?}` → 201 `CommentOut`. `document_id = {id}`. Validation: §4.1 CHECKs, §5 caps and quote check, label id, reply depth. |
| PATCH | `/api/documents/comments/{cid}` | author/admin | `{body?, suggested_text?}`; sets `edited_at`; re-links attachment tokens |
| DELETE | `/api/documents/comments/{cid}` | author/admin | 204; replies and attachment rows cascade; blob deletes are best-effort after commit |
| POST | `/api/documents/comments/{cid}/resolve` | named | idempotent; sets status, `resolved_at`, `resolved_by_*` |
| POST | `/api/documents/comments/{cid}/reopen` | named | idempotent; clears the resolved fields |
| POST | `/api/documents/{id}/comment-attachments` | named | multipart `file`; sniff + cap; → 201 `{id, filename, content_type, size_bytes}`; `code` from `{id}`; unlinked until claimed |
| GET | `/api/documents/comment-attachments/{aid}` | login | bytes with `Content-Type` from the row, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Cache-Control: private` |
| GET | `/api/documents/comment-labels` | login | the catalog (§4.3) |
| GET | `/api/documents/{id}/comments/export?status=open` | login | `text/markdown`, §6.3 |
| GET | `/api/documents/comments?status=open&author_agent=&code_prefix=&limit=100` | login | cross-document list, newest first, each row with `code`, document `title`, `number`, `kind`, `label`, `author`, `created_at`; for agents and dashboards to find open work without walking every document |
| PUT | `/api/documents/{id}/content` | admin user | §10.3, draft-only content replace |

**Route order trap:** the literal two-segment paths `/documents/comments` and `/documents/comment-labels` must be declared **before** `/documents/{doc_id}` in the router, or FastAPI parses `comments` as a document id and returns 422. A test pins this.

`DocumentDetail` gains `open_comment_count` so the list page can show a count without a second query. `DocumentOut` and `_doc_out` both name it (the `response_model` strip trap).

### 6.3 Export format

Markdown, in plannotator's `exportAnnotations` spirit, written for an agent that will revise the document:

```
# Comments on ART-0004 "Additional COA Profile Audit"
Latest revision: r3 (active). 3 open.

## 1. ❓ Clarify this — Forrest Parker, on r2, 2026-10-03 14:02
> "Dedupe on an EXPLICIT code still behaves as before"
Where: h2 "Rulings" › p
Which "before"? Name the behaviour.
Agent tip: This passage is ambiguous. Rewrite it so a new technician reads it one way.
Attachments: {attachment:12}
Replies:
- jarvis, 2026-10-03 14:10: Meaning the pre-09-17 bare-publish behaviour. Will state it.

## 2. Suggestion — Forrest Parker, on r3, 2026-10-03 14:05
> "the container's calendar day"
Replace with:
> "the lab's calendar day (BusinessHoursConfig.timezone)"

## 3. Global — jarvis, 2026-10-03
Section 4 has no owner named.

---
Address each item. Post the next revision with `documents_revise`. Then resolve what you handled with
`documents_comment_resolve`, or answer with `documents_comment_reply` where you disagree. Do not edit
comments you did not write.
```

"Where" comes from `elementContext.heading` and `elementContext.path` when present; a quote-only anchor prints only the quote. Resolved items are omitted unless `status=all`.

## 7. Viewer architecture

### 7.1 Where injection happens

In the parent, at render time, exactly as plannotator does. `DocumentViewer` fetches the HTML as today, stamps `data-theme`, then `injectIntoHead(html, "<!--pn-inject-->" + buildSrcdocInjection({...}) + "<!--/pn-inject-->")` and sets `srcDoc`. The sandbox attribute stays exactly `allow-scripts`. Stored bytes are never touched: `content_sha256` stays meaningful and Download still gives the clean document.

Theme tokens are read from the Mk1 root (`getComputedStyle(document.documentElement)` for `THEME_TOKENS`) and pushed under `--pn-*` with `hostTheme: false`, so nothing bare leaks into the document's own CSS namespace. The `srcDoc` memo already depends on the resolved theme, so a theme switch rebuilds the injection; no `theme` message is needed.

### 7.2 The bridge is served by URL, not inline

A srcdoc document inherits the **parent page's** Content Security Policy. No CSP header exists in the repo for the web build today, but the droplet's nginx may add one later and the Tauri config already has one. An inline `<script>` would die under any `script-src 'self'`. plannotator's `bridgeScriptUrl` option exists for this: we inject `<script src="/pn-bridge.v<N>.js">`, resolved absolute against `document.baseURI` with the vendored `resolveBridgeScriptUrl`, where `<N>` is `BRIDGE_PROTOCOL_VERSION`.

`scripts/build-bridge-asset.mjs` imports `BRIDGE_SCRIPT` and writes `public/pn-bridge.v<N>.js`. The asset is **committed**; a vitest test regenerates and compares, so the two cannot drift, and `check:all` runs that test. If the bridge never posts `ready` within the timeout, the viewer shows plannotator's unavailable banner, hides the annotation tools, and still renders the document. Global comments still work in that state; they need no bridge.

### 7.3 Trust boundary: `useDocumentBridge`

One hook owns the iframe ref and the single `message` listener. It accepts a message only when `event.source === iframe.contentWindow` **and** `event.origin === 'null'` (the opaque origin a sandboxed srcdoc has) and `data.type` starts with `plannotator-bridge-`. Every payload is shape-checked and capped before use: anchors through the vendored `parseHtmlElementAnchor`, contexts through `parseHtmlElementContext`, selection text ≤ 10,000 chars, ids ≤ 256 chars, rect numbers finite, heading lists ≤ 500 entries of ≤ 130 chars, serialized HTML ≤ 16 MB. Anything else is dropped.

| direction | message | handling |
|---|---|---|
| in | `ready` | version check against `BRIDGE_PROTOCOL_VERSION`; mismatch = banner + tools hidden. Then post `set-input-method`, one `find-and-mark` per stored comment (`id`, `comment` or `deletion`, `originalText`, `anchor`, `additionalAnchors`), `sync-annotations` with `{id, number}`, and `report-unanchored` |
| in | `selection` / `selection-rect` / `selection-clear` | pending draft state; the toolbar and composer follow the rect, offset by the iframe's bounding box |
| in | `mark-click` | select that comment in the panel |
| in | `unanchored` | the lost-its-place set |
| in | `resize` | iframe height |
| in | `link-click` | `window.open(href, '_blank', 'noopener')` for `http:`/`https:` only; everything else ignored |
| in | `headings` (ours) | TOC state |
| in | `serialized` / `apply-failed` (ours) | §10 |
| out | `create-mark`, `cancel-selection`, `remove-mark`, `scroll-to`, `focus-mark`, `scroll-to-fragment`, `set-annotate-mode`, `set-input-method` | upstream, unchanged |
| out | `set-edit-mode`, `serialize`, `apply-replacement` (ours) | §10 |

Nothing in this hook touches `contentDocument`; it cannot, and the design depends on that staying true.

### 7.4 Bridge extensions

Three fenced blocks in the vendored `bridge-script.ts`, each `// accumark: <name>` … `// /accumark`, listed in `VENDORED.md`:

1. **`headings`.** After ready and on the existing mutation observer, collect `h1`–`h4` in document order, skipping the viewer's own overlay host. A heading without an `id` gets `id="pn-h-<n>"`. Post `{type: 'plannotator-bridge-headings', headings: [{id, level, text}]}`, text whitespace-collapsed and cut at 130 chars, at most 500 entries. TOC clicks reuse the upstream `scroll-to-fragment` with that id.
2. **`set-edit-mode {on}`.** Sets `document.body.contentEditable`, and while on, suppresses selection capture and pinpoint (the upstream `set-annotate-mode` off path) so typing does not open composers. Markers stay visible and inert.
3. **`serialize`** and **`apply-replacement {id, text}`.** `apply-replacement` finds the restored range for comment `id`, replaces its contents with a text node, and then does what `serialize` does. `serialize` detaches the overlay host, removes `contenteditable` and every `pn-h-*` id it assigned, builds `'<!doctype html>\n' + document.documentElement.outerHTML`, re-attaches the overlay, and posts `{type: 'plannotator-bridge-serialized', html}`. A failed apply posts `{type: 'plannotator-bridge-apply-failed', id}`.

The parent additionally runs `stripViewerInjection(html)`: removes the `<!--pn-inject-->…<!--/pn-inject-->` block, any `<script src="…/pn-bridge.v*.js">`, and the `data-theme` stamp on `<html>`. Both sides strip, so a bridge that missed something cannot leak viewer markup into a saved revision.

## 8. Frontend components

All new files live in `src/components/documents/annotations/`; API client in `src/lib/api-document-comments.ts`; hooks in `src/services/document-comments.ts` following the existing TanStack pattern.

- **`DocumentViewer.tsx` (existing, extended).** Header gains a Select / Pinpoint toggle (`set-input-method`), a "Comments (N)" toggle, and, for admins, Edit (§10). The body becomes a `ResizablePanelGroup` from the existing `resizable` kit: the iframe, then a collapsible right panel, 360 px default. Below the `md` breakpoint the panel is a `Sheet`.
- **`useDocumentBridge.ts`** — §7.3.
- **`SelectionToolbar.tsx`.** Floats at the selection or pinpoint rect: Comment, Suggest edit, Label ▾ (the catalog, with digit shortcuts like plannotator), 👍 (`nice-work`). A label click creates the comment immediately with an empty body, like plannotator's quick labels. Comment and Suggest open the composer.
- **`CommentComposer.tsx`.** A radix `Popover` anchored at the rect. Textarea with the flag composer's paste and drop upload behaviour copied (first `image/*` file → upload → `{attachment:ID}` at the caret), an Images button that opens a file picker and then the vendored `ImageAnnotator` dialog so the user can draw before attaching, an optional label chip, Ctrl+Enter to save, Esc to cancel (which posts `cancel-selection`). In suggestion mode a second textarea pre-filled with the quote holds the replacement. On save: `POST`, then `create-mark` with the new id and type, then `sync-annotations`.
- **`CommentsPanel.tsx` / `CommentCard.tsx`.** Tabs: **Comments**, **Contents**. Comments list by `number`. A card shows the marker number, label chip, quote, body through the existing `CommentBody` with a new optional `resolveAttachmentUrl` prop pointing at the document attachment route (default stays the flags resolver), author as a person or an agent name, "on rN" when made on a different revision than the one shown, replies indented, a reply box, Resolve or Reopen, and for the author or an admin, Edit and Delete. Suggestions show original and replacement, and for admins an **Apply** button (§10). A filter toggles open / resolved / all. A **Global comment** button opens the composer with no anchor. A **Lost its place** group holds the unanchored set. Clicking a card posts `scroll-to` and `focus-mark`.
- **`ContentsTab.tsx`.** The headings list, indented by level like plannotator's flat TOC; a click posts `scroll-to-fragment`.
- **Bridge unavailable** (timeout or version mismatch): banner, no toolbar, panel still lists comments and allows global comments, Contents tab empty.
- **Documents list page.** A **Comments** column with the open count from `open_comment_count`, next to the existing Threads column; the cell opens the viewer with the panel expanded.

## 9. Agent participation

Agents use the same routes with a per-agent `X-Service-Token`; the author shows as the agent's name. The lab MCP (`labmanager-mcp`, `tools/documents.py`) gains four tools; reads ride the bot bearer as today and writes ride `LABMGR_MK1_SERVICE_TOKEN`:

| tool | does |
|---|---|
| `documents_comments(code=None, status="open")` | with a code: the §6.3 export for that code's latest revision. Without: the cross-document list (§6.2), for finding open work |
| `documents_comment_create(code, body, quote=None, kind="comment", suggested_text=None, label=None, reply_to=None)` | resolves the code's latest revision, builds a quote-only anchor when `quote` is given, posts. A `quote` that is not in the document is the server's 400, surfaced verbatim so the agent fixes its quote |
| `documents_comment_reply(comment_id, body)` | `POST` with `parent_id` |
| `documents_comment_resolve(comment_id)` | |

Tool descriptions are passed through `mcp.tool(description=...)` (an f-string is not a docstring) and carry the loop: read, revise with `documents_revise`, resolve or reply, never edit others' comments. Agents cannot apply suggestions or edit content: those are admin-bearer paths (§10), and `documents_revise` already covers an agent posting a full new revision.

## 10. Edit mode

### 10.1 Interaction

Admin only, web viewer. **Edit** in the header posts `set-edit-mode {on: true}`; the panel shows an "Editing · unsaved" bar with **Save** and **Cancel**. The user edits text in the page with the browser's native `contenteditable` behaviour (Ctrl+B, Ctrl+I, Enter, paste as text). **Save** posts `serialize`; the parent runs `stripViewerInjection` on the returned HTML and then follows §10.2. **Cancel** posts `set-edit-mode {on: false}` and re-sets `srcDoc` from the cached content, discarding edits. Leaving the viewer with unsaved edits asks for confirmation.

### 10.2 Two rules for where edits go

- **Editing an active or retired revision never touches it.** Save calls the existing `POST /api/documents` with `{code, html, activate: false}`. Title and description are inherited (the 1.22.3 behaviour), `created_by_user_id` and `updated_by` come from the bearer, and the result is the next revision as a **draft**. The viewer navigates to it. Activation stays the existing step. Open comments on the code re-anchor onto the new draft by themselves.
- **Editing a draft replaces that draft's content in place** (§10.3). Otherwise every save would stack another draft and the library's one-draft-per-code reading would break. Immutability stays absolute for anything that was ever active.

### 10.3 `PUT /api/documents/{id}/content`

Admin bearer only (`require_document_admin_writer` minus agents: an `AgentWriter` is 403, the internal token is 403). Body `{html}`.

- 404 unknown; **409** unless `status = 'draft'` and no row has `supersedes_id = {id}`.
- `validate_html` runs as on create (theme inlining is a no-op because the marker is already present; the size cap applies).
- Identical bytes to the current blob: 200, no change.
- Otherwise: write the new blob, update `storage_key`, `size_bytes`, `content_sha256`, `updated_by`, `updated_at`, **commit**, then delete the old blob best-effort. A failed delete leaves an inert orphan; a row never points at missing bytes. Same ordering rule as `delete_draft`.
- Audited like the other writer routes.

### 10.4 Apply suggestion

On a suggestion card, an admin's **Apply** posts `apply-replacement {id, text}`. The bridge replaces the already-restored range (which is why quotes crossing inline tags work where a string replace would not) and returns the serialized document. The parent saves it by §10.2, and only after a 2xx resolves the suggestion with the admin as resolver. `apply-failed` (the suggestion lost its place) shows a toast and changes nothing.

## 11. Security

- The iframe sandbox stays `allow-scripts`: no `allow-same-origin`, no popups, no top navigation. Document scripts cannot reach Mk1 storage or the JWT. Nothing in this design relaxes that.
- Every bridge message is source-, origin-, type-, shape-, and size-checked (§7.3). A hostile document can post forged messages; the worst it can do is pretend to be a selection or a heading list, neither of which writes anything without a human clicking Save.
- The bridge asset is same-origin and version-pinned. Subresource integrity is a follow-on.
- Anchors are validated JSON with upstream caps and are never rendered or interpolated on the parent side (§5).
- Comment bodies render through the existing markdown-it `html: false` + DOMPurify pipeline. Attachments are magic-byte sniffed, size-capped, served authenticated with `nosniff`. Unlinked uploads are garbage-collected.
- Quote verification stops an agent from anchoring a comment to words that are not in the document.
- Authorship is derived from the credential, never the body. The nameless internal token cannot comment. Agents cannot edit document content or apply suggestions; those need an admin bearer. Editing or deleting a comment needs its author or an admin.
- Edit mode serializes inside the sandbox; both sides strip viewer markup (§7.4); the saved bytes pass `validate_html` and the size cap; draft replace is 409-guarded; active revisions are never rewritten.
- Document links intercepted by the bridge open only `http:`/`https:` and only with `noopener`.

## 12. Testing

Follow the sibling conventions: backend files on the in-memory SQLite engine with the documents route fixture (`storage.set_storage_for_tests`, `seed_categories`, dependency overrides for `get_db`, `get_current_user`, and the writer); frontend in vitest + Testing Library; one Playwright run on a devbox stack.

**Backend**
- `test_documents_comments.py`: create / list / nested replies / reply-depth 400 / numbering stable across statuses and deletes / cross-revision listing by code / resolve-reopen idempotence / author-or-admin edit and delete rules / agent-token authorship sets `author_agent` / internal token 403 / label id validation / suggestion CHECKs / `open_comment_count`.
- `test_documents_anchors.py`: every cap from §5 with fixtures mirroring upstream (16 KiB, 400-char quote, 16 targets, 2 KiB context), unknown keys dropped, quote-only accepted, quote-only with a missing quote → 400 with the quote named, DOM-anchored quote not verified.
- `test_documents_comment_attachments.py`: sniff accepts the four types and rejects others, cap, unlinked → linked on body save, cross-code token refused, serve headers, GC sweep.
- `test_documents_export.py`: a golden export covering a labelled comment with tip and attachment, a suggestion, a global comment, a reply, and the "on rN" marker.
- `test_documents_content_replace.py`: 404, 409 on active, 409 on a superseded draft, identical bytes no-op, replace updates hash/size/key and deletes the old blob after commit, agent 403, non-admin 403.

**Frontend**
- `useDocumentBridge.test.ts`: messages from another source or a non-null origin are ignored; oversized and malformed payloads dropped; version mismatch sets the unavailable state; `ready` issues the find-and-mark batch and numbering; `link-click` opens only http(s).
- Vendored `html-anchor.test.ts` ported to vitest and passing unchanged.
- `stripViewerInjection.test.ts`: injection block, script tag, and theme stamp removed; author content byte-identical otherwise.
- `bridge-asset.test.ts`: `public/pn-bridge.v<N>.js` equals the generated output.
- `CommentComposer.test.tsx`: paste inserts `{attachment:ID}` at the caret; Ctrl+Enter saves; suggestion mode requires replacement text.
- `CommentsPanel.test.tsx`: cards ordered by number, lost-its-place grouping, filter, agent author display.

**End to end (devbox stack, Postgres, S3-shaped attachments)**
`e2e/documents-annotations.spec.ts`: open a document, select text, comment with a label, attach a drawn image, reload and see the marker and image restored, post a new revision through the MCP with the sentence moved and another removed, see one comment re-anchor and one land in Lost its place, apply a suggestion as admin and see a draft appear, resolve. Two things only the stack can settle: the asset bridge under whatever CSP the deployed nginx sends, and JSONB + CASCADE + CHECK behaviour on Postgres. SQLite green is not done.

**Gates.** Backend failure-set diff against master empty (the baseline has known failures; gate on the set, never on zero). Frontend `npm run check:all`. Postgres proving on a stack before merge.

## 13. Rollout

Four slices, each its own PR, in this order, so comments can be proven on a stack before edit mode lands:

1. **Backend:** tables, DDL, anchors validator, labels, comment and attachment routes, export, cross-document list, `open_comment_count`.
2. **Viewer:** vendored files, bridge asset build, `useDocumentBridge`, toolbar, composer, panel, Contents tab, list-page column.
3. **MCP:** the four tools, staged and cut over with the existing `roll_stage.sh` / `roll_cutover.sh` on the bot host.
4. **Edit mode:** `set-edit-mode` / `serialize` / `apply-replacement` extensions, `PUT …/content`, Edit UI, Apply.

Deploy notes: tables via `create_all` plus idempotent DDL at boot; no env change (attachments ride the existing flag prefix); the bridge asset ships with the frontend build. Post-deploy smoke: comment on a prod document, attach an image (the first PutObject under `<flag prefix>/documents/`), reload, resolve. If the bridge banner appears on prod, the fix is the nginx CSP `script-src`, not the code.

## 14. Follow-ons

Live updates over the flags SSE bus pattern; label catalog in Settings; mentions and notifications; shift-click multi-target comments; active-heading tracking; revision diff view (plannotator's `htmlDiff` is MIT too); an MCP tool that returns attachment images; SRI on the bridge asset; a dedicated `documents/` S3 prefix for both document blobs and comment images.

## 15. Amendments during implementation (2026-10-03)

Recorded from the execution ledger; each supersedes the earlier text above.

- §4.1 **Numbering is stored, not computed.** "Computed on read, never stored" contradicted "deletes leave gaps": a position cannot keep a gap. `document_comments.number` (Integer, NULL on replies) comes from a per-code high-water counter, `document_comment_counters(code PK, next_number)`, on the `document_code_counters` pattern (PK row lock under Postgres), so a deleted top number is never reused; `UniqueConstraint(code, number)` stays as a second guard, and a lost race surfaces as the existing 409 "conflicting write; retry". The stability promise ("item 7 stays item 7") is what the number exists for and stands.
- §4 **DDL.** The three tables are new, so boot's `create_all` builds them exactly as it built `documents` in 1.22.0. Because a development database may already hold `document_comments` from an earlier boot in the same branch, `_run_migrations` carries two idempotent statements for the `number` column and its unique index; nothing else needs an entry.
- §6.2 **The "quote not found" detail carries the full quote** (the validator caps it at 400), and `PATCH` enforces the same body-or-label invariant as create, validating before it assigns.
- §6.1 **Reads are bearer-only.** `GET` list, `GET` by id, export and index take a login; a per-agent token is a write credential. Agents read through the lab MCP's bot login (§9), so the "any agent" row in the actor table is satisfied by that path, not by the token.
- §4.2 **`_sniff_image` is copied, not imported.** `flags.service._sniff_image` raises `flags.errors.BadRequestError`, which the documents error mapper would turn into a 500. Ten duplicated lines beat coupling the two modules' error types. The storage seam is still shared, imported lazily.
- §5 **Text extraction joins with no separator.** `document_text` concatenates text nodes directly so inline markup (`per <em>USP</em>.`) verifies as rendered. A quote spanning two block elements is a false negative the agent sees as a 400 and can rephrase.
- §6 **One `_http`.** `comment_routes.py` imports `_http` and `_match_agent` from `documents.routes`; the `ForbiddenError` → 403 branch lives in `routes._http`.
- **Line endings.** `backend/` is LF in the git index (639 of 642 Python files), as is `src/`. `git ls-files --eol` is the only trustworthy check on the development machine, whose system-level git config sets `core.autocrlf=true`; a `git show | grep -c $'\r'` count misreported LF blobs as CRLF and briefly produced two CRLF files, since renormalised.
