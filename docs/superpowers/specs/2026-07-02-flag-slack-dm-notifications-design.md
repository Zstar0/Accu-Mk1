# Flag System — Slack DM notifications

*Design approved 2026-07-02 (approach A: in-process bus subscriber). Extends the
flag system merged in PR #28.*

## Context / problem

Flag toasts only reach users who are in the app. Staff want the same pings as
Slack DMs — assigned to you, activity on flags you raised or watch, @mentions —
with a per-user page to configure which categories they receive.

Slack constraint: incoming webhooks cannot DM users. DMs require a Slack app
with a bot user. Push-only DMs need no public URL, no OAuth flow, no event
subscriptions — just a bot token and three scopes.

## One-time Slack app setup (manual, Handler)

Create an app in the lab workspace (api.slack.com/apps) with bot scopes
`chat:write`, `im:write`, `users:read.email`; install to workspace; copy the
`xoxb-` bot token into the Mk1 backend env as **`MK1_SLACK_BOT_TOKEN`**
(prod `backend/.env`; never in the repo, never logged). Unset token = the whole
feature is dormant (same env-gate pattern as `MK1_PHOTO_S3_BUCKET`).

## Architecture (approach A)

New **host-side** module `backend/slack_notify/` — the flags module stays
plugin-pure and never learns what Slack is. The notifier subscribes to the
existing in-process flag event bus (`flags/bus.py`, post-commit — the same feed
SSE uses). Per event it:

1. Computes the recipient set server-side: flag assignee + creator +
   mentioned user ids (from `commented` event `details.mentions`) + watchers
   (participants), **minus the actor**.
2. Filters each recipient through their stored prefs (master toggle + the
   category matching the event).
3. Resolves each recipient's Slack member id (see Mapping) and fires a
   `chat.postMessage` DM via `httpx` (no Slack SDK dependency — 3 endpoints).

Delivery is **fire-and-forget**: an asyncio task per event with one retry
(short backoff); failures are logged and dropped. A Slack outage can never
block or slow a flag operation. Lab-scale volume is far below Slack rate
limits; no queueing in v1 (durable outbox is the explicit later upgrade if
missed-DMs-during-restart ever matters).

**Toast-parity semantics:** never DM the actor about their own action; collapse
the `raised`+`assigned` pair into a single "Assigned to you" DM (mirror of the
frontend glue's `supersededByAssign`).

## Categories and prefs

Server-side table **`slack_dm_prefs`** (host table; created via `create_all` +
idempotent migration, Mk1 pattern):

| column | type | default |
|---|---|---|
| `user_id` | int, unique FK users | — |
| `enabled` | bool | true |
| `slack_member_id` | text, nullable | null (unresolved) |
| `notify_assigned` | bool | true |
| `notify_mentioned` | bool | true |
| `notify_raised_activity` | bool | true (comments/status on flags you created) |
| `notify_watching_activity` | bool | true (activity on flags you watch — **broader than toasts**, which deliberately exclude watchers; per-user opt-out resolves the noise objection) |
| `notify_status_changes` | bool | true (resolved/blocked/reopened on relevant flags) |
| `created_at` / `updated_at` | timestamp | now |

Rows are lazy — absent row = all defaults. Event→category mapping: `assigned`→
assigned; `commented` with you in `details.mentions`→mentioned; `commented`/
`status_changed` on your created flags→raised_activity; same on watched flags→
watching_activity; `status_changed` where you're assignee/creator/watcher→
status_changes. First matching category in that order wins (one DM per event
per user).

## Mapping Mk1 user → Slack user

Emails are mixed (`@accumarklabs.com` / `@valenceanalytical.com` aliases), so:

1. **Happy path:** on first DM attempt with `slack_member_id` null, call
   `users.lookupByEmail` with the Mk1 login email; on hit, cache the member id
   into the prefs row.
2. **Fallback:** lookup miss → mark the row unresolved; the preferences UI
   shows "Not linked" with a field to paste your Slack member ID
   (Slack profile → Copy member ID) and a **"Send test DM"** button.

No domain-swap heuristics — explicit link only.

## API

- `GET /api/slack-prefs` — own row (or defaults), + `linked` status.
- `PUT /api/slack-prefs` — own row only (master toggle, category toggles,
  `slack_member_id` override). Self-scoped; no admin editing of others in v1.
- `POST /api/slack-prefs/test` — sends "Test from Accu-Mk1" to the caller's
  resolved DM; returns ok/error detail (surfaced inline in the UI).

All behind `get_current_user`; `user_id` always derived from the JWT.

## Frontend

The **Account → Profile page** gains a "Slack notifications" card
(`src/components/auth/SlackPrefsSection.tsx`): master toggle, link status
showing WHO the mapping resolved to ("Linked → {Slack display name}", cached
`slack_display_name` via `users.info` at every link path), member-id field +
test button, five category toggles. Server-stored (the backend is the
consumer) — not localStorage. **Placement rationale (2026-07-02):** these are
per-user prefs, not admin settings — the settings dialog will eventually be
admin-only, and every user must keep reaching their own Slack config.

**Deep link (new):** DM tap-through needs a URL that opens a flag's thread.
Add a `flag` query param to the existing `#section/subsection?…` hash scheme:
`applyNavToStore` in `src/lib/hash-navigation.ts` reads `?flag=<id>` on
load/back-forward and calls `openFlagThread(id)`.

Links are **entity-aware** — one URL lands on the flagged entity's page AND
opens the thread. The notifier resolves the entity via `seams.resolve_context`
and `link_hash_for(deep_link, flag_id)` maps it:

| deep_link kind | URL |
|---|---|
| `sample` | `{MK1_PUBLIC_URL}/#senaite/sample-details?id=<sid>&flag=<id>` (vials resolve to their parent sample) |
| `worksheet` | `{MK1_PUBLIC_URL}/#hplc-analysis/worksheet-detail?id=<wid>&flag=<id>` |
| `none` / unresolvable | `{MK1_PUBLIC_URL}/#dashboard/orders?flag=<id>` (thread still opens) |

## Message format

Compact Block Kit card: action line ("**Nick** assigned you a flag" /
"mentioned you" / "commented on a flag you're watching"), flag title, context
line `Entity · Type · Status`, and the deep link. Comment events include a
one-line comment excerpt (truncated ~140 chars).

## Failure modes

- Token unset → subscriber never registers (dormant, zero overhead).
- Unresolvable recipient → skip silently (UI shows "Not linked").
- Slack 4xx/5xx/429 → one retry, then log + drop. Never raises into flag ops.
- DM even if the user is online in Mk1 (duplicate with toast) — presence-aware
  suppression is explicitly out of scope for v1.

## Security

Bot token server-side env only, never logged, never in responses. Prefs
endpoints strictly self-scoped. Slack member ids are not secrets. No inbound
Slack surface exists (push-only), so no request-signing concerns. The flag
system's existing trusted-staff assumption is unchanged; DMs carry the same
data any authenticated staff user can already see.

## ISO 17025 alignment

Notifications are a convenience channel; the authoritative record remains
`flag_events` (attribution 7.5.1). No new records of decision; no traceability
impact. DM delivery is not audited in v1.

## Testing

- Unit: recipient computation per event type (assignee/creator/mentions/
  watchers/actor-exclusion, raised+assigned collapse), category mapping order,
  prefs filtering (defaults + explicit rows), payload building — all against a
  fake `httpx` transport; no live Slack in tests.
- Prefs API: self-scoping, lazy-row defaults, member-id override, test-DM error
  surfacing (fake transport).
- FE: pane section renders/saves; hash-route `#flags?open=<id>` opens the
  thread.
- Live acceptance: real token in a dev stack, link one user, raise/assign/
  mention → 3 DMs with working deep links.

## Phase 2 — interactive actions (PREPPED, not built)

Decision 2026-07-02: prepare for in-DM actions ("Resolve", "Assign to me",
"Open"). Prep shipped in v1 so the Slack app never needs recreating:

- The manifest pre-enables `interactivity` with
  `request_url: https://accumk1.valenceanalytical.com/api/slack/interactions`.
  With no interactive components in v1 messages, Slack sends nothing; the URL
  404s harmlessly until Phase 2.
- Phase 2 adds: `POST /api/slack/interactions` on Mk1 with **mandatory
  request-signature verification** (new `SLACK_SIGNING_SECRET` env,
  `X-Slack-Signature` v0 HMAC over `v0:{timestamp}:{body}`, reject stale
  timestamps ±5 min — this becomes Mk1's first inbound Slack surface, so it
  must fail closed); `block_actions` payload handling mapped onto the existing
  `flags.service` actions (actor = the Slack user reverse-mapped via
  `slack_dm_prefs.slack_member_id`, unmapped → ephemeral error); action
  buttons appended to the DM blocks.
- Phase-2 security review trigger: the signing secret joins the token in the
  env; the endpoint must never mutate state on unverified requests.

## Out of scope (v1)

Presence-aware suppression, digests/batching, channel posts, per-flag mute,
admin management of other users' prefs, durable outbox delivery. (Interactive
actions moved to Phase 2 above — prepped, not built.)
