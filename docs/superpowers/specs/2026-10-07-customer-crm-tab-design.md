# Customer CRM tab (Close) - design

Date: 2026-10-07. Status: approved in conversation (brainstorming), awaiting written-spec review.

## 1. Intent

Bring a customer's Close CRM history into Accu-Mk1 so the people who deal with that customer can see it without leaving the app.

- **Who:** a lab manager checking on a customer before calling them; Scott reviewing his accounts; Forrest checking how an account has been handled; Lauren (CS).
- **What they need:** the communication log (emails, calls, SMS, meetings) and the account notes, newest first, with drill-down into any item.
- **Success:** from a customer's page, an admin sees every real interaction Close holds for that customer in one timeline, can open any item in full, and can pull fresh data on demand.

### Rulings (Handler, 2026-10-07)

- CRM (Close) first. Support (Plain) is a separate later phase.
- Feeds first. An AI summary is phase 2.
- Admin-only for now (`require_admin` / `isAdmin()`).
- Approach A: live read through the Mk1 backend, no mirror.
- Use Forrest's Close API key (stored in the `Accumark` vault as `CLOSE_API_KEY`; verified 2026-10-07: authenticates as Forrest Parker, org Accumark Labs, `email_address:` lead lookup works).
- A Refresh control bypasses the cache.

### Out of scope

Support/Plain tab, AI summaries, a labmanager-mcp tool, any write to Close, CRM-wide reporting.

## 2. Findings that shape the design

- Close is in active use: 891 activities since 2026-09-01, mostly by one non-Forrest user.
- Activity mixes real work (notes, meetings, customer email threads) with noise: WooCommerce "[Accumark Labs]: You've got a new order: #N" admin notifications synced from a mailbox. Example: Kyle Robertson's 81 activities are almost all of that kind.
- Many notes are only a Plain thread link (`https://app.plain.com/workspace/.../thread/th_...`).
- A customer can map to more than one lead (Kyle runs two brands).
- Close API keys carry the full permissions of their user; there is no read-only key. Read-only is enforced in our client.

## 3. Architecture

New backend package `backend/crm_close/`, mirroring the `customer_insights/` layout. No database tables, no migration, no IS or WordPress change.

| Unit | Purpose |
|---|---|
| `client.py` | Thin Close REST client. GET only. Basic auth with `CLOSE_API_KEY` as username. 10 s timeout; one retry on 429 (honouring `Retry-After`, capped at 5 s) and on 5xx. Raises `CrmNotConfigured` when the key is unset, `CrmUnavailable` on failure after retry. |
| `match.py` | Customer key to Close leads. Resolves the customer's emails, then queries `GET /api/v1/lead/?query=email_address:"<email>"` per email (deduplicated by lead id). |
| `timeline.py` | Normalizes Close activities into one item shape; flags automated items; detects Plain-link notes. Pure (no I/O). |
| `rules.py` | Constants: automated-email subject patterns and sender patterns, Plain URL pattern, page size, cache TTLs, refresh cooldown. |
| `cache.py` | Small in-process TTL cache (same single-flight pattern as `customer_insights/sources.py`). |
| `routes.py` | `/crm/*` API, admin-only. |

### 3.1 Resolving a customer's emails

- `wc:<id>`: `wc_customers.email` plus distinct `billing_email` values from `wc_orders` where `customer_id = <id>` (IS DB via `get_integration_db`).
- `email:<addr>`: that address.
- Lowercased, deduplicated, empty values dropped.

### 3.2 Close calls

- Leads: `GET /api/v1/lead/?query=email_address:"<email>"&_fields=id,display_name,status_label,url,contacts,opportunities`.
- Owner and user names: `GET /api/v1/user/` (cached 1 hour) to turn `user_id` into a name.
- Opportunities: from the lead payload (value, value period, status label, confidence, expected date).
- Activities: `GET /api/v1/activity/?lead_id=<id>&_limit=100&_skip=<n>` per lead; merged across leads and sorted by activity date descending. Types kept: `Email`, `Call`, `SMS`, `Meeting`, `Note`. `EmailThread` is dropped (Close returns it alongside each `Email`, so keeping both would double every message); thread grouping uses the email's `thread_id` in the drill-down. Others (status changes, task completed, created) are dropped in phase 1.
- Item detail: `GET /api/v1/activity/<type>/<id>/`.

### 3.3 Normalized item

```
{
  "id": "acti_...",
  "type": "email" | "call" | "sms" | "meeting" | "note",
  "at": ISO-8601 UTC,
  "direction": "inbound" | "outbound" | null,
  "who": "<Close user name or contact name/email>",
  "title": "<email subject | call outcome | meeting title | first line of note>",
  "preview": "<first ~160 chars of plain text>",
  "lead_id": "lead_...",
  "lead_name": "...",
  "automated": bool,
  "support_thread_url": "<Plain thread URL>" | null
}
```

- **Automated:** email whose subject matches `^\[Accumark Labs\]: You've got a new order`. `rules.py` also holds an `AUTOMATED_SENDERS` list that starts empty and is filled from the scrubbed fixture data during implementation (only addresses seen sending system mail). Hidden by default.
- **Plain-link note:** a note whose text is only a Plain thread URL gets `support_thread_url` and title "Support thread".
- Email bodies come from `body_text`; when only `body_html` exists it is converted to text server-side (tags stripped). HTML is never sent to the browser.

### 3.4 Caching and refresh

- Lead match per customer key: 1 hour. Timeline per customer key: 5 minutes. User names: 1 hour.
- `?refresh=true` drops that customer's match and timeline entries before loading.
- Refresh cooldown: 10 seconds per customer key; a refresh inside the cooldown returns the cached result with `refresh_throttled: true`.
- If Close fails and a cached copy exists, it is served with `stale: true` and its `fetched_at`.

## 4. API

Both routes require `require_admin`.

### `GET /crm/customers/{customer_key}`

Query: `refresh` (bool), `types` (repeatable: email, call, sms, meeting, note), `include_automated` (bool, default false), `page` (default 1), `page_size` (default 50, max 200).

Response:

```
{
  "configured": true,
  "emails_tried": ["..."],
  "leads": [{ "id", "name", "status", "owner", "url",
              "contacts": [{ "name", "emails": [...], "phones": [...] }],
              "opportunities": [{ "status", "value", "value_period", "confidence", "expected_date" }] }],
  "items": [ <normalized item> ],
  "total": int, "page": int, "page_size": int,
  "counts": { "email": n, "call": n, "sms": n, "meeting": n, "note": n, "automated": n },
  "fetched_at": ISO-8601, "stale": bool, "refresh_throttled": bool
}
```

- Unknown customer key: 404. No matching lead: 200 with `leads: []`, `items: []`.
- Key missing: 503 `{"code": "crm_not_configured"}`. Close failure with no cache: 502 `{"code": "crm_unavailable"}`.
- Pydantic response models declare every key (the `response_model` drops undeclared keys silently).

### `GET /crm/customers/{customer_key}/activities/{activity_id}?type=<type>`

Full item:

- email: the message (from, to, cc, sent, subject, body as text) plus the other messages on the same lead sharing its `thread_id`, oldest first
- call: duration, direction, disposition/outcome, note, recording URL if present, who
- sms: text, direction, who, time
- meeting: title, starts/ends, attendees, notes
- note: full text, `support_thread_url`

The activity's `lead_id` must be one of the leads matched for `customer_key` (from the cached or freshly resolved match); otherwise 404. This keeps Mk1 from acting as a general Close browser by id.

## 5. UI

New **CRM** tab on the customer detail view (`CustomerStatusPage.tsx`, alongside **Customer Orders** and **Dashboard**), rendered only when `isAdmin()`. Works for `wc:` and guest `email:` keys.

- **Account header:** one card per matched lead: name, status chip, owner (rep), contacts (emails, phones), open opportunities (value, stage, expected close), "Open in Close" link.
- **Controls:** type chips All, Emails, Calls, SMS, Meetings, Notes (with counts); "Show automated" toggle (off); **Refresh** button with "Updated N min ago"; refresh spinner; a note when `stale` or `refresh_throttled`.
- **Timeline:** newest first, grouped by day; each row has type icon, in/out arrow, who, title, one-line preview, time; 50 per page with "Load more".
- **Drill-down:** clicking a row opens a side panel with the full item per type (section 4). Email bodies are plain text with line breaks preserved. Plain-link notes show a "Support thread" chip linking to Plain.
- **States:** loading skeletons; "No Close lead found" listing `emails_tried`; "Close is unreachable" with Retry; "CRM not configured" (admin message).

New frontend files: `src/components/customers/CustomerCrmTab.tsx` (tab + timeline), `src/components/customers/CrmActivityPanel.tsx` (drill-down), `src/lib/api-crm.ts` (types + fetchers). React Query keys `['crm', key, filters]`; Refresh calls with `refresh=true` and invalidates.

## 6. Security

- `CLOSE_API_KEY` lives only in the prod `backend/.env` (loaded from the vault at deploy, never printed) and in the developer's vault. Never in the repo, logs, responses or the browser.
- The client exposes GET only; a test asserts no other method exists.
- Admin enforced server-side on both routes.
- No persistence of CRM content; in-process cache only.
- Email bodies converted to text; no HTML rendered.
- Activity detail scoped to leads matched to known customers (section 4).
- Logs carry ids and counts, never email bodies, note text or contact details.

## 7. Errors

| Condition | API | UI |
|---|---|---|
| Key unset | 503 `crm_not_configured` | "CRM not configured" |
| Close 429/5xx/timeout after retry, no cache | 502 `crm_unavailable` | "Close is unreachable" + Retry |
| Same, cache present | 200 `stale: true` | "Showing data from N min ago" |
| Unknown customer key | 404 | existing customer 404 handling |
| No lead match | 200, empty | "No Close lead found for ..." |
| Unknown activity type | item skipped, logged | not shown |

## 8. Testing

- Backend unit: `match.py` (multi-email, multi-lead dedupe, guest key), `timeline.py` (each type, automated detection, Plain-link note, HTML-to-text, merge and sort across leads, pagination), `cache.py` (TTL, refresh drop, cooldown), `client.py` (GET only, retry on 429/5xx, not-configured). Fixtures are recorded Close responses with names, emails and phones scrubbed.
- Backend route: admin gate (403 for standard users), response-model completeness, 503/502/404 paths, stale fallback, refresh throttle.
- Frontend: tab hidden for non-admins; chips filter; automated toggle; drill-down panel per type; empty, error, stale states; Refresh triggers `refresh=true`.
- Live check before merge: devbox stack with `CLOSE_API_KEY`, read-only, Kyle Robertson plus one customer with calls and notes.

## 9. Rollout

- One Mk1 release (backend + frontend). No IS/WP change, no migration.
- Deploy: add `CLOSE_API_KEY` to prod `backend/.env` from the vault (never printed), deploy, smoke as admin.
- Phase 2 candidates: Support (Plain) tab, AI summary card, labmanager-mcp read tool, opening the tab to a non-admin role.
