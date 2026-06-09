# Design: HPLC vial mirrors the parent's full analyte set (+ per-analyte prep bridge)

*Created 2026-06-08. Branch `subvial/continue` (PR #9). Production-behavior change — fixes the deferred blend-support gap in the sub-sample analysis seeder, now load-bearing post-Mk1-cutover.*

## Problem

Assigning a sub-sample vial to the **HPLC** role seeds the wrong analyses. The seeder (`backend/lims_analyses/seeder.py`) uses a fixed generic whitelist (`ROLE_TO_KEYWORDS["hplc"] = ["HPLC-PUR", "HPLC-ID"]`) plus the **Analyte-1-only** identity (`parent.peptide_name` holds only Analyte 1). For a multi-analyte blend (e.g. PB-0076 = GHK-Cu + BPC-157 + TB500) the vial gets only: `HPLC-PUR`, `HPLC-ID`, `ID_GHKCU`.

This is doubly wrong, verified against PB-0076's live SENAITE analyses:
- It seeds generic `HPLC-PUR`, which the **parent doesn't even have** (the parent carries `ANALYTE-1..4-PUR`).
- It misses all 14 of the parent's real Analytics-group rows: `ANALYTE-1..4-PUR`, `ANALYTE-1..4-QTY`, `PEPT-Total`, `BLEND-PUR`, `ID_GHKCU`, `ID_BPC157`, `ID_TB500BETA4`, `HPLC-ID`.

The seeder docstring flags this as a known deferred limitation ("blends … will only get the first analyte's ID service … Blend support can be added in a future phase"). It is now load-bearing because Model-D native vials have no SENAITE secondary-AR clone to fall back on — the seeder is the sole source of truth.

## Decisions (locked with the Handler)

1. **Mirror rule:** exact **1:1** of the parent's HPLC-group rows (per-analyte purity/quantity/identity, blend purity, generic peptide ID, peptide-total — whatever the parent carries in the Analytics service group).
2. **Scope:** **HPLC role only.** Endo/ster vials keep their current single-keyword seeding (`ENDO-LAL` / `STER-PCR`).
3. **Sync timing:** seed **at assignment, idempotent**. No continuous re-sync if the parent's profile later changes.
4. **Error handling:** **fail-hard.** If the mirror can't read the parent's analyses (or seeding errors), the role assignment fails atomically and surfaces the error — no silent half-seeded state.
5. **Prep bridge:** **included in this spec.** The bridge routes a vial prep's result to the correct per-analyte row.

## Key facts (grounded, don't re-derive)

- The parent's SENAITE analysis **keywords match the Mk1 catalog exactly** (`ANALYTE-1-PUR`, `ID_GHKCU`, `BLEND-PUR`, `PEPT-Total`, `HPLC-ID`, …). Keyword is the join.
- The **Analytics service group is id=1** (`service_groups`); Microbiology is id=2. Group membership (`service_group_members`) defines "HPLC/Analytics". `ENDO-LAL`/`STER-PCR` are Micro → excluded.
- The parent's SENAITE AR carries **`Analyte{N}Peptide`** fields (N=1..4) giving the slot→peptide map, e.g. PB-0076: 1=`GHK-Cu - Identity (HPLC)`, 2=`BPC-157 - Identity (HPLC)`, 3=`TB500 (Thymosin Beta 4) - Identity (HPLC)`, 4=None. Values are the identity-service titles.
- There are **no per-peptide purity/quantity services** — purity/quantity are **positional** (`ANALYTE-N-PUR`/`ANALYTE-N-QTY`). So routing a peptide's result requires its slot.
- `set_assignment_role` (`backend/sub_samples/service.py`) currently commits the role flip + `role_assigned` event FIRST, then seeds best-effort in a try/except that never rolls back.
- `lims_analyses` rows are deduped by a partial unique index on `(lims_sub_sample_pk, keyword)` — idempotency is enforced at the DB.

---

## Feature 1 — HPLC vial mirrors the parent's Analytics analyses

### Architecture

Replace the **HPLC branch** of `seed_analyses_for_vial`. Instead of the generic whitelist + Analyte-1 identity, read the parent's SENAITE analyses, keep those whose Mk1 `analysis_service` is in the Analytics group (id=1), and create a `lims_analyses` row per keyword on the vial. Endo/ster branches are unchanged. Idempotent via the existing `(sub_sample_pk, keyword)` dedup.

### Components

- **`mirror_parent_hplc_analyses(db, *, sub_sample, parent_sample_id, created_by_user_id=None) -> list[LimsAnalysis]`** (new, in `seeder.py`):
  1. Fetch the parent's analysis keywords from SENAITE (a small helper in `backend/sub_samples/senaite.py`, e.g. `fetch_parent_analysis_keywords(parent_sample_id) -> list[str]`, querying `senaite_catalog_analysis` by `getRequestID` and returning `getKeyword` values). Raises on SENAITE failure (drives fail-hard).
  2. Load Analytics-group services once: `select(AnalysisService).join(service_group_members).where(service_group_id == ANALYTICS_GROUP_ID)` → `{keyword: AnalysisService}`.
  3. For each parent keyword that maps to an Analytics service AND isn't already on the vial → `la_service.create_analysis(host_kind="sub_sample", host_pk=sub_sample.id, analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title, created_by_user_id=…)`.
  4. Return the inserted rows.
- **`seed_analyses_for_vial`**: for `role == "hplc"`, call `mirror_parent_hplc_analyses` instead of `select_services_for_role` + `_seed_peptide_identity_services`. The HPLC entry in `ROLE_TO_KEYWORDS` and the `_seed_peptide_identity_services` helper are retired (delete both; endo/ster keep their `ROLE_TO_KEYWORDS` entries). The seeder needs the `parent_sample_id` — thread it from the caller (already available in `set_assignment_role`/`_seed_analyses_if_role`).
- **`ANALYTICS_GROUP_ID`**: resolve the Analytics group id (don't hardcode 1 — look it up by `service_groups.name == "Analytics"`, cache acceptable).

### Data flow

`set_assignment_role(role="hplc")` → `seed_analyses_for_vial(role="hplc", parent_sample_id=…)` → `mirror_parent_hplc_analyses` → reads parent SENAITE analyses → filters Analytics group → creates `lims_analyses` on the vial.

### Error handling — fail-hard

Restructure the sub-sample branch of `set_assignment_role` so the role flip + `role_assigned` event + seeded analyses commit **atomically**:

```
flip sub.assignment_role; add role_assigned event   # no commit yet
if role and role != "xtra":
    seed_analyses_for_vial(...)                       # raises on failure (NO try/except swallow)
db.commit()                                           # role + event + analyses together
# on any exception: db.rollback() (implicit via teardown) → role NOT flipped → propagate
```

The route (`backend/sub_samples/routes.py:264`) surfaces the failure: SENAITE-unreachable → 502/503, other → 500. The user retries. This removes the current commit-first + try/except-swallow. Endo/ster seeding (local-only, no SENAITE) rides the same atomic commit; it only fails on a real DB error, which should surface anyway. Mirror the same atomic structure in the create path (`_seed_analyses_if_role`).

### Edge cases

- **Single-peptide / non-peptide samples:** mirror whatever Analytics rows the parent has — no special-casing. Unused `ANALYTE-4-*` placeholder rows are seeded because the parent carries them (true 1:1).
- **Other Analytics tests** (e.g. `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`) present on the parent are mirrored — the Analytics vial does all Analytics work.
- **Parent has no Analytics analyses:** nothing seeded (empty list, no error).
- **Re-assignment:** idempotent — existing keywords skipped; only missing rows added.

---

## Feature 2 — Prep bridge routes to per-analyte rows

### Problem

`prep_bridge.py` (the vial-prep result bridge) matches purity by `keyword == "HPLC-PUR"` and quantity by `QTY_*`. Post-mirror, HPLC vials carry `ANALYTE-N-PUR` / `ANALYTE-N-QTY` instead, so the bridge would no longer write purity/quantity. Identity already routes correctly (it prefers the specific `ID_<peptide>`).

### Architecture

Extend the bridge's category resolution + row selection to handle per-analyte rows, with a **slot resolver** and **backward-compat** fallback to the old generic rows.

### Components

- **Slot resolver** (`prep_bridge.py` or a small helper): given the prep's `peptide` and the vial's `parent_sample_id`, read the parent's SENAITE `Analyte{N}Peptide` fields and return the slot N whose value matches the peptide (normalize both: strip ` - Identity (HPLC)` suffix, uppercase-alphanumerics via the existing `_norm`). Returns `None` if no match.
- **Category mapping** (`_category`): recognize the new keywords —
  - purity: `HPLC-PUR` (legacy) OR `ANALYTE-{1..4}-PUR`
  - quantity: `QTY_*` (legacy) OR `ANALYTE-{1..4}-QTY`
  - identity: `HPLC-ID` OR `ID_*` (unchanged)
- **Row selection** (per category, replacing the current "exactly one or skip"):
  - **identity:** unchanged — prefer the single `ID_<peptide>` over generic `HPLC-ID`.
  - **purity / quantity:** if the vial has `ANALYTE-N-*` rows → resolve the prep's slot N and pick `ANALYTE-N-PUR` / `ANALYTE-N-QTY`. If it has only the legacy generic (`HPLC-PUR` / `QTY_*`) → pick that (old vials). If the slot can't be resolved or is ambiguous → skip that category with a logged warning (never guess).
- **Not bridged:** `BLEND-PUR`, `BLEND-IDENT`, `PEPT-Total` — blend-level, not per-peptide. Left for manual/computed entry.

### Error handling — best-effort (unchanged stance)

The bridge stays wrapped by the caller's try/except + `db.rollback()` in `run_hplc_analysis` (the HPLC analysis is already committed; a bridge failure never loses it). The new SENAITE read for slot resolution is inside that boundary — if it fails, the bridge skips and logs; the result is still recorded. (Fail-hard applies to the **mirror**, not the bridge.)

### Idempotency

Unchanged — only `unassigned` rows are written; re-runs are no-ops.

---

## Interactions / backward-compat

- **Existing vials** seeded by the old logic keep their `HPLC-PUR`/`ID_*` rows (mirror is additive + idempotent; nothing is removed). The bridge's legacy fallback keeps them working.
- **Variance / family-state / overlay** consumers read `lims_analyses` by keyword; they already handle `ANALYTE-*`/`ID_*` (the parent overlay's `buildVialAssignmentMap` matches by keyword). No change expected — the live verification will confirm.

## Testing

**Feature 1 (mirror) — backend unit (`tests/test_seeder_mirror.py` or extend existing):**
- Blend parent (3 analytes, 4-slot package) → vial gets all Analytics rows (`ANALYTE-1..4-PUR/QTY`, `PEPT-Total`, `BLEND-PUR`, `ID_*` ×3, `HPLC-ID`), excludes `ENDO-LAL`/`STER-PCR`.
- Analytics-group filter holds (a Micro keyword on the parent is not mirrored).
- Idempotent re-run is a no-op; pre-existing keyword skipped.
- Fail-hard: SENAITE read raises → `set_assignment_role` propagates and the role is **not** committed (assert role unchanged after the failed call).

**Feature 2 (bridge) — backend unit (extend `tests/test_prep_bridge.py`):**
- Vial with `ANALYTE-1-PUR`/`ANALYTE-1-QTY` + `ID_GHKCU`, prep peptide = GHK-Cu (parent Analyte1Peptide=GHK-Cu) → purity→`ANALYTE-1-PUR`, quantity→`ANALYTE-1-QTY`, identity→`ID_GHKCU`, all `to_be_verified`.
- Slot resolution picks the right slot for a non-first analyte (BPC-157 → slot 2 → `ANALYTE-2-PUR`).
- Backward-compat: legacy vial with `HPLC-PUR` only → purity routes to it.
- Slot unresolved → purity/quantity skipped, identity still written; existing skip-ambiguous and idempotency tests stay green.

**Live (Handler standing pref):**
- Assign a blend sub-sample (e.g. a PB-0076 vial) to HPLC → the vial's analyses match the parent's Analytics table (per-analyte purity/quantity, blend purity, all identities, peptide ID, peptide total).
- Run a vial prep for one analyte → its result lands on the correct `ANALYTE-N-PUR`/`ANALYTE-N-QTY` + `ID_<peptide>`, reaching `to_be_verified`.

## Key files

| Concern | File |
|---|---|
| Seeder (mirror + retire generic HPLC branch) | `backend/lims_analyses/seeder.py` |
| Parent-analyses SENAITE read helper | `backend/sub_samples/senaite.py` |
| Fail-hard role-assign transaction | `backend/sub_samples/service.py` (`set_assignment_role`, `_seed_analyses_if_role`) |
| Role-assign route (error surfacing) | `backend/sub_samples/routes.py` (~264) |
| Prep bridge (per-analyte routing + slot resolver) | `backend/lims_analyses/prep_bridge.py` |
| Bridge call site (best-effort boundary) | `backend/main.py` `run_hplc_analysis` (`/hplc/analyze`) |
| Analytics group / catalog | `analysis_services`, `service_groups`, `service_group_members` (DB) |

## Out of scope

- Continuous re-sync of the vial when the parent's profile changes (decision 3).
- Endo/ster mirror (decision 2).
- Bridging blend-level rows (`BLEND-PUR`, `PEPT-Total`).
- Parent-tier analyst/single-vial attribution (separate deferred item).
