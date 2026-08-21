# S2 Sub-Spec — Worksheets/Inbox off Service Groups

*Sub-spec under the 2026-08-10 Catalog Foundation Hardening umbrella (Slice 2). Drafted
2026-08-11 from a full-code dossier (scratchpad s2-dossier.md); every claim below was verified
against `C:/tmp/Accu-Mk1-amendment-audit` @ b30d9fc0. ALL THREE Handler rulings LANDED
2026-08-12 (see ✅ RULED markers — note RULING 2 reversed the draft recommendation: HM no longer
blocks COA generation). Spec is build-ready.*

## Headline research corrections to the umbrella spec

1. **The 2026-07-28 "COA blocking gate" IS still service-group-keyed — found.** The ruling's
   `main.py:9779` line reference went stale (that's now `/peptides/with-service-set`). The gate
   lives at `main.py:10309` + `:10326-10337` → `lims_analyses/seeder.py:248-272`
   `_micro_group_keywords`, keyed by group **NAME** (`"Microbiology"`, `"Endotoxin"`) through
   `service_group_members`. It raises a hard 422 (`main.py:10387`), and its fail posture INVERTS
   on an empty keyword set: no groups → micro analytes start blocking every COA.
2. **`worksheets` has NO `service_group_id`** — only `worksheet_items` does (`models.py:904`).
   The umbrella's proposed `worksheets.department_id` has nothing to dual-read against, and
   `main.py:18429` proves worksheets legitimately span groups.
3. **Inbox lanes are ALREADY department-keyed** (`catalog/roles.py inbox_lanes` reads only
   VialRole + Department). `_inbox_allowed_group_ids` is a department→groups translation shim
   with ONE caller and ONE consumption site (`main.py:17948`) — deleting it is a bounded port.
4. **The department fallback precedent already exists** in the worksheet serializer
   (`main.py:18471-18513`, analyses_json[0].keyword → AnalysisService.department_id) — fine for
   display, NOT safe for stamping (reads only the first analysis).

## Design

### D1. Department lives at the ITEM tier only (resolves dossier Q1)

No `worksheets.department_id`. Add **`worksheet_items.department_id`** (nullable FK,
`ON DELETE SET NULL`) — additive alongside `service_group_id`, which becomes a frozen read-only
legacy column on historical rows. A worksheet's "department" is a display aggregation of its
items (already how `group_ids` works at `main.py:18429`). This is the cheapest true-to-code
option and avoids inventing single-department worksheets that `main.py:18429` disproves.

### D2. Item identity + the five copy-pasted `gid_filter` sites (Q2, Q3, Q12)

- New adds carry `department_id` on the wire (`AddToWorksheetRequest` gains optional
  `department_id`; precedence: `department_id` wins, both-present-and-disagreeing → 400;
  FE flips to sending `department_id` in the same wave, keeping `service_group_id` optional for
  rollback).
- The five verbatim `gid_filter` copies (`main.py:18725/18823/18861/18971/19092`) collapse into
  one helper `_item_scope_filter(sample_uid, department_id, service_group_id)` that matches on
  department when present, else legacy group — and every `scalar_one_or_none()` on that shape
  (`:18742/:18754/:18974/:19095`) becomes an ordered `.first()` with a logged
  `worksheet.item_scope_ambiguous` warning, because the many-to-one group→department collapse
  (Analytics+Core HPLC→Analytical, Microbiology+Endotoxin→Microbiology) can legitimately match
  two historical rows.
- The path-param routes `DELETE /worksheets/{id}/items/{sample_uid}/{service_group_id}` and its
  `/reassign` twin (`main.py:18961/:19081`, `0`-as-NULL sentinel) are **retired in favor of the
  by-id siblings** which already exist and are documented preferred (`main.py:19017-19024`; FE
  already uses them, `src/lib/api.ts:5232`). No `{department_id}` path twins are minted.

### D3. Stamping (Q4, Q5)

`stamp_for_item` / `clear_for_item` / `restamp_for_worksheet` gain `department_id: Optional[int]`
alongside `service_group_id`. `_resolve`'s filter becomes, in precedence order:

1. `department_id` provided → `AnalysisService.department_id == department_id` (direct column —
   no M2M fan-out; a service in two groups no longer matches twice).
2. else `service_group_id` provided → existing group join (legacy items, unchanged).
3. else → **wildcard: all live analyses on the vial** — `None` KEEPS its current wildcard
   meaning (`worksheet_analyst.py:36,47`); it never becomes a "department IS NULL" filter.
   Every historical group-less item keeps its behavior.

Department-less-service fallback for native families (the hm precedent generalized): when the
department join yields zero rows but the vial's `assignment_role` maps to a `VialRole` whose
`department_id` equals the requested department, stamp ALL live analyses on that vial (the vial
was seeded role-scoped — `main.py:17969-17974` records that its rows already match its role).
New helpers in `catalog/departments.py` (the dossier notes none exist): `department_id_for_service`
and `department_id_for_role`. This closes the P-0146-S04 incident (`STERILITY_USP71` in no group
→ stamping no-ops) by construction.

### D4. Inbox port (Q10)

Delete `_inbox_allowed_group_ids` (`main.py:17057-17069`); its single consumption
(`main.py:17948`) becomes a department comparison; `keyword_to_group` (`:17564-17578`) becomes
`keyword_to_department` (keyword → department id/name/color). `default_group` (`:17607-17615`)
retires with it: an unresolved keyword lands in the explicit `(0, "Other", "gray")` bucket —
fail-visible, no `Department.is_default` analogue is added. The Mk1-native branch needs nothing.

### D5. Display (Q9)

`department_name` is already emitted per item (`main.py:18607-18613`). Rendering contract:
item `department_id` set → department name; NULL with a live legacy `service_group_id` →
group's department via bridge (today's path); NULL both but analyses_json resolves → the §18471
fallback (exists); truly unresolvable → `"Legacy"` badge. `service_group_name` fields on
analysis payloads stay (frozen senaite-era display), native path already emits None.

### D6. Group admin freeze (Q7, Q8)

- `DELETE /service-groups/{id}` currently has **NO in-use guard** and SET-NULLs historical
  items + CASCADE-deletes `sla_priority_tiers` rows. It gets the departments-style guard
  (409 while any worksheet_item/SLA tier/member references it) FIRST — this is a prerequisite
  for "historical rows keep their group ids", not an optional courtesy.
- POST blocked (410 "legacy"), PUT name-edit blocked, `PUT /members` **stays open** until the
  COA gate port (D7) lands — freezing membership before then can strand a new micro service
  outside the gate's exemption set (fail-posture inversion).
- FE `ServiceGroupsPage` becomes read-only with a "Legacy — departments own routing now" banner.
- **SLA per-group overrides are explicitly out of scope; group rows stay alive for S7** (which
  re-keys `SlaPriorityTier` to profile).

### D7. The COA gate 🔶 (Q6)

Port `_micro_group_keywords` to a department-keyed exemption with a **transition union**:
`exempt = keywords(dept ∈ {Microbiology, Heavy Metals}) ∪ _micro_group_keywords(db)`
(Heavy Metals added per RULING 2 below). The union preserves
today's behavior even if either source is empty or prod lacks the `Endotoxin` group (open gate
G5 — the seeder and departments.py disagree about prod), and it self-heals the day department
totality (S6a) lands. Group half deleted at SENAITE decommission.

✅ **RULING 1 — RULED 2026-08-12: port APPROVED** with the transition union (production
COA-generation behavior change signed off; this ports, not removes, per the 2026-07-28 ruling's
spirit; the widening — department services with no group become exempt — is accepted).
✅ **RULING 2 — RULED 2026-08-12: Heavy Metals does NOT block COA generation.** Handler: "I'm
not sure yet if HM is going to take longer for results, so for now it should not block." This
REVERSES today's behavior (HM blocked by omission from `_NON_HPLC_GROUPS`) — HM analytes join
the exempt set via the Heavy Metals department term in the union above. Revisitable once HM
turnaround reality is known.

### D8. FE storage keys 🔶 (Q11)

`WorksheetDrawer.tsx:290` localStorage `prep_started:${sampleId}-${serviceGroupId}` and the
`${sample_uid}|${service_group_id}` React/SLA-map keys: new items key by department
(`…-d${departmentId}`), readers fall back to the old group-shaped key when the new one is absent
(stranded prep flags avoided). ✅ **RULING 3 — RULED 2026-08-12: ACCEPTED** (one-time cosmetic loss of stranded prep-started
flags; no FE-flip hold).

## Backfill & migration order

1. `ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL`
2. Backfill: `department_id` from `service_group_id → service_groups.department_id` where set;
   else the analyses_json[0] display fallback is NOT used for backfill (write-path purity) —
   rows stay NULL and read through D5's chain.
3. Guarded DELETE lands before any admin-freeze messaging.
4. Stamping/inbox/display ports (each dual-read).
5. COA gate union port (after RULING 1).
6. FE wave (wire field, keys, read-only groups page).

## Test strategy

- `test_worksheet_analyst_stamp.py` (12) gets department-keyed twins for every group-keyed case
  plus the role-fallback case (usp71 vial, no group) — the incident regression test.
- Gate tests: union predicate — micro-by-department exempts; micro-by-group-only (dept NULL)
  still exempts during transition; HM analytes now EXEMPT (RULED 2026-08-12 — pin the behavior
  change with a before/after-style test naming the ruling).
- Ambiguity: two historical items (Microbiology + Endotoxin group, same vial) — `.first()` +
  warning, no MultipleResultsFound.
- Full-suite failure-set diff vs base (67-failure baseline discipline).

## Non-goals

No group-row deletion, no SLA re-key (S7), no `worksheets.department_id`, no healing of
historical NULL-group items, no senaite mirror changes, no retirement of
`service_group_name` display fields on senaite analysis payloads.
