# Re-test overlay: legacy samples, combined re-test + add, and visible reasons

Date: 2026-09-30. Status: APPROVED (Handler ruling after P-0637). Extends
`2026-09-29-retest-overlay-v2.md` and `2026-09-29-addon-same-sample.md`. Additive only: every
existing request/response field keeps its meaning; new fields are optional.

## Why

1. The Re-test tab lists profiles from `catalog_snapshot.profiles`. Samples registered before
   the catalog (prod: 2,771 of 3,505 published, every one before ~2026-09-08) have none, so the
   tab is empty and Create stays blocked on "Tick at least one Re-test". P-1908 (Frontier) and
   P-0637 are examples.
2. Re-test + carry + add services is one spec body (`retest`, `carry`, `drop`, `add`) that Mk1,
   IS and WordPress (`Retest::create_from_spec` reads both `retest` and `add`) already handle in
   one order. Only the overlay splits it across two tabs.
3. When Create is disabled the user gets no reason: a WooCommerce order that no longer exists
   (P-0637, order 3555 hard-deleted) renders as an empty context block and "price unavailable";
   a SENAITE-era result renders as a greyed Carry box with no explanation.

## Backend (Mk1, `backend/lims_analyses/retest_carry.py`, `retest_routes.py`)

### Effective profile keys (fallback when the snapshot is empty)

New `effective_profiles(db, sample) -> list[EffectiveProfile]` where
`EffectiveProfile = {key, legacy: bool, source: "snapshot" | "rows"}`:

- Snapshot present (`snapshot_profile_keys(sample)` non-empty): return those keys, `legacy=False`,
  `source="snapshot"`. Behaviour identical to today.
- Snapshot empty: derive from LIVE parent-tier rows (`lims_sub_sample_pk IS NULL`,
  `provenance IN ('canonical','shadow')`, `review_state NOT IN dead states`, and for shadow rows
  `mirror_review_state NOT IN ('rejected','retracted','cancelled','registered')`):
  - a row whose service has `origin == 'mk1'`: the all-native, non-alias `AnalysisProfile` that
    contains that service (active ones first, then by `sort_order`); `legacy=False`.
  - a SENAITE-origin row: by keyword family, `legacy=True`. Each family is an ordered list of
    keys and resolves to the FIRST key whose `AnalysisProfile` exists and has at least one
    mk1-origin member; `active` is NOT consulted:
    `HPLC-PUR | PEPT-Total | HPLC-ID | ID_* | ANALYTE-*-PUR | ANALYTE-*-QTY | BLEND-PUR | HPLC-BLEND-*`
    -> (`hplc-purity-identity`, `hplcpurity_identity`); `ENDO-LAL` -> (`endotoxin-usp85-lal`,
    `endotoxin`); `STER-PCR | PCR-BACTERIA | PCR-FUNGI` -> (`rapid-sterility-pcr`, `sterility_pcr`);
    bac-water family (`BA`, `PH`, `FILL-VOL`, `Benzyl_Alcohol_Assay`, `FILL-NET-CONTENT`,
    `PH-DETERM`) -> (`bac_water_panel`). Prod and the stack `retest` catalog have
    `hplc-purity-identity` INACTIVE but holding the HPLC services, while the ACTIVE alias
    `hplcpurity_identity` has no members (same for `endotoxin` / `sterility_pcr`). Resolving to
    the alias minted a retest with no HPLC rows (stack P-5004), so membership decides, not
    `active`. A family with no member-bearing profile, and unknown keywords, are ignored
    (logged once per sample at debug).
  - de-duplicated, ordered by profile `sort_order`; `source="rows"`.
- The alias profiles in `LEGACY_ADDON_EXCLUDE` are never offered as add-ons and never resolve
  an mk1-origin row through membership.
- `canonical_retest_key(key)` maps an alias to its member-bearing twin
  (`hplcpurity_identity` -> `hplc-purity-identity`, `endotoxin` -> `endotoxin-usp85-lal`,
  `sterility_pcr` -> `rapid-sterility-pcr`, identity otherwise). `validate_retest_spec`,
  `apply_retest_spec` and `dropped_profile_keys` resolve `retest`, `carry` and `drop` keys
  through it (only when the twin has mk1 members), so a sample whose SNAPSHOT carries the alias
  (prod P-2604) also mints a retest with HPLC rows. Either spelling counts as on the original
  for the drop/clash/missing checks. The spec forwarded to IS keeps the keys as sent.

`snapshot_profile_keys` stays as is (other callers untouched). Inside the retest flow only,
`retest_options`, `carry_eligible_profile_keys`, `validate_retest_spec` and
`dropped_profile_keys` use the effective keys for the ORIGINAL's "have" set.

### Carry rules for legacy profiles

`carry_eligible_profile_keys` is unchanged in substance: a profile is eligible only when
`_carry_plan` finds live mk1 canonical rows. A `legacy=True` profile derived from SENAITE rows
therefore is NOT eligible (its members are SENAITE-origin services; nothing native to copy).
`validate_retest_spec` keeps refusing `carry` of a non-eligible key; message for a legacy key:
`"cannot carry SENAITE-era result(s): [keys]; re-test them instead"`.

`dropped_profile_keys` uses the effective keys, so a legacy HPLC left unticked is recorded as a
drop (and the existing `retest_spec_warning` event names it), exactly like a native drop today.

### `GET /api/samples/{id}/retest-options` additions (all additive)

- top level `profiles_source: "snapshot" | "rows" | "none"` (`none` = no snapshot and no live rows).
- per profile: `legacy: bool`, `carry_blocked_reason: string | null`:
  - eligible -> `null`
  - legacy -> `"SENAITE-era result: cannot be carried, re-test it instead"`
  - native but not verified -> `"not verified yet"` (today's "cannot carry: not verified")
  - native, withdrawn/pending member -> `"a member result is still pending"`
  `carry_eligible` stays and must equal `carry_blocked_reason is None`.
- top level `context_error: {kind, message} | null` from `_fetch_retest_context`, which now
  returns `(data, error)`:
  IS answers errors with its envelope, not FastAPI's `detail`; the message is read from
  `error.message` (falling back to `detail`, then the raw text):
  - IS 404 `{"error":{"code":"not_found","message":"sample not in any order"}}` -> `kind="no_order"`,
    `message="This sample is not linked to any WooCommerce order, so no retest or add-on order can be created."`
  - IS 502 `{"error":{"code":"upstream_unavailable","message":"WordPress 404"}}` (message starts
    with `"WordPress 404"`) -> `kind="order_missing"`,
    `message=f"WooCommerce order {n} no longer exists (it was deleted), so no retest or add-on order can be created."`
    where `n` is the sample's `client_order_number` without the `WP-` prefix.
  - anything else (unreachable, 5xx, unconfigured) -> `kind="unavailable"`,
    `message="Customer and pricing are unavailable right now (Integration Service or WordPress did not answer)."`
  Existing behaviour (context null, prices blank) is unchanged; only the reason is added.

### `POST /api/samples/{id}/retest` and `addon-order`

- `create_retest`: unchanged body. With effective keys, a retest of a derived legacy profile
  (e.g. `hplc-purity-identity` on P-1908) validates and mints a native retest sample with that
  profile; carried = nothing; dropped = the other derived keys (warning event as today).
- When `context_error.kind in ("no_order", "order_missing")` the route answers 409 with the
  same message BEFORE calling IS (fail closed, no half-created order). Same for `addon-order`.

### Tests (pytest, `backend/tests/test_retest_routes.py` + a new `test_retest_effective_profiles.py`)

- snapshot present: identical output to today (regression pin, including `profiles_source="snapshot"`).
- empty snapshot + SENAITE shadow rows (HPLC-PUR/PEPT-Total/ID_X verified-mirror, ENDO-LAL,
  STER-PCR): profiles = hplc-purity-identity, endotoxin-usp85-lal, rapid-sterility-pcr, all
  `legacy=True`, `carry_eligible=False`, reason text pinned; `profiles_source="rows"`.
- empty snapshot + native canonical rows only: profile resolved through membership, `legacy=False`.
- registered/rejected shadow rows are ignored (PB-0350 class).
- validate: carry of a legacy key -> 400 with the pinned message; retest of it -> accepted and
  the other derived keys land in `drop`.
- context_error for the three kinds; retest/addon-order 409 on `no_order` / `order_missing`.

## Frontend (`src/components/senaite/RetestDialog.tsx`, `src/lib/api.ts`, tests)

### Combined re-test + add services

- The Re-test tab gains an **"Also add services"** section under the profile table (same
  add-on table as the Add services tab: Service / Price / Vials, sellable gating, extra vials
  input inside More options). Ticks are shared with the Add services tab (one `addons` set).
- `buildBody()` for the Re-test tab sends `add: {profiles: tickedAddons, variance_points,
  additional_vials: state.extraVials}` (today it sends `profiles: []`). Add services tab body is
  unchanged.
- Summary on the Re-test tab lists the add-on lines (and extra vials) under the fee/variance
  lines; Total includes them. The "When you press Create" second line gains
  `"; <names> added"` after the carried/dropped parts.
- `test('sends only the active tab half...')` is replaced by the new rule: the Re-test tab sends
  retest + carry + drop + add; the Add services tab still sends `retest: []`.

### Visible reasons

- **Order gone / no order** (`context_error.kind` `order_missing` or `no_order`): the context
  block shows the message in an amber note (same style as the unpaid strip), the Create button is
  disabled on every tab, and `retest-disabled-reason` reads the message (not "Pricing
  unavailable"). Billing Waived does NOT unblock it.
- **Context unavailable** (`kind=unavailable`): today's behaviour (prices blank, Waived unblocks)
  plus the message in the context block.
- **Legacy / non-carryable rows**: under a disabled Carry box render `carry_blocked_reason`
  (replaces the hard-coded "cannot carry: not verified"). For `legacy=True` rows the Profile cell
  gets a small muted "SENAITE-era" tag.
- **No profiles at all** (`profiles_source="none"`): the profile table is replaced by
  "No tests on record for this sample; nothing can be re-tested or carried." and only Add
  services remains usable.
- **Rule sentence** on the Re-test tab when `profiles_source="rows"`: append "Results from the
  previous system cannot be carried; re-test them if they are needed on the new certificate."
- Older backends (fields missing): everything renders exactly as today.

### Tests (vitest `src/test/retest-dialog.test.tsx`)

- Re-test tab with an add-on ticked sends `add.profiles` and the summary/outcome include it.
- `context_error.kind="order_missing"`: amber note text, Create disabled with that reason even
  when Waived.
- legacy row: Carry disabled with the pinned reason, SENAITE-era tag present.
- `profiles_source="none"`: empty-state sentence, Create blocked.
- missing new fields: old behaviour (snapshot of today's assertions).

## Evidence required on the PR (pr-evidence contract)

Stack `retest`: (1) a fabricated legacy sample (empty snapshot + SENAITE shadow rows, live WP
order) shows derived profiles with the SENAITE-era tag and blocked Carry, re-test of HPLC creates
the order and mints the native retest; (2) a native sample re-test with Fentanyl ticked creates
ONE WooCommerce order carrying the retest line + the add-on line; (3) a sample whose IS order
lookup 404s shows the amber reason and a disabled Create. Screenshots in
`docs/superpowers/e2e/2026-09-30-retest-legacy-combined/`.

## Not in scope

Carrying SENAITE-era results onto a native retest (needs a value mapping across service
identities and COA rules); IS passthrough of the WordPress error body; the stack `retest`
golden lacking shadow rows (fixture is fabricated per sample).
