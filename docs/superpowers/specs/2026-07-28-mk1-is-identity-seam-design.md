---
title: "Mk1 ↔ Integration Service identity seam — dual-key resolution"
date: 2026-07-28
status: draft
authors: [ZeroSignal, forrestp]
part_of: "SENAITE phase-out program (seam preparation). Independent of the new-test-families specs 1-3."
---

# Mk1 ↔ IS identity seam

## Summary

Make every Accu-Mk1 ↔ Integration Service endpoint resolve a sample from **either** the SENAITE
sample id **or** Accu-Mk1's native id.

Additive and inert on day one: callers keep sending exactly what they send today. The point is to
stop the two services that will outlive SENAITE from depending on SENAITE's identifier to talk to
each other, so the eventual cutover is a change to *what is sent* rather than a renegotiation of the
contract while orders are in flight.

The enabling change is small and slightly embarrassing: **Integration Service already receives Mk1's
native id and throws it away.**

## The problem

Every identifier crossing this seam belongs to the system being decommissioned.

| Direction | Call | Key |
|---|---|---|
| IS → Mk1 | `GET /samples/{sample_id}/variance-payload` (`backend/main.py:17752`) | SENAITE sample id — `webhook.py:752` passes `senaite_id` |
| IS → Mk1 | `POST /s2s/lims-samples` (`app/adapters/accumk1.py:328`) | `{"sample_id": "P-2001", "senaite_uid": …}` |
| Mk1 → IS | `fetch_sample_services(sample_id)` (`backend/sub_samples/service.py:1058`) | docstring: "the WP `services` dict for a **SENAITE sample**" |
| Mk1 → IS | explorer proxy `/orders/{order_id}/…`, `/samples/{sample_id}/additional-coas` | WP order number / SENAITE sample id |
| IS → Mk1 | `/peptide-requests/{request_id}` | a real UUID — the one clean key on the seam |

Spec 2 of the new-families program inherits this: its section payload is keyed by `sample_id`, which
is fine for Heavy Metals (it rides a peptide sample that has an Analysis Request) and breaks for any
fully-native, AR-less sample. That case was deferred there precisely because it needs this seam
fixed first.

## Three facts that shape the fix

**1. Mk1 already has a native identity.** `lims_samples.native_id` — `String(20)`, unique, indexed
(`backend/models.py:804`), format `aP-0001`, minted once and forward-only by
`backend/sub_samples/native_id.py:42` from the `lims_native_id_sequences` table. Its column comment
says "Internal-only … never customer-facing in this program," which is exactly the right property
for a service-seam key.

**2. Mk1 already sends it, and IS already ignores it.** `POST /s2s/lims-samples` returns
`{"sample_id", "native_id"}` (`backend/main.py:17833`). Searching Integration Service for
`native_id` returns **one hit — a docstring in the adapter** (`app/adapters/accumk1.py:320`). The
value is received by `order_processor.py:599` and discarded.

**3. Integration Service has no sample table.** `sample_id` is a bare indexed string on **eight**
tables: `coa_generations`, `ingestions`, `coa_access_logs`, `sample_status_events`,
`published_coa_results`, `verification_codes`, and `additional_coas` (as `senaite_sample_id`). There
is no canonical sample row anywhere in IS.

Fact 3 rules out the obvious approach. **"Migrate Integration Service to native ids" is not on the
table** — it would renumber eight tables including published certificates and verification codes,
which are citable customer-facing records. A mapping is the only sane move.

## Design

### Integration Service gains one small table

`sample_identities`:

| Column | Type | Notes |
|---|---|---|
| `senaite_sample_id` | String, **unique**, indexed, NOT NULL | e.g. `P-2001`, `BW-0012` |
| `mk1_native_id` | String, **unique**, indexed, nullable | e.g. `aP-0001`. NULL until Mk1 supplies one |
| `created_at` / `updated_at` | DateTime | |

Populated from the `/s2s/lims-samples` response Integration Service **already receives**. That is a
handful of lines at `order_processor.py:599` — persist what comes back instead of dropping it.

**The eight existing tables are untouched.** They keep `sample_id` as the SENAITE string. No
migration, no renumbering, no risk to published records.

### A resolver on each side

Both services gain one function: *given an identifier of either kind, return the sample.*

- **Integration Service** resolves an incoming identifier through `sample_identities` to the
  `sample_id` string its internal tables already use.
- **Accu-Mk1** resolves against `lims_samples.sample_id` or `lims_samples.native_id`.

**Resolve by lookup, never by parsing the string.** It is tempting to discriminate on shape —
native ids start `aP-`, SENAITE ids start `P-` or `BW-`. Do not. Prefix rules are exactly the class
of fragile string coupling this program has been removing everywhere else, and a future id scheme
would break them silently. Try both columns; if both match different rows, that is a data defect and
must raise, not pick a winner.

### Nothing changes on the wire today

Callers keep sending SENAITE sample ids. Endpoints simply become tolerant of the alternative. The
flip — changing what callers *send* — is a separate, later decision, and by then it costs one line
per call site instead of a cross-service contract negotiation.

## Coverage and backfill

`native_id` is **nullable and forward-only**, so historical samples may not have one. Nothing may
depend on native-id resolution until coverage is established.

1. **Measure first.** Count `lims_samples` rows with NULL `native_id` in production before writing
   any backfill. Do not assume.
2. **Backfill Mk1** native ids for existing samples, minted through the same
   `lims_native_id_sequences` path so uniqueness holds.
3. **Backfill `sample_identities`** in Integration Service from Mk1.

Backfills follow the discipline the phase-out program's earlier sweeps already proved: throttled,
resumable, checkpointed, idempotent, dry-run first, per-row commits. Note the recorded trap that the
checkpoint key convention is `last_pk`, and that an empty log or a `created: 0` line reads as a false
failure — an advancing checkpoint is the real health signal.

Until coverage is proven, the resolver falls back to the SENAITE id and the seam behaves exactly as
it does today.

## Ride-along fix: the order-reference prefix

The second identifier on this seam does not round-trip. `client_order_number` and
`sample_status_events.order_ref` carry the `WP-` prefix (`WP-4530`, `WP-2969`), while
`/explorer/orders/{order_id}` expects the bare WooCommerce order id (`4530`). That mismatch produced
a real 404 — the Lab Manager agent's first live run returned null order and customer because of it.

Normalize in **one** place, on the Integration Service side, and accept both forms. This is a small
defect on the same seam and fixing it separately would mean touching these call sites twice.

## Deliberately deferred

- **Migrating Integration Service's eight tables** to native ids. Not needed, and not safe for
  citable records.
- **Flipping what callers send.** A later decision, cheap once both sides resolve either key.
- **Making `native_id` customer-facing.** It is deliberately internal.
- **The AR-less native sample flow itself.** This spec removes the identity blocker; the flow is
  still its own work.

## Risks

| Risk | Mitigation |
|---|---|
| Something relies on native-id resolution before coverage exists | Measure NULL coverage in prod first; resolver falls back to the SENAITE id; nothing flips until backfill is verified |
| A resolver that silently returns nothing turns a bad id into a "no data" answer | An unresolvable identifier must raise a loud 404, never an empty result. This is the fail-open class the program keeps converting |
| Both columns matching different rows | Treat as a data defect and raise; never pick a winner |
| Identifier-shape parsing creeping in | Stated as a rule: resolve by lookup only |
| Backfill load against SENAITE | The backfill is Mk1-internal and Mk1↔IS only — no SENAITE reads, so the bulk-scan hazard does not apply |

## Testing

- Every seam endpoint resolves correctly given the SENAITE id **and** given the native id.
- A sample whose `native_id` is NULL still resolves by SENAITE id (pre-backfill behavior).
- An unknown identifier returns a loud 404 — never an empty payload.
- `sample_identities` upsert is idempotent; a repeated `/s2s/lims-samples` signal does not duplicate.
- Order-ref normalization round-trips both `WP-4530` and `4530`.
- Existing callers, unchanged, behave byte-identically (the day-one inertness claim).
- Backfill idempotency: re-running is a no-op.
- Additive proof: failure-set diff against master in the same virtualenv, never zero-failures
  (`architecture_mk1_test_baseline_failures`).

## Execution environment

Cross-repo (Accu-Mk1 + Integration Service). Rehearse on an isolated devbox stack mounting both
worktrees. Integration Service migrations are hand-applied Alembic in production — note the recorded
divergence that Mk1 uses `create_all` plus hand-rolled idempotent `ALTER`s while IS uses Alembic, so
the new table follows IS's convention. Integration Service must pass `ruff check . && mypy app`.

## Open questions

1. **Should `sample_identities` also carry `senaite_uid`?** Mk1 stores it and `/s2s/lims-samples`
   already sends it. Cheap to include and would make the table the single translation point for all
   three identifiers, but it is not needed for the dual-key goal.
2. **Does the native id need to reach WordPress?** Not for this spec. WordPress joins on order
   number, not sample id, so probably never.

## Cross-references

- `backend/models.py:804`, `backend/sub_samples/native_id.py:42` — native id and its minting
- `backend/main.py:17833` — the `/s2s/lims-samples` response already carrying `native_id`
- `integration-service/app/adapters/accumk1.py:298-340`, `app/services/order_processor.py:599` — the
  discard site
- Spec 2 (`2026-07-28-native-coa-sections-design.md`) — deferred the AR-less sample case to this seam
- SENAITE phase-out program — this is seam preparation, not a mirror slice
