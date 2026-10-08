# Customer Support tab (Plain) - design

Date: 2026-10-08. Status: approved in conversation (brainstorming), awaiting written-spec review.

## 1. Intent

Bring a customer's Plain support history into Accu-Mk1, next to the CRM tab, so the customer page becomes one place to understand everything about a customer.

- **Who:** the same audience as the CRM tab: a lab manager before a call, Scott on his accounts, Forrest, Lauren (CS).
- **What they need:** the customer's support tickets with status, labels, assignee and recency, and the full conversation of any ticket, including the team's internal notes.
- **Success:** from a customer's page, an admin sees every Plain ticket for that customer, knows at a glance whether the customer is waiting on us, can read any conversation in full, and can pull fresh data on demand.

### Rulings (Handler, 2026-10-08)

- Support tab first; the AI customer review is the next spec and consumes this tab's data.
- Internal notes and internal discussions are included in the conversation, marked "Internal".
- Approach A: mirror the CRM tab's pattern (live read through the Mk1 backend, nothing persisted), reusing `crm_close`'s cache class and email lookup by import, not by copy.
- Admin-only, like the CRM tab.
- Use the vault key `Mira_APIkey_plain` (verified 2026-10-08: reads customers, threads and timelines).

### Out of scope

Replying to customers or changing tickets from Mk1; the AI customer review (next spec); a labmanager-mcp read tool; opening the tab to non-admin roles; refactoring `crm_close` into a shared framework.

## 2. Findings that shape the design

From a read-only probe of Plain's GraphQL API on 2026-10-08 (shapes and counts only):

- Plain finds a customer by email (`customerByEmail`); a Plain customer has exactly one email. Kyle Robertson (wc:1551) has 4 threads: 3 `DONE`, 1 `SNOOZED`, all channel `EMAIL`, labelled Engineering / Shipping/Tracking Info / Lab.
- `threads(filters: {customerIds: [...]})` lists a customer's threads; the filter also supports `statuses` and `isMarkedAsSpam`.
- A thread's `timelineEntries` mixes conversation and events. In Kyle's latest thread: 3 `EmailEntry` (customer and user), `ThreadDiscussionMessageEntry` / `ThreadDiscussionEntry` / `ThreadDiscussionResolvedEntry` (internal team discussions), `ThreadStatusTransitionedEntry`, `ThreadLabelsChangedEntry`, `ThreadAssignmentTransitionedEntry`.
- `EmailEntry` carries `textContent` plus `hasMoreTextContent` / `fullTextContent` for long emails.
- `TimelineEntryConnection` has `pageInfo` but no `totalCount`.
- The key can write internal notes, AI drafts and thread links. Read-only is enforced in our client.

## 3. Architecture

New backend package `backend/support_plain/`, laid out like `backend/crm_close/`. No database tables, no migration, no IS or WordPress change.

| Unit | Purpose |
|---|---|
| `queries.py` | The fixed GraphQL query strings, in full. No mutation text anywhere in the package. |
| `client.py` | Thin Plain client. POSTs only the queries from `queries.py` to `https://core-api.uk.plain.com/graphql/v1` with `Authorization: Bearer $PLAIN_API_KEY`. 10 s timeout; one retry on 429 (honouring `Retry-After`, capped at 5 s) and on 5xx. GraphQL `errors` in a 200 response count as a failure. Raises `SupportNotConfigured` when the key is unset, `SupportUnavailable` on failure after retry. One pooled client per key (as `crm_close.client.get_client`). |
| `match.py` | `customer_ids(emails, client)`: `customerByEmail` for each email from `crm_close.match.customer_emails`, skipping unsafe emails, de-duplicating by id. |
| `threads.py` | Pure normalization, no I/O: thread list items, conversation entries, "waiting on us", Plain links. |
| `service.py` | Orchestration with a `crm_close.cache.TTLCache` instance of its own; refresh cooldown; stale fallback; detail scoping. Test seams as in `crm_close.service`. |
| `routes.py` | Two admin-only routes (section 4). |

### 3.1 Resolving a customer

`crm_close.match.customer_emails(customer_key)` gives the customer's emails (account plus billing for `wc:` keys; validated, known address for `email:` keys; `None` for an unknown customer, which becomes a 404). Each email goes to `customerByEmail`; the found Plain customer ids are de-duplicated. No ids means an empty tab, not an error.

### 3.2 Plain calls

1. `customerByEmail(email)` per email -> `{id, fullName}`.
2. `threads(first: 50, after, filters: {customerIds, isMarkedAsSpam: false})` -> thread fields used by section 3.3, paged with `pageInfo` up to a cap of 500 threads.
3. `thread(threadId)` with `timelineEntries(first: 100, after)` paged to the end (cap 1000 entries) for the conversation.
4. `EmailEntry` with `hasMoreTextContent: true` uses `fullTextContent`.
5. The workspace id for "Open in Plain" links comes from `myWorkspace { id }`, cached for the process lifetime.

Test threads (`isTestThread: true`) are dropped in `threads.py`.

### 3.3 Thread list item

```json
{
  "id": "th_...",
  "ref": "T-482",
  "title": "...",
  "status": "open" | "snoozed" | "done",
  "priority": "urgent" | "high" | "normal" | "low",
  "labels": ["Lab", "Engineering"],
  "assignee": "<name>" | null,
  "created_at": "<iso>",
  "updated_at": "<iso>",
  "preview": "<first ~160 chars of previewText>",
  "waiting_since": "<iso>" | null,
  "plain_url": "https://app.plain.com/workspace/<ws>/thread/<id>"
}
```

- Status maps Plain `TODO` -> `open`, `SNOOZED` -> `snoozed`, `DONE` -> `done`.
- Priority maps Plain's 0..3 to urgent/high/normal/low.
- `waiting_since` is `lastInboundMessageInfo.timestamp` when the thread is not done and there is no outbound message after it; otherwise null.
- Sorted by `updated_at` newest first.

### 3.4 Conversation entry

```json
{
  "id": "<timeline entry id>",
  "at": "<iso>",
  "kind": "email" | "chat" | "slack" | "note" | "discussion" | "event",
  "author": "<name>" | null,
  "author_kind": "customer" | "agent" | "system",
  "internal": true | false,
  "subject": "<email subject>" | null,
  "text": "<plain text body or one-line event>"
}
```

| Plain entry | kind | internal |
|---|---|---|
| `EmailEntry` | email | false |
| `ChatEntry` | chat | false |
| `SlackMessageEntry`, `SlackReplyEntry`, `MSTeamsMessageEntry`, `DiscordMessageEntry` | slack | false |
| `NoteEntry` | note | true |
| `ThreadDiscussionMessageEntry` | discussion | true |
| `ThreadStatusTransitionedEntry`, `ThreadLabelsChangedEntry`, `ThreadAssignmentTransitionedEntry`, `ThreadPriorityChangedEntry` | event | false |
| anything else | dropped; type name logged once at INFO | - |

- `author_kind` comes from the actor: `CustomerActor` -> customer; `UserActor` / `MachineUserActor` -> agent; `SystemActor` -> system.
- Bodies are plain text. Markdown and HTML are never rendered.
- Event text is one line built from the entry, e.g. "Marked done by Lauren", "Labels: Lab, Engineering", "Assigned to Scott".
- Entries are ordered oldest first.
- This plain-text entry list is the input contract for the AI customer review.

### 3.5 Caching and refresh

Same rules as the CRM tab (spec 2026-10-07, 3.4), with its own cache:

- Customer-to-Plain-ids match: 1 hour. Thread list: 5 minutes. Conversation: 5 minutes per thread. Workspace id: process lifetime.
- `refresh=true` re-loads and replaces the cached copy only on success; at most once per 10 s per customer (`refresh_throttled: true` otherwise).
- When Plain fails and a cached copy exists, it is served with `stale: true` and `fetched_at`.

## 4. API

Both routes use `Depends(require_admin)`. Every response key is declared on its pydantic `response_model`.

### `GET /support/customers/{customer_key}`

Query: `status` (comma list of open/snoozed/done, default all), `refresh` (bool), `page` (default 1), `page_size` (default 50, max 200).

```json
{
  "customer_key": "wc:1551",
  "matched": 1,
  "threads": [<thread list item>],
  "total": 4,
  "page": 1,
  "page_size": 50,
  "counts": {"open": 0, "snoozed": 1, "done": 3, "waiting": 0},
  "last_contact_at": "<iso>" | null,
  "fetched_at": "<iso>",
  "stale": false,
  "refresh_throttled": false
}
```

`counts` covers all of the customer's threads, ignoring the `status` filter. `last_contact_at` is the newest `updated_at`.

### `GET /support/customers/{customer_key}/threads/{thread_id}`

Query: `refresh` (bool). `thread_id` must match `^th_[A-Za-z0-9]+$` (422 otherwise). Returns 404 unless the thread's customer id is one of this customer's matched Plain ids.

```json
{
  "thread": <thread list item>,
  "entries": [<conversation entry>],
  "fetched_at": "<iso>",
  "stale": false
}
```

## 5. UI

- **Tab:** "Support" after "CRM" on the customer detail page, rendered for admins only (`isAdmin()`), with the same non-admin fallback to `orders`. The guest customer view gets a Support section for admins.
- **Summary line:** "N tickets · N open · N waiting on us · last contact <date>". A red "Waiting on us" badge with the age of the oldest `waiting_since` when any thread is waiting.
- **Controls:** status chips All (default) / Open / Snoozed / Done; Refresh button with the CRM tab's one-shot behaviour.
- **List:** newest activity first. Row: ref · title · status badge · priority (urgent/high only) · label chips; second line: assignee · relative updated time · preview. "Load more" pages.
- **Side panel (Sheet):** header with ref, title, status, labels, "Open in Plain" link. Conversation oldest first: customer and agent messages as plain cards with the author's name; internal notes and discussions on an amber-tinted card with an "Internal" tag; events as small grey one-liners. Bodies `whitespace-pre-wrap`, never HTML.
- **States:** "No support tickets for this customer"; "Support not configured" (503); "Plain is unavailable, showing data from <age> ago" (stale); "Plain unavailable" (502 with nothing cached).

## 6. Security

- Admin-only routes and tab. Internal notes are visible to every admin; revisit before any non-admin rollout.
- Read-only by construction: the client only sends query strings from `queries.py`; a test asserts no `mutation` text exists in the package.
- `PLAIN_API_KEY` lives only in the prod `backend/.env`, loaded from the vault, never printed or logged. Request logging must not include the Authorization header or customer emails.
- Bodies render as plain text, so customer HTML and markdown cannot inject script or load tracking pixels.
- Thread detail is scoped to the requesting customer's matched Plain ids, so one customer's key cannot open another customer's thread.
- "Open in Plain" links are built by us from ids, never taken from Plain response URLs.

## 7. Errors

| Condition | Response |
|---|---|
| `PLAIN_API_KEY` unset | 503 `support_not_configured` |
| Plain fails after retry, nothing cached | 502 `support_unavailable` |
| Plain fails, cached copy exists | 200 with `stale: true` |
| Unknown customer key | 404 |
| Thread not found or not this customer's | 404 |
| Malformed `thread_id` | 422 |
| Integration Service DB error during email lookup | 502 `support_unavailable` |

## 8. Testing

- **Backend unit (no network):** `threads.py` (each kept entry type, dropped types, internal flag, full email text, event one-liners, `waiting_since` cases, status and priority maps, ordering, test-thread drop), `match.py` (several emails, one Plain customer found twice, unsafe email skipped, unknown customer), `client.py` (only known queries sent, GraphQL `errors` treated as failure, retry on 429/5xx, not configured), and the no-`mutation` guard. Fixtures are recorded Plain responses with names, emails and text replaced.
- **Routes:** list and detail 200; foreign thread 404; malformed id 422; non-admin 403 on both routes; refresh cooldown; failed refresh keeps the cached copy; stale fallback; 503 and 502.
- **Frontend (vitest + Testing Library):** list rendering, status chips, waiting badge, side panel with Internal styling and event one-liners, empty and error states, admin-only tab.
- **Gates:** backend failure set identical to master's; `npm run check:all` scope as for the CRM tab (tsc, eslint, vitest); a read-only live smoke of the real routes against Plain for a few real customers, printing shapes and counts only.

## 9. Rollout

1. Merge, cut a Mk1 release.
2. Before the deploy, append `PLAIN_API_KEY` (value of vault `Mira_APIkey_plain`) to prod `/root/accu-mk1/backend/.env` via ssh stdin, never printed, with a dated backup.
3. Deploy after lab hours; health check; in-container read-only smoke for a known customer.
4. Admin click-through of the Support tab in prod.

Rollback: redeploy the previous version; the tab disappears and nothing else depends on it.
