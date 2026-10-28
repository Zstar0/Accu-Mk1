# Customer Insights: design

Date: 2026-10-05. Status: approved in conversation (comps, data approach A, agent access option a); this document is the written spec for review.
Comps: [overview](assets/2026-10-05-customer-insights/overview.html) and [customer page](assets/2026-10-05-customer-insights/customer.html) (illustrative numbers, fictional customers).

## 1. Goal

Give the team, and our agents, one place to answer:

- How much does each customer spend, how often do they order, how many samples, which tests?
- Is a customer's spending dropping off? Who should we call?
- What share of customers re-order, how fast, and is that rate changing over time?
- What might be driving drop-off (late COAs, non-conforming results, retests)?

**Audience:** every Mk1 user (no role gating for now), plus the Hermes bots (Jarvis, TARS) through labmanager-mcp with the same data the UI shows, unanonymized (Handler ruling 2026-10-05).

**Success:**
- The overview's headline numbers reconcile with the 2026-10-02 WooCommerce SQL baseline (see section 9).
- The UI and the agents read the same endpoints, so a number in a bot's Slack digest matches the screen.

## 2. Definitions (one implementation, used everywhere)

- **Customer key:** the WooCommerce customer id; guests (customer id 0) are keyed by lowercased billing email. Matches the 2026-10-02 analysis.
- **Excluded accounts:**
  - test emails, the same `TEST_EMAILS` set the inbox uses (moved to one shared constant);
  - internal accounts, a configurable list of customer keys.
  - The 5 February launch accounts are NOT excluded by default. They sit behind an `exclude_launch_accounts` flag (default true on cohort views, false elsewhere), configured as a list of keys.
- **Paid order:**
  - a WooCommerce order with a paid date whose status is not pending, failed, cancelled, refunded or checkout-draft;
  - **net total** = order total minus refunds.
  - An order refunded in full drops out entirely.
- **Spend:** the sum of net totals, bucketed by **paid date in lab time** (`lab_tz`, America/Los_Angeles).
- **Testing order:** a paid order that submitted at least one new sample (it has an IS `order_submissions` row with samples, excluding transfers).
  - Orders that only buy Additional COAs or add-ons to existing samples count toward spend and the order count. They do NOT count as a re-order, because they create no new lab work.
  - *Decision to confirm in review.*
- **Re-order:** a testing order after the customer's first testing order.
- **Repeat rate (for a period):** customers whose first testing order was at least 60 days before period end and who placed a second one, divided by all customers whose first testing order was at least 60 days before period end. The 60-day maturity window keeps new customers from dragging the rate down.
- **Usual gap:** the median days between a customer's consecutive testing orders. It needs at least 3 orders (2 gaps); otherwise the default of 60 days applies.
- **At risk:** days since last testing order > max(2 × usual gap, 21 days), AND at least 2 testing orders ever. Ranked by trailing-12-month spend. "Overdue" = days since last ÷ usual gap.
- **Spend trend:** net spend in the selected period vs the immediately preceding period of equal length.
  - **Dropping:** down 40% or more, with at least $500 in the prior period.
  - **Growing:** up 40% or more.
  - **Steady:** otherwise.
  - **One-time:** a single paid order ever.

All thresholds live in one module (`backend/customer_insights/rules.py`) with a `ponytail:` note, so the lab can tune them.

## 3. Data architecture (approach A)

### 3.1 Integration Service: a WooCommerce order mirror

New IS table `wc_orders`: one row per WooCommerce order, money only (the IS already holds samples and tests in `order_submissions`).

| column | type | note |
|---|---|---|
| `id` | bigint PK | WooCommerce order id (same value as `order_submissions.order_id`) |
| `order_number` | text | |
| `customer_id` | bigint null | WC customer id, 0/null for guests |
| `billing_email` | text | lowercased |
| `status` | text | WC status |
| `currency` | text | |
| `total` | numeric(12,2) | |
| `discount_total` | numeric(12,2) | |
| `refund_total` | numeric(12,2) | sum of refunds |
| `coupon_codes` | text[] | |
| `date_created_gmt` / `date_paid_gmt` / `date_completed_gmt` | timestamptz | |
| `line_items` | jsonb | `[{name, product_id, qty, total, category}]` |
| `wc_date_modified_gmt` | timestamptz | for newer-wins upserts |
| `synced_at` | timestamptz | |

Indexes: `(customer_id)`, `(billing_email)`, `(date_paid_gmt)`.

**Line-item `category`** is set at sync time from the product and name:
- `testing`
- `additional_coa`: name LIKE `Additional COA%`, as in the 10-02 recipe;
- `variance`: name LIKE `Variance%`;
- `addon`: endotoxin, sterility, heavy metals post-order add-ons;
- `retest`
- `fee`
- `other`

**Sync follows the `wc_customer_sync` pattern exactly**:
- an adapter method `list_orders(page, modified_after)` plus `get_order(id)`;
- a one-time `backfill_orders` admin route;
- webhooks `order.created`, `order.updated` and `order.deleted`, HMAC-verified like `/wc/customer-*`, handled by thin handlers calling `handle_order_event`;
- newer-wins upserts on `wc_date_modified_gmt`;
- a nightly reconcile on the existing `wc_reconcile_scheduler`, which walks orders modified in the last 7 days to heal missed webhooks;
- sync state and webhook status on the existing `wc_sync_state`.

Refunds arrive as `order.updated` (WooCommerce updates the parent order), and the handler recomputes `refund_total` from `refunds[]`.

Out of scope for IS: no metrics, no API for the dashboards. IS only mirrors. Mk1 owns every computation, as it does for every other report.

Prod changes this needs, each with Handler sign-off:
- IS migration plus deploy;
- registering 3 WooCommerce webhooks on prod WordPress;
- running the backfill. WooCommerce paging at 100 per page covers about 4,000 orders in under 5 minutes; run it after hours.

### 3.2 Accu-Mk1: computation and API

New package `backend/customer_insights/`:
- `sources.py`: SQL readers.
  - **IS DB** (via `get_integration_db`, like other reports):
    - `wc_orders` for money;
    - `order_submissions` for samples and tests (expanding `payload->'samples'`: services flags, `variance`, native extras such as heavy metals, `analytical_test`, `analytes`);
    - `published_coa_results` joined to published primaries only (the Analyte Trends rule) for COA verdicts.
  - **Mk1 DB:** per-sample SLA met/missed from the same calculation SLA Performance uses (`sla_perf`), keyed to the order.
- `rules.py`: the definitions above as pure functions.
- `metrics.py`: pure builders (`summary`, `cohorts`, `at_risk`, `customer_rows`, `customer_dossier`, `churn_signals`, `changes`) over in-memory records. Fully unit-tested without a DB.
- `routes.py`: FastAPI router mounted at `/reports/customers`. Every response model declares every field (the FastAPI `response_model` trap), and each route gets a route-level serialization test.

Volume is small (about 800 customers, about 4,000 orders, about 15,000 samples). Each request loads the needed rows and computes in Python, with a 60-second in-process cache keyed by query params. No materialized tables until a measured need. *ponytail: full recompute per request; add a nightly snapshot table if p95 > 2 s.*

## 4. API (shared by UI and agents)

All `GET`, `get_current_user` auth.
- **Common params:** `period` (`30d|90d|6m|1y|all`) or `from`/`to` (ISO dates, lab time), `exclude_launch_accounts` (bool).
- **Money:** returned as decimal strings in USD.
- **Dates:** returned as ISO timestamps with the zone.

| Route | Returns |
|---|---|
| `/reports/customers/summary` | KPIs with prior-period deltas (active customers, revenue, paid orders, AOV, repeat rate, median days to 2nd order); monthly revenue split new vs returning; concentration (top 10, top 10%, repeat share, median/mean LTV); add-on attach rate new vs returning; first-order type vs repeat rate (accutry50 / other coupon / full price / with add-on) |
| `/reports/customers/cohorts` | first-testing-order month × months-since grid: cohort size and returning share per cell |
| `/reports/customers/at-risk` | at-risk customers with 12-month spend, orders, usual gap, last order, overdue ratio, monthly spend series (for the sparkline) |
| `/reports/customers/list` | paged, sortable customer rows: key, name, email, company, period spend, delta, lifetime spend, orders, samples, usual gap, last order, top 3 test types, status (at risk / dropping / growing / steady / one-time). Params `search`, `sort`, `dir`, `page`, `page_size` |
| `/reports/customers/{customer_key}` | the dossier: identity, KPIs with lab averages, monthly spend + samples series, order timestamps (rhythm strip), test mix vs all customers, top analytes with pass rate, recent orders with COA verdict + SLA met/late, orders table (total, discount, coupon, samples, tests, status) |
| `/reports/customers/churn-signals` | repeat-within-60-days rate split by: COA on time vs late, all conforming vs any non-conforming, retest vs none; each with n |
| `/reports/customers/changes?since=` | event feed for monitoring: `became_at_risk`, `spend_drop` (period-over-period beyond threshold), `first_reorder`, `returned` (an at-risk customer ordered again), `entered_top_decile`. Each event: customer key, name, type, detected_at, numbers that triggered it |
| `/reports/customers/orders` | one row per paid order: customer key, order id/number, paid date, net total, discount, coupons, categories, samples, tests. Paged JSON, `format=csv` |

`customer_key` is `wc:<id>` or `email:<address>` (URL-encoded), so guests are addressable.

`changes` is computed by comparing the rule outputs at `since` against now, so it needs no event store.
*ponytail: stateless diff; persist events if bots need an audit trail.*

## 5. UI

Under AccuMark Tools > **Customers**, which gains two sub-items: **Insights** (new) and **All customers** (the existing list).

- **Insights page:** the overview comp.
  - Period picker; KPI strip.
  - Revenue new-vs-returning bars with a launch-accounts toggle.
  - Cohort grid.
  - At-risk table, with a shared rich hover card (shadcn `Tooltip` pattern) and a click to the customer.
  - Churn-signal bars showing n.
  - First-order, attach-rate and concentration cards.
  - Charts use recharts with a time axis in lab time (the Analyte Trends conventions); colors follow the existing report palette, with light-theme-safe tints.
- **All customers:** the existing `CustomerStatusPage` list gains the spend, delta, samples, usual gap, top tests and status columns from `/reports/customers/list`. The existing search and paging are kept, and guests become clickable through `email:` keys.
- **Customer page:** the empty **Dashboard** tab in `CustomerDetailView` (`CustomerStatusPage.tsx`) becomes the customer comp.
  - At-risk banner; KPIs vs lab average.
  - Spend + samples chart; order-rhythm strip.
  - Test mix vs all customers; top analytes linking to Analyte Trends.
  - "Their experience with us".
  - The existing Customer Orders tab gets total, discount and coupon columns.

States: loading, empty (no paid orders yet), and an error banner with retry. A data-freshness line ("orders synced 4 min ago") reads `wc_sync_state`.

## 6. Agent access

- Add every `/reports/customers/*` route, plus `/reports/analyte-trends` (missing today), to the labmanager-mcp `reports_get` allowlist. No new tools and no new credentials: reads use each bot's existing Mk1 login.
- Document in the tool description the intended monitoring loop:
  1. poll `changes?since=<last run>` daily;
  2. raise a Flag or post a digest for `became_at_risk` and `spend_drop`;
  3. use `/{customer_key}` for context.
- Bots see the same unanonymized data as the UI (ruling (a)). Anything they post to Slack carries customer names and spend, so the digest channel should be internal.

## 7. Phasing (each phase ships independently)

1. **IS order mirror:** model and migration, adapter methods, webhooks, backfill route, reconcile, tests. Deploy, register webhooks, run the backfill after hours, verify counts against WooCommerce.
2. **Mk1 core:** `customer_insights` package, `summary` / `cohorts` / `at-risk` / `list` / `orders` routes, Insights page, upgraded All customers list.
3. **Customer page:** the dossier route and the Dashboard tab, plus money columns on Customer Orders.
4. **Signals and agents:** `churn-signals` and `changes` routes and UI cards, MCP allowlist update, an example bot routine.

## 8. Testing

- **IS:**
  - unit tests for line-item categorization, refund netting and newer-wins upsert;
  - webhook handler tests with recorded WooCommerce payloads;
  - a backfill test against a fake adapter.
- **Mk1:**
  - `rules.py` / `metrics.py` unit tests covering guest keys, refunds, exclusions, the maturity window, the usual-gap fallback and the at-risk boundary;
  - route serialization tests for every endpoint;
  - vitest for page utils;
  - a Playwright spec on a devbox stack (screenshots into the PR, like Analyte Trends).
- **Prod acceptance (read-only, after phase 1):** see section 9.

## 9. Acceptance: reconcile with the 2026-10-02 WooCommerce baseline

On prod, with the same exclusions as that analysis, the new endpoints must reproduce within rounding:
- 782 customers since store open;
- September 2026 paid revenue $366.0K;
- repeat rate 24.0%, using that analysis's definition (any paid order after the first);
- median 10 days to the second order;
- top 10% = 85.8% of revenue.

Where the testing-order definition (section 2) differs from that analysis, the delta is shown and explained in the PR, not hidden.

## 10. Risks and open items

- **Testing order vs any paid order** (section 2): this decision changes the repeat rate. Confirm in review.
- **Stripe invoices sent outside WooCommerce aren't in WooCommerce,** so they're missing from spend. Small today; noted on the page.
- **Webhooks registered on prod WordPress are a production change,** and a missed delivery heals at the nightly reconcile (up to a day late).
- **The churn-signals view is correlation, not causation;** the UI says so and shows n.
- **Bot transcripts and Slack posts will contain customer PII** (accepted, ruling (a)).
- **Performance:** a full recompute per request is fine at current volume; revisit with measured p95.

## 11. Out of scope

Xero (ruled out for sales data), editing customers, emailing customers from Mk1, forecasting, per-product margin.
