# Per-vial certificates: one real COA per used vial

Date: 2026-10-20. Status: design for Handler sign-off. Owner: Handler.

## Why

On a variance lot every vial is a physical sample of its own. Today a vial
certificate is a thin thing: the vial's HPLC figure dropped into a legacy-only
document with no native sections, produced only for vials that carry HPLC
figures, with a separate "Core COA" that re-renders the primary without the
variance table. The Handler's ruling (2026-10-20):

- a vial certificate is generated the same way as a normal, non-variance COA,
  carrying every result that pertains to that vial (endotoxin may sit on one
  vial only, and that vial may have no HPLC results at all);
- no certificate is generated for a vial that carries no results;
- the Core COA child is no longer produced (the primary already carries
  everything the Core had);
- vial certificates are produced on every normal Generate and regen, and a
  normal Publish publishes them.

## Facts the design rests on (read from the code)

- Rows live on two tiers. A vial-tier row has `lims_analyses.lims_sub_sample_pk`
  set; a parent-tier row has `lims_sample_pk` set and `lims_sub_sample_pk` NULL.
  `lims_analysis_promotions` links each certified parent-tier row to the
  vial-tier rows that contributed to it (`parent_analysis_id`,
  `source_analysis_id`, `contribution_kind`). So a certified parent row knows
  which vial it came from.
- Certificates are built from parent-tier rows: `coa/native_sections.py`
  picks `_eligible_parent_row(parent_pk, service_id)` per profile member,
  `coa/legacy_rows.py` shapes `list_parent_analyses_senaite_shape` (parent-hosted
  rows of both provenances), and `coa/sample_meta.py` resolves image and
  chromatogram, already vial-aware.
- On a variance lot the parent-tier HPLC rows are the aggregate; a vial's own
  HPLC figure comes from its vial-tier rows (`coa/variance_series.py::build_vial_figures`).
- COABuilder's vial mode (`scripts/server.py`, `is_vial_coa = bool(vial_figures)`)
  only swaps the HPLC figures (`conformance._apply_vial_figures`) and turns off
  the variance series and the additional-COA loop. It does not strip native
  sections or add-on results; those are empty today only because Mk1 sends
  `sections: []` for a vial body.
- The Integration Service publish cascade (`_publish_additional_coas`) publishes
  the draft children of the generation being published and supersedes a
  previously published child of the same vial. WordPress files a vial COA under
  `_accumark_vial_coas` and as a library row named after the peptide with a "Vial N" suffix, with the
  vial's own results, and sends no email for it.
- The customer-facing AccuVerify page renders a vial code like a primary
  (checked with TYKE-YCJU against BMBS-EFPR on 2026-10-20).

## The rule

Scope: variance lots only (`build_variance_replicates` non-empty), on every
path: the post-generate auto-run, regen, and the manual button. A non-variance
sample gets the primary only, as today.

Enumeration walks the vials, not the parent rows. For each `lims_sub_samples`
row of the parent, in vial order:

1. collect the vial-tier `lims_analyses` rows hosted on it
   (`lims_sub_sample_pk = vial.id`) that carry a result;
2. for HPLC on a variance lot, the vial's own figure comes from those rows
   through `build_vial_figures`, as today (the parent-tier HPLC row is the
   aggregate and is never printed on a vial certificate);
3. for every other row, follow its promotion links of kind `chosen` or
   `aggregated_in` (`lims_analysis_promotions.source_analysis_id = row.id`) to
   the parent-tier row, and keep that parent row when its review_state is
   verified or published. `reference` and `carried` links do not count:
   `reference` means looked at, not used; `carried` points at another
   sample's vial.

Why the lineage step cannot be skipped: verify is a parent-tier verb
(`_TIER_ALLOWED_KINDS`: vial tier has assign, submit, retract, reject, reset,
retest, auto, variance_verify, cancel; parent tier has verify and publish). A
vial-tier row is never `verified`, so the certifiable verdict and the spec
evaluation exist only on the parent row it was promoted into. Walking the
sub-samples guarantees no vial is missed; the promotion link is how each vial
row reaches its certified value.

A vial is used when step 2 or step 3 yields at least one result. Only used
vials get a certificate. A vial-tier result that was never promoted (for
example endotoxin run on two vials with one chosen for the lot) has no
certified verdict and does not appear on that vial's certificate. Parent-tier
rows with no vial lineage (SENAITE-mirror shadow rows, or a service promoted
from no vial) stay on the primary.

## Change set

### Accu-Mk1 backend (one PR)

1. `coa/wire_document.py`: `build_vial_wire_document(db, parent, vial)` builds
   the same document the primary gets, scoped to the vial:
   `build_native_sections(db, parent, vial=vial)` keeps a profile member only
   when its eligible parent row has a promotion from this vial, and omits
   profiles that end up empty (no "deferred" entry: the section does not belong
   to this vial); `build_legacy_rows(db, parent, vial=vial)` keeps the shaped
   rows with a promotion from this vial, and the HPLC rows keep being replaced
   by the vial's figures through `vial_figures` as today;
   `build_sample_meta(db, parent, vial=vial)` requires a chromatogram only when
   the vial carries HPLC figures (a missing chromatogram on a non-HPLC vial is
   not fatal, matching the primary's rule), and keeps the vial's own photo
   (1.49.4).
2. `coa/variance_series.py`: new `list_vials_for_certificates(db, parent)`
   walks every `lims_sub_samples` row of the parent (any assignment role) and
   returns `[(vial_sequence, vial_figures_or_None, parent_row_ids)]` for the
   used vials, in vial order, replacing `list_hplc_vials_with_figures` as the
   source set for the loop, the auto-run and the manual route. The manual
   route gains the same variance gate the auto-run already has.
3. `main.py::_generate_vial_coas_loop`: posts `vial_sequence` for every used
   vial and `vial_figures` only when the vial has HPLC figures; the body is
   otherwise the same as a primary's (remarks, aliases, scheduled date
   override).
4. `main.py`: the Core child stops being emitted. `_maybe_emit_regular_coa_child`
   stays but both call sites (`/generate-coa`, `regen-primary`) sit behind
   `COA_EMIT_REGULAR_CHILD`, default off. Existing Core COAs are untouched; the
   Mk1 "Core COA" card, the IS supersede kind and the WordPress Core rows
   stay for history.
5. `main.py::regen_primary_coa`: emits the vial drafts under the new primary
   before its publish step, so the cascade publishes fresh vial certificates
   and supersedes each vial's previous code.
6. `main.py::generate_vial_coas` (manual button): attaches to the newest draft
   primary when one exists so the next Publish carries the drafts; when the
   only primary is already published, publishes the new vial drafts straight
   through the IS cascade (same as the 2026-10-20 hand-run on P-5324).
7. Optional hardening: `publish-coa` refuses when the newest top-level draft is
   older than the live primary (the gen 1 trap of 2026-10-20).

Tests: a vial with endotoxin only gets a certificate with the endotoxin section
and no HPLC block and no chromatogram requirement; a vial with HPLC and
endotoxin gets both; an unused vial gets nothing; the Core child is not emitted;
regen emits vials; the manual route attaches to the newest draft or publishes
through the cascade; the parent certificate is byte-for-byte unchanged.

### COABuilder (one small PR, deployed first)

- Vial mode keys on `vial_sequence is not None` (with `parent_generation_id`),
  not on `vial_figures`; `vial_figures` becomes optional inside vial mode so a
  vial without HPLC renders its sections and add-on results only. Everything
  else in vial mode stays (no variance series, no additional-COA loop,
  registered as a vial child in the IS).

### Integration Service and WordPress

- No change. The IS vial kind is keyed on `vial_sequence`; WordPress already
  renders a vial row from the vial's own verify payload, so an endotoxin-only
  vial shows its endotoxin result and verdict. The AccuVerify mixed-lot purity
  coverage (coab 2.35.4, wpstar 2.61.0) must be checked against a vial child
  that has no purity figure before deploy; it should ignore such a vial, not
  count it as missing.

## Build notes (2026-10-20, what shipped differs from the plan)

- **HPLC-less vials are reported, not sent.** COABuilder refuses a
  certificate with no legacy results table (rule R-7, sample_meta without
  legacy_rows, and the empty-rows check in `extract_legacy_rows`), and on a
  native-born lot the legacy table holds only HPLC rows. So an endotoxin-only
  vial cannot render yet; the same is true of a primary with no HPLC today.
  Mk1 lists such vials under `blocked` in the manual route's response and
  logs them on the auto-run, never sends them, and does not fail the run.
  COABuilder PR #34 (vial mode keyed on vial_sequence) is held as a draft
  until a "native sections only" certificate is designed.
- **Legacy rows are not scoped.** On native-born lots they are the HPLC rows,
  which the vial's own figures replace; SENAITE-origin rows carry no vial
  lineage. Only native sections are scoped to the vial.
- **HPLC never prints from the parent on a vial.** Parent HPLC rows (trio
  categories and blend aggregates) are excluded from a vial's lineage set even
  when aggregated in from that vial; the vial's own figures are the HPLC.
- **Manual button on a published primary** calls the new IS route
  `POST /explorer/samples/{id}/publish-children` (IS 1.0.38), which runs the
  publish cascade for the live primary without re-publishing it.
- **Publish guard** shipped: Publish refuses (409) when the draft it would
  pick is older than the published primary; fails open if the IS can't be
  read.

## Deploy order

Integration Service 1.0.38 first (the manual route calls publish-children),
then Accu-Mk1 backend-only. COABuilder 2.35.5 is not needed until HPLC-less
vials are supported. No migration, no JWT change. Handler approval, after
hours.

## Risks

- A vial certificate now carries add-on sections. The first lot after deploy
  should be inspected vial by vial before Publish (the per-vial PDF button from
  1.49.6).
- SENAITE-born lots have no promotion lineage; their vials keep HPLC-only
  certificates until the SENAITE phase-out completes.
- Lots already published with a Core COA keep it; new publishes of the same
  lot produce none, so the customer's library will show the Core row as
  superseded only when the lab regenerates such a lot.

## How to revert

Redeploy the previous Mk1 backend image and the previous COABuilder image.
Certificates minted under the new rule stay valid; they are ordinary vial
children.

## Open assumptions for the Handler

- Only promoted results are certified: a vial-tier result that was never
  chosen or aggregated for the lot does not appear on its vial's certificate,
  because nothing verified it. Say so if an unpromoted but submitted result
  should print.
- A result `aggregated_in` from several vials appears on each contributing
  vial's certificate as that vial's own figure (HPLC), and a value `chosen`
  from one vial appears on that vial only.
- Vial certificates stay variance-only on every path; the manual button is
  gated the same way.
- The "Vial N" naming and numbering stay as they are; gaps from unused vials
  are fine.
