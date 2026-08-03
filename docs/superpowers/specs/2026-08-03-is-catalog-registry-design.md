---
title: "Integration Service Catalog Registry — declared service keys sync from Mk1 instead of a redeploy"
date: 2026-08-03
status: draft
authors: [ZeroSignal, forrestp]
depends_on: "docs/superpowers/specs/2026-07-28-catalog-order-routing-design.md (spec 3, which introduced NATIVE_SERVICE_KEYS)"
part_of: "New-test-families program — removes the second of three per-family manual touchpoints"
---

# Integration Service Catalog Registry

## Summary

Today, adding a test family requires editing a Python literal in the Integration Service, rebuilding
the image, and deploying — **before** the WordPress product goes live, because the ordering is
load-bearing.

```python
# app/services/order_validator.py:162
NATIVE_SERVICE_KEYS: frozenset[str] = frozenset({"heavy_metals"})
```

This spec replaces that hand-maintained list with a **registry synced from Mk1's catalog**, cached in
the Integration Service, refreshed on a schedule, and readable on the order path without ever blocking
an order on Mk1 being up.

Net effect: **adding a family stops requiring an Integration Service deploy.**

### This is a correctness improvement, not only convenience

The check exists to catch WP↔IS drift. Its documented failure mode: WordPress sends `heavy_metals:
true` before the Integration Service knows the key, the key vanishes (Pydantic `extra` handling), the
order succeeds, the customer is charged, and no vial, no analysis and no error are produced anywhere.

But validating against a hand-copied list only answers *"is this key in a list someone maintained?"*
Syncing from the catalog answers the question that actually matters: **"is this key something Mk1 can
fulfil?"** That is the same question the seeder and demand resolver will ask minutes later, so
agreement stops being a matter of two humans typing carefully.

## Scope boundary

**In scope:** the Integration Service declared-key registry and the Mk1 endpoint that feeds it.

**Out of scope, explicitly:**

- The WordPress admin dropdown (slice 1a of [[project_mk1_commercial_layer_program]]). Handler ruling
  2026-08-03: WordPress comes after these systems are solid. The Mk1 endpoint below is nonetheless
  designed so that surface can consume it later without change.
- The WordPress ordering-wizard card grid. That is the actual wall blocking sale of a new family;
  this spec does not touch it and does not claim to.
- COABuilder spec ownership — its own spec
  (`docs/superpowers/specs/2026-08-03-native-spec-ownership-design.md`).

## The design decision that matters most

**The registry answers "is this key real?", never "is this key sellable?"**

Therefore the sync ingests **every** profile key from Mk1, regardless of `analysis_profiles.active`.

The temptation is to filter on `active` so retired products stop being orderable. Resist it. Sale
gating belongs to WordPress (the Test-Services entry and the product's publish state); Mk1's `active`
flag means *retired from the bench*, and its own semantics are explicitly "fulfilment of already-sold
orders continues." If the Integration Service rejected orders for a just-deactivated profile, a lab
admin toggling a checkbox in Mk1 would start losing live customer orders — a money-path failure caused
by a bench-side policy flag. Recognition and salability are different questions and must not share a
switch.

## Mk1 side: a new S2S catalog read

No S2S catalog endpoint exists today — every existing `require_internal_service_token` route is
sample-, peptide-request- or admin-scoped (`variance-payload`, `coa-sections`, `s2s/lims-samples`,
the peptide-request pair, the ClickUp admin pair). Add one, following the `/s2s/lims-samples` naming
convention:

```
GET /s2s/catalog/service-keys        →  require_internal_service_token
```

```json
{
  "keys": ["hplcpurity_identity", "bac_water_panel", "endotoxin",
           "sterility_pcr", "variance", "heavy_metals", "sterility_usp71"],
  "generated_at": "2026-08-03T18:20:00Z"
}
```

- Source: `analysis_profiles.key`, **all rows**, active or not (see above).
- Read-only, no pagination (the catalog is single-digit rows and will stay small).
- `generated_at` exists for observability and staleness reporting, not for conditional fetching.

## Integration Service side

### Storage — a singleton row, mirroring `wc_sync_state`

The Integration Service already has exactly this pattern: `wc_sync_state`
(`app/models/persistence.py:296-320`) is a singleton (`CHECK id = 1`) holding sync metadata plus a
JSONB payload. Copy it rather than inventing a shape.

`catalog_registry_state`:

| Column | Type | Notes |
|---|---|---|
| `id` | SmallInteger PK | `CHECK id = 1` singleton |
| `service_keys` | JSONB NULL | The synced key list |
| `last_sync_at` | timestamptz NULL | |
| `last_sync_outcome` | String NULL | `ok` \| `failed` |
| `last_sync_error` | String NULL | Truncated |
| `key_count` | Integer NULL | Cheap drift signal |
| `updated_at` | timestamptz NOT NULL | |

Persisting rather than caching in memory only is deliberate: **a restart must not require Mk1 to be
reachable.** Unlike Mk1, the Integration Service uses alembic (`migrations/versions`), so this needs a
migration, applied manually in production per the existing deploy discipline.

### Resolution order — and the boot floor

```
KNOWN_SERVICE_KEYS = pydantic field names
                   ∪ pydantic aliases
                   ∪ NATIVE_SERVICE_KEYS      ← kept, as the FLOOR
                   ∪ synced catalog keys      ← new
```

**`NATIVE_SERVICE_KEYS` is not deleted.** It stops being the authority and becomes the boot floor. The
consequence is the property that makes this change safe to deploy: **the worst case is exactly today's
behaviour.** An empty database plus an unreachable Mk1 degrades to the current hardcoded set rather
than to "reject everything" (which loses orders) or "accept everything" (which resurrects the silent
drop).

The pydantic aliases must stay in the union too — legacy WordPress wire keys like
`hplcpurity&identity` are model aliases, not profile keys, so a catalog sync alone would not cover
them.

### Startup: fetch fresh, in an explicit ordered fallback (Handler ruling 2026-08-03)

On boot the Integration Service **reaches out to Mk1 for a fresh full key list** rather than trusting
whatever it last stored. The fallback chain is ordered and explicit:

```
1. fresh fetch from Mk1 at startup   ← authoritative when it succeeds
2. persisted catalog_registry_state  ← last known good
3. NATIVE_SERVICE_KEYS frozenset     ← floor; never empty
```

Three properties of that chain are load-bearing:

**It must not block startup.** Blocking the lifespan on Mk1 means a Mk1 outage becomes an *order-intake
outage* — strictly worse than serving from a slightly stale cache, which is still correct and at worst
misses a family created in the last hour. The startup fetch is fire-and-forget against the existing
scheduler (`DateTrigger(now())`), exactly like `reconcile_startup`.

**It must retry, with bounded backoff.** This is the case a single startup attempt gets wrong. During
the combined deploy window Mk1 and the Integration Service restart together, so **IS very likely comes
up while Mk1 is still starting** — the most probable moment in the system's life for Mk1 to be
unreachable. One failed attempt followed by an hour of waiting would leave newly-added families
unrecognised for that hour. Retry the startup fetch a bounded number of times (proposed: 3 attempts at
roughly 10s / 30s / 60s) before falling through to the periodic schedule.

**Persistence is what makes step 2 exist, and it is not ceremony.** Without the stored row, a restart
while Mk1 is down drops straight to the frozenset — which by definition does *not* contain any family
added since the last IS image was built. That is precisely the failure this spec exists to remove, and
a combined-deploy restart is when it would fire. The `catalog_registry_state` row earns its migration
on that case alone.

### Reading on the order path

The cache is the mechanism. A live fetch is a **freshness optimisation only**, and its value is narrow
and worth stating honestly: a key already cached passes either way, and a typo is correctly rejected
either way. The live call only helps for a family minted in Mk1 since the last refresh.

Rules:

- **Timeout ≈ 2 seconds.** The adapter's existing default is 15s
  (`app/adapters/accumk1.py`), which is unacceptable on a checkout webhook.
- **The fallback must trip on timeout, not only on connection error.** This is the bug people write in
  this pattern.
- **Any live-fetch failure is a warning, never an order rejection.** Fall through to the cache.
- A successful live fetch opportunistically refreshes the stored row.

### Refresh job

Register on the **existing** `AsyncIOScheduler` singleton
(`app/services/wc_reconcile_scheduler.py`) — no new dependency, no new lifecycle:

- `catalog_sync_startup` — `DateTrigger(now())`, fire-and-forget, with the bounded retry described
  above (3 attempts, ~10s / 30s / 60s) so a combined-deploy restart does not leave the registry stale
  for an hour.
- `catalog_sync_periodic` — hourly.
- Its own `asyncio.Lock` and `max_instances=1`, matching the reconcile job.
- A manual `POST /admin/refresh-catalog` mirroring `POST /admin/reconcile-customers`, including the
  **409 on lock contention**.

### Never shrink on failure

A failed or empty fetch **must not** clear or reduce the stored key set. Only a successful fetch
returning a well-formed non-empty list replaces it. A fetch that returns `{"keys": []}` is treated as
suspect and logged as a failure rather than applied — an empty catalog is far more likely to be a bug
than a real state, and applying it would reject every native order.

This is the single most dangerous failure mode in the design and deserves its own test.

## What does not change

- `SampleServices` keeps `extra="allow"` (`app/models/order.py:120-161`). Rejecting at parse time
  would 422 **before** the `order_submissions` row is written, leaving the rejection unrecorded —
  the exact reason spec 3 moved the check into the validator.
- Both existing check sites keep their current semantics: the submit path records a
  `validation_failed` rejection (`order_validator.py:465-488`); `/order-services-updated` returns HTTP
  400 (`webhook.py:1192-1206`). Only the *set* they consult changes.
- Unknown keys stay loud. Nothing here weakens the anti-silent-drop guarantee.

## Deploy order and rollback

**Mk1 first, then the Integration Service.** Partial deploy is safe in that direction: an IS that
cannot reach the endpoint (404 or otherwise) logs a failed sync and falls back to the boot floor, which
is today's behaviour. Deploying IS first is merely inert, not harmful — but Mk1-first means the first
sync succeeds.

Rollback is the stored row: clear `service_keys` and the union collapses to the boot floor. No image
revert required, which is a notably better rollback story than most of this program.

Attaches to the ONE combined deploy window; no independent deploy.

## Observability

- Log `catalog_sync_ok key_count=N` / `catalog_sync_failed reason=…` on every run.
- Log at WARNING when an order is validated against a cache older than 24h — the condition that means
  the scheduler has silently died.
- Log `catalog_key_accepted_via_floor key=…` when a key passes **only** because of the frozenset
  floor: that means the sync has not seen a key the code still hardcodes, which is the drift signal
  worth watching after the first deploy.

## Test plan

| Case | Expected |
|---|---|
| Key present in synced cache | accepted |
| Key absent everywhere | recorded `validation_failed` (submit) / 400 (services-updated) |
| Live fetch returns a key not yet cached | accepted, cache refreshed |
| Live fetch times out | falls back to cache, order accepted, warning logged |
| Live fetch raises | falls back to cache, order accepted |
| Sync fails | previous `service_keys` retained, unchanged |
| Sync returns `{"keys": []}` | treated as failure, cache retained |
| Empty DB + Mk1 unreachable | boot-floor keys still accepted (== today) |
| Startup fetch succeeds | stored row replaced with the fresh full list |
| Startup fetch fails all retries | previous stored row still served; floor union intact; startup completes |
| Mk1 unreachable at boot, then reachable | a retry (or the hourly job) lands the fresh list without a restart |
| Restart while Mk1 is down, with a populated stored row | keys added since the last IS image are STILL accepted — the case persistence exists for |
| Mk1 slow to start during a combined deploy | startup retry backoff covers it; no hour-long stale window |
| Legacy alias `hplcpurity&identity` | accepted (alias union preserved) |
| Deactivated profile in Mk1 | still accepted — recognition ≠ salability |
| Two concurrent refreshes | second returns 409 |

The deactivated-profile case is the one most likely to be "fixed" into a regression by a future
reader; it gets an explicit comment citing this spec.

## Risks

| Risk | Mitigation |
|---|---|
| Live fetch adds latency to order acceptance | 2s timeout; fallback on timeout *and* error; cache is the mechanism |
| A bad sync empties the registry and rejects every native order | Never shrink on failure; empty result treated as failure; boot floor |
| Scheduler dies silently, cache goes stale | Staleness WARNING at 24h; `key_count` on the row; manual refresh endpoint |
| Blocking startup on Mk1 turns a Mk1 outage into an order-intake outage | Startup fetch is fire-and-forget with bounded retry; the lifespan never awaits it |
| IS boots before Mk1 during a combined deploy | Startup retry backoff + persisted last-known-good; the frozenset is the floor, never the working set |
| Someone filters the sync on `active` | Explicit test + comment; called out as the top design decision above |
| Mk1 endpoint leaks catalog data | `require_internal_service_token`, same guard as the other eleven S2S routes; keys are not sensitive |
| Registry drifts from what WP can actually sell | Out of scope by design — sale gating is WordPress's job, not this registry's |

## Open questions

1. **Refresh cadence.** Hourly is proposed. A new family becomes orderable within an hour of creation
   without the live-fetch path; the live fetch closes that window for the impatient case. Faster is
   cheap but pointless given WordPress work must happen anyway.
2. **Should `/s2s/catalog/service-keys` return richer data** (labels, `is_addon`, `active`) in
   anticipation of the WordPress dropdown reading it later? Recommendation: **no** — ship the minimum
   the registry needs. Widening a response is additive and cheap; guessing WordPress's needs before
   that slice is specced is not.
