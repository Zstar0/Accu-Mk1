# Flag System Phase 2 — Design

**Date:** 2026-07-09
**Status:** Approved (brainstormed with Forrest 2026-07-09; sections 2–7 approved by delegation — "you have enough to go off of")
**Prior art:** `2026-06-27-flag-system-design.md` (Phase 1 spec), shipped to prod as Mk1 1.0.16 (PR #28 + Slack DMs PR #32).

## 1. Context & Goals

Phase 1 shipped a work-product-anchored flag/task system (flyout, threads, SSE, entity buttons, Slack DMs). It is in daily production use. Phase 2 responds to staff feedback after a week of real use:

1. **General tasks** — flags not anchored to any entity (feature requests, errands like "pick up equipment", lab ops tasks), plus linking a flag to multiple related entities and to other flags.
2. **Richer comments** — Slack-like formatting, clickable links, pasted screenshots.
3. **Reactions** — emoji reactions on comments.
4. **Filter improvements** — hide closed/resolved by default (composite "All Open"), assignee filter, consistent filter bar across tabs.
5. **Activity personalization** — filter the Activity tab to "my" activity flavors.
6. **Watcher visibility** — see who's watching from the thread; add watchers.
7. **Due dates** — tasks want deadlines and overdue visibility.
8. **Slack round 2** — interactive DM buttons (prepped in Phase 1), morning digest.
9. **Recurring tasks** — scheduled minting of routine flags (calibrations, maintenance).
10. **State-change watches** — arm a watch on an entity ("when sample X hits Received") that creates a flag or comments on an existing one.

**Deferred to a later phase:** Analytics dashboard. Every Phase 2 slice must still *capture the data* the dashboard will need (see §9, Analytics readiness). Bulk actions, comment full-file attachments (non-image), multi-anchor flags, and per-user access limits on analytics are likewise out of scope.

## 2. Decisions (locked during brainstorm)

- **Single assignee stays.** No multi-assignee. Watchers + reassign-on-handoff cover "who's involved"; `flag_events` already records every handoff. (Braindump item 9 resolves as a decision, not a build.)
- **Link model (b): primary anchor + references.** A flag keeps at most ONE `(entity_type, entity_id)` anchor (now nullable). Additional entities attach as *reference links* — navigational chips, NOT counted in rollups/indicators/EntityFlagButton counts. Promotable to multi-anchor later without schema rework (same join table; we'd start counting).
- **Rich text = markdown-lite, stored as markdown source in `flag_comments.body`.** No ProseMirror/Tiptap document model. Bold/italic/code/code-block/lists/links + existing @mentions. Bare pasted URLs auto-linkify. Existing plain-text comments render unchanged (markdown renderer is a superset).
- **Images only in v1** for attachments (paste/drag into composer). Other file types deferred; same table can carry them later.
- **Analytics deferred but data-first.** New mutations emit `flag_events` rows with timestamps + actor attribution so the future dashboard computes retroactively (as Phase 1's event log already allows).
- **Poll, don't instrument** for state-change watches. Entity state changes via multiple write paths (receive wizard, SENAITE sync); a scheduler-driven poller evaluating armed watches every few minutes is robust to all of them. Minutes-level latency is acceptable.
- **Six slices, each its own PR, each independently deployable** (system is live in prod — small additive merges over one giant branch). Order: filters → task foundation → comments v2 → search → Slack round 2 → watches.
- **Module purity holds.** The flags module keeps zero knowledge of Mk1 domain objects. New host knowledge enters only via seams (`seams.py` closures): attachment storage, entity state reads.
- **Trusted-staff assumption unchanged** (Phase 1 security review): all authenticated Mk1 users are staff. RE-REVIEW TRIGGER: any customer-facing role ⇒ per-flag authz on reads, attachment URLs, and the interactions endpoint.

## 3. Slice overview

| # | Slice | Branch (suggested) | Surface | Migrations |
|---|-------|--------------------|---------|-----------|
| 1 | Filters & visibility | `feat/flag-p2-filters` | FE + tiny API | none |
| 2 | Task foundation | `feat/flag-p2-tasks` | BE + FE | yes (nullable anchor, 2 link tables, due_at) |
| 3 | Comments v2 | `feat/flag-p2-comments` | BE + FE | yes (attachments, reactions) |
| 4 | Comment search | `feat/flag-p2-search` | BE + FE | index only |
| 5 | Slack round 2 + scheduler | `feat/flag-p2-slack2` | BE + FE (prefs) | yes (schedules, digest prefs) |
| 6 | State-change watches | `feat/flag-p2-watches` | BE + FE | yes (watches) |

Dependencies: 2 before 3 (composer changes stack), 5's scheduler before 6 (poller rides it) and before recurring tasks (same slice as 5). 1 and 4 are independent. Each slice branches off master after its predecessor merges; plan docs ride their slice branch.

## 4. Slice 1 — Filters & visibility

No migrations. Server additions are query params on existing endpoints.

**Composite "All Open" status filter.** `FlagsFilterBar` status dropdown gains an **"All Open"** option = `OPEN_STATES` (`open`, `in_progress`, `blocked`) and it becomes the **default** on Assigned/Raised/Watching tabs (today's default "All statuses" stays available; All-Open tab semantics unchanged — it is already open-scoped server-side). Persist the user's last choice per tab in localStorage (`flags:filter:<tab>`), same idiom as `flags:viewMode`.

**Assignee filter.** New dropdown in `FlagsFilterBar` (all tabs where it makes sense — hidden on Assigned-to-me): "Anyone" + user list (reuse the user directory that mention-autocomplete already loads, `flag-users.ts`). Client-side filtering like the existing status/entity/type filters (`filterFlags` in `flag-filter.ts`) — lists are already fully fetched per tab; no server round-trip needed. Include an "Unassigned" option (assignee_id null).

**Activity tab personalization.** The feed is already server-scoped to relevance (assignee/creator/watcher ∪ own actions — `list_activity`). Add client-side filter chips above the feed: **All · My actions · My flags (assigned/raised) · Watching · Mentions**. "Mentions" filters to events whose comment mentions include me — if `details.mentions` turns out absent from comment events, add it additively to the event details in this slice. Chips persist in localStorage.

**Watchers in the thread.** `FlagDetailResponse` gains `watchers: list[WatcherInfo]` (id + display name, resolved via the user provider seam). Thread view: a compact watcher row under the header (avatar cluster + count, expandable), an **"Add watcher"** picker (user directory; POST `/{id}/watchers` exists since Phase 1), self-serve **Watch/Unwatch** button, and remove affordance (DELETE exists). Audit lines already emit for watcher add/remove — verify and keep. Adding a watcher notifies them per existing Slack category `watching_activity` prefs (no new toast category — watchers get no live toasts, LOCKED in Phase 1).

## 5. Slice 2 — Task foundation

**Nullable anchor.** `flag_flags.entity_type` / `entity_id` become nullable (relaxing migration, existing rows untouched). A flag with NULL anchor = **general task**. Card/table render without an entity context line; deep-link column shows a dash. `EntityContext` resolution short-circuits to `None`. Slack DM link falls back to dashboard hash (existing fallback path). SSE payloads unchanged (`entity: null` already tolerated for worksheet-only flags).

**Raise flow.** Compose gains an anchor selector: **"On this page's item"** (current stack-top preset, unchanged) / **"General (no item)"**. The flyout's global Add Flag button — hidden when the entity stack was empty (Phase 1 iteration 11 option A) — becomes **always visible**, defaulting to General when no page entity is registered. Type picker filters by entity scope as today; General tasks use types scoped `global`. The filter bar's entity dropdown gains a **"General"** option so unanchored tasks are findable (ships here, not slice 1, since no general flags exist before this slice).

**New builtin types** seeded: **Task** (kind issue, global scope) and **Feature Request** (kind issue, global scope). Admin pane (Plan 5's `flag_types` catalog) already supports rename/recolor/deactivate/add — no further seeding (Errand etc. is user-managed config).

**Entity reference links.** New table `flag_entity_links(id, flag_id FK CASCADE, entity_type, entity_id, added_by, created_at)`, unique on `(flag_id, entity_type, entity_id)`. Endpoints: `POST /{id}/links/entities`, `DELETE /{id}/links/entities/{link_id}`, list rides `FlagDetailResponse.entity_links` (server-resolves labels via `seams.context()` like the anchor does). UI: chips in the thread header ("Related: WS-0142 · PB-0071"), each deep-links; add via a small picker (entity type + id search — reuse the manual entity form kept from Phase 1); compose offers "add related items". NOT in rollups (decision §2). Audit event `entity_link_added`/`removed`.

**Flag↔flag links.** New table `flag_links(id, flag_id, linked_flag_id, relation, added_by, created_at)`, `relation` = `related` only in v1, unique pair, CHECK `flag_id != linked_flag_id`. Symmetric render (a link shows in both threads). Chips in thread ("Related flags: #12 Pump seal"), click = open that thread. Endpoints mirror entity links. Audit event both sides.

**Due dates.** `flag_flags.due_at` nullable timestamp (+ index). Composer date field (optional); editable from thread (assignee/creator/admin — same permission check as status changes). List/table: overdue rows get a red accent + relative "due in 2d / overdue 3d" text; **Overdue toggle** in the filter bar; due-date sort in table view. Events: `due_set` / `due_changed` / `due_cleared` with old/new in details (audit line: "due date set to Jul 15"). Overdue is computed, never stored. Slack: due dates DO NOT generate DMs in this slice (digest in slice 5 covers overdue nudges — avoids double-notification design now).

## 6. Slice 3 — Comments v2

**Markdown-lite.** Renderer: a small, sanitizing markdown pipeline (CommonMark subset: bold/italic/inline-code/code-block/lists/links; NO raw HTML — escaped; NO images-via-markdown-syntax — images come from attachments). Auto-linkify bare URLs (target=_blank, rel=noopener). @mentions keep the existing token syntax and render as today (mention-parse composes with the renderer; mentions parse BEFORE markdown so `@name` inside code spans stays literal — decide final order in plan, add tests). Composer: light toolbar (B / I / code / list / link) inserting markdown tokens + Ctrl+B/I shortcuts; plain textarea remains the storage/UX model (no contenteditable). Slack `body_excerpt` stays a plain-text strip (strip markdown tokens server-side before excerpting; existing `_esc()` mrkdwn escaping unchanged).

**Dependency note (npm-only frontend):** `markdown-it` (CommonMark, html:false so raw HTML stays escaped, linkify:true for bare URLs) + `dompurify` as a belt-and-suspenders sanitize pass, both pinned. If the implementing plan finds the bundle cost objectionable, the sanctioned fallback is a hand-rolled ~100-line subset renderer — but default to the libraries.

**Image attachments.** New table `flag_attachments(id, flag_id FK, comment_id FK nullable, uploaded_by, filename, content_type, size_bytes, storage_key, created_at)`. Upload: `POST /api/flags/{id}/attachments` (multipart; image/* only — sniff magic bytes server-side, don't trust content-type header; size cap ~10 MB; strip EXIF optional-later). Storage via a **new seam**: `seams.attachment_storage` → host provides the same S3-backed storage used by vial photos (`backend/sub_samples/photo_storage.py` pattern; module receives a put/get/delete/url interface, never boto3 directly). Serving: authenticated `GET /api/flags/attachments/{id}` streaming from storage (no public URLs). Composer: paste/drag → upload with progress → on success inserts an attachment reference token into the body (`{attachment:ID}`); renderer swaps tokens for inline `<img>` (click = lightbox/full size). A comment's attachments also FK it (`comment_id` set on comment save; orphaned uploads GC'd by scheduler later — note for slice 5). Event `attachment_added` (analytics + audit; body_excerpt shows "📎 image").

**Reactions.** New table `flag_comment_reactions(id, comment_id FK CASCADE, user_id, emoji, created_at)`, unique `(comment_id, user_id, emoji)`. **Curated set v1** (~8: 👍 ✅ 👀 🎉 ❤️ 😂 🤔 🚨) — no emoji-picker dependency; full picker later if asked. Endpoints: `PUT /api/flags/comments/{id}/reactions/{emoji}` (idempotent add), `DELETE` same path (remove own). `CommentResponse` gains `reactions: [{emoji, count, user_ids}]` (or `reacted_by_me` + names for tooltip). UI: hover a comment → reaction bar; existing reactions render as pills with counts, click toggles; tooltip lists who. SSE: reactions emit on the existing bus/event stream (`comment_reaction` event) for live in-thread updates but **no toast, no Slack DM, no unread bump, and NO `flag_events` audit rows** (noise; the reactions table itself carries analytics data: who/what/when). `updated_at` on the flag is NOT bumped by reactions (keeps Unread semantics honest).

## 7. Slice 4 — Comment search

Flyout search box (today: title + Sample-ID, client-side) gains comment-body matching. Client-side won't fly (bodies aren't in list payloads) — so: `GET /api/flags/search?q=` returns matching flag ids + snippet (Postgres `ILIKE` on `flag_comments.body` + `flag_flags.title` with a `pg_trgm` GIN index — tsvector is overkill at lab scale; sqlite test fallback = plain LIKE, no index). The flyout merges server hits into the current tab's client filter (badge "matched in comments" + snippet line on the card). Debounced ≥300 ms, min 3 chars, capped results. This preserves the existing instant client-side filter for title/ID and adds bodies without shipping every comment to the browser.

## 8. Slice 5 — Slack round 2 + scheduler (+ recurring tasks)

**Interactions endpoint (prepped in Phase 1).** `POST /api/slack/interactions` — verify `SLACK_SIGNING_SECRET` (v0 HMAC, 5-min replay window, fail-closed; env unset ⇒ 404/disabled). Payload `block_actions` → map Slack user → Mk1 user via `slack_dm_prefs` reverse lookup (member id) → call `flags.service` as that actor. **v1 buttons on DMs:** *Assign to me* (assignment DMs to others show it; no-op if already assignee), *Mark read*, *Resolve* (only on flags where the actor could resolve in-app — same permission path). Button results update the DM message (chat.update) with a confirmation line. All actions produce normal `flag_events` (analytics + audit parity with in-app). Manifest already pre-enables interactivity (Phase 1); scopes unchanged.

**Scheduler primitive.** In-process asyncio ticker in the existing lifespan (single-uvicorn — same justification as the SSE bus; NO celery/cron). `flags/scheduler.py`: registry of jobs `(name, interval_or_cron_like, fn)`, jitter, per-job lock via a `flag_scheduler_runs` table (name, last_run_at, last_status) so restarts don't double-fire and ops can see health. Jobs run in threadpool (sync DB). This primitive is host-level wiring; job functions live with their features. Jobs registered in this slice: digest, recurring-mint, and the orphaned-attachment GC deferred from slice 3 (deletes uploads never referenced by a saved comment after 24 h).

**Morning digest.** Per-user opt-in (extend `slack_dm_prefs`: `digest_enabled`, `digest_hour_local`, tz assumption = lab-local, single-tz team). Job: at each user's hour, DM one message: assigned-open count (with overdue and blocked breakdowns), unread thread count, oldest overdue title + link. Skip empty digests. Uses existing notifier/client + `_esc()`.

**Recurring tasks.** Table `flag_recurring(id, title, body, type, assignee_id, watchers JSONB, entity_type/entity_id nullable, cadence, next_run_at, active, created_by, created_at, last_minted_flag_id)`. Cadence v1: `daily` / `weekly:<dow>` / `monthly:<dom>` (no full cron syntax). Scheduler job mints flags at `next_run_at` (skips if the previous minted flag is still open — configurable `skip_if_open` bool, default true), advances `next_run_at`, emits normal `raised` events (SSE/DM flow identical to human-raised). Admin UI: a "Recurring" section in the Flags settings pane (list + create/edit/deactivate; admin-only like type management). Minted flags carry `details.recurring_id` in their raised event for analytics lineage.

## 9. Slice 6 — State-change watches

Table `flag_entity_watches(id, entity_type, entity_id, condition JSONB, action JSONB, created_by, watch_flag_id nullable, status[armed|fired|cancelled], created_at, fired_at)`.

- **Condition v1:** `{"field": "state", "equals": "received"}` — evaluated via a **new seam** `seams.state(entity_type, entity_id) -> Optional[str]` (host closure reads e.g. sample `review_state`; each registered entity type opts in; unsupported types can't be watched). Design leaves room for other fields later; only `state equals X` ships.
- **Action v1:** `{"kind": "create_flag", "type": "task", "title": ..., "assignee_id": ...}` or `{"kind": "comment", "flag_id": N, "body": ...}` — the second also bumps the flag per normal comment flow (SSE/DMs/unread ride free).
- **Poller:** scheduler job every ~2 min; loads armed watches, evaluates condition via seam, fires action idempotently (status → fired inside the same transaction; a watch fires ONCE, one-shot v1 — re-arm manually).
- **UI:** in the thread: "Watch an item for a state change…" (pre-filled with the flag's anchor when present) → creates a watch tied to `watch_flag_id`; armed watches render as a chip on the thread ("⏱ waiting: PB-0102 → received", cancellable by its creator or an admin). Also reachable from EntityFlagButton menu for the raw "watch this sample" case (creates a standalone watch whose action = create_flag).
- Events: `watch_armed` / `watch_fired` / `watch_cancelled` on the associated flag (or on the minted flag for standalone watches).

## 10. Analytics readiness (cross-cutting requirement)

The deferred dashboard will need, and Phase 2 therefore captures:

- **Lifecycle timing:** already derivable from `flag_events` transitions; due dates add `due_set/changed/cleared` events; keep `resolved_at` semantics unchanged.
- **Attribution:** every new mutation path (links, due dates, attachments, Slack buttons, recurring mints, watch fires) writes `flag_events` with real `actor_id` (Slack actions attribute the mapped user, recurring/watches attribute the creator with a `details.automated: true` marker).
- **Reactions:** intentionally NOT in `flag_events` — the reactions table itself is the analytics source (rows carry user/emoji/created_at).
- **Volumes:** no aggregation tables now; the dashboard will compute from base tables (fine at lab scale). Revisit only if it's ever slow.

## 11. Security notes

- Slack interactions: signed (HMAC v0), replay-windowed, fail-closed when `SLACK_SIGNING_SECRET` unset; actor mapping only via verified `slack_dm_prefs.member_id`; actions route through the same service-layer permission checks as the UI.
- Attachments: authenticated serving only; magic-byte sniffing; size caps; storage keys unguessable (uuid); no user-controlled paths.
- Markdown: sanitize-by-construction (no raw HTML pass-through), link rel hardening.
- All new endpoints behind `get_current_user`; recurring + type-style admin surfaces behind `require_admin`.
- Trusted-staff assumption + customer-role re-review trigger restated from Phase 1 (§2).

## 12. Testing & verification

Per-slice, matching Phase 1 discipline: TDD backend (pytest in-stack), frontend vitest + typecheck + build; live verification in an isolated devbox stack per slice (accumark-stack platform); visual sign-off by Forrest at the end of the phase (review stack left up). SSE additions ride the existing `/api/flags/stream` — **no new SSE endpoints**, so no new nginx unbuffered-location work; if any slice DOES add one, both nginx configs need the unbuffered locations (Phase 1 incident). New scheduler = watch memory/health via `flag_scheduler_runs`.

## 13. ISO 17025 alignment

Attachments (photo evidence on flags), immutable audit events for all new mutations, attributable Slack-originated actions, and traceable automated actions (`automated: true` markers) all strengthen 7.5.1 attribution and traceable-amendment posture. Reactions are social metadata, deliberately outside the audit record.
