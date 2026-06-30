# Flag System — Design Spec

**Date:** 2026-06-27
**Status:** Design — agreed in brainstorm; pending user review before planning.
**Reference mockups:** `assets/2026-06-27-flag-system/` (`toolbar-badge.html`, `flyout-form.html`, `toast-animation.html`, `flag-thread.html`, **`flag-thread-dark.html`** ← approved look).

---

## 1. Problem & Goals

Cross-team coordination on lab work currently happens in Slack and breaks down: messages scroll away, get missed, and aren't tied to the specific sample/vial/COA they're about. "This sample is waiting on someone," "this needs a re-run," "this is ready for verification" — all get lost.

**Goal:** a durable, anchored, owned, conversational, discoverable coordination tool that lives *inside* Accu-Mk1 — effectively a **lightweight, work-product-anchored task/thread system** (the anti-Slack). The user-facing verb is "flag"; the underlying object is a small **task/thread** that someone owns and eventually closes.

A solution must have five properties Slack lacks:
- **Durable & triageable** — persists until closed; doesn't scroll away.
- **Anchored** — attached to the specific work-product, so context travels with it.
- **Owned** — an assignee and a clear status.
- **Conversational** — threaded comments on the task itself.
- **Discoverable** — a global flyout that is a personal triage inbox.

**Non-goals (now):** a full project-management tool (boards, sub-tasks, sprints), customer-facing chat, and user-group permissions. The first two are explicitly out of scope; group permissions are *designed for* but not built (see §8).

---

## 2. Core Concept

A **flag** is a mini-ticket anchored to any work-product entity. It carries:
- a **kind** (issue vs signal) and a **type** (the colored triage label),
- a **status** (lifecycle),
- an **assignee** and **watchers**,
- **threaded comments**,
- an append-only **audit trail**.

It can be raised from any registered entity, assigned, discussed, and resolved/closed.

**Guardrails:** lean task system, not Jira (raise → assign → discuss → close). Built native (not ClickUp — a generalist with a staff learning tax that can't live inside the vial page), but designed as an **extractable module** so its bones are reusable in other projects.

---

## 3. Architecture — Extractable Plug-in Module

The flag system is a **self-contained module** (backend package + frontend components) with its own storage, service, API, and UI. **The core never knows what a "vial" is.** It talks to the host application (Accu-Mk1 today) through three thin adapters:

1. **Entity registry** — the host registers each entity type it wants flaggable (`vial`, `sample`, `worksheet`, `coa`, …). Each registration provides:
   - a **label renderer** (id → display string),
   - a **deep-link builder** (id → URL within the host app),
   - a **permission check** (see §5).
   The module persists only an opaque `(entity_type, entity_id)` pair — **no foreign keys into host domain tables**. This is the seam that lets the same module drop into another project: that project registers its own entity types.

2. **User / identity provider** — the module depends on a minimal user interface (`id`, `display name`, `avatar`) supplied by the host. It never hard-codes Mk1's user table.

3. **Event sink** — the module emits domain events (`flag.created`, `flag.assigned`, `flag.status_changed`, `comment.added`, …). The host decides what to do with them: toast/native notifications, the real-time stream (§6), and — later — email or a customer-chat bridge. **The module never sends a notification itself.**

**Boundary rules:**
- Module owns its own schema; **no FKs to host domain tables**.
- Tables use a neutral **`flags_` prefix** (NOT `lims_` — `lims_` signals lab-domain coupling this module avoids).
- It is an **extractable module, not a published framework** — we build no plugin-loader / config-DSL reuse machinery until a second consumer actually exists.

---

## 4. Data Model

All tables live in the Mk1 Postgres database (`accumark_mk1`). Append-only audit; soft lifecycle via `status`.

```
flags_flag
  id              bigserial pk
  entity_type     text         -- opaque; resolved via host entity registry
  entity_id       text         -- opaque host id (string to span int/uuid/hex)
  kind            text         -- 'issue' | 'signal'  (derived from type def, denormalized)
  type            text         -- 'blocker' | 'critical' | 'question'
                               --   | 'waiting_on_customer' | 'ready_for_verification' (extensible)
  status          text         -- 'open' | 'in_progress' | 'resolved' | 'closed'
  title           text
  created_by      text         -- host user id
  assignee_id     text null    -- host user id (denormalized for fast "assigned to me")
  created_at      timestamptz
  updated_at      timestamptz
  resolved_at     timestamptz null
  resolved_by     text null

flags_comment
  id              bigserial pk
  flag_id         bigint fk -> flags_flag
  author_id       text
  body            text
  audience        text default 'internal'  -- future: 'customer' (see §8)
  created_at      timestamptz
  edited_at       timestamptz null

flags_participant
  id              bigserial pk
  flag_id         bigint fk -> flags_flag
  user_id         text
  role            text         -- 'watcher'  (assignee is denormalized on flags_flag)
  added_at        timestamptz
  added_by        text
  unique (flag_id, user_id)

flags_event            -- append-only audit
  id              bigserial pk
  flag_id         bigint fk -> flags_flag
  actor_id        text
  event_type      text  -- 'raised'|'assigned'|'unassigned'|'type_changed'
                        --  |'status_changed'|'commented'|'watcher_added'
                        --  |'watcher_removed'|'resolved'|'reopened'|'closed'
  from_value      text null
  to_value        text null
  metadata        jsonb null
  created_at      timestamptz
```

**Type definitions** are a small data-driven registry (a `flags_type` lookup table *or* a config map — start with a config map, promote to a table only if the lab needs to self-manage types). Each type carries: `kind` (issue/signal), display label, color, `is_blocking` (bool), and `auto_resolve_on` (optional entity event — e.g. `ready_for_verification` auto-resolves when the entity is verified). `kind` on `flags_flag` is denormalized from the type definition for fast filtering.

**Type → kind mapping (initial):**

| type | kind | color |
|---|---|---|
| blocker | issue | red |
| critical | issue | orange |
| question | issue | blue |
| waiting_on_customer | issue | purple |
| ready_for_verification | signal | green |

**Key indexes** (flyout queries): `(assignee_id, status)`, `(entity_type, entity_id)`, `flags_participant(user_id)`, `(status, updated_at)`.

---

## 5. Lifecycle & Permissions

**Status lifecycle:** `Open → In Progress → Resolved → Closed`, with `Closed → Open` (reopen) allowed. **Signals** (e.g. `ready_for_verification`) may **auto-resolve** when the underlying entity reaches the corresponding state (driven by a host event into the module), via the type's `auto_resolve_on`.

**Type and Status are independent fields:** Type is the triage label (what it is); Status is where it is in its life. We deliberately do *not* add a separate "Waiting" status — `waiting_on_customer` as a Type already conveys the blocked-on-external state, keeping the lifecycle lean.

**Permissions are resolved by the host, never hard-coded in the module.** The module calls `host.can(user, action, flag)` for actions: `create`, `comment`, `assign`, `change_type`, `change_status`, `resolve`, `close`, `reopen`, `watch`.

- **v1 host implementation (role-based):** any staff user can `create / comment / watch / assign`; the **assignee or a lab-manager role** can `resolve / close / reopen`.
- **Future (user groups):** the host's resolver starts consulting user groups — **the module does not change** (see §8).
- **Internal-only** is enforced at this layer; flags are never customer-visible.

Every state-changing action writes a `flags_event` row (attribution + timestamp) — this is the audit trail.

---

## 6. Real-time (SSE)

Live updates ride the **event-sink seam** — they are simply a second consumer of the events the module already emits. One flag event has two possible destinations:
- recipient is **not viewing** it → toast / native notification (existing Sonner + Tauri framework, `docs/developer/notifications.md`), including the fly-to-home animation;
- recipient **is viewing** it (flyout or thread open) → the open view updates **in place**, no refresh; badge counts re-tally live.

**Transport: Server-Sent Events (SSE) for v1.** Server→client push over plain HTTP, FastAPI-native (Mk1 is FastAPI), proxy-friendly, auto-reconnecting. Clients still POST comments/changes via normal REST; SSE only carries "here's what changed" back down. Target latency: sub-second to ~1–2s ("fairly real-time").

- The SSE stream is **per-user and authenticated**, scoped to events on flags the user can see (assigned / watching / participates-in, plus optionally all-open for triage views).
- **WebSocket is reserved** for a future presence/typing-indicator feature (§8) — not needed for comments.

---

## 7. UI / UX

(See mockups in `assets/2026-06-27-flag-system/`.)

- **Entry point — Flags button** beside the Worksheets button, top-right: **segmented color-coded count chips** (e.g. 2 blockers · 1 critical · 4 ready) that **glow/pulse when something new arrives** (glow tied to *new*, not always-on).
- **Flyout — full-height right slide-over** (mirrors the worksheet flyout). Tabs: **Assigned to me · Raised by me · Watching · All open**. Flag cards show: entity chip (vial/sample/worksheet/COA + icon), colored type pill, title, assignee avatar (YOU = assigned to you), comment count, time, blue unread dot.
- **Flag thread view:** entity context (deep-link) + type pill + resolve action; status / assignee / watchers controls; a **timeline** that interleaves grey **system/audit lines** (raised, assigned, status→) with **threaded comments**; a composer with `@mention`. New comments **animate in** (slide + fade).
- **Toast — fly-to-home animation:** toast springs up, **dwells ~1.75s** (tunable), then flies into the Flags button, which bumps, glows, and increments the relevant chip. Includes an **Undo** grace window before the flag commits.
- **Raising a flag:** a "Flag" action on any registered entity's page/row opens a small compose (type, title, optional assignee, first comment).
- **Theme:** follows the app's light/dark theme; **dark mode is validated** (`flag-thread-dark.html`).

---

## 8. Future / Out-of-Scope (don't build, don't preclude)

These are explicitly **not** in scope now. The architecture leaves each one additive:
- **User-group permissions** — the host permission resolver evolves from roles → groups; the module is untouched.
- **Customer-facing comments / customer chat** — `flags_comment.audience` already exists (v1: always `internal`). Later, a user could mark a comment `customer`; the event sink routes it to a customer-chat surface, likely **bridged via lab remarks**. Build neither now.
- **WebSocket presence / typing indicators** — upgrade from SSE when wanted.
- **Email / digest delivery** — another event-sink consumer.
- **Cross-system entities (COAs)** — COAs live in the integration-service DB; flagged via opaque id + a host entity-registry resolver that links across systems. Phase 2.
- **Reference/config entities** (peptides, calibration curves, analysis services, instruments) — later phase.

---

## 9. Phasing

The full generic model is designed up front; the **first build is a vertical slice**.

- **Phase 1 (slice):** the module (tables, service, REST API), the three host seams, entity registry for **samples / vials / worksheets**, raise/assign/comment/type/status/resolve, the slide-over flyout + Flags button, the flag thread view, **SSE live updates**, the toast animation, and the audit log. Internal-only, role-based permissions.
- **Phase 2:** sample preps, COAs (cross-system), additional entity types; promote type definitions to a managed table if needed.
- **Phase 3+:** user-group permissions, the customer-comment seam, WebSocket presence, email/digest.

---

## 10. ISO 17025 Alignment

- **Attribution (7.5.1):** every flag, comment, and transition records actor + timestamp in `flags_event`.
- **Traceable amendments (7.5.2 / 8.4):** the audit log is append-only; resolve/reopen/close are tracked, not overwritten.
- **Scope note:** flags are an internal coordination record, not customer-facing data; they don't alter results or COAs.

---

## 11. Testing Approach

- **Portability proof:** module unit tests run against *fake* host adapters (entity registry, user provider, event sink) — verifies the core has no host coupling.
- **Permissions:** table-driven tests of `host.can(...)` for each action × role.
- **Lifecycle:** transition tests (legal/illegal transitions; auto-resolve on entity event).
- **Audit:** every state-changing action emits exactly one correct `flags_event`.
- **Real-time:** event fan-out tests — an action produces the right SSE events scoped to the right users.
- Frontend: flyout filter/tab logic, optimistic comment send + reconcile with SSE, toast animation smoke.
