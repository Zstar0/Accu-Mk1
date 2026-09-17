# Documents Library — design

**Date:** 2026-09-15
**Status:** approved in chat by the Handler 2026-09-15; implementation plan next
**Scope:** Accu-Mk1 only (backend + desktop frontend + one repo skill). Companion slices listed at the end are out of scope here.

## 1. Purpose

Give Accu-Mk1 a controlled-document library that holds two kinds of HTML documents today and any future kind by category:

- **Artifacts** — the report pages Claude Code builds during sessions (today published only to claude.ai). Example: the 2026-09-14 Additional COA Profile Audit.
- **SOPs** — the lab's standard operating procedures, converted from Word to HTML by a later skill.

Documents are **created and revised by LLM agents through the API**. The Mk1 UI lists, views, retitles, and manages categories. It does not author or edit content in this slice.

Every document carries a controlled-document identity modeled on the existing HPLC Methods system (`hplc_methods`): a code, a revision number, a lifecycle status (draft → active → retired), an effective date, and an immutable revision chain.

Documents render with the **artifact look**: the palette and type of the pages Claude publishes today, carried inside each document, not applied by Mk1. The Mk1 shell keeps its own theme.

## 2. Non-goals

- No in-app content editor. Title/description/category/effective-date metadata edits only.
- No re-theme of the Mk1 application.
- No Word → HTML conversion here (separate skill, see §12).
- No Alembic adoption here (separate infra slice, see §12). The new tables ride the existing `create_all` boot path.
- No public or unauthenticated access to documents.
- No full-text search over document *content*. Search covers code, title, and description.

## 3. Data model

Two tables on the shared `database.Base`, defined in `backend/documents/models.py` and imported in `init_db()` the way `flags.models` is. **No `lims_` prefix**: these are not sample-hierarchy entities (see the naming rule for `lims_*`).

### 3.1 `document_categories`

| column | type | notes |
|---|---|---|
| id | int PK | |
| name | varchar(100), unique | e.g. `Artifact`, `SOP` |
| code_prefix | varchar(10), unique | e.g. `ART`, `SOP`; uppercase letters/digits only |
| description | text, nullable | |
| sort_order | int, default 0 | |
| active | bool, default true | inactive categories are hidden from pickers, existing documents keep them |
| created_at, updated_at | datetime | |

Seed at boot, idempotent by `name`: `Artifact / ART` and `SOP / SOP`.

### 3.2 `documents`

One row per **revision**. Shape mirrors `hplc_methods` (slice 3 lifecycle).

| column | type | notes |
|---|---|---|
| id | int PK | |
| code | varchar(30), not null | `ART-0012`; minted or supplied (§5.4) |
| revision | int, not null, default 1 | |
| title | varchar(300), not null | |
| description | varchar(1000), nullable | the "short desc" shown in the list |
| category_id | FK → document_categories.id, not null, `ON DELETE RESTRICT` | |
| status | varchar(10), not null, default `draft` | `draft` \| `active` \| `retired` |
| effective_date | date, nullable | set on activate if absent |
| activated_at, retired_at | datetime, nullable | |
| supersedes_id | FK → documents.id, nullable, `ON DELETE SET NULL` | previous revision of the same code |
| author | varchar(200), nullable | agent or person name, e.g. `Claude Code` |
| source_session | varchar(200), nullable | provenance, e.g. the Claude Code session id |
| created_by_user_id | FK → users.id, nullable | set when a logged-in admin publishes |
| content_type | varchar(100), not null, default `text/html; charset=utf-8` | |
| storage_key | varchar(500), not null | blob-store key (§4) |
| size_bytes | int, not null | |
| content_sha256 | char(64), not null | |
| created_at, updated_at | datetime | |

Constraints, copied from `hplc_methods`:

- `UniqueConstraint(code, revision)` — `uq_documents_code_revision`
- partial unique index on `code` where `status = 'active'` — at most one active revision per code (`uq_documents_code_active`)

Invariant: a code's revisions are a chain; `supersedes_id` of revision *n* points at revision *n-1*. Content is never rewritten; a change is a new row.

### 3.3 `document_code_counters`

| column | type | notes |
|---|---|---|
| prefix | varchar(10) PK | matches `document_categories.code_prefix` |
| next | int, not null, default 1 | next number to mint; read and bumped under `SELECT … FOR UPDATE` (§5.4) |

A row is created lazily on the first mint for a prefix. Supplied codes never touch the counter, so a supplied `ART-0100` does not advance minting; when the counter later reaches a number already in use the minter skips forward to the next free one, so minting never collides with a supplied code.

## 4. Storage

Bytes live in the existing blob store, not Postgres. Reuse `backend/sub_samples/photo_storage.py` (`get_storage()`): `FilesystemPhotoStorage` in dev/tests, `S3PhotoStorage` in prod, with the same selector; the route layer never branches. Key shape: `documents/{code}/r{revision}.html`. The flag-attachments adapter in `main.py` is the precedent for a per-feature prefix.

Limits: HTML only (`text/html`), **16 MB** cap (matches the artifact cap), body must begin with `<` after whitespace.

## 5. API

Package `backend/documents/` = `models.py`, `schemas.py`, `service.py`, `routes.py`, mounted in `main.py` like `flags` and `priority`. Router prefix `/api`.

Auth dependencies (all existing in `backend/auth.py`):

- **read** (`GET`): `get_current_user`
- **write** (`POST`/`PATCH` lifecycle, categories): `require_admin` **or** `require_internal_service_token` (`X-Service-Token` == `ACCUMK1_INTERNAL_SERVICE_TOKEN`). Implement one `require_document_writer` dependency that accepts either.

### 5.1 Documents

| verb | path | auth | behaviour |
|---|---|---|---|
| GET | `/api/documents` | read | list; query params `q` (ILIKE over code/title/description), `category_id`, `status` (repeatable; default `draft,active`), `sort` (`updated_at` desc default; also `title`, `code`, `effective_date`), `page`/`page_size` (default 50, max 200). Returns **latest revision per code** matching the status filter, plus `revision_count`. |
| GET | `/api/documents/{id}` | read | the row plus `revisions[]` (all rows sharing its code, ordered by revision) |
| GET | `/api/documents/{id}/content` | read | streams the HTML inline. Headers: `Content-Type: text/html; charset=utf-8`, `Content-Disposition: inline; filename="{code}-r{rev}.html"`, `Content-Security-Policy: sandbox allow-scripts`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=0`. |
| POST | `/api/documents` | write | create a document or a new revision (§5.4). JSON body. 201 with the row. 200 with the existing row on identical-content repush (§5.5). |
| PATCH | `/api/documents/{id}` | write | metadata only: `title`, `description`, `category_id`, `effective_date`. Does not bump `revision`. |
| POST | `/api/documents/{id}/activate` | write | draft → active. Retires any other active revision of the same code in the same transaction (lockstep). Sets `activated_at`, and `effective_date` if null. 409 if not draft. |
| POST | `/api/documents/{id}/retire` | write | active → retired. Sets `retired_at`. 409 if not active. |

No delete. Retire is the terminal verb.

### 5.2 Categories

| verb | path | auth |
|---|---|---|
| GET | `/api/document-categories` | read (`?active_only=true` for pickers) |
| POST | `/api/document-categories` | write |
| PUT | `/api/document-categories/{id}` | write — `name`, `description`, `sort_order`, `active`. `code_prefix` is immutable once any document uses it. |
| DELETE | `/api/document-categories/{id}` | write — 409 if any document references it |

### 5.3 Create body

```json
{
  "title": "Additional COA Profile Audit",
  "description": "Accounts with more than five additional-COA profiles ...",
  "category": "ART",              // code_prefix, or "category_id": 1
  "code": null,                   // optional; existing code => new revision
  "author": "Claude Code",
  "source_session": "d06d233c-0b47-40cf-a036-db2773c31e8c",
  "effective_date": null,         // optional ISO date
  "activate": true,               // default true
  "html": "<!doctype html>..."    // full document, ≤ 16 MB
}
```

`html` is the whole document as a string. Multipart upload is not needed for this slice.

### 5.4 Code minting and revisions

- No `code` supplied → mint `{code_prefix}-{NNNN}` from a per-prefix counter table `document_code_counters(prefix PK, next int)`, incremented under `SELECT … FOR UPDATE`. Zero-padded to 4, grows past 9999 naturally.
- `code` supplied and unknown → use it verbatim (validated `^[A-Z0-9]+-[A-Z0-9-]+$`); revision 1. The prefix must match the chosen category's prefix.
- `code` supplied and known → new row at `max(revision)+1`, `supersedes_id` = the current latest revision's id. `category_id` is inherited from the latest revision unless the body overrides it.
- `activate: true` → run the activate verb inside the same transaction, so a publish is atomic: new revision active, previous revision retired.

### 5.5 Dedupe

If the latest revision of `code` has the same `content_sha256` as the incoming HTML, no row is created; respond 200 with that row (and apply any `title`/`description` in the body as a metadata patch). Prevents an agent that reruns a build from minting empty revisions.

## 6. Publishing from an agent

Repo skill `.claude/skills/mk1-publish-document/` with one script, `publish_document.py` (stdlib only: `urllib`, `json`, `hashlib`, `re`).

```
python publish_document.py page.html --title "..." --description "..." --category ART \
    [--code ART-0012] [--author "Claude Code"] [--session <id>] [--draft] [--effective 2026-09-15]
```

Steps, in order:

1. Read the file. If it is an artifact-style fragment (no `<html>`), wrap it: doctype, `<html>`, `<head>` with charset + viewport, `<body>`.
2. **Inline the theme**: if the document does not already contain the marker `/* accumark-docs vN */`, prepend `<style>` with the canonical stylesheet (§7). Documents that carry a newer theme are left alone.
3. **Secret scan**: refuse (exit 2, print the match kind, never the value) on `AKIA[0-9A-Z]{16}`, `sk_(live|test)_`, `-----BEGIN [A-Z ]*PRIVATE KEY`, `ghp_[A-Za-z0-9]{36}`, `xox[abp]-`, `Bearer [A-Za-z0-9._-]{20,}`, `password\s*[:=]\s*\S+`. Override with `--allow-secrets` only if a human says so.
4. POST to `${MK1_API_BASE_URL}/api/documents` with `X-Service-Token: ${ACCUMK1_INTERNAL_SERVICE_TOKEN}`. Both env vars already exist on prod and the stacks; the script fails loudly if either is missing.
5. Print the code, revision, id, and the Mk1 deep link `#reports/documents?id={id}`.

Session id: default from the scratchpad path when run inside Claude Code (`…/claude/<project>/<session>/scratchpad`), else `--session`.

## 7. Theme: `accumark-docs.css`

Canonical file: `src/docs-theme/accumark-docs.css` in the Mk1 repo, versioned by a header comment `/* accumark-docs v1 */`. It is **inlined into documents at publish time** (by the publish skill and by the SOP conversion skill) — never linked — because:

- claude.ai artifacts cannot load external stylesheets (CSP), and I want the same file to render identically on claude.ai, in Mk1, and from disk;
- a document must not change appearance when Mk1's theme file changes later; revisions are snapshots.

Contents, extracted from the 2026-09-14 audit page: the token set for light and dark (`:root`, `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`), type (Archivo display, IBM Plex Sans body, IBM Plex Mono data, via Google Fonts `<link>` which is the one external resource allowed), masthead, eyebrow, stamp row, KPI tiles, chips (status palette: critical/serious/warning/good/info), controls, tables, detail rows, the bar-chart primitives, tooltip, method/definition list, and the responsive rules at 760px. Nothing Mk1-specific.

Mk1's own theme is untouched.

## 8. Frontend

### 8.1 Navigation

- `ui-store.ts`: add `'documents'` to `ReportsSubSection`; add `selectedDocumentId: number | null` + setter (mirrors how explorers keep a selected id).
- `AppSidebar.tsx`: `{ id: 'documents', label: 'Documents' }` under Reports, after Ready to Publish.
- `MainWindowContent.tsx`: `if (activeSubSection === 'documents') return <DocumentsPage />`.
- `hash-navigation.ts`: no allowlist change; `#reports/documents?id=123` opens the viewer.
- Update `AppSidebar.test.tsx` and `QuickNav.test.tsx`.

### 8.2 List page — `src/components/documents/DocumentsPage.tsx`

TanStack Query → `apiFetch` functions added to `src/lib/api.ts` (`listDocuments`, `getDocument`, `getDocumentContent`, `patchDocument`, `listDocumentCategories`, …). Uses the shared `src/components/ui/data-table.tsx`.

Columns: Code · Title (description underneath, muted) · Category (chip) · Rev · Status (chip: draft/active/retired) · Effective · Updated · Created. Filter row above: search `Input` (debounced 250 ms, server `q`), Category `Select`, Status `Select` (default "Draft + Active"). Sort via the table headers (server-side). Row click → viewer. Empty state names the publish skill so the first visit explains how documents get here.

Pure helpers in `src/components/documents/documents-utils.ts` (query-string building, status labels) with vitest coverage, following `ready-to-publish-utils.ts`.

### 8.3 Viewer — `src/components/documents/DocumentViewer.tsx`

Header: back link, code, title, revision picker (all revisions of the code, current marked), status chip, category, effective date, author, created/updated; actions **Download** (blob of the fetched HTML, filename `{code}-r{rev}.html`) and **Retitle** (admin only; dialog for title + description; `PATCH`).

Body: `<iframe sandbox="allow-scripts" srcdoc={html} title={title} className="flex-1 w-full border-0">`.

- Content is fetched with the normal bearer `apiFetch` (as text), so no token ever appears in a URL.
- `sandbox="allow-scripts"` **without** `allow-same-origin` gives the frame an opaque origin: the document's JavaScript cannot read Mk1's localStorage, cookies, or auth store, cannot navigate the top window, and cannot call Mk1's API with the user's session.
- Theme sync: before assigning `srcdoc`, stamp Mk1's current theme onto the document root (`<html data-theme="dark">` / `"light"`), which the artifact CSS already honors. Re-stamp when Mk1's theme toggles.
- Google Fonts load inside the frame (sandboxed frames may load subresources); if offline, the fallback stacks in the theme apply.

### 8.4 Settings — categories

`src/components/preferences/SettingsPage.tsx` gets an admin-only **Documents** tab (`SettingsSubSection` += `'documents'`): a small table of categories (name, prefix, description, active, document count) with Add, Rename/Edit, Deactivate. Deletion is exposed only for categories with zero documents (the API refuses otherwise).

## 9. Security

- **Writers**: service token or admin only. The service token is the existing `ACCUMK1_INTERNAL_SERVICE_TOKEN`; no new secret.
- **Readers**: any logged-in Mk1 user. No public route.
- **Execution**: document JS runs only inside the sandboxed frame (§8.3). The raw content route also sends `Content-Security-Policy: sandbox allow-scripts` so a document opened directly in a browser tab is still confined.
- **Input**: HTML-only sniff, 16 MB cap, hash recorded, dedupe by hash.
- **Provenance**: `author`, `source_session`, `created_by_user_id` on every row; revisions immutable; no delete verb.
- **Secrets**: the publish skill's scan (§6) is the last line before a report that accidentally embeds a key lands in a shared library.
- Categories `code_prefix` immutable once used, so codes never orphan.

## 10. Testing

Backend (`backend/tests/test_documents.py`, filesystem storage via the existing test selector):

- mint: `ART-0001`, `ART-0002`, per-prefix counters independent; supplied code honored; prefix/category mismatch → 422.
- revisions: second push on a code → revision 2, `supersedes_id` set, prior revision retired when `activate: true`; partial unique index holds (second concurrent activate → 409).
- lockstep: activate non-draft → 409; retire non-active → 409.
- dedupe: identical bytes → 200, same id, no new row; metadata patch applied.
- categories: delete with references → 409; prefix immutable once used; seed idempotent across two `init_db()` calls.
- auth: anonymous → 401 on all; user → 200 on GET, 403 on write; admin → 2xx; service token → 2xx; wrong token → 401.
- content route headers (CSP, nosniff, disposition).

Frontend: vitest for `documents-utils.ts`; `AppSidebar.test.tsx` / `QuickNav.test.tsx` updated for the new item. `npm run check:all` gated on the **failure-set diff** against master (repo rule), never on zero.

Publish skill: a self-check `demo()` that wraps a fragment, inlines the theme once, and rejects a fixture containing an `AKIA…` string.

## 11. Rollout

- Tables created by `create_all` at boot; categories seeded idempotently in `init_db()` after `create_all`.
- No new env vars. Storage uses the existing `MK1_PHOTO_*` config with the `documents/` key prefix.
- Version bump + CHANGELOG entry under `## Unreleased` → cut with the next Mk1 release. **Full** Mk1 deploy (backend + frontend). Additive only; no existing route or table changes.
- Rollback: the tables are inert without the routes; reverting the release is sufficient.
- First content: republish the 2026-09-14 Additional COA Profile Audit through the skill as `ART-0001`.

## 12. Follow-on slices (not in this spec)

1. **SOP conversion skill** — Word (`.docx`) → HTML with `accumark-docs.css` inlined, SOP number as `code`, published as `--draft` for review; activation done by an admin in Mk1 or by the agent on instruction.
2. **Alembic adoption** — baseline autogenerate against prod, drift reconciliation, stamp prod/stacks/golden, swap the boot step. Own sign-off and rollback plan.
3. Admin upload from the UI, and content editing, if ever wanted.
4. Content full-text search.

## 13. Amendments during implementation (2026-09-15)

Recorded from the implementation ledger; each supersedes the earlier text above.

- §3.2/§5.4 `effective_date` defaults to the **local business date** (`date.today()`) on activation; `activated_at`/`retired_at` stay UTC.
- §4 storage keys are content-addressed: `{code}/r{revision}-{sha256[:12]}.html` (filesystem/in-memory); S3 objects are `{code}/{uuid}.bin` under the `documents/` prefix. Keys are opaque handles; only `documents.storage_key` resolves them.
- §4/§11 the filesystem backend is its own class, rooted at `MK1_DOCUMENTS_DIR` if set, else `<MK1_PHOTO_STORAGE_DIR or /app/data>/documents` so stack and prod containers keep the bytes on the mounted volume. No new env var is required.
- §5.1 list semantics are **filter-first**: the latest revision per code among rows matching the status filter; `revision_count` is unfiltered.
- §5.1 `PATCH category_id` is rejected (400) when the category's prefix differs from the code's prefix; `POST` on an existing code rejects a cross-prefix category the same way. In practice a document's category cannot change.
- §5 `IntegrityError` maps to 409.
- §8.3 there is **no "Open in window"** action: a top-level `blob:` URL is same-origin with Mk1 and would let document scripts reach localStorage. Download remains.
- §8.2 sort is a select control, not table headers. §6 the publish script does not auto-derive the session id; agents pass `--session`.
- §7 the theme does not inject a Google Fonts link; documents that want the faces carry their own `<link>` (artifact fragments already do), and the fallback stacks apply otherwise.
