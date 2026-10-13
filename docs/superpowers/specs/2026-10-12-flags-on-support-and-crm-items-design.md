# Flags on Support tickets and CRM items - design

Date: 2026-10-12. Status: approved in conversation (brainstorming), awaiting written-spec review.
Builds on: the flags system (`backend/flags/`, entity types registered in `backend/flags/seams.py`), the Support tab (`backend/support_plain/`, Mk1 1.45.x) and the CRM tab (`backend/crm_close/`).

## 1. Intent

Let the team raise flags on a Plain support ticket or a Close CRM activity, assign them to anyone, and give whoever is on the flag enough access to see what it is about.

- **Who:** anyone in Mk1. The motivating case: a CS agent on a ticket needs lab help, raises a flag assigned to Dennis or another tech, and the tech opens the ticket from the flag and reads the conversation.
- **Success:**
  - a Flag button on the ticket and CRM slide-outs, with the same behaviour as samples (pill when open flags exist, "N past" chip when only resolved ones)
  - flagged rows marked in the ticket and CRM lists
  - flags listed and labelled in the flags flyout
  - a flag's link reopens the customer page with the item open
  - everyone on the flag can read that one item

### Rulings (Handler, 2026-10-11 and 2026-10-12)

- Label source: a snapshot taken when the flag is raised (ref, title, customer name), never a live Plain or Close lookup while listing flags.
- Anyone logged in can raise, see, assign and work these flags, including in the flags flyout.
- Flag-based access: a user who is the creator, the assignee or a participant (watcher) of any flag on an item may read that one item, read-only, for as long as they are on any flag about it, open or resolved.
- The Support and CRM tabs keep their own gates (Support: admin or Plain seat; CRM: admin). Writes to tickets still need the user's own Plain seat.

### Out of scope

Flags on whole customers; raising a flag from the list without opening the item; notifications beyond what flags already send; flag-based access to the ticket list or other tickets; editing a ticket through flag access.

## 2. Findings that shape the design

- Flags anchor to any registered entity type by an opaque `(entity_type, entity_id)` pair (`flags/models.py`, no foreign key). `register_entity(entity_type, label=, deep_link=, can_flag=, can_raise=, can_view=, visible_entity_ids=, context=, snapshot=, search=, search_scoped=, audience=, ...)` in `flags/seams.py`. Documents are the closest model (`documents/flag_entity.py`).
- When a flag is raised, `flags/service.py` calls the type's `snapshot(db, eid)` and stores it in the "raised" `FlagEvent.details["entity_snapshot"]`. Labels are resolved per listing through `label(db, eid)`.
- `FlagParticipant(flag_id, user_id, role)` holds watchers; `FlagFlag` has `created_by` and `assignee_id`.
- `GET /flags` supports `entity_type` without `entity_id`, so one request returns every open flag of a type.
- Frontend: `EntityFlagButton` (1.45.2, with the past-flags chip), `flag-entity.ts` (icons, `navigateToDeepLink` switch), and a pending-item pattern for planning boards (`setPendingBoardNode` / `consumePendingBoardNode`) that the customer page can reuse.
- The CRM detail route needs the activity type: `GET /crm/customers/{key}/activities/{id}?type=email|call|sms|meeting|note`.
- Support reads are gated by `support_plain.seat.require_support_reader` (admin or seat); CRM reads by `require_admin`.

## 3. Entity types (backend)

### 3.1 Ids

| Type | entity_id | Example |
|---|---|---|
| `support_ticket` | `{customer_key}\|{thread_id}` | `wc:1572\|th_01KNK2DP78S9Z8P62PZV6M7F8M` |
| `crm_item` | `{customer_key}\|{type}\|{activity_id}` | `wc:1572\|email\|acti_8f2...` |

A shared helper parses and validates these: customer key `wc:<digits>` or the existing guest key form; thread ids match `rules.THREAD_ID_PATTERN`; CRM type is one of the five item types. Malformed ids are rejected on raise (422) and never resolve on read.

### 3.2 Registration

`support_plain/flag_entity.py` and `crm_close/flag_entity.py`, registered at startup beside `document`:

- `label(db, eid)`: the latest "raised" `FlagEvent.details.entity_snapshot.label` for a flag on this entity. Fallback: "Support ticket" or "CRM item". No external calls.
- `snapshot(db, eid)`:
  - Support: `{label: "T-1540 · Contact form · Lilia Billones", ref, title, customer}` from the cached Support list, with one Plain read if the cache is cold.
  - CRM: `{label: "Email · Re: COA timing · Kyle Robertson", type, title, at, lead}` from the cached CRM list.
  - If the lookup fails, `{label: "Support ticket"}` or `{label: "CRM item"}`. Raising never fails because of it.
- `can_raise(db, user, eid)`: any active user, and the item must belong to that customer. Support uses the existing scoping (`service.thread_detail` returns None for a foreign thread); CRM uses `service.activity_detail` the same way. A foreign or unknown item is refused.
- `can_view` and `visible_entity_ids`: everyone (these flags are lab-wide).
- `context(db, eid)`: `{label, deep_link: {kind: "customer_item", id: "<type>:<entity_id>"}}`, where type is `support` or `crm`.
- `deep_link`: `/#customers`.
- `search`: none. These flags are raised from the slide-out, not by searching.

### 3.3 Flag-based read access

A new helper `flags.access.on_flag_for(db, user_id, entity_type, entity_id) -> bool`. It is true when any `FlagFlag` with that entity has `created_by == user_id`, or `assignee_id == user_id`, or a `FlagParticipant` row for the user. Open or resolved both count.

Read gates change as follows; nothing else does:

| Route | Today | After |
|---|---|---|
| `GET /support/customers/{key}/threads/{th}` | admin or seat | admin or seat, **or** `on_flag_for(user, "support_ticket", f"{key}\|{th}")` |
| `GET /crm/customers/{key}/activities/{id}?type=` | admin | admin, **or** `on_flag_for(user, "crm_item", f"{key}\|{type}\|{id}")` |

The ticket list, the CRM list, every write and `/support/workspace` keep their current gates. A flag-access read still goes through the customer scoping, so a flag cannot be used to read another customer's ticket.

## 4. Link target

- A new deep-link kind `customer_item`, with id `support:{entity_id}` or `crm:{entity_id}`.
- `navigateToDeepLink` handles it: close the flags flyout, `navigateToCustomerKey(key)`, then `setPendingCustomerItem({kind, entityId})`.
- The customer page consumes the pending item on mount (`consumePendingCustomerItem`) and opens the matching slide-out directly, whether or not the viewer can see the tab:
  - Support: `SupportThreadPanel` with a minimal thread `{id, ref, title}` from the snapshot, filled in by the detail query.
  - CRM: `CrmActivityPanel` with a minimal item.

## 5. UI

### 5.1 Flag button

- `EntityFlagButton entityType="support_ticket"` in the ticket slide-out header, next to "Open in Plain".
- `EntityFlagButton entityType="crm_item"` in the CRM activity slide-out header.
- Raising prefills the item, exactly like other entities. The pill, count and "N past" chip behave as on samples.

### 5.2 List markers

- The Support tab and the CRM tab each make one request for open flags of their type (`GET /flags?tab=all_open&entity_type=...`), filtered client-side to ids starting with `{customer_key}|`.
- Each row with open flags shows a small type-colored flag icon, with a count when there is more than one. Clicking the icon opens that row's flags in the flyout.

### 5.3 Flyout and threads

`flag-entity.ts` gains:
- `support_ticket` (LifeBuoy icon, label "Support ticket")
- `crm_item` (Contact icon, label "CRM item")

Both use `canDeepLink: false`, so navigation goes through the server `deep_link`.

### 5.4 Read-only mode for flag participants

When the viewer reached the item through flag access (they have no seat and are not an admin for Support; not an admin for CRM):
- The slide-out shows the conversation and the sidebar or activity detail only.
- There is no action bar, composer, Recent threads or edit menus.
- A line at the top reads: "You're seeing this because you're on flag #{id}". The id is the newest flag the viewer is on for that item, returned by the detail route as `via_flag`.

## 6. Security

- **Threat: flag access widens into the whole customer.**
  - Access is granted per entity id.
  - The list routes and the other tickets keep their gates.
  - The customer scoping still applies, so `wc:1572|th_x` cannot reach a thread of another customer.
- **Threat: a user adds themselves as a watcher to gain access.** Anyone can already raise a flag. To raise one on a ticket they must already see the ticket (the button is in the gated slide-out), or know a valid customer key and thread id. Raising validates that the thread belongs to the customer, which needs the customer's thread list, readable only through the gate.
  - Accepted residual: someone who learns a ticket's ids (for example from a flag shared with them) and watches an existing flag gains read access to that one ticket. This is the intended reach of "anyone on a flag".
- **Threat: customer-sensitive text in flag titles.** Flags are lab-wide; whoever raises one keeps sensitive detail in the ticket. Ruled by the Handler.
- No new tables, no schema change, no secrets.

## 7. Testing

Backend:
- id parse and validate, valid and malformed
- `can_raise` for a foreign or unknown thread and CRM item
- label from the snapshot, plus the fallback when the snapshot is missing
- snapshot failure still lets the flag be raised
- `on_flag_for` for creator, assignee, watcher, a resolved flag, and a non-participant
- the detail routes allow a participant without a seat or admin role, deny a non-participant, and still apply customer scoping
- writes stay denied to a participant without a seat
- `via_flag` present only for flag-access reads

Frontend:
- the Flag button appears in both slide-out headers
- list markers render from one query, filtered to the customer
- the `customer_item` deep link navigates and opens the right slide-out, including for a viewer who cannot see the tab
- read-only mode hides the action bar and composer and shows the flag line

## 8. Rollout

One release, frontend and backend. No env change. Smoke on prod:
1. Raise a flag on a test ticket assigned to a non-seat user.
2. As that user, open the flag's link and read the ticket.
3. Confirm the user cannot reply.
4. Resolve the flag and confirm the user can still read the ticket.
