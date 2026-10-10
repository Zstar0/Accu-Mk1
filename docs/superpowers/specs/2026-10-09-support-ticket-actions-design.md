# Support ticket actions (reply and manage Plain tickets from Mk1) - design

Date: 2026-10-09. Status: approved in conversation (brainstorming), awaiting written-spec review.
Builds on: `2026-10-08-customer-support-tab-design.md` (the read-only Support tab, LIVE in 1.38.0).

## 1. Intent

Let the team work a customer's Plain tickets end to end from the customer page in Accu-Mk1: read the conversation, reply to the customer, leave internal notes, and move the ticket along (status, snooze, assignee, priority, labels). Plain stays the system of record; Mk1 is a second front end on the same tickets, so anything done in Mk1 shows in Plain and the other way round.

- **Who:** anyone in Mk1 who also has a Plain seat under the same email (support staff, lab managers who answer tickets, admins).
- **Success:** from a customer's Support tab, a staff member with a Plain seat can reply to a ticket and the customer receives it from that staff member by name; they can add a note, mark done, snooze, reopen, assign, set priority and labels; every action is visible in Plain and recorded in Mk1.

### Rulings (Handler, 2026-10-09)

- Customer page first. A cross-customer support inbox is a later spec.
- **The Plain seat is the permission.** A Mk1 user may act on tickets when their Mk1 login email matches an active Plain workspace user. No separate Mk1 permission, no manual mapping table. Replies go out as that Plain user.
- v1 actions: reply, internal note, mark done, snooze, reopen (Todo), assign / unassign, **priority and labels** (triage included).
- Approach: direct writes through the Mk1 backend (no outbox, no browser-side Plain calls).

### Out of scope

The cross-customer inbox; attachments; canned replies / snippets; AI-drafted replies; "reply and mark done" as one control; webhooks / live push (we refresh on open and after each action); creating new threads; MS Teams and Discord threads; changing the AI review.

## 2. Findings that shape the design

Verified against Plain's published schema (`core-api.uk.plain.com/graphql/v1/schema.graphql`, fetched 2026-10-09) and Plain's docs:

- `replyToThread(input: {threadId, textContent!, markdownContent, impersonation})`. `impersonation.asUser.userIdentifier` takes `userId` or `emailAddress`. Only an API key can impersonate, and the key's **impersonation allow list** must include that user. On email threads Plain sends from the user's public name; on chat it shows the user's name and avatar; on Slack it posts through the user's own Slack connection and fails with `missing_user_auth_slack_integration_for_team` if they have none. Errors: `cannot_reply_to_thread` (not on allow list, role cannot reply, or caller not a machine user), `not_found` (user removed), `input_validation`.
- `createNote(input: {customerId!, threadId, text!, markdown})`. **No impersonation:** Plain shows the note as written by the key's machine user. `customerId` is required.
- `markThreadAsDone`, `markThreadAsTodo`, `snoozeThread(input: {threadId, durationSeconds})`. Any new activity un-snoozes a thread and moves Done back to Todo.
- `assignThread(input: {threadId, userId})`, `unassignThread(input: {threadId})`.
- `changeThreadPriority(input: {threadId, priority: Int})` (0 urgent, 1 high, 2 normal, 3 low).
- `addLabels(input: {threadId, labelTypeIds})`, `removeLabels(input: {labelIds})` (removal is by the label instance id, not the label type id).
- `userByEmail(email)` returns the user or null; deleted users are returned with `isDeleted`. `users(...)` lists workspace members. `labelTypes(filters: {isArchived: false})` lists label types.
- Mutations return `{ ..., error { message type code fields { field message type } } }`; a failed mutation is an `error` object in `data`, not a GraphQL `errors` array.
- **Our client retries once** on network errors, 429 and 5xx (`support_plain/client.py`). Safe for reads; for a reply it can send the same email twice. Writes must never go through that path.
- Today's key (`Mira_APIkey_plain`) is scoped for reads. Writes need a new key.

## 3. Architecture

```
SupportThreadPanel (composer + controls)
   -> POST /support/customers/{key}/threads/{th}/<action>
        -> seat.require_seat(current_user)       Mk1 email -> Plain user (cached 5 min)
        -> service.thread_detail(key, th)         proves the thread belongs to this customer (existing scoping)
        -> actions.<action>(...)                  one Plain mutation via PlainClient.mutate (no retry)
        -> audit.record(...)                      support_actions row, every attempt, ok or not
        -> service.invalidate(key, th)            drop cached list + thread
        -> service.thread_detail(key, th, refresh=True) -> refreshed thread returned
```

New modules in `backend/support_plain/`:

| File | Responsibility |
|---|---|
| `seat.py` | Resolve a Mk1 user's email to an active Plain user; FastAPI dependencies `require_support_reader` (admin or seat) and `require_seat`. |
| `actions.py` | One function per action; builds the mutation variables, calls `mutate`, maps Plain error codes. |
| `audit.py` | `support_actions` table model and `record()`; duplicate-reply guard. |
| `queries.py` (extended) | Mutations in a separate `MUTATIONS` allowlist; `USER_BY_EMAIL`, `USERS`, `LABEL_TYPES` queries. |
| `client.py` (extended) | `PlainClient.mutate()`; reads unchanged. |
| `routes.py` (extended) | The new endpoints; read endpoints switch from `require_admin` to `require_support_reader`. |

### 3.1 Seat resolution

- Key: the Mk1 user's login email, lower-cased. `userByEmail(email)`; a seat exists when the result is non-null and `isDeleted` is false.
- Cached in the existing `TTLCache` for 5 minutes, positive and negative results alike, so a removal in Plain takes effect within 5 minutes and a newly added person can act within 5 minutes.
- Plain unavailable during resolution: readers who are admins still read (admin check needs no Plain call); writes fail closed with 503.
- The seat carries `plain_user_id`, `full_name`, `public_name`, `email`.

### 3.2 Writes: `PlainClient.mutate`

- Accepts only strings in `queries.MUTATIONS` (the read `query()` keeps accepting only `queries.ALL`, which never contains a mutation). `ValueError` otherwise.
- **One attempt, no retry**, for every status code and exception.
- Timeout 20 s (reads keep 10 s).
- Returns `data[<mutationName>]`. A non-null `error` in that payload raises `PlainActionError(code, type, message)`. HTTP 401/403 raises `SupportNotConfigured`. Network errors and timeouts raise `SupportWriteUnconfirmed`; other failures raise `SupportUnavailable`.

### 3.3 Actions

| Action | Plain call(s) | Notes |
|---|---|---|
| reply | `replyToThread` with `textContent` (markdown rendered to text by stripping markup) and `markdownContent`, `impersonation.asUser.userIdentifier.userId = seat.plain_user_id` | Body 1 to 10,000 chars after trim. Duplicate guard (3.5). Timeout confirm (3.6). |
| note | `createNote` with `customerId` (the thread's Plain customer), `threadId`, `text` / `markdown` prefixed `"{full_name}: "` | Prefix because Plain cannot attribute notes; body limits as reply. |
| status | `markThreadAsDone` / `markThreadAsTodo` / `snoozeThread(durationSeconds)` | Snooze `until` must be 5 minutes to 90 days ahead; converted to seconds server-side from the server clock. |
| assign | `assignThread(userId)` or `unassignThread` | `userId` must be an active workspace user from 3.4. |
| priority | `changeThreadPriority` | `urgent|high|normal|low` mapped to 0 to 3. |
| labels | `addLabels(labelTypeIds)` then `removeLabels(labelIds)` | Either list may be empty, not both. Label type ids must be unarchived types from 3.4. Remove takes label instance ids, which the thread response now includes. |

Only reply impersonates; status, assign, priority, labels and notes appear in Plain as done by the Mk1 machine user. The Mk1 audit row records the person (3.5).

### 3.4 Workspace data for the pickers

`GET /support/workspace` returns `{teammates: [{plain_user_id, name, email}], label_types: [{id, name, color}]}` from `users` (non-deleted) and `labelTypes(isArchived: false)`, cached 10 minutes. Requires `require_seat`.

### 3.5 Audit and the duplicate guard

New table `support_actions` (not `lims_`: this is support data, not LIMS data), via the normal migration path:

| Column | Type |
|---|---|
| id | bigint PK |
| at | timestamptz, default now |
| mk1_user_id | int, FK users |
| plain_user_id | text |
| customer_key | text |
| thread_id | text |
| action | text (`reply`, `note`, `status`, `assign`, `priority`, `labels`) |
| args | jsonb (status / until / assignee / priority / label ids; never message text) |
| body_sha256 | text, null for non-text actions |
| body_len | int, null for non-text actions |
| outcome | text (`ok`, `duplicate`, `unconfirmed`, `confirmed_after_timeout`, `error`) |
| error_code | text, null |

- Message bodies are **not** stored: Plain holds the content; a hash and length prove what was sent without a second copy of customer conversations in our database.
- Every attempt writes exactly one row, including refusals and failures.
- **Duplicate guard:** before sending a reply, if a row exists with the same `mk1_user_id`, `thread_id`, `body_sha256` and `outcome` in (`ok`, `confirmed_after_timeout`) within the last 60 seconds, refuse with 409 `duplicate_reply` and record `outcome = duplicate`. Notes use the same guard.

### 3.6 Reply timeout confirmation

When `mutate` raises `SupportWriteUnconfirmed` on a reply, do not retry. Re-read the thread's latest timeline entries (fresh, bypassing cache) and look for an outbound entry by this Plain user, created within the last 3 minutes, whose text starts with the first 200 characters of the sent text (whitespace-normalised).
- Found: record `confirmed_after_timeout`, return 200 with the refreshed thread.
- Not found or the re-read fails: record `unconfirmed`, return 504 `reply_unconfirmed` ("Not confirmed. Check the thread before sending again.").

### 3.7 Cache

After every successful action: drop the customer's list (`l:{key}`) and the thread (`d:{key}:{th}`), then return a fresh `thread_detail(..., refresh=True)` that ignores the refresh cooldown for this call. The thread response gains `labels: [{id, type_id, name}]` (instance ids are needed for removal), `priority`, `assignee_id`, and `customer_plain_id`.

## 4. API

All under `/support`, all JSON. `{key}` is the Mk1 customer key, `{th}` a Plain thread id that must belong to that customer (existing scoping; otherwise 404).

| Method and path | Access | Body | Success |
|---|---|---|---|
| `GET /me` | logged in | | `{has_seat, plain_user_id?, name?, email?}` |
| `GET /workspace` | seat | | 3.4 |
| `GET /customers/{key}` and `/customers/{key}/threads/{th}` | admin **or** seat | (unchanged) | (unchanged, plus 3.7 fields) |
| `POST /customers/{key}/threads/{th}/reply` | seat | `{markdown}` | `{thread}` |
| `POST .../note` | seat | `{markdown}` | `{thread}` |
| `POST .../status` | seat | `{status: "todo"|"done"|"snoozed", until?: ISO-8601}` | `{thread}` |
| `POST .../assign` | seat | `{plain_user_id: string|null}` | `{thread}` |
| `POST .../priority` | seat | `{priority: "urgent"|"high"|"normal"|"low"}` | `{thread}` |
| `POST .../labels` | seat | `{add: [labelTypeId], remove: [labelId]}` | `{thread}` |

## 5. UI

All in the existing `SupportThreadPanel` slide-out on the customer page; the thread list stays as it is and refreshes after an action.

- **`/support/me` once per page** decides the mode. Without a seat: the conversation reads as today, the controls are hidden, and one line says "Replying needs a Plain account under {your email}." Admins without a seat still read.
- **Header controls** (seat holders): status menu (Todo, Snooze: 1 hour / tomorrow 8 am / next Monday 8 am / pick a date, Done), assignee picker (Me, teammates, Unassigned), priority menu, label chips with remove (x) and an add picker. Each applies immediately, shows a spinner on that control, and on failure restores the previous value with an inline error.
- **Composer** pinned to the bottom of the panel with two tabs:
  - **Reply** (default): markdown textarea with a Preview toggle; the button reads "Send as {public name}"; Send asks one confirmation ("Send to {customer email}?") the first time per panel open.
  - **Note**: same textarea, visibly internal (the `.note`-style tinted background used for internal entries), button "Add internal note", no confirmation.
  - Ctrl/Cmd+Enter submits. The button is disabled while sending and while the body is empty.
  - Drafts persist per thread and tab in `localStorage` (try/catch, per-viewer convenience only) and clear on success.
- **Errors in plain words:** not on the key's allow list ("Plain hasn't allowed Mk1 to send as you yet. Ask an admin to add you to the Mk1 key's impersonation allow list."); Slack not connected; duplicate ("Already sent a moment ago."); unconfirmed (3.6); not configured; Plain unavailable. The draft is kept on every failure.
- **Thread status Done or Snoozed** still allows a reply (Plain moves it back to Todo); the composer says so under the button.

## 6. Security

- **Threat:** a Mk1 user sends email to a customer as someone else. Mitigation: impersonation uses only the seat resolved from the caller's own authenticated email; no endpoint accepts an "as user" field.
- **Threat:** acting on a thread of a different customer, or a thread the caller guesses. Mitigation: every write first runs the existing customer scoping (`thread_detail(key, th)`); a mismatch is 404.
- **Threat:** a widened key leaks. Mitigation: the key lives only in prod `backend/.env` (appended with a dated backup, never printed), scoped to exactly the permissions in 7; the impersonation allow list limits who can be impersonated even with the key.
- **Threat:** double-sent customer email. Mitigation: no-retry write path (3.2), duplicate guard (3.5), timeout confirmation (3.6), disabled button in flight.
- **Fail closed:** any seat-resolution failure blocks writes.
- Logs carry thread id, action, outcome and error code; never message text, never the key.

## 7. Rollout

1. **Handler, in Plain:** create a machine user API key "Accu-Mk1" with permissions `customer:read`, `thread:read`, `timeline:read`, `user:read`, `labelType:read`, `thread:reply`, `thread:edit`, `thread:assign`, `label:create`, `label:delete`, `note:create` (exact permission names confirmed in Plain's key screen); add every staff member who should reply to its impersonation allow list; save it with `set-secret` as `PLAIN_API_KEY_RW`.
2. Deploy the release (backend migration adds `support_actions`).
3. Replace `PLAIN_API_KEY` in prod `backend/.env` with the new key (append-with-backup procedure, then restart the backend). The read paths keep working with the wider key.
4. Smoke: `/support/me` for a seat holder; a note on an internal test thread; a reply to a test thread addressed to a team mailbox; snooze then reopen; label add then remove; check each shows in Plain and in `support_actions`.
5. Retire `Mira_APIkey_plain` in Plain once the new key is verified.

## 8. Errors

| Condition | HTTP | Code |
|---|---|---|
| No seat | 403 | `no_plain_seat` |
| Not on allow list / role cannot reply | 403 | `not_allowed_to_reply` |
| Slack thread, user has no Slack connection | 409 | `slack_not_connected` |
| Duplicate reply or note | 409 | `duplicate_reply` |
| Thread not this customer's / not found | 404 | `thread_not_found` |
| Validation (empty body, snooze range, unknown label or user) | 422 | `invalid_input` |
| Reply sent but not confirmed | 504 | `reply_unconfirmed` |
| Key missing or rejected | 503 | `support_not_configured` |
| Plain down / other Plain error | 502 | `support_unavailable` |

## 9. Testing

Backend (`backend/tests/`, transport-mocked Plain, no network):
- seat: match, no match, deleted user, cache expiry, Plain down fails writes closed but admins still read.
- `mutate`: allowlist enforcement, single attempt on 5xx / 429 / network error, error payload to `PlainActionError`.
- each action: exact mutation and variables, error-code mapping per section 8, impersonation present only on reply.
- duplicate guard within and after 60 s; notes too.
- timeout confirm: found, not found, re-read failure.
- audit: one row per attempt, no message text stored.
- scoping: a thread of another customer is 404 for every action.
- route access: admin without seat can read but not write; seat holder without admin can read and write.

Frontend (vitest):
- no-seat mode hides controls and shows the explanation.
- composer: disabled when empty and in flight, confirmation once, draft restore, error keeps draft.
- each control: optimistic spinner, rollback on failure.

## 10. Deferred, named

Support inbox across customers; attachments; canned replies; AI-drafted replies; webhooks for live updates; per-person Plain email mapping for mismatched emails.
