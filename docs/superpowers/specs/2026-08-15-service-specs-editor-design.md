# Analysis Service Specs Editor + Peptide Tier (native-spec-ownership slice 2)

*Designed 2026-08-15 with the Handler. Base: `b30d9fc0` (pre-slice chain; owns the specs table,
`service_spec_audit.py`, and the fail-closed native-sections reader). Branch:
`feat/spec-ownership-s2-specs-editor`, worktree `C:\tmp\Accu-Mk1-specs-editor`.*

## Why

The arcitest capstone (create the `heavy_metals` family end-to-end, zero code) dead-ended at COA
generation: the native-sections gate is fail-closed on `analysis_service_specs`, and the table has
**no authoring surface** — its only writers are the boot parity seeder (hard-coded to five legacy
keywords) and hand-SQL. Every new native family currently requires code or SQL for its specs,
contradicting the catalog program's self-service premise. `service_spec_audit.py`'s docstring
already reserved this slice: "the slice-2 admin editor tomorrow."

The Handler additionally ruled: specs must support **peptide-level** limits (results legitimately
differ peptide-to-peptide, and bac water differs from all of them), bound to the existing
**Peptides entities by FK** — never by name string.

## Ruled decisions

- **R1 (Handler):** full matrix support in v1, plus a peptide tier bound to `peptides.id`.
- **R2 (Handler, approach A):** one table — extend `analysis_service_specs` with `peptide_id`;
  no parallel table.
- **R3 (program, inherited):** every write calls `record_spec_change` (before/after AuditLog);
  rows are deactivated, never deleted; specs stay OUT of `catalog_change_log` (documented
  exemption — dedicated trail, not doubled).
- **R4 (controller, vetoable):** an unresolvable peptide NEVER aborts a COA — the peptide tier is
  skipped and resolution falls through to matrix/wildcard. The fail-closed abort fires only when
  no tier at all has an active row (today's behavior, preserved byte-for-byte).
- **R5 (controller, vetoable):** blend samples skip the peptide tier by design (multiple
  peptides, no single limit is coherent); they resolve via matrix/wildcard.
- **R6 (controller, vetoable):** the sample's peptide is anchored on its identity-analysis
  service's `peptide_id` FK (crisp), NOT `_fuzzy_match_peptide` on `peptide_name` (the PB-0272
  alias-gap class). No identity service or NULL FK → peptide tier silently skipped (R4).

## Data model

One alembic migration, additive:

- `ALTER TABLE analysis_service_specs ADD COLUMN peptide_id INTEGER NULL REFERENCES peptides(id)`.
- Row shapes (CHECK `ck_analysis_service_specs_tier`): peptide row (`peptide_id` set, `matrix`
  NULL), matrix row (`matrix` set, `peptide_id` NULL), wildcard (both NULL). Both-set forbidden.
- Active-row uniqueness, extending the existing partial-index pattern:
  - `uq_..._peptide` UNIQUE (analysis_service_id, peptide_id) WHERE active AND peptide_id IS NOT NULL
  - existing `uq_..._matrix` unchanged (matrix rows)
  - existing `uq_..._null_matrix` REPLACED by a wildcard index guarded on BOTH columns NULL
    (`WHERE active AND matrix IS NULL AND peptide_id IS NULL`) — the old index would collide
    peptide rows with the wildcard slot.
- `snapshot_spec()` gains `peptide_id`.

## Resolution (the one reader change)

`backend/coa/native_sections.py`: today's per-service lookup becomes a three-tier precedence
function (new, unit-testable, in `backend/catalog/` beside the audit module):

1. `(service, sample_peptide_id)` — sample peptide via the parent's identity-analysis service's
   `peptide_id` (R6); skipped for blends (R5) and unresolved peptides (R4).
2. `(service, normalize_matrix(parent.sample_type_title))` — unchanged from today.
3. `(service, wildcard)` — unchanged from today.
4. No active row in any tier → the existing fail-closed abort, message extended to name the
   tiers consulted.

No other consumer changes. Conformance evaluation reads whichever row resolution returned.

## API (main.py, existing route conventions + auth dependency)

- `GET /analysis-services/{id}/specs` — active rows, all tiers, peptide display name joined.
- `POST /analysis-services/{id}/specs` — create; tier inferred from which of peptide_id/matrix is
  present; 422 on rule-shape violations (range needs min and/or max; equals needs equals_value;
  both-set tier); 409 on active-row uniqueness conflict; matrix restricted to the
  `normalize_matrix` output vocabulary (no dead rows).
- `PATCH /analysis-service-specs/{spec_id}` — in-place field edits and `active=false`
  deactivation. No DELETE route exists (R3).
- Every mutation: before-snapshot → mutate → `record_spec_change(db, spec, before=..., actor_user_id=current_user.id)`.

## Editor UI (AnalysisServicesPage)

Each service row gains a **Specs** subsection (expandable): a table of active rows — tier chip
(peptide name / matrix / "All"), rule rendered readably ("≤ 0.5 µg/g", "= Not Detected"), unit,
display override, deactivate control — plus an add-spec form: tier selector, searchable peptide
picker bound to the Peptides entities (FK), matrix dropdown (normalize_matrix vocabulary), rule
kind, min/max/equals, unit, display override. Precedence explainer as a rich hover tooltip
(house FE default). Server state via TanStack Query following the page's existing hooks; no
Zustand. Spec-count badge on the service row so services with zero specs (the COA-abort class)
are visible at a glance.

## Testing

- Route tests: create/edit/deactivate per tier; audit rows carry correct before/after incl.
  `peptide_id`; 409 uniqueness per tier; 422 rule shapes; matrix vocabulary enforcement.
- Resolution tests: peptide beats matrix beats wildcard; blend skips peptide; unresolved peptide
  falls through; deactivated rows invisible; no-tier abort preserved (existing test untouched or
  extended, never weakened).
- Migration: fresh-create and upgrade paths; the replaced wildcard index verified against
  peptide-row coexistence.
- FE: page-level tests per existing AnalysisServicesPage conventions; `npm run check:all` gate.
- Full-suite gate: failure-SET diff vs the 68F/14E baseline (never zero-failures).

## Explicitly out of scope

- Per-peptide matrix combinations (`peptide_id` + `matrix` both set) — forbidden by CHECK until a
  real need exists.
- Any change to COABuilder's legacy BAKED_SPECS path or the conformance engine migration program.
- Spec history browsing UI (the AuditLog trail exists; a viewer is a future increment).
- Seeder changes — it stays idempotent and non-overlapping (keyed slots the editor also respects).

## Deploy notes

- Joins the merge train as a NEW slice PR stacked on the pre-slice chain (same base as S9);
  no interaction with S1-S9 files beyond `native_sections.py` (owned by the base chain, untouched
  by any slice branch — verified: no slice branch modifies it).
- arcitest activation for the capstone: mount the branch or cherry-pick onto the arc composition,
  then author the 4 HM specs through the UI (replacing the interim hand-SQL rows, which should be
  deactivated through the editor as its first real exercise).
