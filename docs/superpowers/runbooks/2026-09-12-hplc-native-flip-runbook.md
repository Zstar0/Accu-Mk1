# HPLC native-born — production flip runbook (draft, 2026-09-12)

Spec: `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` §Flip runbook. This runbook is the executable version, updated for what was actually built. Every step is read-only or reversible except the flip itself (step 6), which is one WordPress admin field and reverts by clearing it.

## 0. What ships, in deploy order (all behaviour-neutral until step 6)
| # | Repo / branch | PRs | Notes |
|---|---|---|---|
| 1 | Accu-Mk1 `feat/hplc-native-slice1…6` | #192 ← #193 ← #195 ← #196 ← #197 ← #198 | one image; boot migrations: `lims_analyses.peptide_id/slot`, widened unique indexes, `lims_native_id_sequences` P=5000/PB=1000, `lims_registry_signal_keys`, `lims_samples.retest_of_sample_id` |
| 2 | COABuilder `feat/native-wire-golden-optional-senaite` | (open) | no behaviour change in mk1 mode; SENAITE creds become optional |
| 3 | Integration Service `feat/hplc-native-routing` → `feat/hplc-native-relay-peptides` | (open, stacked) | env: `ACCUMK1_BASE_URL` + `ACCUMK1_INTERNAL_SERVICE_TOKEN` now REQUIRED; new `LIMS_NATIVE_ROUTING_DISABLED` (unset), `PEPTIDE_LIST_SOURCE` (senaite) |
| 4 | wpstar `feat/hplc-primary-alias-set` | (open) | pure key logic; no CSS/markup (no WPSTAR_VERSION buster) |
| 5 | accumark-stack PRs #2→#3→#4 | (open) | devbox only |

Deploy with the `accumark-deploy` skill in the order Mk1 → COABuilder → IS → wpstar (no JWT rotation). Merge the whole chain only when the Handler lifts the no-merge ruling; the devbox rehearsal (step 1) happens on the stacked branches.

## 1. Devbox rehearsal (stack `priority` or a fresh stack) — REQUIRED before prod
Mount Mk1 slice 6, IS slice B, coab C1, wpstar WP-0 on one stack (see the stack handoff doc for `mount`/env gaps; IS→Mk1 wiring is in stack PR #2). Then run the golden matrix from the spec §Verification, collecting per case: Mk1 rows, wire doc, coab PDF p1/p2 + `data_sources`, AccuVerify JSON, WP order page, IS `sample_status_events`, SENAITE search = 0.
- single peptide · 3-peptide blend (alias case) · single + endo85 + PCR · variance n=3 · retest of a native original with AutoCheckin · relabel on native-born · identity FAIL · unresolved analyte (expect COA abort + relabel) · rollback drill (clear `profile_key` mid-window; legacy order lands; native finishes; no adoption) · regression: one Bac Water order and one legacy in-flight sample unchanged.
Exit criteria: every case green; the pre-flip watch queries (step 7) empty.

## 2. Pre-flip probes (prod, read-only)
```sql
-- catalog
SELECT keyword, origin, department_id, active FROM analysis_services WHERE keyword LIKE 'HPLC-%';              -- 5 rows, origin mk1
SELECT id, key, active, coa_archetype, vials_required, fulfillment_role FROM analysis_profiles WHERE key='hplc-purity-identity';  -- archetype NULL, role hplc
SELECT COUNT(*) FROM analysis_profile_members m JOIN analysis_profiles p ON p.id=m.profile_id WHERE p.key='hplc-purity-identity';   -- 5
SELECT s.keyword, sp.rule_kind, sp.min, sp.equals FROM analysis_service_specs sp JOIN analysis_services s ON s.id=sp.analysis_service_id WHERE s.keyword LIKE 'HPLC-%';  -- purity/blend ≥98, quantity/total informational, identity equals Conforms; no duplicate active spec per (service,tier)
-- counters above SENAITE max
SELECT prefix, next_value FROM lims_native_id_sequences WHERE prefix IN ('P','PB');
SELECT MAX(CAST(SUBSTRING(sample_id FROM 3) AS int)) FROM lims_samples WHERE sample_id ~ '^P-[0-9]+$';
SELECT MAX(CAST(SUBSTRING(sample_id FROM 4) AS int)) FROM lims_samples WHERE sample_id ~ '^PB-[0-9]+$';
-- authority + coa
SELECT value FROM settings WHERE key='registry_read_source';   -- every key mk1, incl. sample_status; coa_generation mk1
-- indexes widened
SELECT indexname FROM pg_indexes WHERE tablename='lims_analyses' AND indexdef LIKE '%COALESCE%';   -- 5 root indexes
```
- IS: `GET /s2s/catalog/service-keys` (from IS, service token) lists `hplc-purity-identity`; IS admin registry refresh shows it; IS env has `ACCUMK1_BASE_URL` + token (never print).
- Regen a wire doc for one recent legacy sample → zero `HPLC-*` rows (the shim only fires for native-born).
- COABuilder `/version` ≥ the C1 release; Mk1's vendored conformance mirror refresh ticket status (parity was proven on the real engine in C1).

## 3. Enable the Mk1 profile
Admin UI → Analysis Profiles → `HPLC Purity + Identity` → active. (Seeded inactive on purpose.) Confirm it now appears in Manage Analyses and in IS's registry within the hour (or trigger the refresh).

## 4. Peptide list from Mk1 (optional in this window)
IS env `PEPTIDE_LIST_SOURCE=mk1`, restart IS, WP admin "Sync peptides" — check the dropdown shows the catalog names. If the list is empty, leave `senaite` until the mirror is populated (IS logs `peptide_registry` errors).

## 5. Rendered-page check (before the flip)
Open the portal submission page with wpstar WP-0 deployed: primary card, variance card, AccuShield price unchanged (Elementor-rendered page, not the template).

## 6. FLIP (one field)
WP admin → Test Services → HPLC Purity & Identity row → `profile_key = hplc-purity-identity` → save. Re-check step 5 immediately (the endo trap precedent: a row that gains a profile_key must not reclassify).
Rollback = clear the field. Emergency valve without a WP change: IS env `LIMS_NATIVE_ROUTING_DISABLED=1` + restart (maps the native key back to the legacy SENAITE profile).

## 7. Handler test order (WP-7133 precedent) — stop-the-line checks
Order: single peptide + endo85 + PCR + variance n=3 (then a blend).
1. Mk1: `lims_samples` row `external_lims_system='mk1'`, uid NULL, `sample_id` P-5xxx, `analytes` populated with `peptide_id`; `client_order_number` = WP-{n}.
2. IS: `order_submissions.sample_results[n]` = `{senaite_id: P-5xxx, status: created, lims: mk1, lims_sample_id: P-5xxx}`; no `senaite_error`.
3. SENAITE search `getId=P-5xxx` → 0.
4. Parent placeholders: per-slot trio + endo + PCR, no shadows (`provenance='ordered'`, `slot` set).
5. Receive in Mk1 → WP stepper shows Received (relay): `lims_sub_sample_events` has `native_status_relay_pending` + `native_status_relayed` for `receive`; IS `sample_status_events` row with `event_id = mk1-P-5xxx-receive-1`.
6. Vials carry the trio per slot; Process HPLC → bridge writes purity/quantity + identity `Conforms`; blend aggregates after the last slot.
7. Promote → parent rows carry `peptide_id/slot`; no `lims_senaite_tee_retries` row for the sample; verify → relay `verify`.
8. Generate COA → wire `legacy_rows.rows` keywords `ANALYTE-1-ID`, `HPLC-PUR`, `PEPT-Total` (blend: per-slot + `BLEND-PUR`); coab `data_sources.legacy_rows=mk1`; PDF p1 identity Conforms + purity/quantity; p2 endo/PCR; AccuVerify JSON has identity/purity/quantity + native_sections.
9. Publish → relay `publish` → WP Complete.
Watch queries (48 h):
```sql
-- relays that never resolved or failed
SELECT lims_sample_pk, details->>'transition' AS t,
       COUNT(*) FILTER (WHERE event='native_status_relay_pending') AS pending,
       COUNT(*) FILTER (WHERE event IN ('native_status_relayed')) AS relayed,
       COUNT(*) FILTER (WHERE event='native_status_relay_failed') AS failed
FROM lims_sub_sample_events WHERE event LIKE 'native_status_relay%'
GROUP BY 1,2 HAVING COUNT(*) FILTER (WHERE event='native_status_relayed') = 0;
-- unresolved analytes on native rows
SELECT lims_sample_pk, slot, reportable_reason FROM lims_analyses WHERE reportable_reason LIKE 'analyte_%';
-- tee retries for native-born (must be 0)
SELECT r.* FROM lims_senaite_tee_retries r JOIN lims_samples s ON s.id=r.lims_sample_pk WHERE s.external_lims_system='mk1';
```
Plus coab 422s in its log (`NativeSectionsValidationError`), IS `native_sample_minted` / failed-sample counts.

## 8. After the flip
- Legacy drain: `SELECT COUNT(*) FROM lims_samples WHERE external_lims_system='senaite' AND status NOT IN ('published','cancelled')` → 0 for 14 days before any SENAITE shutdown step.
- Remaining disconnect items: Bac Water panel native slice; retire `workflow/is_event_stream.py`; parity/registry-debug SENAITE reads already skip native; relay retry job ticket; Mk1 vendored engine mirror refresh; peptide-id sync into WP + Peptide Group (post-flip slices).
