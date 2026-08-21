<!-- Reviewed and adopted as the S9 inventory deliverable, 2026-08-11. Research-grade:
verdicts are proposals under the Handler litmus ruling; each entry gets re-verified when
S9 plans. Controller notes: (1) D1/D2 — the derive_base_demand legacy-wins override is the
slice centerpiece and needs Handler sign-off (production demand behavior); (2) the ster:2
vintage flag means S9 must build on the branch carrying the sterility 2→1 fix (s3rehe
stack worktree, unpushed); (3) D3/D4/D5 conformance limits coordinate with the
spec/validation-engine migration program, not double-owned. -->

# Slice 9 — De-hardcoding sweep inventory

**Repos surveyed (read-only, nothing modified):**
- `C:/tmp/Accu-Mk1-amendment-audit` — Accu-Mk1 `backend/` + `src/`
- `C:/tmp/wpstar-coa-export` — WordPress theme "wpstar", catalog-adjacent PHP

**Litmus test (Handler ruling):** if a lab manager could reasonably want to change it
(names, labels, colors, groupings, demand, tiers, wire keys, classification of tests)
→ catalog row with UI CRUD + change-log. If only an engineer should change it
(state-machine legality, audit invariants, index predicates, renderers) → stays code,
reason documented.

**Verdicts:** `datafy` | `obsolete-by-S2/S3` | `stays-code`

---

## New discoveries beyond the spec's known inventory

Ordered by how much they'd hurt if missed.

1. **`derive_base_demand` is the REAL vial-demand source of truth, and it is a
   hardcoded ternary — not a map.** `backend/sub_samples/service.py:1194-1198`.
   The catalog path (`catalog_demand.py`) already exists and is consulted, but on
   ANY divergence **the hardcoded legacy value wins and the catalog value is
   overwritten** (`service.py:1206-1214`). This is a fail-open-to-hardcode guard:
   S9 cannot simply "add catalog rows," it must retire this override or the
   catalog stays cosmetic. Highest-value entry in this document.

2. **Vintage flag — this worktree still carries `ster: 2`.** `service.py:1197`
   reads `"ster": 2 if ster else 0`. Memory records the sterility 2→1 change as
   CLOSED on `s3rehe` but unpushed. Whoever carries S9 must rebase onto the
   sterility branch first or S9 will silently re-hardcode `2` back into the catalog
   seed. Flagged, not resolved — I did not verify which branch holds the fix.

3. **The hand-sync comment idiom is a reliable defect detector.** Grepping
   `kept in sync|mirrors|copy #` surfaced four *self-confessed* duplicated
   vocabulary literals, each annotated by its own author as a hazard:
   - `_ROLE_VARIANCE_KEYS` ↔ `VARIANCE_BUCKET_KEYS` (a test asserts equality —
     `backend/tests/test_variance_demand.py:58`)
   - `_PARENT_ANALYTE` regex, **three** copies (seeder / block_summary / FE)
   - `ROLE_BADGES` label maps, **eight** surfaces
   - `catalog/roles.py:41` — `suggest_role_code` is hand-ported to
     `src/lib/role-code.ts`; two implementations of one algorithm.

4. **SLA tiers are ALREADY datafied — do not re-datafy them.** `sla_tiers` is a
   real table with UI-editable `target_minutes` / `amber_threshold_percent`
   (`backend/database.py:417-448`). The only hardcoded SLA vocabulary left is the
   `PRIORITIES` tuple and the `'Standard', 2880` seed row. The lead's "tier matrix"
   entry resolves to `_TIER_ALLOWED_KINDS` in the state machine, which is a
   *transition-legality* matrix, not an SLA tier matrix — opposite verdict. Do not
   conflate the two; they share a word and nothing else.

5. **`_UNGROUPED_ANALYTICAL_LIKE_PATTERNS` is load-bearing and fail-closed.**
   `catalog/departments.py:65-73`. Its own docstring records that getting it wrong
   seeds **ZERO analyses onto every HPLC vial, silently**, because the Analytical
   department row still exists so the missing-department abort never fires. Any S9
   change here needs the seeder test as a gate, not a review.

6. **`catalog/departments.py` splits three ways in one file** — one row per map
   literal, not per file: the group-name map dies with S2, the keyword-prefix
   patterns are datafy-or-code, the department name constants are FK-adjacent.

7. **`_NON_HPLC_GROUPS` is partially dead but still live in one gate** (row **O13**).
   `lims_analyses/seeder.py:246`. The HPLC mirror abandoned it for a Department
   allow-list, but the **COA-generation blocking gate in `main.py` still calls it**.
   Retiring service groups (S2) without following that caller breaks COA blocking.

8. **Two FE keyword classifiers nobody listed.** `computePrimaryAnalysisUids`
   (`vial-quicklook-helpers.tsx:138`) classifies by `service_group_name === 'Analytics'`
   **and** `ENDO`/`STER` keyword prefixes — it is simultaneously an S2 casualty and an
   S3-adjacent keyword classifier. `WorksheetsInboxPage.tsx:44-46` hardcodes a
   role-filter dropdown.

9. **`BAKED_SPECS` / `TEST_TECHNIQUES` are hardcoded pass/fail thresholds.**
   `conformance_vendored/baked_specs.py:28-51`. These are *numeric conformance
   limits* — the single most lab-manager-owned vocabulary in the codebase, currently
   requiring an engineer + a deploy to change an endotoxin limit.

10. **Four `ROLE_SHORT`-family maps in the ReceiveWizard alone**, three of them
    distinct literals (`AssignStep`, `BoxStep`, `BoxLabelTemplate`, `LabelTemplate`),
    disagreeing on whether `ster` renders as `PCR` or `Sterility`.

---

## Verdict: `datafy`

Lab-manager-owned vocabulary. Each should become a catalog row with UI CRUD +
change-log entry.

| # | file:line | verbatim | encodes | reasoning | slice/PR |
|---|-----------|----------|---------|-----------|----------|
| D1 | `backend/sub_samples/service.py:1194-1198` | `legacy = {`<br>`  "hplc": 1 if hplc else 0,`<br>`  "endo": 1 if endo else 0,`<br>`  "ster": 2 if ster else 0,`<br>`}` | **Core vial demand per role** | Vials-per-test is a lab protocol number, the definition of a thing a lab manager changes. Catalog path exists but is overridden on divergence. | **S9 primary** — must retire the legacy-wins override, not just seed rows |
| D2 | `backend/sub_samples/service.py:1206-1214` | `if catalog.get(bucket, 0) != legacy_n:`<br>`    log.error("demand_divergence ...")`<br>`    catalog[bucket] = legacy_n` | Fail-open-to-hardcode guard | The blocker that makes D1's catalog cosmetic. Retiring it IS the de-hardcoding. Needs sign-off: it is a production-behavior change. | **S9 primary**, Handler sign-off |
| D3 | `backend/conformance_vendored/baked_specs.py:28-51` | `BAKED_SPECS: dict[tuple[str, str], BakedSpec] = {`<br>`  ("Bacteriostatic Water", "Benzyl_Alcohol_Assay"): {"min": 0.81, "max": 0.99, ...},`<br>`  ("Bacteriostatic Water", "PH-DETERM"): {"min": 4.5, "max": 7.0, ...},`<br>`  ("Bacteriostatic Water", "ENDO-LAL"): {"max": 0.25, "unit": "EU/mL", ...},`<br>`}` | **Per-matrix pass/fail conformance limits** | Spec limits are the lab manager's domain by definition; changing an endotoxin limit must not need a deploy. Overlaps the spec/validation-engine migration. | S9 or spec-migration slice — **coordinate, don't double-own** |
| D4 | `backend/conformance_vendored/addon_parsing.py:20-22` | `_ENDO_SPEC_DEFAULT = 5.0`<br>`_ENDO_UNIT = "EU/mL"`<br>`_NONCONFORM_COLOR = "#444F5B"` | Default endotoxin threshold + unit + status color | Same class as D3 — the fallback limit when no per-matrix spec exists. | S9 with D3 |
| D5 | `backend/conformance_vendored/baked_specs.py:58-62` | `TEST_TECHNIQUES: dict[str, str] = {`<br>`  "Benzyl_Alcohol_Assay": "HPLC",`<br>`  "PH-DETERM": "pH",`<br>`  "FILL-NET-CONTENT": "Gravimetric",`<br>`}` | Analytical technique label per keyword, printed on the COA | Printed customer-facing text keyed by service; belongs on the service row. | S9 |
| D6 | `backend/lims_analyses/service.py:487-491` | `_ROLE_VARIANCE_KEYS: Dict[str, str] = {`<br>`  "hplc": "hplcpurity_identity",`<br>`  "endo": "endotoxin",`<br>`  "ster": "sterility_pcr",`<br>`}` | Role → WP wire key for variance entitlement | Wire keys are catalog vocabulary. Duplicated (D7) with a test pinning equality. **No production callers remain** — retained as reference, so this is a low-risk deletion candidate. | S1 (roles-as-data) or S9 |
| D7 | `backend/sub_samples/service.py:1146-1150` | `VARIANCE_BUCKET_KEYS: dict[str, str] = {`<br>`  "hplc": "hplcpurity_identity",`<br>`  "endo": "endotoxin",`<br>`  "ster": "sterility_pcr",`<br>`}` | Same map as D6, second copy | Duplication is the defect surface. `test_variance_demand.py:58` asserts D6 == D7 — that test moves or dies with them. | S1/S9 with D6 |
| D8 | `backend/lims_analyses/seeder.py:66-71` | `ROLE_TO_WP_KEYS: Dict[str, Set[str]] = {`<br>`  "hplc": {"hplcpurity_identity", "bac_water_panel"},`<br>`  "endo": {"endotoxin"},`<br>`  "ster": {"sterility_pcr"},`<br>`  "xtra": set(),`<br>`}` | Role → WP service keys implying analyses | Author already documents "THE CATALOG IS AUTHORITATIVE; this map is the legacy fallback... never extended for new roles." Explicitly a retirement candidate. | S9 |
| D9 | `backend/lims_analyses/seeder.py:84-88` | `ROLE_TO_KEYWORDS: Dict[str, List[str]] = {`<br>`  "endo": ["ENDO-LAL"],`<br>`  "ster": ["STER-PCR"],`<br>`  "xtra": [],`<br>`}` | Role → exact service-keyword whitelist | Same legacy-fallback comment. **Caution:** comment says "Never re-route endo/ster onto the catalog path: they stay pinned here" — retiring needs explicit Handler override. | S9, **needs ruling** |
| D10 | `backend/catalog/vial_roles_seed.py:17-23` | `_LEGACY_ROLES = [`<br>`  ("hplc", "HPLC", ANALYTICAL_DEPARTMENT, True, True, 0),`<br>`  ("endo", "Endotoxin", MICROBIOLOGY_DEPARTMENT, True, True, 1),`<br>`  ("ster", "Sterility", MICROBIOLOGY_DEPARTMENT, True, True, 2),`<br>`  ("hm", "Heavy Metals", HEAVY_METALS_DEPARTMENT, False, False, 3),`<br>`  ("xtra", "Extras", None, True, True, 9),`<br>`]` | Role codes, labels, department, boxable, variance-eligible, order | Seed data — **legitimate as code** IF it stays a first-boot seed. Listed as datafy because the row values (labels, boxable) are exactly what a manager edits; the seed must never re-clobber admin edits. Currently correct (idempotent, self-healing). | S1 — verify non-clobber, likely **no change** |
| D11 | `src/lib/assignment-colors.ts:32-59` | `ROLE_BADGE_CLASS` / `ROLE_CHIP_CLASS` / `ROLE_TEXT_CLASS`, each keyed `hplc/endo/ster/xtra/hm/unassigned` (3 maps, ~28 lines) `[truncated]` | **Badge colors keyed by role code** | Already centralized to ONE file (good). Colors are the "SAMPLE LEGEND" — manager-owned. A new catalog role currently renders with no color. | S1 (roles-as-data carries color onto the role row) |
| D12 | 8 surfaces — `hplc/InboxVialCard.tsx:38-45`, `hplc/WorksheetDropPanel.tsx:59-64`, `intake/ReceiveWizard/VialDetailsTab.tsx:17-24`, `intake/ReceiveWizard/VialsList.tsx:25-32`, `senaite/vial-quicklook-helpers.tsx:107-111`, `senaite/SenaiteDashboard.tsx:172-178`, `senaite/AnalysisTable.tsx:114-118`, `intake/ReceiveWizard/AssignStep.tsx:46-52` | e.g. `const ROLE_BADGES: Record<string, {label,cls}> = {`<br>`  hplc: {label:'HPLC', cls: ROLE_BADGE_CLASS.hplc},`<br>`  ster: {label:'PCR', cls: ROLE_BADGE_CLASS.ster}, ... }` | **Role display labels**, duplicated 8× | The colors were deduped; the **labels were not**. Renaming role `ster` from "PCR" today means editing 8 TSX files — the cleanest one-line argument for datafy. `WorksheetDropPanel.tsx:57` literally self-labels "copy #5; dedup is a tracked fast-follow". | **S1 handles**; S9 verifies zero remain |
| D13 | `intake/ReceiveWizard/BoxStep.tsx:89-91`, `BoxLabelTemplate.tsx:7`, `LabelTemplate.tsx:3`, `AssignStep.tsx:46-52` | `const ROLE_LABEL = { hplc:'HPLC', endo:'Endotoxin', ster:'Sterility', xtra:'Extras', hm:'Heavy Metals' }`<br>`export const ROLE_SHORT = { hplc:'HPLC', endo:'ENDO', ster:'PCR', xtra:'XTRA' }` | Role labels, long form + short form | 4 more maps beyond D12, **mutually inconsistent** (`ster` = "Sterility" vs "PCR") and `BoxLabelTemplate` omits `hm` entirely. These print on physical box labels. | S1 with D12 |
| D14 | `src/components/hplc/WorksheetsInboxPage.tsx:44-46` | `{ value: '', label: 'All' },`<br>`{ value: 'endo', label: 'Endotoxin' },`<br>`{ value: 'ster', label: 'Sterility' },` | Hardcoded worksheet-inbox role filter options | A new catalog role gets no filter chip. Backend already computes lanes dynamically (`catalog/roles.py:66 inbox_lanes`) — FE just isn't reading it. | S1 |
| D15 | `src/components/intake/ReceiveWizard/AssignStep.tsx:269-271` | `{ key:'hplcpurity_identity', label:'HPLC', ariaLabel:'Variance HPLC' },`<br>`{ key:'endotoxin', label:'Endo', ... },`<br>`{ key:'sterility_pcr', label:'Sterility', ... }` | WP wire keys + labels for the variance paid-count display | Wire keys hardcoded in the FE — the same vocabulary as D6/D7, third location. | S1/S9 |
| D16 | `backend/catalog/departments.py:65-73` | `_UNGROUPED_ANALYTICAL_LIKE_PATTERNS = (`<br>`  "ANALYTE-%", "ID\\_%", "HPLC-%", "PEPT-%", "PUR\\_%", "QTY\\_%", "BLEND-%",`<br>`)` | Keyword prefixes rescued into the Analytical department | Which keyword families are analytical is catalog classification. **Survives S2** (keyed by keyword, not group name) and **survives S3** (not identity-specific). Datafy, but see discovery #5 — fail-closed, needs the seeder test as a gate. | S9, gated by seeder test |
| D17 | `backend/sla_engine.py:25` | `PRIORITIES = ("normal", "high", "expedited")` | Priority tier names | Manager-facing vocabulary; the rest of the SLA system is already datafied around it. Low value, low risk. | S9 (low priority) |
| D18 | `backend/database.py:443-444` | `INSERT INTO sla_tiers (name, target_minutes, ...)`<br>`SELECT 'Standard', 2880, FALSE, TRUE, NOW(), NOW()` | Default SLA target (2880 min = 48h) | Seed only, already editable via UI afterward. **Listed for completeness — recommend no change**; changing a seed doesn't change live rows. | none |
| D19 | `backend/families/service.py:36` | `_ADDON_PREFIXES = ("ENDO-", "STER-")`<br>`def _is_hplc(keyword): return not keyword.upper().startswith(_ADDON_PREFIXES)` | **endo/sterility vs HPLC classification** | **Survives S3** — classifies by service-role keyword, not identity keyword, so keyword-identity retirement does not touch it. Which tests are add-ons vs analytical is catalog classification. Self-labelled "Phase 5b heuristic… Phase 5c may switch to a service_group-based classifier." | **S9** |
| D20 | `backend/conformance_vendored/addon_parsing.py:15` | `ADDON_KEYWORDS: tuple[str, ...] = ("ENDO-LAL", "STER-PCR")` | Which keywords are add-on analyses | Same discriminator as D19 — survives S3. Closes the spec's "endo-vs-sterility keyword classification" entry with an explicit **non-obsolete** ruling. | **S9 with D19** |
| D21 | `src/components/senaite/vial-quicklook-helpers.tsx:151-154` | `} else if (role === 'endo') {`<br>`  if (kw.startsWith('ENDO')) set.add(a.uid)`<br>`} else if (role === 'ster') {`<br>`  if (kw.startsWith('STER')) set.add(a.uid)`<br>`}` | endo/ster keyword-prefix classification, **FE copy** | The endo/ster branches of O2 — same class as D19/D20, survives S3. (O2's `hplc` branch is group-name-keyed and dies with S2; split when carried.) | **S9**; hplc branch → S2 |

---

## Verdict: `obsolete-by-S2/S3`

Dies when service groups retire (S2) or keyword identity retires (S3). Do NOT
hand-patch these — per doctrine, never hand-patch what a slice retires by class.

| # | file:line | verbatim | encodes | reasoning | slice/PR |
|---|-----------|----------|---------|-----------|----------|
| O1 | `backend/catalog/departments.py:49-54` | `_GROUP_NAME_TO_DEPARTMENT = {`<br>`  "Analytics": ANALYTICAL_DEPARTMENT,`<br>`  "Core HPLC": ANALYTICAL_DEPARTMENT,`<br>`  "Microbiology": MICROBIOLOGY_DEPARTMENT,`<br>`  "Endotoxin": MICROBIOLOGY_DEPARTMENT,`<br>`}` | Service-group **name** → department | Keyed by group name, and carries an environment-drift wart ("Analytics" in dev, "Core HPLC" in prod). S2 retires service groups → this map has no left-hand side. | **S2** |
| O2 | `src/components/senaite/vial-quicklook-helpers.tsx:147-155` | `if (role === 'hplc') {`<br>`  if (groupName === 'Analytics') set.add(a.uid)`<br>`} else if (role === 'endo') {`<br>`  if (kw.startsWith('ENDO')) set.add(a.uid)`<br>`} else if (role === 'ster') {`<br>`  if (kw.startsWith('STER')) set.add(a.uid)`<br>`}` | Role → "primary analysis" classifier | **Straddles both slices — split when carried**: the `hplc` branch is group-name-keyed (dies with S2, listed here); the endo/ster branches are keyword-prefix and survive S3 (**filed as D21, datafy**). Highlight-only, so low blast radius. | **S2** for the hplc branch only; endo/ster → **D21** |
| O3 | `src/lib/vial-assignment.ts:89-93` | `export function isIdentityAnalysis(a): boolean {`<br>`  const kw = (a.keyword ?? '').toUpperCase()`<br>`  if (kw === 'HPLC-ID' \|\| kw.startsWith('ID_')) return true`<br>`  return /\bidentity\s*\(hplc\)/i.test(a.title ?? '')`<br>`}` | **Identity-analysis matching**: `ID_*` prefix + title-suffix regex | The centerpiece of S3. Keyword-identity retirement removes the `ID_*` namespace AND the title-form dependency (memory: P-1611 broke exactly on the service-title form). Pure S3 casualty. | **S3 centerpiece** |
| O4 | `src/lib/vial-assignment.ts:151-153` | `if (matches.length === 0 && identityBridgeAllowed && isIdentityAnalysis(pa)) {`<br>`  matches = matchToVialMatches((_kw, a) => isIdentityAnalysis(a))`<br>`}` | Identity type-bridge (`ID_*` ↔ `HPLC-ID`) | The bridge exists only because identity is keyword-encoded. With roles-as-data + S3 the join is by service identity, not keyword shape. | **S3** |
| O5 | `src/lib/vial-assignment.ts:113` | `const PARENT_ANALYTE = /^ANALYTE-([1-4])-(PUR\|QTY)$/` | Generic blend-slot analyte keyword, **FE copy** | Slot-encoded-in-keyword is the same anti-pattern S3 retires. Hard-caps blends at 4 analytes while `sub_samples/service.py:293` allows 8 — a live inconsistency. | **S3** |
| O6 | `backend/lims_analyses/seeder.py:56` | `_PARENT_ANALYTE = re.compile(r"^ANALYTE-([1-4])-(PUR\|QTY)$")` | Same regex, **backend copy #1** | Canonical of the three. Self-labelled as hand-synced. | **S3** |
| O7 | `backend/coa/block_summary.py:27` | `_ANALYTE_GENERIC = re.compile(r"^ANALYTE-([1-4])-(PUR\|QTY)$")`<br>`_CATEGORY_LABEL = {"PUR": "Purity", "QTY": "Quantity"}` | Same regex, **copy #2**, + category labels | Comment at line 26: "Mirrors lims_analyses/seeder.py:_PARENT_ANALYTE — kept in sync by hand." | **S3** |
| O8 | `backend/coa/variance_series.py:52-54` | `if kw == "HPLC-PUR" or kw.startswith("PUR_") or _ANALYTE_PUR.match(kw):`<br>`if kw == "PEPT-TOTAL" or kw.startswith("QTY_") or _ANALYTE_QTY.match(kw):` | `PUR_`/`QTY_` prefix → result category | Per-substance keyword namespace. Memory: `PUR_`/`QTY_` are **Mk1-local, auto-derived on boot, never in SENAITE** — so this is derivable from the catalog, not intrinsic. | **S3** |
| O9 | `backend/lims_analyses/prep_bridge.py:68-72` | `if kw == "HPLC-PUR" or kw.startswith("PUR_") or _ANALYTE_PUR.match(kw):`<br>`if kw.startswith("QTY_") or _ANALYTE_QTY.match(kw):` | Same categorizer, **second copy** | `variance_series.py:46` says "Mirrors lims_analyses.prep_bridge._category but ALSO recognizes the generic..." — the two copies are already **known to differ** (`PEPT-TOTAL` handled in one, not the other). | **S3** |
| O10 | `backend/database.py:780-806` | `SELECT p.name \|\| ' - Purity', 'PUR_' \|\| substring(idsvc.keyword from 4), 'HPLC', '%', ...`<br>`SELECT p.name \|\| ' - Quantity', 'QTY_' \|\| substring(idsvc.keyword from 4), 'HPLC', 'mg', ...`<br>`JOIN analysis_services s ON left(s.keyword, 4) IN ('PUR_', 'QTY_')` `[truncated]` | **Boot-time SQL that MINTS the `PUR_`/`QTY_` namespace** by string-slicing `ID_*` keywords | The generator of the vocabulary O8/O9 parse. `substring(idsvc.keyword from 4)` hard-depends on the literal `ID_` prefix length. S3 must replace this derivation, not just its readers. Memory: this is the derivation that "heals on restart". | **S3** — the root, carry first |
| O11 | `backend/lims_analyses/seeder.py:367` + `src/lib/vial-assignment.ts` slot bridge | `m = _PARENT_ANALYTE.match(kw)` → slot title → `ID_<X>` service → `peptide_id` → `PUR_<X>/QTY_<X>` | Slot→peptide→service resolution chain, **anchored on the `"{Peptide} - Purity"` title contract** | The FE comment admits it matches on title text "since the FE has no peptide_id to join on". Title-form coupling is exactly the P-1611 break class. | **S3** |
| O12 | `backend/coa/block_summary.py` micro set / `backend/tests/test_coa_block_summary.py:39` | `MICRO = {"ENDO-LAL", "STER-PCR", "KF"}` (test); prod path resolves micro group membership dynamically | Which analytes never block COA generation | Prod code resolves this from group membership (S2 casualty) but the **test hardcodes the set** — the test will outlive the code. Flag for the S2 author. | **S2** |
| O13 | `backend/lims_analyses/seeder.py:246` | `_NON_HPLC_GROUPS = ("Microbiology", "Endotoxin")` | Service-group names that are not HPLC work | Keyed by **group name** → dies with S2. **Migration caveat:** the HPLC mirror abandoned it, but `main.py`'s COA-generation blocking gate still calls it (via `_micro_group_keywords`). Cannot be deleted with the groups until that caller is followed. | **S2**, with the `main.py` caller followed |

> **NOT in this section — ruling recorded:** the **endo/sterility keyword
> classifiers** (`_ADDON_PREFIXES`, `ADDON_KEYWORDS`) were evaluated for S3 and
> ruled **`datafy` — see D20/D21**. Under the discriminator "does S3 retire *this*
> keyword's role, or only identity keywords?" the answer is **only identity**, so
> they survive S3. They are deliberately absent from this table: an S2/S3 author
> must **not** treat them as dying by class.

---

## Verdict: `stays-code`

Engineer-owned. Reason documented per row, as the litmus test requires.

| # | file:line | verbatim | encodes | reasoning | slice/PR |
|---|-----------|----------|---------|-----------|----------|
| C1 | `backend/lims_analyses/state_machine.py:107-141` | `_ALLOWED: Dict[Tuple[str, str], str] = {`<br>`  ("unassigned","assign"): "assigned",`<br>`  ("to_be_verified","verify"): "verified",`<br>`  ("parent_to_verify","verify"): "verified",`<br>`  ("verified","publish"): "published",`<br>`  ("promoted","reject"): "rejected", ... }` (~35 lines) `[truncated]` | **Transition legality** | Explicitly named in the litmus test as stays-code. A lab manager inventing a new legal transition is an audit-integrity hole, not a config change — ISO 17025 traceability depends on this being reviewable in diff. | none |
| C2 | `backend/lims_analyses/state_machine.py:151-160` | `_TIER_ALLOWED_KINDS: Dict[str, FrozenSet[str]] = {`<br>`  TIER_VIAL: frozenset({"assign","submit","retract","reject","reset","retest","auto","variance_verify"}),`<br>`  TIER_PARENT: frozenset({"publish","retract","auto","verify"}),`<br>`}` | **Tier × verb matrix** (vial vs parent) | This is the "tier matrix" from the spec list — a *legality* matrix, not SLA tiers. Encodes the second-sign-off invariant (vials never self-verify). Datafying it would let a UI edit dissolve separation of duties. | none |
| C3 | `backend/sub_samples/service.py:1669` | `_VALID_KINDS = {"core", "variance"}` | Assignment-kind enum | Structural: `assignment_kind` has code branches per value. A new kind needs code anyway. | none |
| C4 | `backend/coa/block_summary.py:36` | `_DEAD_CANDIDATE_STATES = frozenset({"rejected","retracted","cancelled","invalid"})` | SENAITE terminal states | Mirrors an external system's state vocabulary, not Accumark's. Changes only when SENAITE changes. (Dies with the SENAITE phase-out, not with S2/S3.) | SENAITE phase-out |
| C5 | `src/lib/vial-assignment.ts:87` | `const DEAD_STATES = new Set(['retracted','rejected'])` | Terminal states for live-row selection | Same class as C4; part of the current-row idiom, an engineer-owned invariant. | none |
| C6 | `backend/sub_samples/service.py:44` | `_PRE_RECEIVED_STATES = {None,"","sample_due","sample_registered","to_be_sampled"}` | Pre-receipt states | External SENAITE vocabulary + guard predicate. | SENAITE phase-out |
| C7 | `backend/sub_samples/catalog_demand.py:26-28` | `_LEGACY_BUCKETS = ("hplc","endo","ster")`<br>`_QUIET_KEYS = {"samplevariance","variance"}` | Zero-floor bucket contract | `_LEGACY_BUCKETS` is a **response-shape** guarantee for callers keyed on the historical 3-bucket dict — an API compat shim, not vocabulary. Should be *deleted* when callers are migrated, not datafied. | S9 (delete, don't datafy) |
| C8 | `backend/sub_samples/service.py:1479` | `_LEGACY_BUCKET_PRIORITY = ("hplc","endo","ster","hm")` | Deterministic tie-break ordering | Ordering exists for reproducibility, not presentation. If a manager wants display order, that is `sort_order` on the role row (already exists, D10). | none |
| C9 | `backend/sub_samples/service.py:293` | `_ANALYTE_KEY_RE = re.compile(r"^Analyte([1-8])(Peptide\|DeclaredQuantity)$")` | SENAITE field-name parser | Parses an **external** field naming scheme. Note the `[1-8]` vs `[1-4]` mismatch against O5/O6 — worth a bug note, but the fix is code. | SENAITE phase-out; **file bug re 4-vs-8** |
| C10 | `backend/catalog/roles.py:14-18` | `_LEGACY_LANE_KEYS = {"Analytical":"hplc","Microbiology":"microbiology","Heavy Metals":"hm"}` | Department name → stored FE pref key | A **backward-compat alias table** protecting stored user prefs and bookmarked `?role=` URLs. Datafying it would let a rename break saved state. The `is_system` guard on the departments PATCH route already enforces this. Correct as code. | none |
| C11 | `backend/catalog/departments.py:35-43` | `ANALYTICAL_DEPARTMENT = "Analytical"`<br>`MICROBIOLOGY_DEPARTMENT = "Microbiology"`<br>`HEAVY_METALS_DEPARTMENT = "Heavy Metals"`<br>`DEPARTMENT_NAMES = [...]` | Canonical department names | Names are manager-facing, **but** these three are pinned by C10's alias table and by the seeder's fail-closed allow-list. They are `is_system` rows whose *names* are locked while other attributes stay editable. Correct compromise; document the reason. | S1 — document, no change |
| C12 | `backend/catalog/roles.py:42-51` + `src/lib/role-code.ts` | `base = re.sub(r"[^a-z0-9_]", "_", key.lower()).strip("_") or "role"` … truncate 8, uniquify | Role-code derivation algorithm | Algorithm, not vocabulary → stays code. **But it is hand-ported to TS** (line 41 admits it). Flag: two implementations, one contract. | S1 — add a parity test |
| C13 | `backend/main.py:2592` | `COA_ARCHETYPES = {"limit_table"}` | Valid `coa_archetype` values | Named in the spec list. Each archetype is a **renderer** — adding a value without a renderer yields a blank COA (cf. the SVG-blank-box class of bug). Litmus test names renderers as stays-code. Revisit only when archetypes become plugin-registered. | none — **document reason** |
| C14 | `backend/sub_samples/service.py:261` | `_COA_META_FIELDS = ("CoaAddress","CoaCompanyName","CoaEmail","CoaWebsite")` | SENAITE COA meta field names | External field names; branding *values* live in SENAITE rows, which is the datafied part already. | SENAITE phase-out |
| C15 | `backend/capture_tokens/routes.py:28` | `_ALLOWED_EXTS = {".jpg",".png",".webp"}` | Upload MIME allowlist | Security control, deny-by-default. Never manager-editable. Included only because it matched the `_ALLOWED` grep — **not** the state machine entry. | none |

---

## Spec entries resolved as NOT PRESENT

| spec entry | finding |
|---|---|
| `_identity_fails` | **Zero hits in Accu-Mk1** (`backend/` and `src/` both clean). Per memory this is a **COABuilder** symbol (`architecture_identity_fails_nonconforming_gap`). Out of scope for this repo pair — **check coabuilder** before S3 closes, since the "misses Non-conforming" gap is an S3-adjacent identity classifier. |
| "product-completion" | Exists but is **not a classifier**: `src/lib/product-completion.ts` derives per-ordered-product completion from vial/analysis state. Contains no hardcoded catalog vocabulary. **No S9 entry.** Recorded so its absence isn't read as an oversight. |
| `PARENT_ANALYTE` | Found — **three copies** (O5/O6/O7). |
| `ID_*` prefix / title-suffix regex / `isIdentityAnalysis` | Found — O3/O4. |
| `PUR_`/`QTY_` prefix regexes | Found — O8/O9, plus the **generator** O10. |
| `departments.py` name-map + ungrouped-rescue | Found — split O1 (obsolete-by-S2) + D16 (datafy). |
| `COA_ARCHETYPES` | Found — C13, stays-code. |
| department name constants | Found — C11, stays-code with documented reason. |
| state machine `_ALLOWED` / tier matrix | Found — C1/C2, both stays-code. **Note:** "tier matrix" ≠ SLA tiers (see discovery #4). |
| FE `ROLE_BADGES` (spec said "≥6 surfaces") | **8 label-map surfaces** (D12) + **4 more** `ROLE_SHORT`/`ROLE_LABEL` maps (D13) = **12 total**. Colors already deduped to one file (D11). |

---

## wpstar (WordPress theme) — catalog-adjacent PHP maps

### ⚠️ Two premise corrections — verified independently, not taken on report

**W-CORRECTION-1: `heavy_metals` does NOT exist in wpstar master.** I re-ran the
grep myself rather than trusting the sweep: `grep -ril "heavy_metals" wp-content/`
→ **zero hits**. Case-insensitive "heavy metals" appears at exactly one place,
`templates/homepage-content.php`, as **marketing prose**. Role codes `hm` / `xtra`
→ zero hits.

This **contradicts the standing belief that cart and checkout diverge on
`heavy_metals` (1 vs 2)**. That divergence is not reproducible in this repo.
Reconciling with what we know: `C:/tmp/wpstar-coa-export` is WP **master**, and
Heavy Metals is a catalog-layer role that was never billed as a WP add-on —
consistent with "the catalog layer is `s3rehe`-only, not in prod" and with the
Heavy-Metals-not-billed finding (`Cart_Order` maps by NAME, looks up by wire KEY;
a miss yields 0 vials and no line item). **The wire-key mismatch mechanism is
real and confirmed below (W1/W2); the specific `heavy_metals` 1-vs-2 number is
not in master.** If that divergence was observed live, it was in the DevKinsta
checkout (stale `feat/enterprise-credits` v2.31.0) or on `s3rehe` — a different
tree than the one I was scoped to. **Recommend confirming which before S9 plans
around it.** I did not search those trees; out of scope.

**W-CORRECTION-2: the two vial-demand copies AGREE — the defect is duplication,
not divergence.** Verified directly:
- `src/Front/Vials.php:30,33,36` → `PRIMARY = 1`, `ENDOTOXIN = 1`, `STERILITY = 2`
- `js/sample-submission.js:223` → `{ primary: 1, endotoxin: 1, sterility: 2 }`
- `js/sample-submission.js:7301` → `{ primary: 1, endotoxin: 1, sterility: 2 }`

All three read `1/1/2`. The hazard is that the JS literals are **fallbacks that
shadow the PHP constants** — edit the canonical constants and two stale copies
survive silently.

**Cross-repo note:** wpstar's `STERILITY = 2` matches Mk1's `"ster": 2`
(discovery #2). The sterility 2→1 change must land in **both repos in one
window**, or WP will quote 2 vials while the LIMS provisions 1.

### wpstar entries

| # | file:line | verbatim | encodes | verdict + reasoning | slice/PR |
|---|-----------|----------|---------|---------------------|----------|
| W1 | `themes/wpstar/src/Front/Cart_Order.php:1783-1790` | `$normalized_name = strtolower(str_replace([' ','-','_','&','(',')'], '', $svc['name']));`<br>`$service_product_map[$normalized_name] = ['product_id' => (int)$svc['product_id'], 'type' => $svc['type'] ?? 'primary'];` | Service display-NAME → normalized key → product binding | **datafy** — the name→key binding is catalog vocabulary and should be a stored wire key on the service row, not derived by string-mangling a display name. | **S9 / catalog wire-key slice** |
| W2 | `themes/wpstar/src/Front/Cart_Order.php:1560-1569` | `$normalized_key = strtolower(str_replace([' ','-','_','&','(',')'], '', $key));`<br>`if (isset($service_map[$normalized_key]) && $service_map[$normalized_key]['type'] === 'addon') { $is_addon = true; ... }` | The **lookup** side of W1 | **datafy (same row as W1)** — confirmed failure chain: `$key` is the wizard alias key normalized in JS by `.replace(/\s+/g,"")` (**whitespace only, parens kept**), while PHP strips `- _ & ( )` too. Two different normalizers over one vocabulary. On a miss the price folds into base, **no child line item, no vial counted**. Converges today only by luck for `Rapid Sterility Screening (PCR)`. | **S9 — highest wpstar priority** |
| W3 | `themes/wpstar/src/Admin/Addon_Upgrades.php:43-47` | `public const ADDON_TYPES = [`<br>`  'samplevariance' => ['label'=>'Variance','kind'=>'variance'],`<br>`  'endotoxin' => ['label'=>'Endotoxin','kind'=>'flat','catalog_match'=>'endotoxin','mk1_key'=>'endotoxin'],`<br>`  'rapidsterilityscreening(pcr)' => ['label'=>'Sterility (PCR)','kind'=>'flat','catalog_match'=>'sterility','mk1_key'=>'sterility_pcr'],`<br>`];` | **Four vocabularies in one literal**: alias key, label, catalog-match needle, Mk1 wire key | **datafy** — this is the single clearest "should be a catalog row" literal in wpstar. Note its keys **retain parens**, a third convention differing from W1 and W2. Consumed at `:675` by `catalog_match` and `:693` by alias key — two vocabularies for one concept inside one class. | **S9** |
| W4 | `themes/wpstar/src/Front/Vials.php:30,33,36` | `const PRIMARY = 1;`<br>`const ENDOTOXIN = 1;`<br>`const STERILITY = 2;` | **Vial demand per service (WP side)** | **datafy** — the WP mirror of Mk1's D1. Must be sourced from the same catalog as D1 or the two drift. Pairs with the sterility 2→1 cross-repo note above. | **S9 with D1** |
| W5 | `themes/wpstar/js/sample-submission.js:223` and `:7301` | `const rules = (wcSampleForm && wcSampleForm.vialRules) \|\| { primary: 1, endotoxin: 1, sterility: 2 };` (identical at both lines) | Vial-demand JS fallback, ×2 | **datafy (delete the fallbacks)** — values agree today; the fallback pattern is the hazard. Correct fix is to fail loud when `vialRules` is absent, not to carry a shadow copy. | **S9 with W4** |
| W6 | `themes/wpstar/src/Front/Vials.php:69-72` | `strpos($lower,'endotoxin')` … `strpos($lower,'sterility') \|\| strpos($lower,'plating')` | endo/sterility classification **by display-name substring** — drives vial counts | **datafy** — same class as Mk1's D19/D20, and worse: renaming a service in the storefront silently changes how many vials are provisioned. | **S9** |
| W7 | 5 sites: `Vials.php:69`, `functions.php:848-854`, `templates/portal-create-order.php:33-38`, `templates/portal-submit-sample.php:61-67`, `src/Front/MyAccount/Sample_Submission.php:348` | `stripos($service['name'],'endotoxin') !== false` … (five independent implementations) | "Is this endotoxin/sterility?" asked **five separate times** | **datafy** — a rename requires editing five files across templates, admin, and front. Strongest wpstar argument for a service-type flag on the catalog row. | **S9** |
| W8 | `themes/wpstar/src/Front/Cart_Order.php:1626-1629` **and** `src/Front/MyAccount/Sample_Submission.php:988-991` (byte-identical) | `$label_map = [`<br>`  'hplcpurity_identity' => 'HPLC',`<br>`  'endotoxin' => 'Endotoxin',`<br>`];` | Mk1 wire key → variance line-item label | **datafy** — same wire keys as Mk1's D6/D7/D15. That vocabulary now has **five** copies across two repos. | **S9 with D6/D7** |
| W9 | `themes/wpstar/js/sample-submission.js:3444-3454` | `const VARIANCE_ELIGIBLE = [`<br>`  { mk1Key: "hplcpurity_identity", label: "HPLC (Purity, Identity, Quantity)" },`<br>`  { mk1Key: "bac_water_panel", label: "Bac Water Panel (pH, Benzyl Alcohol, Fill Volume)" },`<br>`  // Endotoxin variance disabled for now — replicate cost too high (2026-06-13).`<br>`];` | Variance-eligibility allowlist + wire key → label | **datafy** — "which services are variance-eligible" is a pricing/product decision a manager makes; it is currently a commented-out line in a JS array. | **S9** |
| W10 | `themes/wpstar/templates/portal-create-order.php:50-53` **and** `templates/portal-submit-sample.php:88-91` (verbatim duplicate) | `$endotoxin_price = $addon_prices['endotoxin'] ?? 200;`<br>`$sterility_price = $addon_prices['sterility'] ?? 180;` | **Fallback list prices** for add-ons | **datafy** — hardcoded currency fallbacks in two templates. A price change that misses these silently quotes stale numbers. | **S9** |
| W11 | `themes/wpstar/src/Admin/Orders.php:996`, `src/Admin/Retest.php:128` | `var VIAL_PRICE = 50;`<br>`$vial_price = $product ? (float)$product->get_price() : 50;` | Retest per-vial price | **datafy** — `Retest.php` already reads the product price and falls back to 50; `Orders.php` hardcodes it outright. | **S9** |
| W12 | `themes/wpstar/js/sample-submission.js:86,91` | `const pepBundle = parseFloat(wcSampleForm.accuShieldBundlePrice) \|\| 535;`<br>`const ratio = pepFull > 0 ? (pepBundle / pepFull) : 0.85;` | Bundle price + BW discount ratio fallbacks | **datafy** — same fallback-shadow hazard as W5/W10. | **S9** |
| W13 | `themes/wpstar/functions.php:426-427` **and** `src/Front/Orders.php:123` | `$primary_alternate_skus = ['hplc-ipq','bac-water-panel'];`<br>`$required_addon_skus = ['endotoxin-lal','sterility-pcr'];` | AccuShield bundle composition **by SKU** | **datafy** — bundle membership is a product decision; duplicated across two files. | **S9** |
| W14 | `themes/wpstar/js/sample-submission.js:31,45` | `const PRIMARY_TEST_NAME = "HPLC Purity & Identity";`<br>`const BAC_WATER_PRIMARY_NAME = "Bac Water Panel";` | Exact catalog primary-service names | **datafy** — the in-file comment (`:40-44`) warns these must match wc-test-services **exactly**. A comment is not an invariant; this is a rename landmine. | **S9** |
| W15 | `Cart_Order.php:397-398`, `Vials.php:151`, `Vials.php:170`, `js/sample-submission.js:3482`, `Cart_Order.php:1778-1780` | `$primary_label = ($cart_sample_data['analyticalTest'] ?? '') === 'Bacteriostatic Water' ? 'Bac Water Panel' : 'HPLC';` | Analytical test → primary panel label, **5 copies** | **datafy** | **S9** |
| W16 | `themes/wpstar/src/Api/ClientEndpoint.php:381-388` | `$summary_map = [`<br>`  'Purity'=>'purity','Identity'=>'identity','Quantity'=>'qty',`<br>`  'Blend Qty'=>'qty','Endotoxin'=>'endo','Sterility'=>'sterility',`<br>`];` | LIMS result NAME → admin-grid column code | **datafy** — keyed by result display name; overlaps `COAEndpoint.php:1941-1945` and `functions.php:2399-2403`. | **S9** |
| W17 | `themes/wpstar/src/Api/COAEndpoint.php:1992-1995` | `$is_sterility = stripos($t['test_name'] ?? '', 'sterility') !== false;`<br>`$val = $is_sterility ? ($conforms ? 'No Growth' : 'Growth Detected') : ($conforms ? 'Pass' : 'Fail');` | **Sterility-only result wording** on customer-facing output | **datafy** — result vocabulary per service ("No Growth" vs "Pass") is exactly a lab-manager-owned label, currently gated on a name substring. | **S9** |
| W18 | `themes/wpstar/woocommerce/checkout/form-pay.php:1159-1163` **and** `templates/portal-view-order.php:1250-1254` (byte-identical) | `$au_label_map = [`<br>`  'variance'=>'Variance Add-on','endotoxin'=>'Endotoxin Add-on','sterility_pcr'=>'Sterility (PCR) Add-on',`<br>`];` | `_addon_type` wire key → customer label | **datafy** | **S9** |
| W19 | `themes/wpstar/src/Api/OrderStatusEndpoint.php:94-100` | `$status_map = ['order_submitted'=>'order-submitted','sample_received'=>'sample-received','analyzing'=>'analyzing','under_review'=>'under-review','complete'=>'completed'];` | IS lab status → WP order status | **stays-code** — a **protocol adapter** between two systems' state enums, not lab vocabulary. Adding a status needs handling code on both sides. Duplicated at `templates/portal-content.php:104-127` and `class-wc-email-order-status-update.php:57+` — worth deduping, not datafying. | S9 (dedup only) |
| W20 | `themes/wpstar/src/Admin/Addon_Upgrades.php:218,359,360,472` | `max(2, min(10, $vp))` … `max(0, min(20, absint($row['additional_vials'] ?? 0)))` | Variance replicate bounds (2–10), vial bounds (0–20) | **datafy** — business limits a manager would tune; also inconsistent with `Retest.php:138` (`max(1, min(20,…))`). | **S9 (low priority)** |
| W21 | `themes/wpstar/templates/services-content.php:48-49`, `woocommerce/myaccount/orders.php:134` | `<h3 class="value-item-title">48-72 Hour Turnaround</h3>`<br>`Standard results typically in 2 business days from sample receipt.` | **The only turnaround numbers in wpstar** — marketing copy | **datafy** — but note: these are **prose, disconnected from the real SLA engine** (Mk1 `sla_tiers`, D18). A manager changing the SLA tier today does **not** change what the storefront promises. Flag as a customer-facing correctness risk, not just a refactor. | **S9 / SLA slice** |
| W22 | `themes/wpstar/src/Admin/Variance_Tester.php:3,9-14,49-52` | `* Variance beta-tester admin profile field + visibility gate.` … `esc_html_e('AccuMark Beta Access','wpstar')` | Beta-cohort gate for one named service | **datafy** — per-service beta gating should be a flag on the service row, not a bespoke class per service. | **S9** |
| W23 | `themes/wpstar/js/sample-submission.js:55-57`, `templates/services-content.php:255`, `Cart_Order.php:1566,1788,1792` | `.filter((s) => s.type === 'addon')` / `=== 'addon-coming-soon'` | Service-type enum `primary` \| `addon` \| `addon-coming-soon` | **stays-code** — a structural enum with code branches per value; adding a type needs rendering code regardless. | none |
| W24 | `themes/wpstar/includes/peptide-requests/rest-proxy.php:291,301,304` | `$needle = preg_replace('/[^a-z0-9]/','',strtolower($compound_name));`<br>`in_array($avail, ['available','coming_soon','disabled'], true)` | **A fourth** compound-name normalizer + availability enum | **datafy (normalizer)** / **stays-code (enum)** — split row: the normalizer is the W1/W2/W3 problem again; the 3-value availability enum is structural. | **S9** |
| W25 | `themes/wpstar/src/Front/Vials.php:156,161` | `preg_match('/Sample #(\d+)/i', $item->get_name(), $m)`<br>`preg_replace('/\s*–\s*Sample\s*#\d+.*$/i', '', $item->get_name())` | Line-item **naming convention parsed as a schema** | **stays-code** — parsing a legacy WooCommerce line-item format is engineer territory, but it is fragile: display text used as a data channel. Document the reason. | none — document |

**wpstar negative finding:** no badge/status colors keyed by a domain code.
`src/Front/Checkout.php:85-145` is Stripe Elements brand theming;
`templates/variance-charts.php:485-492` is a generic 8-color series palette.
Domain status styling is CSS-class-based
(`class-wc-email-order-status-update.php:65,74` → `'status-badge sample-received'`).
No `boxable` vocabulary in wpstar (0 hits) — that concept is Mk1-side only.

### The headline wpstar structural finding

**Four competing name-normalization conventions over one vocabulary:**

| convention | site | strips |
|---|---|---|
| JS wizard alias | `js/sample-submission.js:474,481,1281,3311,3907` | whitespace only (**parens kept**) |
| PHP Cart_Order | `Cart_Order.php:1560,1785`, `MyAccount/Sample_Submission.php:886` | whitespace, `-`, `_`, `&`, `(`, `)` |
| Addon_Upgrades const keys | `Addon_Upgrades.php:43-47` | whitespace only (**parens kept**) |
| peptide rest-proxy | `includes/peptide-requests/rest-proxy.php:291` | everything non-alphanumeric |

They agree today only for the current service names. **Any catalog rename that
introduces a character one convention strips and another keeps silently produces
0 vials and no line item** — the exact mechanism behind the Heavy-Metals
not-billed class of bug. This is the strongest single argument in either repo for
a **stored wire key on the catalog row**, replacing all four derivations.

---

## Recommended S9 carry order

1. **W1/W2/W3 + a stored wire key** — retires four normalizers and the
   0-vials-no-line-item bug class. Highest blast-radius reduction.
2. **D1/D2** — retire the legacy-wins demand override so the catalog stops being
   cosmetic. Needs Handler sign-off (production behavior) and a rebase decision on
   the sterility 2→1 branch.
3. **W4/W5 + D1 together** — WP and Mk1 vial demand from one source, in one window.
4. **D12/D13 via S1** — role labels, 12 surfaces.
5. **D3/D4/D5** — conformance limits, coordinated with the spec/validation-engine
   migration so the two slices don't both claim `baked_specs.py`.
6. **W6/W7 + D19/D20/D21** — the endo/sterility name-and-keyword classifiers,
   **10 sites across both repos** (5 in wpstar, 3 in Mk1, plus the two prefix
   tuples). All survive S3, so S9 owns them outright.

## Open questions for the Handler

1. **The `heavy_metals` 1-vs-2 divergence is not in wpstar master.** Which tree was
   it observed in — DevKinsta (stale `feat/enterprise-credits`) or `s3rehe`?
   S9 scope depends on the answer.
2. **D9 `ROLE_TO_KEYWORDS`** carries an explicit "never re-route endo/ster onto the
   catalog path" instruction. Does S9 override that, or does endo/ster stay pinned?
3. **W21**: storefront turnaround copy ("48-72 Hour") is disconnected from the real
   `sla_tiers` engine. In scope for S9, or a separate correctness fix?
4. **C13 `COA_ARCHETYPES`**: confirm stays-code. Archetypes map 1:1 to renderers, so
   datafying invites blank-COA bugs — but that is a ruling, not my call.
