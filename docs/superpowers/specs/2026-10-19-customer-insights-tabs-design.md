# Customer Insights: At risk, New customers and Cohorts tabs, with CRM and Support touch columns

Date: 2026-10-19. Status: draft for Handler approval. Repo: Accu-Mk1 only (no Integration Service or COA Builder change).

## 1. Goal

The Handler asked for three things on the Customer Insights page (AccuMark Tools, sub-section `customer-insights`):

1. Turn the standalone "At-risk customers" card into a tabbed section.
2. Put the "biggest new customers" list (first produced by hand from WooCommerce SQL on 2026-10-19) in that section, so it is one click away instead of a query.
3. Add a Cohorts tab where a cohort can be opened to see which customers it contains, and a cohort cell can be opened to see who came back in that month.

And on the lists themselves, more at-a-glance data: for each customer, the date of the last CRM correspondence and the date of the last Support contact, each clickable into that customer's CRM or Support tab in Mk1.

Why now: the lab is working the at-risk list by hand and the sales side wants to know who the new accounts are without asking for a report. All of the data already lives in Mk1 (WooCommerce order mirror, Close CRM timeline, Plain support threads); nothing new has to be synced.

## 2. Definitions (reuse the existing ones, one implementation each)

- **Testing order, paid order, at risk, usual gap, overdue, status**: unchanged, as in `docs/superpowers/specs/2026-10-05-customer-insights-design.md` section 2 and `backend/customer_insights/rules.py`.
- **Cohort**: the lab-time month (`rules.lab_month`) of a customer's first testing order. This is what `metrics.cohorts` already uses. Launch accounts are excluded on cohort views (existing default).
- **New customer (in a period)**: a customer whose first testing order falls inside the page's selected period. Same first-order definition as the cohort. Note for acceptance: the 2026-10-19 SQL list counted first *paid* order, so a customer whose first order was ACOA-only or retest-only is "new" in SQL but not here. That is the intended definition; the difference is explained, not fixed.
- **Last CRM touch** (Handler ruling 2026-10-19, "humans only"): the most recent Close activity that is a `call`, or an `email` that was actually sent or received (Close email `status` of `sent` or `inbox`; `draft`, `scheduled`, `outbox` and `error` do not count), in either direction, and is not automated. Automated means the existing subject rule or any of Close's `sequence_id`, `sequence_subscription_id`, `bulk_email_action_id` or `agent_config_id` being set on the email (field names checked against the Close API reference on 2026-10-19). Notes, meetings and SMS do not count.
- **Last Support touch**: Plain's `last_contact_at` as the existing `support_plain.service.customer_support` computes it (the `updated_at` of the customer's most recently updated non-test thread).

## 3. Current state (origin/master, v1.49.2)

- `src/components/customers/CustomerInsights.tsx` renders: KPI row; a two-column row with the revenue-by-month chart and a small "Re-order cohorts" grid (6 of 12 months, not clickable); the "At-risk customers" card (customer, rep, 12-month spend, orders, usual gap, last order, overdue; hover card; row click opens the customer's Dashboard tab); then first-order, attach, concentration, product prices and churn cards.
- Backend: `backend/customer_insights/` with `/reports/customers/{summary,cohorts,at-risk,list,orders,churn-signals,changes,{key}}`. `metrics.customer_rows` returns per-customer rows (no first-order date). `/list` supports `period`, `from`/`to`, `exclude_launch_accounts`, `search`, `sort`, `dir`, `page`, `page_size`.
- CRM: `backend/crm_close/` (`GET /crm/customers/{key}`, admin only, items newest first, `types` and `include_automated` filters, in-process TTL cache: match 1 h, timeline 5 min, stale fallback, refresh cooldown).
- Support: `backend/support_plain/` (`GET /support/customers/{key}`, admin or Plain seat, threads newest-updated first, `last_contact_at`, `counts`, same cache pattern: list 5 min).
- Customer detail (`CustomerStatusPage.tsx`) has tabs `orders | dashboard | crm | support | ai-review`; CRM and AI review show for admins, Support for admins or seat holders. The ui-store's `navigateToCustomerKey(key)` opens the detail on the Dashboard tab; `email:` (guest) keys open the Dashboard-only guest view, which has no CRM or Support tabs.
- `FastAPI response_model` strips undeclared keys: every new field must be declared on the Pydantic model or it silently disappears (memory `architecture_fastapi_response_model_strips_undeclared_keys`).

## 4. Design

### 4.1 Backend

All changes are additive. No migration, no IS change.

**`crm_close.timeline.normalize`** (shared by the CRM tab and the new route) learns what a sequence is. Today `automated` comes from one subject regex (`rules.AUTOMATED_SUBJECT`), so a sequence step sent from a rep's mailbox with an ordinary subject counts as human. Widen it: an email is `automated` when the subject rule matches or any of `sequence_id`, `sequence_subscription_id`, `bulk_email_action_id`, `agent_config_id` is set. Also carry the email's Close `status` through as a new nullable `email_status` field on the normalized item and on the `Item` response model (email items only). Consequence on the CRM tab, deliberate and consistent with the ruling: sequence and bulk sends move behind the existing "include automated" toggle and into `counts.automated`; drafts keep showing on the tab as they do today (the tab is a timeline, the touch is a contact).

**`metrics.customer_rows`** gains two fields per row:

- `first_order_at`: ISO datetime of the first testing order (`min(dates)`), `null` when the customer has no testing order.
- `testing_orders`: count of testing orders (the existing `orders` counts all paid orders, including ACOA and add-on-only orders).

Declare both on `CustomerRow` (and therefore `AtRiskRow`) in `routes.py`, and add `first_order_at` and `testing_orders` to `SortField`.

**`GET /reports/customers/list`** gains three optional filters, applied before search, sort and paging so `total` reflects the filter:

- `new_only: bool = false`: keep rows whose `first_order_at` lies inside the resolved period window `[lo, hi]` (the same `lo`/`hi` that `period` and `from`/`to` already resolve to). Rows without a testing order are dropped.
- `cohort: str` (pattern `^\d{4}-\d{2}$`): keep rows whose first testing order's lab month equals `cohort`.
- `returned_in: str` (same pattern, only valid together with `cohort`; 422 otherwise, and 422 when `returned_in == cohort`): keep rows that have at least one testing order in that lab month. This mirrors `metrics.cohorts` exactly (`months_by_key[c]` contains the target month), so a drill-down's `total` equals the grid's `size × cell share`, rounded.

With `cohort=` the UI always passes `exclude_launch_accounts=true` to match the grid's membership. Acceptance: for every cohort row, `/list?cohort=M&exclude_launch_accounts=true&page_size=1` returns `total == size`.

**`GET /reports/customers/touchpoints`** (new, in a new module `backend/customer_insights/touchpoints.py`, mounted on the same router):

- Params: `keys` (repeated query param, 1 to 50 customer keys, `wc:<id>` or `email:<addr>`). More than 50 is a 422; the client chunks.
- Register it on the router before the `/{customer_key}` dossier route, or the dossier route swallows the path. The agent gate (`backend/agents/auth.py`) matches on the route template, so agents stay denied for this route without further work.
- Auth: `get_current_user`. Then `crm_visible = user is admin` (same test `auth.require_admin` applies), `support_visible = support_plain.seat.is_support_reader(user)`. A field the caller may not see is omitted from every row, and no upstream call is made for it.
- Response (declare every field; see the response_model trap):

```
TouchpointsResponse {
  crm_visible: bool
  support_visible: bool
  rows: dict[str, Touchpoints]      # keyed by customer key, one entry per requested key
}
Touchpoints { crm?: CrmTouch, support?: SupportTouch }
CrmTouch {
  state: 'ok' | 'none' | 'unavailable'
  at?: str                            # ISO, when state == ok
  type?: 'email' | 'call'
  direction?: 'inbound' | 'outbound' | null
  who?: str; title?: str; preview?: str
  lead_name?: str; lead_url?: str
  stale: bool                         # served from the CRM stale fallback
  reason?: 'not_configured' | 'unavailable' | 'unknown_customer'
}
SupportTouch {
  state: 'ok' | 'none' | 'unavailable'
  at?: str                            # last_contact_at
  thread_id?: str; title?: str; status?: str
  waiting_since?: str | null; plain_url?: str
  open_count?: int                    # counts.open
  stale: bool
  reason?: as above
}
```

- Implementation: for each key, call the existing services, never the Close or Plain clients directly:
  - CRM: `crm_close.service.customer_crm(key, refresh=False, types=["email", "call"], include_automated=False, page=1, page_size=rules.TOUCH_SCAN)` (start at 10); items are newest first, so the touch is the first item that is a call or an email with `email_status` in `("sent", "inbox")`. If none of the scanned items qualifies but `total` exceeds the scan, request the next page once more, then give up as `none`. Empty is `none`; `None` (unknown customer) is `none` with `reason=unknown_customer`.
  - Support: `support_plain.service.customer_support(key, refresh=False, statuses=[], page=1, page_size=1)`; `last_contact_at` and `threads[0]` give the touch.
  - `CrmNotConfigured`, `CrmUnavailable`, `SupportNotConfigured`, `SupportUnavailable` are caught per key and become `state=unavailable` with a reason. One bad key never fails the response. Any other exception is logged with the key kind and becomes `unavailable` too.
  - Fan-out with a bounded `ThreadPoolExecutor` (`rules.TOUCH_WORKERS`, start at 4). The services' per-key single-flight cache makes concurrent loads of the same key safe.
  - Cache the per-key summary (the small `CrmTouch` / `SupportTouch` dicts) for `rules.TOUCH_TTL` (start at 900 s), so a page that stays open does not re-pull every Close activity every 5 minutes. The summary lives in the owning service's existing `CACHE` under the prefix `touch:` (`crm_close.service.CACHE` for CRM, `support_plain.service.CACHE` for Support), and each service's successful refresh path drops `touch:{customer_key}` (one additive line next to the existing `CACHE.put` / `CACHE.drop` calls). So a refresh on a customer's CRM or Support tab and the Insights cell agree on the next touchpoints request; there is no reverse import from the services into `customer_insights`. A summary is cached only when its state is `ok` or `none`; `unavailable` is not cached. This route has no `refresh` param.
- Logging: one info line per request with key count, visible flags, and counts by state; never log emails.

### 4.2 Frontend

**`CustomerInsights.tsx`** replaces the at-risk card and the small cohort grid with one tabbed card (`@/components/ui/tabs`, the primitive `CustomerStatusPage` already uses). The revenue-by-month chart takes the full width of its row now that the small grid has moved (my call).

Tabs, in order, with counts in the labels when known:

1. **At risk (N)**: the existing table and hover card, plus two new columns at the right: **Last CRM** and **Last support**. Subtitle unchanged ("Overdue against their own usual re-order gap, ranked by 12-month spend"). Still all-time (the period selector does not apply), say so in the subtitle.
2. **New customers (N)**: customers whose first testing order fell inside the selected period (the page's 30D / 90D / 6M / 1Y / All control), ranked by lifetime spend. Columns: Customer, Company, Rep, First order, Testing orders, Lifetime spend, Last order, Status, Last CRM, Last support. Served by `/list?new_only=true&period=<p>&exclude_launch_accounts=<page switch>&sort=lifetime&dir=desc&page_size=25`. Paged with the same simple pager the Customers list uses; sortable on the columns `/list` can sort. Subtitle: "First testing order in this period, ranked by lifetime spend". The page's existing "Exclude launch accounts" switch applies here exactly as it does to the revenue chart (default off), so the switch moves from the chart header to the page header next to the period control.
3. **Cohorts**: the grid, all 12 months, same tints. Each cohort label is a button that selects the cohort; each filled cell is a button that selects cohort plus month. The selected row and cell are highlighted. Below the grid, a members panel with a header line like `2026-07 cohort · 126 customers` or `2026-07 cohort · came back in M3 (2026-10) · 41 of 126`, and a table with the New customers columns. Served by `/list?cohort=YYYY-MM[&returned_in=YYYY-MM]&exclude_launch_accounts=true&period=all&sort=lifetime&dir=desc&page_size=25`. Nothing selected shows a one-line hint ("Pick a cohort to see its customers").

**Touch cells** (`TouchCell`, a pure prop-driven component, one for CRM and one for Support):

- Loading: a muted dash with a subtle pulse while the touchpoints query is in flight. The table renders from the list query first; touch data arrives from a second query (`['customers', 'touchpoints', keys]`, `staleTime` 5 min) keyed on the keys currently on screen, chunked at 50.
- `ok`: short date (`Oct 12`) and relative age (`7 d`), plus for CRM a direction glyph (lucide `ArrowDownLeft` inbound, `ArrowUpRight` outbound) and a type glyph (`Mail` or `Phone`); for Support the thread status as a small chip when it is `open` or waiting. Hover shows the sectioned `font-mono` tooltip card (the SLA-breakdown pattern, repo default): CRM card = who, title, preview, lead name; Support card = thread title, status, waiting since, open thread count. Stale data gets a "cached" note in the card.
- `none`: muted "none".
- `unavailable`: muted "n/a" with the reason in the hover card (CRM not configured, CRM unreachable, unknown customer).
- Click or Enter on an `ok` cell stops row propagation and calls `onOpenCustomer(key, 'crm' | 'support')`. The row click still opens the Dashboard tab. For `email:` guest keys the detail has no CRM or Support tab, so the cell click opens the guest detail as the row does; the cell still shows the date.
- Column visibility follows the response flags `crm_visible` / `support_visible` (the server decides; the UI never shows a column the response omitted). Both hidden means the two columns are absent, not empty.

**Navigation**: `navigateToCustomerKey(key, opts?: { tab?: CustomerDetailTab; origin?: 'customers' | 'customer-insights' })` gains an optional options argument (defaults `tab: 'dashboard'`, `origin: 'customers'`, so the existing Customers-list caller is unchanged). `AccuMarkTools` wraps it for Insights with `origin: 'customer-insights'`, and the touch cells pass `tab`. The detail page already falls back to `orders` when the user may not see the requested tab.

**View persistence (my call)**: the selected tab, period, cohort and month live in the ui-store (`insightsView: { tab, period, cohort, month }` with one setter) rather than component state, so opening a customer from a drill-down and coming back lands on the same view. The detail page's back action (`navigateToCustomers`) returns to the Customers list today; add `customerDetailOrigin`, set from the `origin` option above, and have the back action return to `customer-insights` when that is the origin. Both are small, additive store fields.

### 4.3 Access

- The Insights page stays open to every signed-in user (10-05 ruling).
- CRM touch data is admin-only; Support touch data needs admin or a Plain seat. The server enforces this on `/touchpoints`; the UI mirrors it by hiding columns.
- Bots: the labmanager-mcp `reports_get` allowlist is name-based and passes params through, so the new `/list` filters work for agents without a change. Allowlisting `customers/touchpoints` for agents is out of scope (it carries CRM content; needs its own ruling).

## 5. Goals, non-goals, anti-goals

Goals: the three tabs; touch columns with click-through; cohort size and drill-down totals agree; nothing slower than today for users who cannot see CRM or Support.

Non-goals: no new sync or storage of CRM or Support data in Mk1; no change to the at-risk rule; no change to the customer detail tabs beyond the wider `automated` classification in 4.1; no export; no agent access to touchpoints.

Anti-goals (a failure even if it works): a page that blocks on Close; a CRM date that counts a sequence email; a cohort drill-down whose count disagrees with the grid; CRM content visible to a non-admin.

## 6. Testing

Backend (`backend/tests/`), one suite at a time against the dev Postgres (existing baseline rule):

- `test_customer_insights_metrics.py`: `first_order_at` and `testing_orders` on `customer_rows`; a customer with paid but no testing orders has `first_order_at = None`.
- `test_customer_insights_routes.py`: `new_only` keeps only first orders inside the window; `cohort` total equals `cohorts()` size for every month in a fixture; `returned_in` total equals `round(size × cell)`; `returned_in` without `cohort` or equal to it is 422; `first_order_at` sorting with nulls last.
- `test_crm_close_timeline.py` (extend the existing timeline tests): an email with `sequence_id` set is `automated`; one with `bulk_email_action_id` set is `automated`; a plain email is not; `email_status` is carried through for emails and is `None` for calls and notes; the `Item` model declares it.
- `test_customer_insights_touchpoints.py` (new): the humans-only filter is passed to the CRM service (`types=["email","call"]`, `include_automated=False`); a `draft` email newer than a `sent` one is skipped and the `sent` one is the touch; a call is always a touch; a non-admin caller gets no `crm` field and the CRM service is never called; a seat holder gets `support` but not `crm`; one key raising `CrmUnavailable` yields `unavailable` for that key and `ok` for the others; `None` from the service is `none` with `unknown_customer`; 51 keys is 422; the summary cache is hit on the second call, `unavailable` is not cached, and a service refresh for that customer drops the `touch:` entry; `GET /reports/customers/touchpoints` is not swallowed by the dossier route.

Frontend (`vitest`): tabs render and switch; `TouchCell` renders each state and the hover card content from props; a cell click calls `onOpenCustomer(key, 'crm')` and does not trigger the row handler; columns are absent when the response flags are false; the cohort cell click issues `/list` with `cohort`, `returned_in` and `exclude_launch_accounts=true`; `navigateToCustomerKey(key, 'support')` sets `customerDetailTab` and `customerDetailOrigin`.

e2e: extend `e2e/customer-insights.spec.ts` on a devbox stack with one screenshot per tab. Close and Plain are not configured on stacks, so the touch cells must show `n/a` and the page must still load; assert that.

## 7. Acceptance (read-only against prod after deploy)

1. For every cohort row, `/list?cohort=M&exclude_launch_accounts=true&page_size=1` returns `total == size`.
2. New customers with period 6M, launch accounts included, sorted by lifetime: UMS Rx LLC (`wc:2243`) is first. With `from=2026-06-19&to=2026-10-19` the count is below the 2026-10-19 SQL figure (783 by first paid order); the difference is the set of customers whose first order was ACOA-only or retest-only, checkable via `/orders`.
3. At-risk count and order are unchanged from v1.49.2.
4. For `wc:2243`, the CRM cell equals the newest call or sent/received email on that customer's CRM tab with "include automated" off, and the Support cell equals the top thread on the Support tab. After pressing refresh on either tab and reloading Insights, the cell still agrees.
5. As a non-admin user without a Plain seat, neither column renders and `/touchpoints` returns rows without `crm` or `support`.

## 8. Rollout

- Mk1 minor release (1.50.0): CHANGELOG entry in the lab-facing voice; release gate is the frontend Docker build (memory `feedback_frontend_docker_build_gate`).
- No IS change, no migration, no env change. Close and Plain stay configured as they are.
- PR carries Risk and How-to-revert per `REVIEW.md`.

## 9. Risk and how to revert

- Risk: first load of the At-risk tab by an admin fans out to Close once per at-risk customer (today about 20 to 40). Bounded by the worker pool and both caches; a Close 429 is retried once by the client and otherwise degrades that one cell to `n/a`. The list itself never waits on it.
- Risk: a `/list` filter bug could show the wrong members. Caught by the size-equals-total test and acceptance step 1.
- Revert: redeploy the v1.49.2 image. Read-only routes and UI only; no data to undo.

## 10. Left to the builder

- Table primitive for the two new tables (`ui/table.tsx`, `ui/data-table.tsx`, or the existing hand-rolled pattern), as long as the three tables look alike.
- Exact TTL, scan and worker constants (start: `TOUCH_TTL = 900`, `TOUCH_SCAN = 10`, `TOUCH_WORKERS = 4`), key chunk size (50), pager size (25).
- Icons, empty-state copy, and whether tab labels show counts before data arrives.
- Where the members panel's header sits relative to the grid on narrow screens.
- Test fixture shapes for the fake CRM and Support services.

## 11. Open items

None blocking. The agent allowlist for `/touchpoints` (section 4.3) is a separate ruling.
