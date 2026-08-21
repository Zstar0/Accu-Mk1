# Catalog Foundation arc — merge & deploy plan

*Drafted 2026-08-13, after S2 (#103) and S3 (#104) closed out the build wave. Living document —
update as PRs merge and gates run. Companion to the 2026-08-10 umbrella spec in this directory.*

## 1. The PR graph

| PR | Branch | What | Base / order constraint |
|---|---|---|---|
| #93 | native-spec-ownership | lab-owned specs (+ coabuilder #8 pairs) | program chain |
| #94 | s2s-catalog-keys | IS registry feed (+ IS #27 pairs) | after #93; S5's dependency |
| #95 | native-parent-analyses-table | shared AnalysisTable | after #94 |
| #96 | native-parent-verification | promote/verify flow | after #95 |
| #97 | native-parent-placeholders | provenance `'ordered'` | after #96 |
| #98 | analysis-amendment-audit | ISO 7.5.2 before/after | **after #97 (stacked)** |
| #99-#102 | s1/s4/s6/s8 slices | roles-as-data · change log+snapshot · hygiene · adoption guard | siblings off `b30d9fc0`, any order after #98 |
| #103 | s2-worksheets-off-groups | departments own routing | sibling, any order after #98 |
| #104 | s3-identity-convergence | service-id identity | sibling, any order after #98 |

GitHub auto-retargets the six slice PRs as the chain merges. All six are siblings off the same
commit — expect trivial textual conflicts at their shared append points (see §2).

## 2. Merge playbook (documented conflict classes)

- **S1 + S4** (whichever merges second): migrations-list-tail textual conflict — keep both blocks,
  any order (all idempotent). Extend `VIAL_ROLE_LOG_FIELDS` with `color`/`short_label`/`badge_glyph`
  (one line, flagged in #100's body).
- **S2 + S3** (and any slice pair): the migrations-tail append class recurs — same resolution,
  keep both blocks in either order.
- **When S2 merges** (before or after S3): in S3's guard
  (`backend/tests/test_identity_convergence_guard.py`), DELETE the `main.py::list_worksheets`
  SHRINKING entry — S2 rewrites that block. Never weaken the assertion.
- **When S1 merges:** reclassify `seeder.py::select_services_for_role` in the same guard (its
  PERMANENT reason rests on the endo/ster in-code pin S1's roles-as-data model supersedes).
- S2 and S3 both touch `main.py`, `seeder.py`, `api.ts` in disjoint regions — conflicts, if any,
  are adjacency-textual, not semantic.

## 3. Pre-deploy gates (HARD — run before anything ships)

1. **S3 identity pre-check, BOTH environments, environment named:**
   `python scripts/s3_identity_precheck.py --env-label s3rehe` and `--env-label prod`
   (prod mechanism: `docker exec -w /app -i accu-mk1-backend python < script` with the label inline).
   - exit 2 = the EXISTING keyword index is missing → migration-mechanism integrity failure, stop and investigate first.
   - exit 3 = would-be violations of the new indexes → **human-decided dedupe before deploy** (rows reported, never auto-healed). This is the one genuinely manual backfill-class task in the arc.
   - Also review the **cross-origin keyword-collision diagnostic** in the same output (risk probe for the mk1 catalog-rescue legs; exit-neutral by design).
   - Local dev proves nothing — its catalog holds zero mk1 services.
2. **Clean worktree before running the deploy** (deploys tar gitignored files — standing trap).
3. JWT_SECRET untouched by this arc; no rotation window needed. Standard order Mk1→IS→WP applies
   only when the IS/WP pieces (S5 wave) ship later.
4. s3rehe only: burn the SENAITE counter past P-0155 before any E2E UAT that registers orders
   (standing collision trap — conveniently, the collisions themselves are S8's quarantine UAT scenario).

## 4. Backfills — what runs itself vs what needs hands

**Automatic at first boot (idempotent raw-SQL migrations + boot calls; heavy on prod's FIRST
deploy of the arc because prod has none of the catalog layer today):**
- departments + vial_roles tables and seeds; `backfill_departments` (ServiceGroup + AnalysisService
  `department_id`, incl. the ungrouped-analytical LIKE rescue)
- S1 display-face columns + parity-exact role seeds (triple-NULL guard protects admin edits)
- S4 `catalog_change_log` table + `lims_samples.catalog_snapshot` column
- S6 PUR_/QTY_ per-substance reconciliation (boot call + counts report)
- S2 `worksheet_items.department_id` + group-bridge backfill UPDATE
- S3 the two service-id unique indexes (+ post-boot `verify_identity_indexes` ERROR if absent)
- S8 `identity_collision` builtin flag seeded in both regimes

**Manual / human-decided (the complete list):**
- S3 violation dedupe IF the pre-check reports rows (§3.1) — the only data-repair backfill.
- S4 snapshots are deliberately NOT backfilled for historical samples — the admin
  `reprovision-snapshot` action is the lever, per ruling; order-edit removals on snapshot-covered
  profiles also take effect via reprovision.
- Historical NULL-group worksheet items stay NULL by design (read through the display chain).

**Explicitly not this arc:** the ~90 blank-logo certs (coabuilder re-render program), the ~70
unit="text" variance COAs (bulk-regen sign-off pending) — different programs.

## 5. Post-deploy verification checklist

- [ ] `pg_indexes` carries `uq_lims_analyses_sub_service_id_root` + `uq_lims_analyses_parent_service_id_root`; no `identity_index_missing` ERROR in boot logs
- [ ] boot `migration_skipped` lines reviewed once against the known-benign set (stale review_state CHECK)
- [ ] S6 `department_totality_report` / `GET /debug/catalog-departments` — totality after backfill
- [ ] S4: a catalog edit produces a `catalog_change_log` row
- [ ] S2: inbox lanes render per department; ServiceGroupsPage shows the Legacy banner; a group-only legacy payload still adds (bridge derive)
- [ ] COA gate: HM-carrying sample generates without a 422 (RULED exemption live); an Analytical unresolved analyte still blocks
- [ ] S3: retest on a drifted native row resolves by service id; catalog keyword edit no longer orphans native rows (P-1611 class)

## 6. UAT ledger (s3rehe, post-merge deploy)

From the 2026-08-13 handoff plus this build wave:
- S1 vial sub-line on native parent rows; usp71 badge everywhere
- S8 quarantine flow (uses the P-0147+ SENAITE counter collisions)
- S4 change-log rows + snapshot reprovision action
- S2: drag/drop round trip; prep-flag legacy fallback (one-time cosmetic loss accepted); department-less analyses invisible in lanes **until S6 totality lands** (self-heals — merge S6 in the same wave to moot it); NULL-bridge claim widening
- S3: resolved-keyword activity label on retest divergence (intended, user-visible); tier-0 join governs all mk1-read-source parent pages
- Deferred-minor backlogs live in each worktree's SDD ledger (`.superpowers/sdd/<plan>/progress.md`) — triaged pre-merge items are already in the branches; the rest ride

## 7. Rollback posture

- **S2's rollback unit is FE+BE together.** The inbox wire re-means `group_id` to department
  identity; an FE-only rollback (or a stale desktop client mid-window) sends department ids as
  `service_group_id` — the backend now rejects unknown gids with a 400 (fail-visible), but plan
  the deploy so FE and BE move together.
- **S3's indexes may safely outlive a code rollback** (older code satisfies keyword uniqueness;
  the residual same-service/different-keyword insert path needs fresh drift via a catalog rename
  in the window — pre-check-verified zero at deploy). Never DROP them by hand.
- All slice migrations are additive; no rollback migration exists or is needed.
