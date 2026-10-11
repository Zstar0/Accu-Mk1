# Support ticket view in Plain's style - design

Date: 2026-10-11. Status: approved in conversation (brainstorming), awaiting written-spec review.
Builds on: `2026-10-08-customer-support-tab-design.md` (read view, LIVE 1.38.0) and `2026-10-09-support-ticket-actions-design.md` (reply, note, triage, LIVE 1.44.0).

## 1. Intent

Make the Support ticket slide-out in Accu-Mk1 work and read like Plain's own ticket screen, so someone used to Plain can work a ticket in Mk1 without re-learning it.

- **Who:** the support seat holders (Lauren, Scott, Dennis, Forrest) and admins reading tickets.
- **Success:** a ticket opens in a two-column view: a conversation that scans like Plain's (avatar cards, team replies distinct from customer messages, amber internal notes, compact event lines, date dividers, a bottom action bar) and Plain's details sidebar (status detail, assignees, priority, labels, tier, thread fields, customer details, recent threads), in Plain's colors, in light and dark.

### Rulings (Handler, 2026-10-11)

- Plain's color theme applies to the ticket view only (the slide-out), and follows Mk1's light or dark mode.
- Layout: a two-column slide-out (conversation left, details sidebar right), not a full page.
- Sidebar edits: status (adding "Waiting for customer"), primary assignee, additional assignees (add and remove), priority, labels. Thread fields and customer details are read-only.
- Conversation order defaults to oldest first, scrolled to the newest, like Plain; the existing newest-first toggle stays.

### Out of scope

Editing thread fields or the customer's company; Plain Sidekick or AI drafting; sender-verification warnings; attachments; keyboard shortcuts beyond R, N and Esc; theming the ticket list or any other Mk1 surface.

## 2. Findings that shape the design

From Plain's published schema (`core-api.uk.plain.com/graphql/v1/schema.graphql`, read 2026-10-11):

- `Thread` exposes `statusDetail` (a union: `ThreadStatusDetailCreated`, `NewReply`, `Replied`, `InProgress`, `Snoozed`, `Unsnoozed`, `WaitingForCustomer`, `WaitingForDuration`, `WaitingIndefinitely`, `DoneManuallySet`, `DoneAutomaticallySet`, `ThreadLinkUpdated`, `LinearUpdated`, `Ignored`, `ThreadDiscussionResolved`), `assignedTo`, `additionalAssignees`, `tier { id name color }`, `threadFields { key type stringValue numberValue booleanValue dateValue }`, and `customer { fullName email { email } externalId avatarUrl company { name } createdAt updatedAt }`.
- `threadFieldSchemas` gives each field's `label`, `key`, `order` and `type`; thread fields carry only the key.
- `User.avatarUrl` exists. `UserActor`, `CustomerActor`, `MachineUserActor` and `SystemActor` identify who wrote an entry; Plain's own autoresponses come from a system or machine actor.
- `EmailEntry` has `to`, `from` (each `{ name email }`), `additionalRecipients` and `markdownContent`.
- Writes: `snoozeThread(input: {threadId, durationSeconds, statusDetail: WAITING_FOR_CUSTOMER | WAITING_FOR_DURATION | WAITING_INDEFINITELY})`, `addAdditionalAssignees(input: {threadId, userIds})`, `removeAdditionalAssignees(input: {threadId, userIds})`.
- The existing panel (`SupportThreadPanel.tsx`) is one column inside `ResizableSheetContent`; its width is remembered in `localStorage` (`mk1.customerSlideoutWidth`).

## 3. Data (backend, additive)

All new keys are declared on the route's response models (FastAPI drops undeclared keys).

### 3.1 Thread detail gains

| Key | Shape | Source |
|---|---|---|
| `status_detail` | `{kind, label, until?}` | `statusDetail` mapped (3.3) |
| `assignees` | `[{plain_user_id, name, avatar_url, primary: bool}]` | `assignedTo` + `additionalAssignees` (users only; machine users shown by name with no edit) |
| `tier` | `{name, color} \| null` | `tier` |
| `fields` | `[{key, label, value: str \| null}]` ordered by schema `order` | `threadFields` joined to `threadFieldSchemas` (cached 10 min); every schema field appears, empty ones with `value: null` |
| `customer` | `{name, email, external_id, avatar_url, company, created_at, updated_at, wp_profile_url}` | `customer`; `wp_profile_url` = `https://accumarklabs.com/wp-admin/user-edit.php?user_id={external_id}` when `external_id` is numeric |

The thread list item is unchanged (the sidebar's "Recent threads" reuses the existing customer list).

### 3.2 Entries gain

| Key | Shape |
|---|---|
| `author_avatar_url` | `str \| null` |
| `automated` | `bool`: an email or chat whose actor is a `SystemActor` or `MachineUserActor` and that is not a website contact form |
| `email_to`, `email_from` | `str \| null` (`"Name <email>"` or the email) for email entries |
| `markdown` | `str \| null` for email entries with `markdownContent` (rendered by the existing sanitizer) |
| `event` | `{icon, actor, text}` for events: icon one of `status`, `label`, `assign`, `priority`; `text` is the sentence without the actor |

`text` stays as today, so the AI review and any other reader of entries is unaffected.

### 3.3 Status detail labels (Plain's words)

| Plain detail | `kind` | label |
|---|---|---|
| Created | `needs_first_response` | Needs first response |
| NewReply, Unsnoozed, ThreadLinkUpdated, LinearUpdated, ThreadDiscussionResolved | `needs_next_response` | Needs next response |
| Replied, InProgress | `in_progress` | In progress |
| WaitingForCustomer | `waiting_for_customer` | Waiting for customer |
| WaitingForDuration, Snoozed | `waiting_until` | Waiting until {date} |
| WaitingIndefinitely | `waiting` | Waiting |
| DoneManuallySet, Ignored | `done` | Done |
| DoneAutomaticallySet | `done_auto` | Done automatically |
| null | from `status` (Todo -> `needs_next_response`, Snoozed -> `waiting`, Done -> `done`) | |

### 3.4 New writes (same no-retry path, seat permission, scoping and `support_actions` audit as 1.44.0)

- `POST .../status` accepts `{status: "waiting_for_customer"}` and `{status: "waiting"}` (indefinitely): `snoozeThread` with `statusDetail` `WAITING_FOR_CUSTOMER` / `WAITING_INDEFINITELY` and no duration. The existing `todo`, `done`, `snoozed` (with `until`, now sent with `statusDetail: WAITING_FOR_DURATION`) stay.
- `POST .../assignees` with `{add: [plain_user_id], remove: [plain_user_id]}`: `addAdditionalAssignees` then `removeAdditionalAssignees`; ids must be active teammates (adds) or current additional assignees (removes); both empty is 422.

## 4. UI

### 4.1 Layout

- The slide-out default width becomes 1,100 px (still resizable, remembered). At 820 px or wider: two columns, conversation (flexible) and sidebar (300 px, its own scroll). Narrower: one column with a **Details** toggle at the top that shows the sidebar above the conversation.
- **Header** (full width): `T-1540` ref, title, status-detail icon and label, priority icon, **Open in Plain**.

### 4.2 Conversation

- **Day dividers** ("Tue, Sep 15, 2026") between days; relative time on each card ("2d ago", exact time on hover).
- **Message card**: avatar (image or initial on a color derived from the name), name, time; for email the subject on its own line and a muted `to: … from: …` line; body as plain text, or the sanitized markdown when present.
  - Customer and contact-form messages: the neutral card.
  - Team messages (agent author): the team card (Plain's deep navy in dark, light blue-gray in light).
  - Automated messages: the team card collapsed to "This email was sent automatically" with **Show message**.
- **Internal notes and discussions**: the amber card, with "Not visible to {customer first name}" under the body; `@Name` mentions render as accent chips.
- **Events**: a single muted line with a small icon: "{actor} changed status to Done · 2d ago", "Plain Sidekick added label Engineering", "Plain assigned You" (the viewer's own name becomes "You").
- **Order**: oldest first, scrolled to the bottom on open; the toggle switches to newest first (still remembered).
- **Action bar** pinned at the bottom (seat holders): **Reply to {customer first name}** (R), **Add note** (N), **More** (Mark done, Waiting for customer, Snooze for 1 hour / until tomorrow 8 am / until Monday 8 am / until a date, Back to Todo). Reply and Add note open the existing composer docked above the bar on the matching tab; Esc closes it (draft kept). R and N only fire when focus is not in a text field. Without a seat: no action bar; one line explains why.

### 4.3 Sidebar

- **Thread details** (collapsible): title; Company; Customer (avatar + name); Status (status-detail menu: Needs next response = Todo, Waiting for customer, Snooze…, Done); Assignee (primary, then additional assignees indented under it as in Plain, each removable, and **+ Assign** to add); Priority (icon + label menu); Labels (chips with remove, **+** to add); Thread tier (chip with the tier color); then the thread fields, first five shown, **Show more fields** / **Show fewer fields**. Empty values show the label in muted text, as Plain does.
- **Customer details** (collapsible): avatar and name, Email, External ID (links to the WordPress profile), Created at, Updated at.
- **Recent threads**: this customer's other tickets with a status icon, ref, title and date; clicking one switches the slide-out to that ticket.
- Non-seat viewers see the sidebar read-only (no menus, no + buttons).

### 4.4 Colors

A scoped palette as CSS variables on a `.plain-view` wrapper inside the slide-out, with a light set and a dark set switched by Mk1's theme class. Tokens: `--pv-bg`, `--pv-surface`, `--pv-card`, `--pv-card-team`, `--pv-card-note`, `--pv-note-ink`, `--pv-border`, `--pv-ink`, `--pv-ink-2`, `--pv-ink-3`, `--pv-accent`, `--pv-chip`. Dark values match the reference screenshots (near-black ground, deep navy team card, brown-amber note card, gray event text, blue accent); light values follow Plain's light theme. No other Mk1 surface uses them.

## 5. Errors and states

- Loading: skeleton for the sidebar and three card placeholders.
- Plain unavailable: the existing stale banner; sidebar shows the last loaded data.
- A sidebar edit failure restores the previous value with the existing plain-language message (1.44.0 `support-errors.ts`).
- Thread field schemas unavailable: fields render with their keys as labels rather than failing the panel.

## 6. Testing

Backend: status-detail mapping table (every union member and null); fields join (order, empty values, unknown key falls back to the key); customer block (numeric and non-numeric external id); entry `automated`, `email_to`/`email_from`, `event` shapes; the two new status values and `assignees` action (exact mutations, validation, scoping, audit); response models declare every new key.

Frontend: two-column at >= 820 px and Details toggle below; day dividers; team vs customer vs automated vs note card selection; "Not visible to {first name}"; event line with "You"; oldest-first default with toggle; action bar R/N/Esc behavior (not while typing); sidebar menus call the right actions; read-only sidebar without a seat; Recent threads switch the ticket; palette tokens present in light and dark.

## 7. Rollout

Frontend and backend in one release; no env or schema change (no new table). Smoke on prod: open a ticket with notes and events, check both themes, set Waiting for customer and back, add and remove an additional assignee on a test ticket.
