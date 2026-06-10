# Variance Demand + Assignment UI (Phase 2 of Variance Addon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vial demand inflates per purchased variance counts, the Receive-wizard Assignment buckets render a VARIANCE sub-row (demand math, not vial designation), and `lock_variance_set` gains the series-complete guard — spec `docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md` §2 + §5.

**Architecture:** `derive_demand` (the single demand source feeding both `/vial-demand` → WizardHeader and `/vial-plan` → AssignStep) inflates per bucket via `max(base, variance_n)`, with a new pure `derive_variance_demand` reading the normalized variance map. Both responses carry the per-bucket `variance` breakdown so the FE can render sub-rows. The lock guard checks that every live analysis row on in-set vials in variance-purchased buckets is `promoted`/`variance_verified` (fail-soft when no variance / WP unreachable — lock behaves exactly as today).

**Tech Stack:** Same as Phase 1 — backend pytest in `accumark-subvial-accu-mk1-backend` against the LIVE `accumark_mk1` DB (ZZTEST fixtures + teardown), FE vitest/tsc in `accumark-subvial-accu-mk1-frontend`.

**Operational notes for the executor:**
- Backend tests: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <files> -q"`
- FE tests: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run <files>"`
- Known pre-existing failures (NOT yours): FE `App.test.tsx` + `peptide-requests-list.test.tsx`; backend `test_lims_analyses_service.py` ×3 + `test_lims_analyses_routes.py::test_transition_happy_path_to_verified`. Baseline anything else suspicious with `git stash`.
- Commit per task with trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (use `git commit -F <file>`).

**Spec-pinned semantics (decided at plan time, surface in the final report):**
- Variance count n = TOTAL replicates in the set; per-bucket demand = `max(base, n)`. NOTE: ster's base is 2 (two vials per sterility test, lab protocol) — `max(2, n)` means ster variance n=3 yields 3 vials, NOT 3 tests × 2 vials. If sterility variance should multiply instead, that's a contract question for Phase 3/4 — flag it to the user, don't redesign here.
- The VARIANCE sub-row is presentational demand math: the plain `hplc` bucket gets a base line + variance line; the Microbiology SubDropZones (endo/ster) get a `(×N variance)` label annotation instead of another nesting level. All vials keep their plain roles; nothing marks a specific vial as "canonical" or "variance".
- Lock guard scope: in-set SUB-SAMPLE vials only (parent rows promote; SENAITE rows aren't lims rows), rows with `review_state NOT IN ('retracted','rejected') AND retested = FALSE` must be `promoted` or `variance_verified`. Superseded (retested) rows are exempt. Guard is skipped entirely when the order has no variance or WP is unreachable (lock keeps today's behavior).

---

### Task 1: Backend — variance demand inflation + response breakdown

**Files:**
- Modify: `backend/sub_samples/service.py` (`derive_demand` :518-532, `compute_vial_plan` :539-647 — the two response dicts and the unreachable branch)
- Modify: `backend/sub_samples/routes.py` (`get_vial_demand` :222-248 — both return dicts)
- Modify: `backend/sub_samples/schemas.py` (`VialPlanResponse` :62-66)
- Test: `backend/tests/test_variance_demand.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_variance_demand.py`:

```python
"""Variance addon Phase 2 — demand inflation + vial-plan breakdown + lock guard.

Spec: docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md §2, §5.
"""
import pytest

from sub_samples import service as sub_service


BASE_SERVICES = {
    "hplcpurity_identity": True,
    "endotoxin": True,
    "sterility_pcr": True,
}


class TestDeriveVarianceDemand:
    def test_maps_keys_to_buckets(self):
        out = sub_service.derive_variance_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 3, "endo": 2, "ster": 0}

    def test_zero_without_variance(self):
        assert sub_service.derive_variance_demand(BASE_SERVICES) == {
            "hplc": 0, "endo": 0, "ster": 0,
        }

    def test_ignores_invalid_counts_via_normalize(self):
        out = sub_service.derive_variance_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 1, "endotoxin": "junk"},
        })
        assert out == {"hplc": 0, "endo": 0, "ster": 0}

    def test_bucket_key_map_matches_lifecycle_gate(self):
        # The demand map and the variance_verify gate must agree on
        # role/bucket -> WP service key, or check-in demand and the sign-off
        # gate drift apart.
        from lims_analyses.service import _ROLE_VARIANCE_KEYS
        assert sub_service.VARIANCE_BUCKET_KEYS == _ROLE_VARIANCE_KEYS


class TestDeriveDemandInflation:
    def test_no_variance_unchanged(self):
        assert sub_service.derive_demand(BASE_SERVICES) == {
            "hplc": 1, "endo": 1, "ster": 2,
        }

    def test_variance_inflates_per_bucket(self):
        out = sub_service.derive_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 3, "endotoxin": 2},
        })
        assert out == {"hplc": 3, "endo": 2, "ster": 2}

    def test_max_semantics_never_shrinks(self):
        # ster base is 2; a variance n=2 must not change it, and an unordered
        # service must stay 0 even if a (contract-invalid) variance key shows up.
        out = sub_service.derive_demand({
            "sterility_pcr": True,
            "variance": {"sterility_pcr": 2, "hplcpurity_identity": 5},
        })
        assert out["ster"] == 2
        assert out["hplc"] == 0  # base 0: variance never creates demand for an unordered service


class TestVialDemandResponses:
    def test_compute_vial_plan_carries_variance(self, monkeypatch):
        from database import SessionLocal
        monkeypatch.setattr(
            sub_service, "fetch_sample_services",
            lambda sid: {"services": {**BASE_SERVICES,
                                      "variance": {"hplcpurity_identity": 3}},
                         "wp_order_number": "WP-1"},
        )
        db = SessionLocal()
        try:
            plan = sub_service.compute_vial_plan(db, "PB-0076")
            assert plan["variance"] == {"hplc": 3, "endo": 0, "ster": 0}
            assert plan["demand"]["hplc"] == 3
        finally:
            db.rollback()
            db.close()

    def test_unreachable_plan_has_zero_variance(self, monkeypatch):
        from database import SessionLocal
        monkeypatch.setattr(
            sub_service, "fetch_sample_services", lambda sid: None)
        db = SessionLocal()
        try:
            plan = sub_service.compute_vial_plan(db, "PB-0076")
            assert plan["is_unreachable"] is True
            assert plan["variance"] == {"hplc": 0, "endo": 0, "ster": 0}
        finally:
            db.rollback()
            db.close()
```

CAUTION: `compute_vial_plan` PERSISTS auto-assign role changes (`db.commit()` at :616). Using the real `PB-0076` could mutate dev data. To stay non-destructive, the two `TestVialDemandResponses` tests must use a THROWAWAY ZZTEST parent with no sub-samples instead of PB-0076: create `LimsSample(sample_id='ZZTEST-VARD', peptide_name='ZZ', status='received')`, commit, run compute_vial_plan against it (no subs → no role changes persisted), and delete it in teardown (mirror the fixture pattern in `tests/test_variance_verify.py`). Write the fixture accordingly — the code above shows intent; adapt it to the ZZTEST fixture before running.

- [ ] **Step 2: Run to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_demand.py -q"`
Expected: FAIL — no attribute `derive_variance_demand` / `VARIANCE_BUCKET_KEYS`.

- [ ] **Step 3: Implement**

`backend/sub_samples/service.py` — directly above `derive_demand` (:518):

```python
# Bucket (== vial assignment_role) -> WP service key carrying variance counts.
# Must stay identical to lims_analyses.service._ROLE_VARIANCE_KEYS (the
# variance_verify gate) — a test asserts equality. Coarse keys only, never
# per-analyte (variance addon spec, "The scoping rule").
VARIANCE_BUCKET_KEYS: dict[str, str] = {
    "hplc": "hplcpurity_identity",
    "endo": "endotoxin",
    "ster": "sterility_pcr",
}


def derive_variance_demand(services: dict) -> dict:
    """Per-bucket variance n (TOTAL replicates incl. the canonical) from a WP
    services payload. 0 when not purchased. Uses the same normalization as the
    entitlement endpoint so counts are int-filtered (>= 2) in one place."""
    entitlement = normalize_variance_entitlement({"variance": (services or {}).get("variance")})
    return {
        bucket: entitlement.get(key, 0)
        for bucket, key in VARIANCE_BUCKET_KEYS.items()
    }
```

`derive_demand` (:518-532) becomes:

```python
def derive_demand(services: dict) -> dict:
    """Translate WP services dict to vial demand per bucket.

    HPLC is satisfied by either `hplcpurity_identity` or `bac_water_panel` —
    both result in chromatography vials. Sterility is the only bucket that
    needs more than one vial (2 per the lab's protocol).

    Variance inflation (addon Phase 2): a purchased variance count n (total
    replicates in the set) raises the bucket to max(base, n). Variance never
    creates demand for an unordered service (base 0 stays 0).
    """
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
    endo = bool(services.get("endotoxin"))
    ster = bool(services.get("sterility_pcr"))
    base = {
        "hplc": 1 if hplc else 0,
        "endo": 1 if endo else 0,
        "ster": 2 if ster else 0,
    }
    variance = derive_variance_demand(services)
    return {
        bucket: max(n, variance[bucket]) if n > 0 else 0
        for bucket, n in base.items()
    }
```

Also export the pre-inflation base so the FE can split counts without guessing. Refactor `derive_demand` to delegate: add

```python
def derive_base_demand(services: dict) -> dict:
    """Pre-variance vial demand per bucket (the lab-protocol baseline)."""
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
    endo = bool(services.get("endotoxin"))
    ster = bool(services.get("sterility_pcr"))
    return {
        "hplc": 1 if hplc else 0,
        "endo": 1 if endo else 0,
        "ster": 2 if ster else 0,
    }
```

and have `derive_demand` use it (`base = derive_base_demand(services)` instead of the inline dict).

`compute_vial_plan`: add `"variance"` AND `"base_demand"` to BOTH return dicts —
- unreachable branch (:558-578): add `"variance": {"hplc": 0, "endo": 0, "ster": 0}, "base_demand": {"hplc": 0, "endo": 0, "ster": 0},` next to `"demand"`.
- success branch (:642-647): next to the `demand = derive_demand(...)` line (:580) compute `services = services_resp.get("services") or {}` once, then `variance = derive_variance_demand(services)` and `base_demand = derive_base_demand(services)`; add both keys to the returned dict.

Extend the Task-1 tests accordingly: `test_compute_vial_plan_carries_variance` also asserts `plan["base_demand"]["hplc"] == 1`, and add

```python
class TestDeriveBaseDemand:
    def test_base_is_pre_variance(self):
        out = sub_service.derive_base_demand({
            **BASE_SERVICES,
            "variance": {"hplcpurity_identity": 5},
        })
        assert out == {"hplc": 1, "endo": 1, "ster": 2}
```

`backend/sub_samples/routes.py` `get_vial_demand` (:234-248): add the same key to both branches —

```python
    if services_resp is None:
        return {
            "demand": {"hplc": 0, "endo": 0, "ster": 0},
            "variance": {"hplc": 0, "endo": 0, "ster": 0},
            "base_demand": {"hplc": 0, "endo": 0, "ster": 0},
            "wp_order_number": None,
            "is_unreachable": True,
        }
    services = services_resp.get("services") or {}
    return {
        "demand": service.derive_demand(services),
        "variance": service.derive_variance_demand(services),
        "base_demand": service.derive_base_demand(services),
        "wp_order_number": services_resp.get("wp_order_number"),
        "is_unreachable": False,
    }
```

`backend/sub_samples/schemas.py` `VialPlanResponse` (:62-66):

```python
class VialPlanResponse(BaseModel):
    demand: dict
    # Per-bucket variance n (total replicates incl. canonical); zeros when none
    # purchased. base_demand is the pre-inflation lab baseline — the FE splits
    # bucket counts into base + variance lines from these two (addon Phase 2).
    variance: dict = {"hplc": 0, "endo": 0, "ster": 0}
    base_demand: dict = {"hplc": 0, "endo": 0, "ster": 0}
    wp_order_number: Optional[str] = None
    vials: list[VialPlanItem]
    is_unreachable: bool = False
```

- [ ] **Step 4: Run to verify green**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_demand.py tests/test_wizard_calculations.py tests/test_sub_samples_service.py tests/test_sub_samples_integration.py -q"`
Expected: variance-demand file green; the others green except pre-existing (baseline if unsure). Residue check:

```bash
docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST%'"
```
Expected: 0.

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/service.py backend/sub_samples/routes.py backend/sub_samples/schemas.py backend/tests/test_variance_demand.py
git commit -F <msgfile>  # "feat(variance): demand inflation + per-bucket variance breakdown in vial plan/demand"
```

---

### Task 2: Backend — `lock_variance_set` series-complete guard

**Files:**
- Modify: `backend/sub_samples/service.py` (`lock_variance_set` :1058-1075; new error class next to `VarianceTooFewVialsError` — find its definition and mirror it)
- Modify: `backend/sub_samples/routes.py` (`lock_variance_set_endpoint` :459-478 — map the new error to 409)
- Test: `backend/tests/test_variance_demand.py` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_variance_demand.py` (fixture mirrors `test_variance_verify.py`'s ZZTEST pattern — committed rows + explicit teardown; `lock_variance_set` commits internally):

```python
from datetime import datetime

from sqlalchemy import text

from database import SessionLocal
from models import LimsAnalysis, LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture()
def lock_fixture(db):
    """ZZTEST parent (in set) + 2 hplc vials (in set) each with one analysis
    row. Variance purchased for hplc (n=3) via injected fetch."""
    parent = LimsSample(sample_id="ZZTEST-VARLOCK", peptide_name="ZZ", status="received")
    db.add(parent)
    db.flush()
    vials, rows = [], []
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    for i in (1, 2):
        v = LimsSubSample(
            sample_id=f"ZZTEST-VARLOCK-S0{i}",
            parent_sample_pk=parent.id,
            external_lims_uid=f"zz-uid-varlock-{i}",
            vial_sequence=i,
            received_at=datetime.utcnow(),
            assignment_role="hplc",
        )
        db.add(v)
        db.flush()
        r = LimsAnalysis(
            lims_sub_sample_pk=v.id,
            analysis_service_id=svc_id,
            keyword=f"ZZTEST-VARLOCK-KW{i}",
            title="ZZ",
            result_value="9",
            review_state="variance_verified",
        )
        db.add(r)
        vials.append(v)
        rows.append(r)
    db.commit()
    yield {"parent": parent, "vials": vials, "rows": rows}
    db.rollback()
    db.execute(text("DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-VARLOCK%'"))
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-VARLOCK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VARLOCK%'"))
    db.commit()


VARIANCE_SERVICES = {"services": {**BASE_SERVICES, "variance": {"hplcpurity_identity": 3}}}


class TestLockSeriesGuard:
    def test_locks_when_all_rows_signed_off(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        # cleanup the lock so teardown deletes cleanly
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_blocks_on_unfinished_row(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        row = lock_fixture["rows"][0]
        row.review_state = "to_be_verified"
        db.commit()
        with pytest.raises(sub_service.VarianceSeriesIncompleteError, match="ZZTEST-VARLOCK-S01"):
            sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)

    def test_promoted_rows_count_as_done(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        row = lock_fixture["rows"][0]
        row.review_state = "promoted"
        db.commit()
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_retested_rows_exempt(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        row = lock_fixture["rows"][0]
        row.review_state = "to_be_verified"
        row.retested = True  # superseded by a retest chain
        db.commit()
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_no_variance_or_unreachable_skips_guard(self, db, lock_fixture, monkeypatch):
        row = lock_fixture["rows"][0]
        row.review_state = "to_be_verified"
        db.commit()
        # unreachable
        monkeypatch.setattr(sub_service, "fetch_sample_services", lambda sid: None)
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")
        # reachable, no variance purchased
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: {"services": dict(BASE_SERVICES)})
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")

    def test_excluded_vial_not_checked(self, db, lock_fixture, monkeypatch):
        monkeypatch.setattr(sub_service, "fetch_sample_services",
                            lambda sid: VARIANCE_SERVICES)
        vial = lock_fixture["vials"][0]
        row = lock_fixture["rows"][0]
        vial.in_variance_set = False
        row.review_state = "to_be_verified"
        db.commit()
        parent = sub_service.lock_variance_set(db, "ZZTEST-VARLOCK", user_id=1)
        assert parent.variance_locked_at is not None
        sub_service.unlock_variance_set(db, "ZZTEST-VARLOCK")
```

- [ ] **Step 2: Run to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_demand.py::TestLockSeriesGuard -q"`
Expected: FAIL — no attribute `VarianceSeriesIncompleteError` (and locks succeed where the guard should block).

- [ ] **Step 3: Implement**

`backend/sub_samples/service.py` — find where `VarianceTooFewVialsError` / `VarianceLockedError` are defined (grep; mirror their style) and add:

```python
class VarianceSeriesIncompleteError(Exception):
    """Lock refused: variance-purchased buckets still have unfinished rows."""
```

Extend `lock_variance_set` (:1058-1075) after the `selected < 2` check, before setting `variance_locked_at`:

```python
    # Series-complete guard (variance addon Phase 2, spec §5): when the order
    # purchased variance, every live analysis row on in-set sub vials in a
    # variance-purchased bucket must be signed off (promoted or
    # variance_verified). Fail-soft: no variance / WP unreachable -> no guard
    # (lock keeps its original semantics for non-variance work).
    try:
        services_resp = fetch_sample_services(parent_sample_id)
    except Exception:
        services_resp = None
    variance = derive_variance_demand(
        (services_resp or {}).get("services") or {}
    )
    variance_buckets = {b for b, n in variance.items() if n >= 2}
    if variance_buckets:
        from models import LimsAnalysis
        unfinished: list[str] = []
        for s in parent.sub_samples:
            if not s.in_variance_set:
                continue
            if (s.assignment_role or "") not in variance_buckets:
                continue
            rows = db.execute(
                select(LimsAnalysis).where(
                    LimsAnalysis.lims_sub_sample_pk == s.id,
                    LimsAnalysis.review_state.not_in(("retracted", "rejected")),
                    LimsAnalysis.retested.is_(False),
                    LimsAnalysis.review_state.not_in(("promoted", "variance_verified")),
                )
            ).scalars().all()
            unfinished.extend(f"{s.sample_id}:{r.keyword}" for r in rows)
        if unfinished:
            raise VarianceSeriesIncompleteError(
                "variance series incomplete — unfinished rows: "
                + ", ".join(sorted(unfinished))
            )
```

(Check the module's existing import of `select` — it's already used at :1060. Combine the two `.not_in` clauses into one if you prefer: `review_state.not_in(("retracted","rejected","promoted","variance_verified"))` — equivalent; pick the single-clause form for clarity.)

`backend/sub_samples/routes.py` `lock_variance_set_endpoint` (:459-478) — add an except arm mirroring the `VarianceTooFewVialsError` one (read its exact shape at :474-477 first):

```python
    except service.VarianceSeriesIncompleteError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": "variance_series_incomplete", "message": str(e)},
        )
```

- [ ] **Step 4: Run to verify green + residue**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_demand.py tests/test_variance_set.py tests/test_variance_stats.py -q"`
Expected: green except pre-existing. Residue check → 0 (same psql as Task 1).

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/service.py backend/sub_samples/routes.py backend/tests/test_variance_demand.py
git commit -F <msgfile>  # "feat(variance): lock_variance_set series-complete guard (fail-soft)"
```

---

### Task 3: FE — types + AssignStep variance sub-rows + header

**Files:**
- Modify: `src/lib/api.ts` (`VialPlanResponse` :4858-4863, `VialDemandResponse` :5040-5044)
- Modify: `src/components/intake/ReceiveWizard/AssignStep.tsx` (bucket render :133-184, `Bucket` :287-351, `MicroBucket` :353-407, `SubDropZone` :409-449)
- Test: `src/test/assign-step.test.tsx` (extend — existing harness mocks `getVialPlan` and renders `<AssignStep>`)

- [ ] **Step 1: Write the failing tests**

Append to `src/test/assign-step.test.tsx` (reuse the existing `PLAN` fixture/mocks; add a variance plan):

```tsx
const VARIANCE_PLAN: VialPlanResponse = {
  demand: { hplc: 3, endo: 2, ster: 0 },
  variance: { hplc: 3, endo: 2, ster: 0 },
  base_demand: { hplc: 1, endo: 1, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc' },
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: 'hplc' },
    { sample_id: 'P-0144-S03', is_parent: false, vial_sequence: 3, assignment_role: 'endo' },
    { sample_id: 'P-0144-S04', is_parent: false, vial_sequence: 4, assignment_role: 'endo' },
  ],
}

describe('AssignStep variance sub-rows', () => {
  it('renders base + VARIANCE count lines in the HPLC bucket', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    renderStep()
    await screen.findByText('P-0144-S01')
    // base line: 1 of 1 (parent fills the base slot); variance line: 2 of 2 extras
    expect(screen.getByText(/HPLC · 1\s*\/\s*1/)).toBeInTheDocument()
    expect(screen.getByText(/Variance · 2\s*\/\s*2/i)).toBeInTheDocument()
  })

  it('annotates the Endo sub-zone with the variance multiplier', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    renderStep()
    await screen.findByText('P-0144-S03')
    expect(screen.getByText(/Endo · 2\s*\/\s*2.*×2 variance/i)).toBeInTheDocument()
  })

  it('renders no variance lines for a plan without variance', async () => {
    renderStep()  // default PLAN fixture (no variance / zeros)
    await screen.findByText('P-0144-S01')
    expect(screen.queryByText(/Variance ·/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/×\d variance/i)).not.toBeInTheDocument()
  })
})
```

NOTE: the existing `PLAN` fixture predates the new fields — TypeScript will demand them once the type is updated. Add `variance: { hplc: 0, endo: 0, ster: 0 }` and `base_demand: { hplc: 1, endo: 0, ster: 0 }` to the existing `PLAN` fixture as part of this task (or make the fields optional — DON'T: required-with-backend-default keeps the contract honest; update the fixture instead). The exact rendered text format may differ from the regexes above — adjust regexes to the implementation's actual text, keeping the semantic assertions (base 1/1, variance 2/2, ×2 annotation, absence without variance).

- [ ] **Step 2: Run to verify they fail**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx 2>&1 | tail -12"`
Expected: new tests FAIL (no variance rendering); existing tests still pass.

- [ ] **Step 3: Implement**

`src/lib/api.ts`:

```ts
export interface VialPlanResponse {
  demand: { hplc: number; endo: number; ster: number }
  /** Per-bucket variance n (total replicates incl. canonical); zeros when
   *  none purchased. Drives the AssignStep VARIANCE sub-rows. */
  variance: { hplc: number; endo: number; ster: number }
  /** Pre-variance lab baseline — the FE splits bucket counts into
   *  base + variance lines from demand/base_demand. */
  base_demand: { hplc: number; endo: number; ster: number }
  wp_order_number: string | null
  vials: VialPlanItem[]
  is_unreachable: boolean
}
```

```ts
export interface VialDemandResponse {
  demand: { hplc: number; endo: number; ster: number }
  variance: { hplc: number; endo: number; ster: number }
  base_demand: { hplc: number; endo: number; ster: number }
  wp_order_number: string | null
  is_unreachable: boolean
}
```

`src/components/intake/ReceiveWizard/AssignStep.tsx`:

1. Bucket render site (:148-156) — pass variance to the HPLC bucket:

```tsx
          {showHplc && (
            <Bucket
              id="hplc"
              label="Analyses Dept."
              vials={plan.vials.filter(v => v.assignment_role === 'hplc')}
              demand={plan.demand.hplc}
              varianceN={plan.variance?.hplc ?? 0}
              onReset={() => handleResetBucket('hplc')}
            />
          )}
```

and to MicroBucket (:157-166):

```tsx
            <MicroBucket
              endo={plan.vials.filter(v => v.assignment_role === 'endo')}
              ster={plan.vials.filter(v => v.assignment_role === 'ster')}
              endoDemand={plan.demand.endo}
              sterDemand={plan.demand.ster}
              endoVarianceN={plan.variance?.endo ?? 0}
              sterVarianceN={plan.variance?.ster ?? 0}
              onResetEndo={() => handleResetBucket('endo')}
              onResetSter={() => handleResetBucket('ster')}
            />
```

(The xtra Bucket gets no variance props — `varianceN` defaults to 0.)

2. `Bucket` (:287-351) — add the optional prop + the presentational split. The bucket stays ONE droppable; the lines are count math only:

```tsx
function Bucket({
  id, label, vials, demand, onReset, varianceN = 0,
}: {
  id: BucketId
  label: string
  vials: VialPlanItem[]
  demand: number | null
  onReset: (() => void) | null
  /** Variance n for this bucket (total replicates incl. canonical, 0 = none).
   *  Purely presentational: splits the count into base + variance lines.
   *  Vials are NOT individually designated — first fills base, surplus fills
   *  variance (spec: demand math, not vial designation). */
  varianceN?: number
}) {
```

Bucket also receives `baseDemand` (the pre-inflation baseline from Task 1's `base_demand` response field) alongside `varianceN`. The render site passes `baseDemand={plan.base_demand?.hplc ?? 0}`. Add both to Bucket's prop list:

```ts
  /** Pre-variance baseline demand for this bucket (from plan.base_demand). */
  baseDemand?: number
```

Inside Bucket, after the existing `<header>` block (keep header counts as-is), insert the split lines BEFORE the vial-chip flex container, rendered only when variance actually inflates the bucket:

```tsx
      {varianceN >= 2 && demand !== null && demand > baseDemand && (
        <VarianceCountLines
          assigned={vials.length}
          baseSlots={baseDemand}
          extraSlots={demand - baseDemand}
          baseLabel={label === 'Analyses Dept.' ? 'HPLC' : label}
        />
      )}
```

New small component (place next to `SubDropZone`). No derivation — both slot counts come straight from the backend (`base_demand` + `demand`), so the math is just fill-order:

```tsx
/** Presentational base/variance count split for a variance bucket. The first
 *  `baseSlots` assignments fill the base line; surplus fills the variance
 *  line. No vial is individually marked — pure demand math (spec §2). */
function VarianceCountLines({
  assigned, baseSlots, extraSlots, baseLabel,
}: {
  assigned: number
  baseSlots: number
  extraSlots: number
  baseLabel: string
}) {
  const baseFilled = Math.min(assigned, baseSlots)
  const extraFilled = Math.max(0, Math.min(assigned - baseSlots, extraSlots))
  const baseShort = baseFilled < baseSlots
  const extraShort = extraFilled < extraSlots
  return (
    <div className="mb-2 space-y-0.5 text-[10px] uppercase tracking-wide">
      <div className={cn(baseShort ? 'text-amber-500' : 'text-muted-foreground')}>
        {baseLabel} · {baseFilled} / {baseSlots}{baseShort && ' ⚠'}
      </div>
      <div className={cn(extraShort ? 'text-amber-500' : 'text-muted-foreground')}>
        Variance · {extraFilled} / {extraSlots}{extraShort && ' ⚠'}
      </div>
    </div>
  )
}
```

(With hplc base 1 and n=3: demand 3, baseSlots 1, extraSlots 2 → `HPLC · 1/1` + `Variance · 2/2` exactly as the spec mock. For ster base 2 with n=2: demand stays 2, `demand > baseDemand` is false → no split lines, only the Micro annotation — correct, since variance didn't add vials.)

3. `MicroBucket` + `SubDropZone`: add `endoVarianceN`/`sterVarianceN` props, pass to SubDropZone as `varianceN`, and in SubDropZone's label line (:433) append the annotation when `varianceN >= 2`:

```tsx
        <span>
          {label} · {vials.length} / {demand}
          {varianceN >= 2 && (
            <span className="text-sky-500"> (×{varianceN} variance)</span>
          )}
          {isShort && ' ⚠'}
        </span>
```

(`varianceN` is an optional prop defaulting 0 on SubDropZone.)

- [ ] **Step 4: Run tests + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx 2>&1 | tail -6 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'AssignStep|api\.ts|WizardHeader' ; echo tsc-done"`
Expected: all green (old + new); tsc clean. (WizardHeader needs NO code change — its total derives from the inflated `demand`; the added `variance` field is type-compatible since `VialDemandResponse` is only widened.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/intake/ReceiveWizard/AssignStep.tsx src/test/assign-step.test.tsx
git commit -F <msgfile>  # "feat(variance): AssignStep variance sub-rows + demand types"
```

---

### Task 4: Gates — suites + live verification

**Files:** none (verification only)

- [ ] **Step 1: Full FE suite**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run 2>&1 | tail -4"`
Expected: only the 2 documented pre-existing failures.

- [ ] **Step 2: Backend slices**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_demand.py tests/test_variance_verify.py tests/test_variance_set.py tests/test_variance_stats.py tests/test_sub_samples_service.py tests/test_sub_samples_integration.py tests/test_wizard_calculations.py -q"`
Expected: green except documented pre-existing. Residue → 0.

- [ ] **Step 3: Live backend verification (simulated variance payload)**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python - <<'EOF'
import json
from sub_samples import service as sub_service

services = {'hplcpurity_identity': True, 'endotoxin': True, 'sterility_pcr': True,
            'variance': {'hplcpurity_identity': 3, 'endotoxin': 2}}
print('DEMAND:', json.dumps(sub_service.derive_demand(services)))
print('VARIANCE:', json.dumps(sub_service.derive_variance_demand(services)))
print('NO-VARIANCE DEMAND:', json.dumps(sub_service.derive_demand(
    {'hplcpurity_identity': True, 'endotoxin': True, 'sterility_pcr': True})))
EOF"
```
Expected: `DEMAND: {"hplc": 3, "endo": 2, "ster": 2}`, `VARIANCE: {"hplc": 3, "endo": 2, "ster": 0}`, `NO-VARIANCE DEMAND: {"hplc": 1, "endo": 1, "ster": 2}`.

- [ ] **Step 4: Live FE dormancy regression**

In a fresh browser context (HMR caveat — close/reopen the tab): log in, open Receive on `PB-0076` (Manage Sub-Samples → Assignment tab), confirm the buckets render exactly as before (no VARIANCE lines, no ×N annotations — no real order has variance) and EXPECTED VIALS unchanged.

- [ ] **Step 5: Report**

Per-task commits, test counts, live outputs, and surface the two plan-time semantics flags (ster `max()` nuance; Micro annotation instead of nested sub-rows) to the user.

---

## Out of scope (later phases)

- IS contract — parse/validate per-service map, expose in payload (Phase 3)
- WP addon product (Phase 4); COA variance section (Phase 5)
- Any vial-designation model (deliberately none — demand math only)
