# Registry-inspect: full-log tab + parity convergence — SLICE STUB

*Captured 2026-07-27 during side-by-side UAT (Handler request). Status: STUB —
brainstorm → plan in a fresh session, build during the side-by-side burn-in
window. Diagnostic-only, zero runtime impact, additive.*

## Why

The registry-inspect panel maintains its own hand-rolled diff (the 23
basic-info fields via `sub_samples/registry_debug.py`) while
`scripts/parity_sample_details.py` already classifies the ENTIRE payload —
analyses field-level values (result/unit/method/instrument), attachments,
remarks, COA block, analytes, profiles, datetime normalization — with 16
known-expected rules so real drift is never buried in noise. Two diff engines
means the panel goes stale every time the harness learns a rule. Both of this
week's data bugs (ANALYTE `result_unit='text'`, crossed same-filename
attachments) lived in payload regions the panel cannot see; both would have
been on-screen under the harness's classifier.

Burn-in triage also needs full histories, not tails: the panel shows the
last-5 transitions and only the LATEST shadow evaluation; diagnosing a
divergent sample means reading the whole trajectory (cf. P-0140's five-row
lifecycle, pulled by hand over SSH during UAT).

## Feature 1 — Log tab

New tab on the registry-inspect panel showing, for one sample:
- the complete `lims_sample_transitions` log (all sources, newest first,
  source-badged: mk1 / senaite / reconcile / is_seed);
- the complete `lims_workflow_shadow_evaluations` trajectory (trigger, verb,
  from→to, outcome, requirements_met; unmet outcome details expandable).
Both queries already exist (`_build_sample_transitions`, `_build_shadow_block`
lookups — just unlimited + full list).

## Feature 2 — Parity convergence

Admin per-sample endpoint (e.g. `GET /api/registry/samples/{id}/parity`) that
runs `scripts.parity_sample_details.compare_sample` over
`fetch_pair_in_process(sample_id, SessionLocal)` and returns the classified
field list. Panel renders it: equal (green) / known_expected + rule id (grey)
/ REAL diff (red), replacing-or-absorbing the hand-rolled 23-field block.

Anchors:
- `compare_sample(mk1, senaite) -> list[FieldDiff]` and
  `fetch_pair_in_process` are importable today; the harness runs in-process
  in the backend container already.
- Cost note: the senaite side does live SENAITE fetches (analyses,
  attachments incl. ARReport probe) — acceptable for a single-sample admin
  panel action; make it on-demand (button), never auto-load, and never on any
  customer-facing path. Consider a `--skip-report-pdf`-style light mode flag
  on the fetch if latency annoys.
- FieldDiff serialization: path/classification/rule_id/mk1_value/
  senaite_value (same shape the harness JSON writes).

## Constraints

- Additive only; admin-gated; zero writes; SENAITE load = one sample per
  click (never a sweep — SENAITE bulk-scan hazard stands).
- The harness stays the single source of truth for rules; the endpoint is a
  thin adapter. No rule logic duplicated into the panel.

## Open questions for the design pass

- Retire `registry_debug.py`'s field diff entirely, or keep it as the
  no-SENAITE-call fallback when SENAITE is down? (The parity fetch needs
  SENAITE up; the current panel works degraded without it.)
- Where the log tab lives: inside registry-inspect vs the sample-details
  side panel.
- Whether the parity view should offer "add known-expected rule" affordance
  (probably not — rules are code, keep authoring in the repo).
