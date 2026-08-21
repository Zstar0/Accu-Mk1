# S9 (Mk1): Catalog-Authoritative Vial Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the legacy-wins demand override so the Accu-Mk1 catalog becomes the source of truth for vial demand (Handler ruling 2026-08-14), with a loud replacement guard for every silent-zero path the old override masked.

**Architecture:** `derive_base_demand` keeps computing the legacy ternary but demotes it to a shadow reference — on divergence the CATALOG value now prevails and the divergence is logged, not clamped. A new boot-time demand-integrity validation (seed-tail pattern, ERROR-not-crash) plus a pre-deploy gate script (S3-precheck pattern) replace the old override's safety role. The route-edge guard that existed only to protect the override comes down with it. Dead duplicate wire-key maps are deleted. The families-state addon classifier goes catalog-first with a keyword-prefix fallback.

**Tech Stack:** Python/FastAPI backend, SQLAlchemy, pytest (SQLite in-memory for pure tests, live local Postgres for `SessionLocal` tests).

## Global Constraints

- **Worktree:** `C:\tmp\Accu-Mk1-s9-demand`, branch `feat/s9-demand-dehardcode`, base `c4bb27e8` (sterility 2→1 fix on `b30d9fc0`). All paths below are relative to this worktree unless absolute.
- **Python:** ALWAYS `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` (shared venv). Run pytest from `C:\tmp\Accu-Mk1-s9-demand\backend`.
- **Test gate = failure-set DIFF, never zero failures.** The full suite has a known-failing baseline (67F/14E at `b30d9fc0`). Slice tests must pass absolutely; the full suite is judged by comparing its sorted FAILED set against baseline. Stale `ZZTEST-*`/`TEST-*` Postgres residue rows are a known flake class — attribute by `created_at` before blaming your change.
- **Additive only.** No renames of public functions, no signature changes to `derive_base_demand`/`derive_demand` (module-level rebinding in `main.py:75` + mock patches in `test_box_label_summaries_batch.py:46,71,117` depend on the name and call shape).
- **NEVER edit `backend/conformance_vendored/`** — mirror-only vendoring contract (`backend/conformance_vendored/VENDORED.md`). D20 is explicitly OUT of this plan (deferred to the coabuilder re-vendor window with D3/D4/D5).
- **No FE changes in this plan.** D21 is explicitly deferred (same-function conflict with sibling S2's O2 retirement — see Deferred section).
- **Never push, never open PRs** — Handler directs pushes explicitly.
- Commit style: `<type>(s9): subject` lowercase, body explains why, end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- SDD ledger: `C:\tmp\Accu-Mk1-s9-demand\.superpowers\sdd\2026-08-14-s9-demand-dehardcode-mk1\progress.md` — every ruling, deferred minor, and premise correction gets an entry.
- `lims_` prefix for any new LIMS-side table (none planned).
- **GitNexus:** the index tracks the main checkout, not this sibling branch — do not attempt `gitnexus_impact` here; the research dossier's grep-verified caller inventories (quoted per task) serve as the impact analysis. Note this in commits/ledger instead of running the tool.

## Standing rulings this plan implements (do NOT re-litigate)

1. **Handler 2026-08-13/14:** Mk1 catalog = source of truth for vial demand; legacy-wins override retires. WP synced manually; Mk1 prevails on divergence.
2. **Handler 2026-08-14:** D9's seeder `ROLE_TO_KEYWORDS` pin STAYS — do not touch `lims_analyses/seeder.py` analysis-seeding paths in this slice.
3. **Handler 2026-08-05 (already on branch as `c4bb27e8`):** sterility = 1 vial.
4. **Controller conditions attached to the flip:** shadow-compare survives one release (log-only); replacement guard ships in the same slice; env kill-switch `MK1_DEMAND_LEGACY_WINS=1` as the rollback path, documented as temporary.

---

### Task 1: Flip the divergence override — catalog prevails, legacy becomes shadow

**Files:**
- Modify: `backend/sub_samples/service.py:1186-1234` (`derive_base_demand` + `derive_demand` docstrings)
- Modify: `backend/tests/test_catalog_demand.py` (the flip-pinning test at :94)
- Test: `backend/tests/test_catalog_demand.py`

**Interfaces:**
- Consumes: `derive_base_demand_catalog(db, services) -> dict` (note arg order `(db, services)` — reverse of `derive_base_demand`).
- Produces: `derive_base_demand(services, db)` now returns catalog values verbatim for legacy buckets on divergence (unless `MK1_DEMAND_LEGACY_WINS=1`); `demand_divergence` ERROR log retained as grep token. Signature unchanged.

Current code (verbatim, `backend/sub_samples/service.py:1209-1219`):

```python
    if db is None:
        return legacy
    from sub_samples.catalog_demand import derive_base_demand_catalog
    catalog = derive_base_demand_catalog(db, services)
    for bucket, legacy_n in legacy.items():
        if catalog.get(bucket, 0) != legacy_n:
            log.error(
                "demand_divergence bucket=%s legacy=%s catalog=%s services=%s",
                bucket, legacy_n, catalog.get(bucket, 0), sorted(services or {}),
            )
            catalog[bucket] = legacy_n
    return catalog
```

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_catalog_demand.py`, REWRITE `test_flip_shadow_compare_prefers_legacy_on_divergence` (line ~94, currently pins legacy-wins) as catalog-wins, and add the kill-switch + under-provision cases:

```python
def test_divergence_catalog_prevails(db_session, caplog):
    """S9 ruling 2026-08-14: on divergence the CATALOG value wins and the
    divergence is logged. Reverting to legacy-wins re-cosmetizes the catalog
    — do not restore the clamp."""
    _mk_profile(db_session, "endotoxin", vials=2, role="endo")  # catalog says 2, legacy says 1
    with caplog.at_level(logging.ERROR):
        d = derive_base_demand({"endotoxin": True}, db=db_session)
    assert d["endo"] == 2, "catalog value must prevail over the legacy shadow"
    assert any("demand_divergence" in r.message for r in caplog.records)


def test_divergence_catalog_zero_prevails_and_screams(db_session, caplog):
    """The under-provision direction: catalog 0 vs legacy 1 also resolves to
    catalog (Handler: Mk1 catalog prevails, both directions) — but the log
    must fire so ops sees it. The boot-time verify (Task 3) is the guard
    that keeps this state from persisting silently."""
    # No profile row for endotoxin at all -> catalog contributes 0
    with caplog.at_level(logging.ERROR):
        d = derive_base_demand({"endotoxin": True}, db=db_session)
    assert d["endo"] == 0
    assert any("demand_divergence" in r.message for r in caplog.records)


def test_legacy_wins_kill_switch(db_session, monkeypatch):
    """MK1_DEMAND_LEGACY_WINS=1 restores the old clamp — the deploy rollback
    path. Temporary: dies with the shadow one release after the flip."""
    monkeypatch.setenv("MK1_DEMAND_LEGACY_WINS", "1")
    _mk_profile(db_session, "endotoxin", vials=2, role="endo")
    d = derive_base_demand({"endotoxin": True}, db=db_session)
    assert d["endo"] == 1, "kill switch must restore legacy-wins clamping"
```

Use the file's existing profile-construction helper (there is one — `test_catalog_demand.py:106` builds an hm profile via `_mk_hm_profile` at :24-31; follow its shape for `_mk_profile`, or reuse/extend it). Match the file's existing imports/fixtures (`db_session` is the SQLite in-memory fixture from `tests/conftest.py:24-36`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:\tmp\Accu-Mk1-s9-demand\backend && <venv-python> -m pytest tests/test_catalog_demand.py -q`
Expected: the three new/rewritten tests FAIL (current code clamps to legacy); the rest PASS.

- [ ] **Step 3: Implement the flip**

Replace the override loop in `derive_base_demand` (keep the `demand_divergence` token and ERROR level):

```python
    if db is None:
        return legacy
    from sub_samples.catalog_demand import derive_base_demand_catalog
    catalog = derive_base_demand_catalog(db, services)
    # S9 ruling 2026-08-14: the catalog is authoritative; the legacy ternary
    # above is a shadow reference only. On divergence the catalog value
    # prevails and the divergence is logged (ERROR: ops must see it — the
    # boot-time verify_demand_catalog keeps misconfigured states loud).
    # MK1_DEMAND_LEGACY_WINS=1 restores the old clamp as a deploy rollback
    # path; both the switch and the shadow compare are slated for removal
    # one release after the flip.
    legacy_wins = os.environ.get("MK1_DEMAND_LEGACY_WINS") == "1"
    for bucket, legacy_n in legacy.items():
        if catalog.get(bucket, 0) != legacy_n:
            log.error(
                "demand_divergence bucket=%s legacy_shadow=%s catalog=%s services=%s"
                " (catalog prevails)",
                bucket, legacy_n, catalog.get(bucket, 0), sorted(services or {}),
            )
            if legacy_wins:
                catalog[bucket] = legacy_n
    return catalog
```

`import os` is already available in this module (verify; add to the module imports if not — never a function-local import for stdlib). Update BOTH docstrings: `derive_base_demand`'s ("With a db, the catalog is authoritative; on divergence the catalog value prevails and the divergence is logged — the legacy map is a shadow reference, removed one release after the S9 flip") and `derive_demand`'s if it references override behavior.

- [ ] **Step 4: Run the file's tests**

Run: `<venv-python> -m pytest tests/test_catalog_demand.py -q`
Expected: ALL PASS.

- [ ] **Step 5: Sweep the other demand tests for override-pinning asserts**

Run: `<venv-python> -m pytest tests/test_demand_ster_vials.py tests/test_variance_demand.py tests/test_sub_samples_service.py tests/test_ride_lists.py tests/test_catalog_seeding.py tests/test_profile_parity.py tests/test_order_box_label_summary.py tests/test_box_label_summaries_batch.py tests/test_sub_samples_routes.py -q`

Expected failures to FIX (they pin the old behavior — the tests are stale, per doctrine):
- `test_ride_lists.py:228-255` — the shadow-compare block asserting legacy buckets never change. Where it asserts the clamp, update to assert catalog-prevails + log. Where it asserts riders never inflate legacy buckets (a `resolve_catalog_fulfillment` property), it should still pass untouched — do NOT weaken those.
- Any other failure: judge each against the flip. If unrelated to the flip, STOP and report (known Postgres-residue flake class — check `created_at` on `ZZTEST-*` rows before touching anything).

Expected: full set green after updates.

- [ ] **Step 6: Commit**

```bash
cd C:\tmp\Accu-Mk1-s9-demand
git add backend/sub_samples/service.py backend/tests/test_catalog_demand.py backend/tests/test_ride_lists.py
git commit -m "feat(s9): catalog prevails over the legacy demand shadow on divergence"
```

(Include any other test files updated in Step 5. Body: cite the Handler ruling 2026-08-14, the kill-switch, and the one-release shadow sunset.)

---

### Task 2: Retire the shadow-compare route guard (`_RESERVED_LEGACY_ROLES`)

**Files:**
- Modify: `backend/main.py:2594-2606` (guard constants), `backend/main.py:15932-15933` (POST edge), `backend/main.py:16025-16033` (PATCH edge)
- Do NOT touch: `backend/main.py:16260` ride-hosts PUT guard and the rider-semantics closure at `:16044-16056` UNLESS verification shows they cite only the shadow-compare (see Step 1).
- Test: `backend/tests/test_api_analysis_profiles.py`

**Interfaces:**
- Consumes: Task 1's flip (the guard's justification — "a NEW profile claiming a legacy role would get silently zero-clamped" — is only true under legacy-wins).
- Produces: POST/PATCH on analysis profiles accept `fulfillment_role` in `{"hplc","endo","ster"}` for any profile. The `xtra` reservation STAYS. Ride-hosts rider-semantics guards STAY.

Context (verbatim, `backend/main.py:2594-2606`):

```python
# Spec-3 shadow-compare guard rails, enforced at the profile POST/PATCH edge
# (not a DB constraint, mirroring COA_ARCHETYPES above):
#   - The three legacy fulfillment_role values are demand-map keys derive_
#     base_demand's shadow-compare owns; a NEW profile claiming one would get
#     silently zero-clamped whenever its key is absent from an order's legacy
#     flags (derive_base_demand only ever checks the five keys below). Only
#     the profiles that ARE those legacy keys may hold a legacy role.
#   - 'xtra' is the reserved no-op bucket (never a real fulfillment target);
#     no profile may claim it.
_LEGACY_PROFILE_KEYS = {
    "hplcpurity_identity", "bac_water_panel", "endotoxin", "sterility_pcr", "variance",
}
_RESERVED_LEGACY_ROLES = {"hplc", "endo", "ster"}
```

- [ ] **Step 1: Read all four guard sites and classify each by justification**

Read `backend/main.py:15920-15945`, `:16015-16060`, `:16230-16270`. For each rejection branch decide: (a) justified ONLY by the shadow-compare zero-clamp (the PATCH 400 message literally says "reserved for the legacy demand map while the shadow-compare is active") → retire; (b) justified by rider semantics ("a legacy-bucket anchor may never carry a ride list because resolve_catalog_fulfillment treats 'has a ride row' as 'is a rider'") or the `xtra` no-op reservation → KEEP. Record the classification of each site in the ledger before editing.

- [ ] **Step 2: Write the failing test**

In `backend/tests/test_api_analysis_profiles.py`, add:

```python
def test_new_profile_may_anchor_legacy_role_post_flip(client, db_session):
    """S9: with the catalog authoritative (legacy-wins clamp retired), a new
    family may legitimately anchor a legacy bucket — the old 400 protected a
    zero-clamp that no longer exists. xtra stays reserved."""
    resp = client.post("/api/analysis-profiles", json={
        "key": "test_new_hplc_family", "name": "Test new HPLC-anchored family",
        "is_addon": True, "vials_required": 1, "fulfillment_role": "hplc",
    })
    assert resp.status_code == 200, resp.text

    resp2 = client.post("/api/analysis-profiles", json={
        "key": "test_xtra_grab", "name": "Test xtra grab",
        "is_addon": True, "vials_required": 1, "fulfillment_role": "xtra",
    })
    assert resp2.status_code == 400, "xtra reservation must survive S9"
```

Match the file's actual route path, auth/client fixture, and payload shape to its existing POST tests (read the file first — :274 documents the five-legacy-key rule and there are existing 400-pinning tests that must be REWRITTEN, not deleted, to pin the new contract).

- [ ] **Step 3: Run to verify the new test fails**

Run: `<venv-python> -m pytest tests/test_api_analysis_profiles.py -q`
Expected: new test FAILS on the first assert (400 from the guard); existing guard-pinning tests PASS.

- [ ] **Step 4: Retire the shadow-compare branches**

Remove the POST/PATCH `_RESERVED_LEGACY_ROLES` rejections classified (a) in Step 1. Keep `xtra` rejection. Rewrite the comment block at :2594 to its post-S9 truth (xtra reservation + whatever rider-semantics guards remain reference these constants). If `_LEGACY_PROFILE_KEYS` / `_RESERVED_LEGACY_ROLES` end up unreferenced, delete them; if the ride-hosts guard still uses them, keep them with the comment updated.

- [ ] **Step 5: Update the stale guard-pinning tests and run**

Rewrite existing tests that pin the retired 400s to pin the new accept behavior. Run: `<venv-python> -m pytest tests/test_api_analysis_profiles.py -q`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_api_analysis_profiles.py
git commit -m "feat(s9): retire the shadow-compare route guard -- new families may anchor legacy roles"
```

---

### Task 3: Boot-time demand-integrity validation (`verify_demand_catalog`)

**Files:**
- Create: `backend/catalog/demand_verify.py`
- Modify: `backend/database.py:145-156` area (add a seed-tail call block after the profile seed block, same try/except-warning idiom)
- Test: `backend/tests/test_demand_verify.py` (new)

**Interfaces:**
- Consumes: `models.AnalysisProfile`, `models.VialRole` (columns verified this vintage: `AnalysisProfile.key/active/vials_required/fulfillment_dim/fulfillment_role/is_addon`; `VialRole.code/department_id`).
- Produces: `verify_demand_catalog(db) -> list[str]` — returns human-readable violation strings AND logs each at ERROR with the grep token `demand_catalog_integrity`. Returns `[]` on a healthy or legitimately-empty catalog. Task 4's precheck script reuses this exact function.

Design (each check exists because the flip removed the clamp that used to mask it):

1. **Legacy-key completeness:** each of `hplcpurity_identity`, `bac_water_panel`, `endotoxin`, `sterility_pcr` must exist, be `active`, have `vials_required >= 1`, and a non-NULL `fulfillment_role`. (Post-flip, a missing/zeroed legacy profile means real under-provisioning — the exact case the old override clamped away.)
2. **Silent-zero class:** any `active` profile with `fulfillment_dim == "role"` and `fulfillment_role IS NULL` — this is `catalog_demand.py:68-69`'s completely-silent `continue`, and it is reachable via the seed (`profile_seed.py`'s `vials_required == 0` guard also gates the role backfill: a row with vials set but role NULL is never healed).
3. **Half-configured class:** any `active` profile with `fulfillment_dim == "role"`, a non-NULL role, and `vials_required == 0` (plans zero vials — admin-created rows default to 0).
4. **Unfillable-role class:** any `fulfillment_role` referenced by an active role-dim profile that has no matching `vial_roles.code` row, or whose role row has `department_id IS NULL` — `real_bucket_codes(db)` (`backend/catalog/roles.py:26-35`) only returns roles with a non-NULL department, so auto-assign silently never fills these (`xtra` is exempt by design and must not be flagged).
5. **Empty-catalog escape hatch:** if there are zero `AnalysisProfile` rows total, return `[]` without logging — a fresh install / pre-first-boot DB is not a misconfiguration (same hatch as `backfill_departments`'s `total_count` guard at `catalog/departments.py:168-192`).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_demand_verify.py` (SQLite `db_session` fixture from conftest; build rows with the models directly):

```python
"""Boot-time demand-catalog integrity validation (S9). Each check covers a
silent-zero path the retired legacy-wins override used to mask."""
import logging

from models import AnalysisProfile, VialRole, Department
from catalog.demand_verify import verify_demand_catalog


def _mk_profile(db, key, *, vials=1, role="endo", dim="role", active=True):
    p = AnalysisProfile(
        key=key, name=f"T {key}", is_addon=True, vials_required=vials,
        fulfillment_dim=dim, fulfillment_role=role, active=active,
    )
    db.add(p)
    db.flush()
    return p


def _mk_role(db, code, *, dept=True):
    d = None
    if dept:
        d = Department(name=f"Dept {code}")
        db.add(d)
        db.flush()
    r = VialRole(code=code, label=code.upper(), department_id=(d.id if d else None))
    db.add(r)
    db.flush()
    return r


def _seed_legacy_ok(db):
    _mk_role(db, "hplc"); _mk_role(db, "endo"); _mk_role(db, "ster")
    _mk_profile(db, "hplcpurity_identity", role="hplc")
    _mk_profile(db, "bac_water_panel", role="hplc")
    _mk_profile(db, "endotoxin", role="endo")
    _mk_profile(db, "sterility_pcr", role="ster")


def test_empty_catalog_is_not_a_violation(db_session, caplog):
    with caplog.at_level(logging.ERROR):
        assert verify_demand_catalog(db_session) == []
    assert not caplog.records


def test_healthy_catalog_is_clean(db_session):
    _seed_legacy_ok(db_session)
    assert verify_demand_catalog(db_session) == []


def test_missing_legacy_key_flagged(db_session, caplog):
    _seed_legacy_ok(db_session)
    db_session.query(AnalysisProfile).filter_by(key="endotoxin").delete()
    with caplog.at_level(logging.ERROR):
        violations = verify_demand_catalog(db_session)
    assert any("endotoxin" in v for v in violations)
    assert any("demand_catalog_integrity" in r.message for r in caplog.records)


def test_role_less_active_profile_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role=None)
    assert any("heavy_metals" in v for v in verify_demand_catalog(db_session))


def test_zero_vials_role_profile_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", vials=0, role="hm")
    _mk_role(db_session, "hm")
    assert any("heavy_metals" in v for v in verify_demand_catalog(db_session))


def test_unfillable_role_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role="hm")  # no vial_roles row for hm
    assert any("hm" in v for v in verify_demand_catalog(db_session))


def test_null_department_role_flagged(db_session):
    _seed_legacy_ok(db_session)
    _mk_role(db_session, "hm", dept=False)
    _mk_profile(db_session, "heavy_metals", role="hm")
    assert any("hm" in v for v in verify_demand_catalog(db_session))


def test_inactive_profiles_are_ignored(db_session):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "retired_thing", role=None, active=False)
    assert verify_demand_catalog(db_session) == []
```

NOTE for the implementer: the four legacy profiles must stay ACTIVE-checked — `_seed_legacy_ok` then deactivating one should also flag (add that case if not covered by `test_missing_legacy_key_flagged`'s shape). `Department.name` is UNIQUE — the helper must not collide names across calls in one test.

- [ ] **Step 2: Run to verify failure**

Run: `<venv-python> -m pytest tests/test_demand_verify.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'catalog.demand_verify'`.

- [ ] **Step 3: Implement `backend/catalog/demand_verify.py`**

```python
"""Demand-catalog integrity validation (S9).

With the legacy-wins override retired (catalog authoritative for vial
demand), a misconfigured catalog row can under-provision vials with no
request-time error. Every check here covers one silent path:

  1. legacy-key completeness  — the four legacy wire keys must resolve to
     active, role-bearing, vials>=1 profiles (post-flip, their absence is
     real under-provisioning, not a clamped no-op);
  2. role-less active profile — catalog_demand.resolve_catalog_fulfillment
     line ~68 skips these with NO log;
  3. zero-vials role profile  — admin-created rows default vials_required=0
     and plan zero;
  4. unfillable role          — roles absent from vial_roles or with a NULL
     department are never returned by catalog.roles.real_bucket_codes, so
     auto-assign never fills them ('xtra' exempt by design).

Called from database.init_db's seed tail (ERROR log, never blocks boot) and
from scripts/s9_demand_precheck.py (the pre-deploy gate).
"""
import logging

log = logging.getLogger(__name__)

LEGACY_DEMAND_KEYS = (
    "hplcpurity_identity", "bac_water_panel", "endotoxin", "sterility_pcr",
)


def verify_demand_catalog(db) -> list[str]:
    from models import AnalysisProfile, VialRole

    total = db.query(AnalysisProfile).count()
    if total == 0:
        # Fresh install / pre-first-boot: an empty catalog is not a
        # misconfiguration (same hatch as backfill_departments' total_count).
        return []

    violations: list[str] = []

    for key in LEGACY_DEMAND_KEYS:
        row = db.query(AnalysisProfile).filter_by(key=key).one_or_none()
        if row is None or not row.active:
            violations.append(
                f"legacy demand key '{key}' missing or inactive — orders "
                f"carrying it will plan ZERO vials for its bucket"
            )
            continue
        if not row.fulfillment_role or row.vials_required < 1:
            violations.append(
                f"legacy demand key '{key}' misconfigured "
                f"(vials_required={row.vials_required}, "
                f"fulfillment_role={row.fulfillment_role!r}) — plans zero"
            )

    role_dim = (
        db.query(AnalysisProfile)
        .filter(AnalysisProfile.active.is_(True),
                AnalysisProfile.fulfillment_dim == "role")
        .all()
    )
    for p in role_dim:
        if not p.fulfillment_role:
            violations.append(
                f"active role-dim profile '{p.key}' has NO fulfillment_role — "
                f"silently skipped by resolve_catalog_fulfillment"
            )
        elif p.vials_required == 0:
            violations.append(
                f"active role-dim profile '{p.key}' has vials_required=0 — "
                f"plans zero vials"
            )

    role_codes = {c for (c,) in db.query(VialRole.code).all()}
    dept_ok = {
        c for (c,) in db.query(VialRole.code)
        .filter(VialRole.department_id.isnot(None)).all()
    }
    for p in role_dim:
        r = p.fulfillment_role
        if not r or r == "xtra":
            continue
        if r not in role_codes:
            violations.append(
                f"fulfillment_role '{r}' (profile '{p.key}') has no vial_roles "
                f"row — auto-assign will never fill it"
            )
        elif r not in dept_ok:
            violations.append(
                f"fulfillment_role '{r}' (profile '{p.key}') has a NULL "
                f"department — excluded from real_bucket_codes, never filled"
            )

    for v in violations:
        log.error("demand_catalog_integrity %s", v)
    return violations
```

- [ ] **Step 4: Run the tests**

Run: `<venv-python> -m pytest tests/test_demand_verify.py -q`
Expected: ALL PASS. Iterate on mismatches between test fixtures and real model constraints (e.g. NOT NULL columns the helpers must satisfy) — fix the TEST fixtures to satisfy the schema, not the schema.

- [ ] **Step 5: Wire into `init_db`'s seed tail**

In `backend/database.py`, immediately AFTER the vial-roles seed block (:145-150) and following the exact established idiom (:132-144):

```python
    # S9: demand-catalog integrity — with the legacy-wins override retired,
    # a misconfigured profile under-provisions with no request-time error.
    # ERROR-per-violation inside; never blocks startup.
    try:
        from catalog.demand_verify import verify_demand_catalog
        with SessionLocal() as _s:
            verify_demand_catalog(_s)
    except Exception as e:  # never block startup
        log.warning("demand_catalog_verify_skipped err=%s", e)
```

Place it AFTER every catalog seed block it validates (departments, profiles, vial roles) — order matters; read :122-156 and insert after the LAST catalog seed.

- [ ] **Step 6: Boot smoke + commit**

Run: `<venv-python> -c "import sys; sys.path.insert(0, '.'); import database; database.init_db()"` from `backend/` — expected: completes without raising; any `demand_catalog_integrity` ERRORs printed reflect the local dev DB's real state (report them, don't fix them here).

```bash
git add backend/catalog/demand_verify.py backend/tests/test_demand_verify.py backend/database.py
git commit -m "feat(s9): boot-time demand-catalog integrity validation"
```

---

### Task 4: Pre-deploy gate script (`s9_demand_precheck.py`)

**Files:**
- Create: `backend/scripts/s9_demand_precheck.py`
- Test: `backend/tests/test_demand_precheck.py` (new)

**Interfaces:**
- Consumes: `catalog.demand_verify.verify_demand_catalog` (Task 3) — single source of check logic.
- Produces: CLI `python scripts/s9_demand_precheck.py --env-label {s3rehe|prod|local-dev}`; exit 0 = clean, 3 = violations (reported, never auto-healed). Pre-catalog-layer DB (no `analysis_profiles` table): prints an explicit "catalog layer absent — flip is inert until first boot seeds profiles; re-run post-boot" note, exit 0.

Model the file on `backend/scripts/s3_identity_precheck.py` at the S3 branch (`C:\tmp\Accu-Mk1-s3-identity\backend\scripts\s3_identity_precheck.py`) — copy its structure: module docstring with usage, `sys.path` insert, `--env-label` required arg, UTF-8 stdout reconfigure, `run_precheck(db, env_label) -> int` split out for testability, read-only rollback in `finally`. Two S9-specific behaviors:

1. **Pre-catalog probe:** before running checks, probe `information_schema.tables` for `analysis_profiles`; absent → print the deferred note, exit 0 (the graceful-degrade contract the S3 script learned on 2026-08-14 — do it right from the start here).
2. **Report shape:** print each violation string on its own line; end `=== clean ===` / `=== VIOLATIONS: N ===`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_demand_precheck.py`:

```python
"""The S9 pre-deploy gate script — same run/report contract as the S3
identity precheck: env named, exit 0/3, diagnostics never crash."""
import logging

from scripts.s9_demand_precheck import run_precheck
from tests.test_demand_verify import _seed_legacy_ok, _mk_profile


def test_clean_db_exits_zero(db_session, capsys):
    _seed_legacy_ok(db_session)
    assert run_precheck(db_session, "test-env") == 0
    out = capsys.readouterr().out
    assert "environment: test-env" in out
    assert "=== clean ===" in out


def test_empty_catalog_exits_zero_with_note(db_session, capsys):
    assert run_precheck(db_session, "test-env") == 0
    assert "catalog" in capsys.readouterr().out.lower()


def test_violations_exit_three_and_report(db_session, capsys):
    _seed_legacy_ok(db_session)
    _mk_profile(db_session, "heavy_metals", role=None)
    assert run_precheck(db_session, "test-env") == 3
    out = capsys.readouterr().out
    assert "heavy_metals" in out
```

(If importing helpers across test modules offends the suite's conventions — check how other test files share fixtures — move `_seed_legacy_ok`/`_mk_profile` into a small shared helper module under `tests/` instead of cross-importing.)

- [ ] **Step 2: Run to verify failure** — `<venv-python> -m pytest tests/test_demand_precheck.py -q` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement the script.** Skeleton (flesh out per the S3 model at `C:\tmp\Accu-Mk1-s3-identity\backend\scripts\s3_identity_precheck.py` — module docstring with usage, UTF-8 reconfigure, read-only finally):

```python
"""S9 demand-catalog pre-deploy gate. Run against BOTH s3rehe and prod,
naming the environment. Exit codes: 0 clean · 3 violations (reported,
never auto-healed). A pre-catalog-layer DB reports the layer absent and
exits 0 — the demand flip is inert until first boot seeds profiles."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import inspect as sa_inspect

from database import SessionLocal
from catalog.demand_verify import verify_demand_catalog


def run_precheck(db, env_label: str) -> int:
    print(f"=== S9 demand pre-check — environment: {env_label} ===")
    if not sa_inspect(db.get_bind()).has_table("analysis_profiles"):
        print(
            "catalog layer absent (no analysis_profiles table; pre-first-boot). "
            "The demand flip is inert until the first boot seeds profiles — "
            "re-run this script post-boot."
        )
        print("=== clean (catalog layer absent) ===")
        return 0
    violations = verify_demand_catalog(db)
    if violations:
        for v in violations:
            print(v)
        print(f"=== VIOLATIONS: {len(violations)} ===")
        return 3
    print("=== clean ===")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="S9 demand-catalog pre-deploy gate")
    ap.add_argument("--env-label", required=True)
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    db = SessionLocal()
    try:
        return run_precheck(db, args.env_label)
    finally:
        db.rollback()
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
```

Note the empty-catalog case (table exists, zero rows) already exits 0 via `verify_demand_catalog`'s escape hatch — the tests pin both layers.

- [ ] **Step 4: Run tests** — ALL PASS.

- [ ] **Step 5: Live smoke against local dev** — `cd backend && <venv-python> scripts/s9_demand_precheck.py --env-label local-dev`. Expected: exits 0 or 3; either is fine — REPORT the output verbatim in the ledger (local dev's catalog state is unknown; violations here are information, not failures).

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/s9_demand_precheck.py backend/tests/test_demand_precheck.py
git commit -m "feat(s9): demand-catalog pre-deploy gate script"
```

---

### Task 5: Delete the dead duplicate wire-key maps (D6/D7)

**Files:**
- Modify: `backend/sub_samples/service.py:1137-1150` (delete `VARIANCE_BUCKET_KEYS` + its comment block)
- Modify: `backend/lims_analyses/service.py:482-491` (delete `_ROLE_VARIANCE_KEYS`), `:494-…` (delete `ensure_variance_entitlement` — zero production callers, self-documented as retained-reference-only)
- Modify: `backend/tests/test_variance_demand.py:50-59` (delete `test_bucket_key_map_matches_lifecycle_gate`)
- Modify: `backend/tests/test_variance_verify.py` (delete the `ensure_variance_entitlement` tests at :174-218 — verify whether that's a class or loose functions and whether the FILE tests anything else; delete only the dead function's tests)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — pure deletion. The bucket→wire-key vocabulary's remaining copies are wpstar-side (W8/W15, owned by the wpstar plan) and `derive_variance_demand`'s inline keys (explicitly deferred — see Deferred section).

- [ ] **Step 1: Verify deadness fresh** (do not trust the dossier blindly): `grep -rn "VARIANCE_BUCKET_KEYS\|_ROLE_VARIANCE_KEYS\|ensure_variance_entitlement" backend/ src/` from the worktree root. Expected referents: the two definitions, `test_variance_demand.py:58-59`, `lims_analyses/service.py:531` (inside the dead function), `test_variance_verify.py` sites. ANY other production hit → STOP, report, do not delete.

- [ ] **Step 2: Delete** all four sites listed under Files. Keep `test_variance_verify.py`'s unrelated tests intact if any exist.

- [ ] **Step 3: Run the touched suites**

Run: `<venv-python> -m pytest tests/test_variance_demand.py tests/test_variance_verify.py tests/test_sub_samples_service.py -q`
Expected: ALL PASS (minus the deleted tests). An ImportError anywhere = you missed a referent; return to Step 1.

- [ ] **Step 4: Commit**

```bash
git add -A backend/sub_samples/service.py backend/lims_analyses/service.py backend/tests/test_variance_demand.py backend/tests/test_variance_verify.py
git commit -m "refactor(s9): delete dead duplicate bucket->wire-key maps and the retained-reference entitlement gate"
```

(Body: cite D6/D7, the "no production callers" verification, and that the commercial re-gate reference case is covered by git history.)

---

### Task 6: Catalog-first addon classifier for family state (D19)

**Files:**
- Modify: `backend/families/service.py:29-40` (`_ADDON_PREFIXES` / `_is_hplc`) and its four call sites (:79, :105, :122, :242)
- Test: `backend/tests/test_families_service.py`

**Interfaces:**
- Consumes: `models.AnalysisService` (has `keyword`, `department_id` at this vintage), `catalog.departments.ANALYTICAL_DEPARTMENT` (`"Analytical"`, `departments.py:35`).
- Produces: `_build_hplc_classifier(db) -> Callable[[str], bool]` — returns a callable mapping keyword → is_hplc, catalog-first with the legacy prefix rule as fallback. `_is_hplc(keyword)` REMAINS as the pure fallback (unchanged semantics) so keyword-only paths and tests keep working.

Design: one catalog query per family-state computation builds `{keyword.upper(): (department == Analytical)}` from `analysis_services` joined to `departments`; the classifier closure checks the map first, falls back to `_is_hplc` (prefix rule) for keywords not in the catalog (SENAITE-legacy rows, unknowns). This makes a new catalog family (e.g. an `HM-*` keyword under the Heavy Metals department) classify as addon WITHOUT a code change — the current bug (dossier item 5: any non-`ENDO-`/`STER-` keyword classifies as HPLC, so a pending HM analysis blocks `waiting_for_addon_results` from ever showing).

- [ ] **Step 1: Read the four call sites** (`families/service.py:79, 105, 122, 242`) and establish whether a `db` session is in scope at each (the functions around them — quote in ledger). If any site genuinely has no db, the classifier map must be built by the CALLER that has one and threaded down — record the actual threading you choose.

- [ ] **Step 2: Write the failing test**

In `backend/tests/test_families_service.py` (follow its existing fixture idiom — :15 has the breakdown builder):

```python
def test_catalog_family_keyword_classifies_as_addon(db_session):
    """S9/D19: a keyword belonging to a NON-Analytical catalog service must
    classify as addon even though it matches no legacy prefix. Pre-S9 this
    misclassified as HPLC and suppressed waiting_for_addon_results."""
    from catalog.departments import ANALYTICAL_DEPARTMENT
    from models import AnalysisService, Department

    hm_dept = Department(name="Heavy Metals TEST")
    db_session.add(hm_dept)
    db_session.flush()
    db_session.add(AnalysisService(
        title="Heavy Metals Panel", keyword="HM-ICPMS", origin="mk1",
        department_id=hm_dept.id,
    ))
    db_session.flush()

    from families.service import _build_hplc_classifier
    is_hplc = _build_hplc_classifier(db_session)
    assert is_hplc("HM-ICPMS") is False          # catalog wins
    assert is_hplc("ENDO-LAL") is False          # prefix fallback intact
    assert is_hplc("IDENTITY_BPC157") is True    # non-catalog keyword falls back to prefix rule
```

(Adjust `AnalysisService` constructor kwargs to the real model — read `models.py` for required fields; the dossier confirms `department_id` exists on it at this vintage via the departments backfill.)

- [ ] **Step 3: Run to verify failure** — `ImportError: cannot import name '_build_hplc_classifier'`.

- [ ] **Step 4: Implement** the builder + convert the four call sites to use it (build once per request/computation, never per-row queries). Keep `_is_hplc` exported and byte-stable.

- [ ] **Step 5: Run the families suites**

Run: `<venv-python> -m pytest tests/test_families_service.py tests/test_families_routes.py -q`
Expected: ALL PASS. If an existing test pinned the prefix-only behavior for a catalog-known keyword, it is stale by this slice's ruling — update it and ledger.

- [ ] **Step 6: Commit**

```bash
git add backend/families/service.py backend/tests/test_families_service.py
git commit -m "feat(s9): family-state addon classifier reads the catalog first, prefix rule demoted to fallback"
```

---

### Task 7: Full-suite gate + ledger closeout

**Files:**
- Modify: `.superpowers/sdd/2026-08-14-s9-demand-dehardcode-mk1/progress.md`

- [ ] **Step 1: Full backend suite** (NEVER concurrently with another worktree's run — shared dev Postgres):

Run: `cd C:\tmp\Accu-Mk1-s9-demand\backend && <venv-python> -m pytest tests/ -q`

- [ ] **Step 2: Failure-set diff.** Sort the FAILED/ERROR list; diff against the 67F/14E baseline at `b30d9fc0` (re-derive by running the suite at the base commit if no baseline file is at hand — `git stash` is NOT acceptable for this; use the S2 or S3 worktree's recorded baseline if present, else derive once and save to the SDD dir). ANY new failure not caused by this slice's intentional test updates → fix or report. Known flake class: `ZZTEST-*`/`TEST-*` residue rows (check `created_at`), and the drop-in-txn lock class (isolate re-run).

- [ ] **Step 3: Ledger closeout.** Record: baseline diff result, every controller ruling made mid-build, every deferred minor, the boot-smoke output from Task 3, and the local-dev precheck output from Task 4.

- [ ] **Step 4: Commit the ledger is NOT required** (SDD dir is untracked by slice precedent). Final state: clean `git status` except untracked plan/SDD files.

---

## Deferred OUT of this plan (ledgered, not forgotten)

| Item | Why deferred | Where it lands |
|---|---|---|
| **D20** (`ADDON_KEYWORDS` etc. in `conformance_vendored/addon_parsing.py`) | Mirror-only vendoring contract (`VENDORED.md`): in-place edits forbidden; file must stay dependency-free (no DB). Datafying requires an upstream coabuilder change + re-vendor. | The coabuilder re-vendor window, WITH D3/D4/D5 (spec/validation-engine migration program). |
| **D21** (`computePrimaryAnalysisUids` + `ROLE_HEADER_BADGES`, FE) | Sibling S2 (#103) rewrites the same function's hplc branch (O2) — a sibling S9 edit guarantees a semantic merge conflict; highlight-only, low blast. | Post-merge integration phase, after S2 lands. |
| **`derive_variance_demand` inline wire keys** (`service.py:1168-1174`) | Fourth hardcoded map, discovered in research — variance demand is kind-dim with its own BW-aware inline ruling (2026-06-17); datafying it entangles the variance program mid-slice. | Backlog for the Handler; candidate for the variance program or an S9 follow-up. |
| **`_DEMAND_DEFAULTS` hm entry** (`profile_seed.py`) | `heavy_metals` intentionally absent from the legacy seed (hm is catalog-native); Task 3's checks make a half-configured hm row LOUD, which is the guard the seed lacks. | No change needed; noted for the record. |
| **D8 (`ROLE_TO_WP_KEYS`), D16 (`_UNGROUPED_ANALYTICAL_LIKE_PATTERNS`), D17 (`PRIORITIES`)** | Not in the adopted carry order's items 1-6. D8 sits in seeder territory adjacent to the D9 pin the Handler ruled STAYS; D16 is fail-closed with a documented seeds-zero-analyses blast radius (needs its own seeder-test-gated slice); D17 is low value. | S9 follow-up backlog, individually ruled. |

## Post-build follow-ups (NOT in this plan's tasks)

- Run `s9_demand_precheck.py` on s3rehe and prod (environment named) before any deploy of this arc — same gate discipline as the S3 identity precheck; prod pre-first-boot will report the catalog-absent note (expected).
- One release after the flip ships: delete the legacy ternary shadow, the `MK1_DEMAND_LEGACY_WINS` switch, and the divergence log (tracked in the arc deploy plan).
- The wpstar S9 plan (separate document) carries the WP-side pairing: STERILITY 2→1 const, wire-key storage, cart fix — deploy ordering per the arc deploy plan (Mk1 before theme).
