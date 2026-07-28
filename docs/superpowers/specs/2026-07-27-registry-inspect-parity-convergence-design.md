# Registry-inspect: full-log tab + parity convergence — design

*2026-07-27. Handler-approved via brainstorm (this doc supersedes and absorbs
`2026-07-27-registry-inspect-parity-convergence-stub.md`, deleted in the same
commit). Rides `feat/side-by-side-workflow-engine` — PR #84 grows; one deploy
ships the engine and this tooling together. Diagnostic-only, additive, zero
runtime impact on non-admin paths.*

## Why

The registry-inspect panel maintains its own hand-rolled diff (23 basic-info
fields via `backend/sub_samples/registry_debug.py`) while
`backend/scripts/parity_sample_details.py` already classifies the ENTIRE
payload — analyses field-level values (result/unit/method/instrument),
attachments, remarks, COA block, analytes, profiles, datetime normalization —
with 16 known-expected rules so real drift is never buried in noise. Both of
the 2026-07-25 week's data bugs (ANALYTE `result_unit='text'`, crossed
same-filename attachments) lived in payload regions the panel cannot see;
both would have been on-screen under the harness's classifier.

Burn-in triage also needs full histories, not tails: the panel shows the
last-5 transitions and only the LATEST shadow evaluation; diagnosing a
divergent sample means reading the whole trajectory (P-0140's five-row
lifecycle was pulled by hand over SSH during UAT).

## Decisions (brainstorm outcomes, Handler-confirmed)

1. **Grow PR #84** — build on `feat/side-by-side-workflow-engine`; the prod
   deploy is gated on this slice landing.
2. **Keep BOTH diffs.** They answer different questions:
   `registry_debug.py` = "is the Mk1 cache stale vs SENAITE right now?"
   (auto-loaded, one cheap `fetch_parent_metadata` call);
   parity = "would flipping the read source change what users see?"
   (on-demand, heavyweight). Nothing is retired. The harness remains the
   only rule engine — no rule logic is duplicated into the panel or the
   hand-rolled diff.
3. **Log lives in registry-inspect** (not the sample-details side panel):
   it is the admin diagnostic surface and already renders the truncated
   versions of both lists.
4. **UI structure = tabs** (`overview | log | parity`) in the existing
   terminal-styled Sheet. Overview stays byte-for-byte today's content.

## Backend

Both endpoints: admin-gated (`require_admin`), **sync `def`** (threadpool —
same posture and reasoning as the existing `/debug/sample-registry`
routes), under the existing prefix (deliberate deviation from the stub's
sketched `/api/registry/samples/{id}/parity`, for consistency).

### `GET /debug/sample-registry/{sample_id}/log`

Pure DB, no SENAITE I/O. Response:

```
{
  "sample_id": str,
  "exists": bool,            # false => both blocks empty, no 404
  "transitions": {
    "rows": [ {verb, from_status, to_status, source, occurred_at} ... ],
    "error": str|null,
    "latest_to_status": str|null, "log_in_sync": bool|null,
    "current_status": str|null
  },
  "trajectory": {
    "rows": [ {evaluated_at, trigger, verb, from_status, to_status,
               outcome, requirements_met,
               outcomes: [ {kind, value, met, detail} ... ]}  ... ],
    "error": str|null
  }
}
```

- `transitions`: ALL `lims_sample_transitions` rows for the parent, newest
  first (`occurred_at DESC, id DESC`). Implemented by giving
  `main._build_sample_transitions` a `limit` parameter (default 5 preserves
  the overview call site; `None` = unlimited for this endpoint). One query
  shape, two call sites.
- `trajectory`: ALL `lims_workflow_shadow_evaluations` rows, newest first
  (`evaluated_at DESC, id DESC`), via a new `_build_shadow_trajectory`
  helper. Rows carry the FULL `outcomes` list (met AND unmet — the
  overview's latest-only `_build_shadow_block` shows unmet-only and stays
  untouched).
- House failure posture: each block has its own try/except and its own
  `error` surface; a failure in one never blanks the other.

### `GET /debug/sample-registry/{sample_id}/parity`

The heavyweight on-demand scan. Thin adapter over the harness:

- Lazy-import `scripts.parity_sample_details` inside the handler (module
  has its own sys.path shim; keeps boot cost at zero).
- `mk1, senaite = fetch_pair_in_process(sample_id, SessionLocal)` then
  `diffs = compare_sample(mk1, senaite)`. `fetch_pair_in_process` opens and
  closes its own session; its internal `asyncio.run` is safe in a sync
  route (threadpool threads carry no event loop).
- Response:

```
{
  "sample_id": str,
  "fields": [ {path, classification, rule_id, mk1_value, senaite_value,
               is_real} ... ],   # ordered: real first, then known_expected,
                                 # then equal
  "summary": {"total": n, "equal": n, "known_expected": n, "real": n},
  "verdict": bool,               # real == 0
  "error": null
}
```

  Classifications are the harness's own vocabulary: `equal`,
  `known_expected` (+ `rule_id`), and the real kinds
  (`differing` / `mk1_only` / `senaite_only`; `is_real` mirrors
  `FieldDiff.is_real`). FastAPI's encoder handles datetime values.
- Whole body in one try/except: ANY failure (SENAITE down/504, lookup 404,
  import error) returns `{sample_id, error: str, fields: [], summary: null,
  verdict: null}`. Never a 500 to the panel.
- Zero writes: the native side is a pure read builder; the senaite side's
  lookup cache is an in-memory dict (verified `main.lookup_senaite_sample`
  reads `_senaite_lookup_cache` only when `no_cache=false`; DB untouched).
- SENAITE load = exactly one sample's fetches per click (analyses,
  attachments incl. ARReport probe). Acceptable for an admin single-sample
  action; the bulk-scan hazard stands — no sweep affordance anywhere.

## Frontend (`src/components/senaite/SampleRegistryDebug.tsx`)

- Tab row `overview | log | parity` under the title bar, same font-mono
  button treatment as the existing SENAITE/Accu-Mk1 source toggle. Defaults
  to `overview` on each open. Overview renders exactly today's content.
- **Log tab**: lazy-fetch `/log` on first activation per open (cached in
  component state; the header refresh button refetches the active tab).
  Two full-width stacked sections:
  - *Transitions*: every row newest-first; `log_in_sync` glyph in the
    section header (same ✔/⚠ vocabulary); `source` rendered as a
    color-coded badge (`mk1` / `senaite` / `reconcile` / `is_seed`);
    timestamps show DATE + time (histories span weeks).
  - *Trajectory*: per row `trigger · verb · from→to · outcome ·
    requirements_met`, outcome color-coded (`advanced` emerald,
    `requirements_unmet` amber, `no_edge`/`seeded` zinc). Row expands (▸)
    to the full outcomes list — kind, value, met ✔/✖, detail.
- **Parity tab**: opens to an explanation line + a `run parity scan`
  button + a "hits live SENAITE for this one sample" note. NOTHING fires
  on tab open — enforced by test. On run: spinner → summary line with
  counts + PASS / REAL-DIFFS verdict → buckets: real diffs first (red,
  `reg`/`sen` two-line values like the existing field diff),
  `known_expected` in zinc with the `rule_id` as a tag, `equal` collapsed
  to a count with an expandable path list. Result cached per open; re-run
  button provided.
- API client: `getSampleRegistryLog` / `getSampleRegistryParity` in
  `src/lib/api.ts`, typed, following the `getSampleRegistryDebug` pattern
  (which already carries the correct `/api` base — do not double it).

## Testing

- BE `tests/test_registry_debug_log.py`: >5 transitions → ALL returned
  newest-first; trajectory rows carry full outcomes (met + unmet);
  `exists: false` for unknown sample; per-block error surfaces; admin gate.
- BE `tests/test_registry_debug_parity.py`: monkeypatch
  `fetch_pair_in_process` → serialization shape, real-first ordering,
  summary counts, verdict; raised exception → error payload (not 500);
  admin gate. NO live SENAITE anywhere in tests.
- FE `SampleRegistryDebug.test.tsx` (extend): tab switching; log tab
  fetches on first activation only; parity tab makes NO network call on
  open; run button triggers fetch and renders buckets; error renders.
- Gates: the four side-by-side feature suites stay green; vitest + `tsc
  --noEmit`; full-suite failure-name diff vs master `9ba3e79` in the same
  venv must stay empty.
- Existing tests need zero edits: the only touched existing code path is
  `_build_sample_transitions` gaining a default-preserving `limit` param.

## Constraints

- Additive only; admin-gated; zero writes; SENAITE load = one sample per
  click (never a sweep — the SENAITE bulk-scan hazard stands).
- The harness stays the single source of truth for rules; the endpoint is
  a thin adapter. No rule logic duplicated into the panel.
- Overview tab behavior and payload are unchanged; existing
  `/debug/sample-registry/{id}` and `/refresh` routes untouched.

## Non-goals

- No "add known-expected rule" affordance — rules are code, authored in
  the repo.
- No light-mode/`--skip-report-pdf` flag on the parity fetch until latency
  actually annoys (YAGNI).
- No sample-details-panel entry point for the log.
- No retirement of the 23-field diff (kept per Decision 2).
