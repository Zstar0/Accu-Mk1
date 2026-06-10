# Variance-Verified Lifecycle (Phase 1 of Variance Addon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `variance_verified` sub-sample analysis state + `variance_verify` transition (with commercial entitlement gate) and the FE action/badges, per spec `docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md` §3–§4.

**Architecture:** Extend the pure state machine (`state_machine.py`), the DB CHECK constraints (idempotent migration mirroring the `promoted` pattern), and `apply_transition` guards. The commercial gate (variance purchased for the vial's role) is a service function called from the transition route, resolving the WP services payload via the existing `_fetch_wp_services_for_parent` (fail closed). FE gets a `Verify (Variance)` row action + `Verified — Variance` badge, gated by a new variance-entitlement endpoint + react-query hook.

**Tech Stack:** FastAPI + SQLAlchemy + psycopg2 (backend, tests via pytest **inside the `accumark-subvial-accu-mk1-backend` container** against the LIVE `accumark_mk1` DB — use `ZZTEST-*` fixtures + teardown, per `tests/test_role_change_cleanup.py`), React + TanStack Query + vitest (FE, run **inside `accumark-subvial-accu-mk1-frontend`**).

**Operational notes for the executor:**
- Backend tests: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <files> -q"`
- FE tests: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run <files>"`
- 3 pre-existing FE failures (`App.test.tsx`, `peptide-requests-list.test.tsx`) and ~3 pre-existing backend state-machine tier-test failures are NOT yours — confirm any new failure against the base commit before chasing it.
- The backend runs `--reload`; migrations in `database.py` run at startup, so after Task 2 restart is automatic on file save. If the backend exits after a stack restart, see memory: restart `accumark-subvial-accu-mk1-backend` once Postgres is healthy.
- Commit after every task with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: State machine + schema — `variance_verified` state, `variance_verify` kind

**Files:**
- Modify: `backend/lims_analyses/state_machine.py` (STATES :67-76, TRANSITION_KINDS :80-83, `_ALLOWED` :94-109, `_TIER_ALLOWED_KINDS` :116-123)
- Modify: `backend/lims_analyses/schemas.py:41-44` (`TransitionKind` Literal)
- Test: `backend/tests/test_variance_verify.py` (create)

- [ ] **Step 1: Write the failing pure state-machine tests**

Create `backend/tests/test_variance_verify.py`:

```python
"""Variance-verified lifecycle — state machine, service guards, entitlement gate.

Spec: docs/superpowers/specs/2026-06-10-variance-testing-addon-design.md §3-§4.
Service-layer tests run against the LIVE accumark_mk1 DB: ZZTEST-* fixtures,
explicit teardown (lims_analysis_transitions cascades via FK).
"""
import pytest

from lims_analyses.state_machine import (
    STATES,
    TRANSITION_KINDS,
    TERMINAL_STATES,
    TIER_PARENT,
    TIER_VIAL,
    InvalidTransitionError,
    TierMismatchError,
    allowed_kinds,
    is_terminal,
    next_state,
)


class TestVarianceVerifyStateMachine:
    def test_state_and_kind_registered(self):
        assert "variance_verified" in STATES
        assert "variance_verify" in TRANSITION_KINDS

    def test_variance_verified_is_not_terminal(self):
        assert "variance_verified" not in TERMINAL_STATES
        assert is_terminal("variance_verified") is False

    def test_to_be_verified_variance_verify_yields_variance_verified(self):
        assert next_state("to_be_verified", "variance_verify", tier=TIER_VIAL) == "variance_verified"

    def test_variance_verify_blocked_at_parent_tier(self):
        with pytest.raises(TierMismatchError):
            next_state("to_be_verified", "variance_verify", tier=TIER_PARENT)

    @pytest.mark.parametrize("from_state", [
        "unassigned", "assigned", "verified", "promoted", "variance_verified", "retracted",
    ])
    def test_variance_verify_illegal_from_other_states(self, from_state):
        with pytest.raises(InvalidTransitionError):
            next_state(from_state, "variance_verify", tier=TIER_VIAL)

    def test_allowed_kinds_from_to_be_verified_at_vial_tier(self):
        kinds = allowed_kinds("to_be_verified", tier=TIER_VIAL)
        assert "variance_verify" in kinds
        assert "verify" not in kinds  # vial verify stays removed

    def test_generic_verify_still_blocked_at_vial_tier(self):
        # variance_verify must NOT re-open the generic verify hole
        with pytest.raises(TierMismatchError):
            next_state("to_be_verified", "verify", tier=TIER_VIAL)
```

- [ ] **Step 2: Run to verify it fails**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py -q"`
Expected: FAIL — `"variance_verified" in STATES` assertion errors / `UnknownKindError` for variance_verify.

- [ ] **Step 3: Implement the state-machine changes**

In `backend/lims_analyses/state_machine.py`:

`STATES` (:67-76) — add the state:

```python
STATES: FrozenSet[str] = frozenset({
    "unassigned",
    "assigned",
    "to_be_verified",
    "verified",
    "published",
    "promoted",
    "variance_verified",
    "rejected",
    "retracted",
})
```

`TRANSITION_KINDS` (:80-83):

```python
TRANSITION_KINDS: FrozenSet[str] = frozenset({
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto", "variance_verify",
})
```

`_ALLOWED` (:94-109) — add one edge (keep the existing entries; insert after the `to_be_verified` block):

```python
    ("to_be_verified", "variance_verify"): "variance_verified",
```

`_TIER_ALLOWED_KINDS` (:116-123) — vial tier only:

```python
_TIER_ALLOWED_KINDS: Dict[str, FrozenSet[str]] = {
    TIER_VIAL: frozenset({
        "assign", "submit", "retract", "reject", "reset", "retest", "auto",
        "variance_verify",
    }),
    TIER_PARENT: frozenset({
        "publish", "retract", "auto",
    }),
}
```

Also extend the module docstring's vial-tier decision flow with one line:

```
  variance_verify: to_be_verified -> variance_verified   (variance replicate
            sign-off; requires result_value + sub-sample host + purchased
            variance — service-layer guards)
```

In `backend/lims_analyses/schemas.py:41-44`:

```python
TransitionKind = Literal[
    "assign", "submit", "verify", "retract", "reject",
    "retest", "publish", "reset", "auto", "variance_verify",
]
```

- [ ] **Step 4: Run to verify it passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py tests/test_lims_analyses_state_machine.py -q"`
Expected: new tests PASS; pre-existing state-machine failures (if any) match the base commit.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/state_machine.py backend/lims_analyses/schemas.py backend/tests/test_variance_verify.py
git commit -m "feat(variance): variance_verified state + variance_verify kind (vial tier)"
```

---

### Task 2: DB constraints — CHECK migrations + fresh-install DDL

**Files:**
- Modify: `backend/database.py` (CREATE TABLE DDL :505-511 and :557-560; `_run_migrations` list — append after the PCR-grouping entries near :662)
- Test: covered by Task 3's committing service tests (a `variance_verified` row + a `variance_verify` audit row must survive a real commit); this task verifies the constraints directly via psql.

- [ ] **Step 1: Update the fresh-install DDL**

`backend/database.py:505-511` — add to the inline CHECK:

```sql
            review_state          TEXT NOT NULL DEFAULT 'unassigned'
                                  CONSTRAINT lims_analyses_review_state_check
                                  CHECK (review_state IN (
                                      'unassigned', 'assigned', 'to_be_verified',
                                      'verified', 'published', 'rejected', 'retracted',
                                      'promoted', 'variance_verified'
                                  )),
```

`backend/database.py:557-560`:

```sql
            transition_kind   TEXT NOT NULL
                              CHECK (transition_kind IN
                                  ('assign','submit','verify','retract','reject',
                                   'retest','publish','reset','auto','variance_verify')),
```

- [ ] **Step 2: Append the idempotent migration entries**

In `_run_migrations`'s statement list (append after the existing promoted-state block / PCR grouping entries, mirroring the drop+recreate pattern at :628-635):

```python
        # Variance addon Phase 1: 'variance_verified' sub-sample state +
        # 'variance_verify' audit kind. Drop+recreate both CHECKs (idempotent).
        "ALTER TABLE lims_analyses DROP CONSTRAINT IF EXISTS lims_analyses_review_state_check",
        """
        ALTER TABLE lims_analyses ADD CONSTRAINT lims_analyses_review_state_check
            CHECK (review_state IN (
                'unassigned', 'assigned', 'to_be_verified', 'verified',
                'published', 'rejected', 'retracted', 'promoted',
                'variance_verified'
            ))
        """,
        "ALTER TABLE lims_analysis_transitions DROP CONSTRAINT IF EXISTS lims_analysis_transitions_transition_kind_check",
        """
        ALTER TABLE lims_analysis_transitions ADD CONSTRAINT lims_analysis_transitions_transition_kind_check
            CHECK (transition_kind IN
                ('assign','submit','verify','retract','reject',
                 'retest','publish','reset','auto','variance_verify'))
        """,
```

(Note: the transitions CHECK was created unnamed inline, so Postgres auto-named it `lims_analysis_transitions_transition_kind_check` — the DROP IF EXISTS targets that auto-name; if a dev DB predates auto-naming conventions the DROP is a harmless no-op and the ADD will fail loudly, which is the correct signal to inspect.)

- [ ] **Step 3: Trigger migrations and verify the constraints**

The dev backend runs `--reload`, so saving `database.py` restarts it and `_run_migrations` runs. Verify:

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main'"
docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='lims_analyses_review_state_check'"
docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='lims_analysis_transitions_transition_kind_check'"
```

Expected: both definitions include `variance_verified` / `variance_verify`.

- [ ] **Step 4: Commit**

```bash
git add backend/database.py
git commit -m "feat(variance): review_state + transition_kind CHECKs allow variance_verified/variance_verify"
```

---

### Task 3: Service — `apply_transition` guards + retest from `variance_verified`

**Files:**
- Modify: `backend/lims_analyses/service.py` (`apply_transition`: retest source states :251, semantic guards :304-329, timestamp block :333-340)
- Test: `backend/tests/test_variance_verify.py` (extend)

- [ ] **Step 1: Write the failing service tests**

Append to `backend/tests/test_variance_verify.py`. Mirror the live-DB fixture/teardown style of `tests/test_role_change_cleanup.py` (ZZTEST ids, explicit teardown — `apply_transition` commits internally, so teardown must DELETE):

```python
from datetime import datetime

from sqlalchemy import text

from database import SessionLocal
from lims_analyses import service
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
def variance_fixture(db):
    """ZZTEST parent + hplc vial + one to_be_verified analysis with a result.
    Committed (apply_transition commits), torn down by id."""
    parent = LimsSample(sample_id="ZZTEST-VARV", peptide_name="ZZ Test", status="received")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(
        sample_id="ZZTEST-VARV-S01",
        parent_sample_pk=parent.id,
        vial_sequence=1,
        received_at=datetime.utcnow(),
        assignment_role="hplc",
    )
    db.add(vial)
    db.flush()
    svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id,
        analysis_service_id=svc_id,
        keyword="ZZTEST-VARV-KW",
        title="ZZ Variance Test",
        result_value="99",
        review_state="to_be_verified",
    )
    db.add(row)
    db.commit()
    yield {"parent": parent, "vial": vial, "row": row}
    db.rollback()
    db.execute(text(
        "DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-VARV%'"))
    db.execute(text(
        "DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-VARV%'"))
    db.execute(text(
        "DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VARV%'"))
    db.commit()


class TestVarianceVerifyService:
    def test_happy_path_sets_state_timestamp_and_audit(self, db, variance_fixture):
        row = variance_fixture["row"]
        out = service.apply_transition(
            db, analysis_id=row.id, kind="variance_verify", user_id=None,
            reason="senior sign-off",
        )
        assert out.review_state == "variance_verified"
        assert out.verified_at is not None
        kinds = db.execute(text(
            "SELECT transition_kind FROM lims_analysis_transitions "
            "WHERE analysis_id=:a ORDER BY id DESC LIMIT 1"), {"a": row.id}).scalar_one()
        assert kinds == "variance_verify"

    def test_requires_result_value(self, db, variance_fixture):
        row = variance_fixture["row"]
        row.result_value = None
        db.commit()
        with pytest.raises(service.BadRequestError):
            service.apply_transition(db, analysis_id=row.id, kind="variance_verify")

    def test_rejected_on_parent_hosted_row(self, db, variance_fixture):
        parent = variance_fixture["parent"]
        svc_id = db.execute(text("SELECT id FROM analysis_services LIMIT 1")).scalar_one()
        prow = LimsAnalysis(
            lims_sample_pk=parent.id,
            analysis_service_id=svc_id,
            keyword="ZZTEST-VARV-PARENT",
            title="ZZ Parent Row",
            result_value="1",
            review_state="to_be_verified",
        )
        db.add(prow)
        db.commit()
        with pytest.raises(service.BadRequestError):
            service.apply_transition(db, analysis_id=prow.id, kind="variance_verify")

    def test_retest_legal_from_variance_verified(self, db, variance_fixture):
        row = variance_fixture["row"]
        service.apply_transition(db, analysis_id=row.id, kind="variance_verify")
        new_row = service.apply_transition(db, analysis_id=row.id, kind="retest")
        assert new_row.retest_of_id == row.id
        assert new_row.review_state == "unassigned"
        db.refresh(row)
        assert row.retested is True
        assert row.review_state == "variance_verified"  # original keeps its state
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py -q"`
Expected: `TestVarianceVerifyService` fails — happy path errors (no semantic guard branch yet, but state-machine edge exists so the transition may half-work; `test_requires_result_value` and `test_rejected_on_parent_hosted_row` MUST fail because no guards exist; `test_retest_legal_from_variance_verified` fails on the retest source-state list).

- [ ] **Step 3: Implement the service changes**

In `backend/lims_analyses/service.py`, `apply_transition`:

Retest source states (:251) — add `variance_verified`:

```python
        if from_state not in ("to_be_verified", "verified", "promoted", "variance_verified"):
            raise InvalidTransitionError(from_state, kind)
```

Also update the comment above it (:249-250):

```python
        # "verified": grandfathered vial rows from before vial-verify was removed
        # (kept for backward-compat); "promoted": cascade-driven (parent retest);
        # "variance_verified": variance replicates re-run safely — they never
        # touched the parent, so there is no SENAITE lock to collide with.
```

Semantic guards — extend the `if kind == "submit": ... elif kind == "verify": ...` chain (:304-315) with a new branch after `verify`:

```python
    elif kind == "variance_verify":
        if not row.result_value:
            raise BadRequestError("variance_verify requires a result_value on the row")
        if row.lims_sub_sample_pk is None:
            # The parent acting as a vial always PROMOTES (it is the canonical);
            # variance sign-off exists only for sub-sample replicates.
            raise BadRequestError(
                "variance_verify is only valid on sub-sample-hosted rows"
            )
```

Timestamp block — after the `elif to_state == "published":` branch (:339-340) add:

```python
    elif to_state == "variance_verified":
        row.verified_at = now
```

- [ ] **Step 4: Run to verify everything passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py tests/test_vial_retest.py tests/test_lims_analyses_service.py -q"`
Expected: all variance tests PASS; vial-retest + service suites green except documented pre-existing failures. Then confirm no ZZTEST residue:

```bash
docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST-VARV%'"
```
Expected: 0.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/service.py backend/tests/test_variance_verify.py
git commit -m "feat(variance): apply_transition guards + retest from variance_verified"
```

---

### Task 4: Entitlement gate — `ensure_variance_entitlement` + route wiring

**Files:**
- Modify: `backend/lims_analyses/service.py` (new constants + function, place after `apply_transition`)
- Modify: `backend/lims_analyses/routes.py:212-230` (transition handler)
- Test: `backend/tests/test_variance_verify.py` (extend)

- [ ] **Step 1: Write the failing gate tests**

Append to `backend/tests/test_variance_verify.py`:

```python
class TestVarianceEntitlementGate:
    def _fetch(self, services):
        return lambda parent_sample_id: services

    def test_passes_when_variance_purchased_for_role(self, db, variance_fixture):
        row = variance_fixture["row"]
        service.ensure_variance_entitlement(
            db, analysis_id=row.id,
            fetch_services=self._fetch({"variance": {"hplcpurity_identity": 3}}),
        )  # no raise

    def test_rejects_when_not_purchased(self, db, variance_fixture):
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="not purchased"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id,
                fetch_services=self._fetch({"variance": {}}),
            )

    def test_rejects_when_count_below_two(self, db, variance_fixture):
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="not purchased"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id,
                fetch_services=self._fetch({"variance": {"hplcpurity_identity": 1}}),
            )

    def test_fail_closed_when_services_unreachable(self, db, variance_fixture):
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="could not be verified"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id, fetch_services=self._fetch(None),
            )

    def test_rejects_role_without_variance_service(self, db, variance_fixture):
        vial = variance_fixture["vial"]
        vial.assignment_role = "xtra"
        db.commit()
        row = variance_fixture["row"]
        with pytest.raises(service.BadRequestError, match="no variance service"):
            service.ensure_variance_entitlement(
                db, analysis_id=row.id,
                fetch_services=self._fetch({"variance": {"hplcpurity_identity": 3}}),
            )

    def test_endo_role_maps_to_endotoxin_key(self, db, variance_fixture):
        vial = variance_fixture["vial"]
        vial.assignment_role = "endo"
        db.commit()
        row = variance_fixture["row"]
        service.ensure_variance_entitlement(
            db, analysis_id=row.id,
            fetch_services=self._fetch({"variance": {"endotoxin": 2}}),
        )  # no raise
```

- [ ] **Step 2: Run to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py::TestVarianceEntitlementGate -q"`
Expected: FAIL — `AttributeError: module ... has no attribute 'ensure_variance_entitlement'`.

- [ ] **Step 3: Implement the gate**

In `backend/lims_analyses/service.py`, after `apply_transition`:

```python
# ─── Variance entitlement gate (Variance Addon Phase 1) ─────────────────────

# Vial assignment_role → the WP service key whose variance entitlement covers
# rows on that vial. Coarse service keys only — never per-analyte (spec
# 2026-06-10-variance-testing-addon-design.md, "The scoping rule").
_ROLE_VARIANCE_KEYS: dict[str, str] = {
    "hplc": "hplcpurity_identity",
    "endo": "endotoxin",
    "ster": "sterility_pcr",
}


def ensure_variance_entitlement(
    db: Session,
    *,
    analysis_id: int,
    fetch_services=None,
) -> None:
    """Raise BadRequestError unless the parent's WP order purchased variance
    for the service that covers this row's host vial role. FAIL CLOSED: an
    unreachable services payload rejects the transition (retry later) — it
    never silently allows.

    fetch_services is injectable for tests; defaults to the same WP/IS lookup
    the vial plan uses. Until IS exposes the `variance` map (Phase 3), real
    payloads lack the key and this gate rejects — which is the correct
    pre-launch behavior (the FE won't offer the action either).
    """
    from models import LimsSample, LimsSubSample

    row = get_analysis(db, analysis_id)
    if row.lims_sub_sample_pk is None:
        raise BadRequestError("variance_verify is only valid on sub-sample analyses")
    vial = db.get(LimsSubSample, row.lims_sub_sample_pk)
    if vial is None:
        raise NotFoundError(f"sub-sample id={row.lims_sub_sample_pk} not found")
    parent = db.get(LimsSample, vial.parent_sample_pk)
    if parent is None:
        raise NotFoundError(f"parent sample pk={vial.parent_sample_pk} not found")

    key = _ROLE_VARIANCE_KEYS.get(vial.assignment_role or "")
    if key is None:
        raise BadRequestError(
            f"vial {vial.sample_id} role {vial.assignment_role!r} has "
            f"no variance service mapping"
        )

    if fetch_services is None:
        from sub_samples.service import _fetch_wp_services_for_parent
        fetch_services = _fetch_wp_services_for_parent
    services = fetch_services(parent.sample_id)
    if services is None:
        raise BadRequestError(
            "variance entitlement could not be verified (order services "
            "unreachable) — try again"
        )
    variance = services.get("variance") or {}
    n = variance.get(key)
    if not isinstance(n, int) or n < 2:
        raise BadRequestError(
            f"variance was not purchased for {key} on {parent.sample_id}"
        )
```

- [ ] **Step 4: Wire the gate into the transition route**

`backend/lims_analyses/routes.py:212-230` — inside the existing `try`, before `apply_transition`:

```python
    try:
        if req.kind == "variance_verify":
            # Commercial gate: variance must be purchased for the vial's role.
            # Fail closed (400 with a clear message) when WP is unreachable.
            service.ensure_variance_entitlement(db, analysis_id=analysis_id)
        row = service.apply_transition(
```

- [ ] **Step 5: Run to verify everything passes**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py tests/test_lims_analyses_routes.py -q"`
Expected: gate tests PASS; routes suite green except documented pre-existing failures.

- [ ] **Step 6: Commit**

```bash
git add backend/lims_analyses/service.py backend/lims_analyses/routes.py backend/tests/test_variance_verify.py
git commit -m "feat(variance): commercial entitlement gate on variance_verify (fail closed)"
```

---

### Task 5: Variance-entitlement endpoint (FE gating data)

**Files:**
- Modify: `backend/sub_samples/service.py` (new function near `_fetch_wp_services_for_parent` :346)
- Modify: `backend/sub_samples/schemas.py` (new response model)
- Modify: `backend/sub_samples/routes.py` (new GET route)
- Test: `backend/tests/test_variance_verify.py` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_variance_verify.py`:

```python
from sub_samples import service as sub_service


class TestVarianceEntitlementNormalize:
    def test_filters_to_valid_counts(self):
        out = sub_service.normalize_variance_entitlement({
            "variance": {"hplcpurity_identity": 3, "endotoxin": 1,
                         "sterility_pcr": "junk", "future_test": 2},
        })
        assert out == {"hplcpurity_identity": 3, "future_test": 2}

    def test_empty_when_absent(self):
        assert sub_service.normalize_variance_entitlement({}) == {}
        assert sub_service.normalize_variance_entitlement({"variance": None}) == {}
```

- [ ] **Step 2: Run to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py::TestVarianceEntitlementNormalize -q"`
Expected: FAIL — no attribute `normalize_variance_entitlement`.

- [ ] **Step 3: Implement normalize + endpoint**

`backend/sub_samples/service.py` (place directly after `_fetch_wp_services_for_parent`):

```python
def normalize_variance_entitlement(services: Optional[dict]) -> dict[str, int]:
    """Extract the per-service variance map from a WP services payload.
    Keeps only int counts >= 2 (n=1 means no variance). Unknown/future service
    keys pass through — variance support is key-agnostic by design."""
    variance = (services or {}).get("variance") or {}
    out: dict[str, int] = {}
    for key, n in variance.items():
        if isinstance(n, int) and n >= 2:
            out[key] = n
    return out
```

`backend/sub_samples/schemas.py` — add:

```python
class VarianceEntitlementResponse(BaseModel):
    """Per-service variance counts the parent's order purchased (n = total
    replicates incl. the canonical). Empty when none purchased; `unreachable`
    distinguishes 'none' from 'could not check' so the FE can fail closed."""
    variance: dict[str, int]
    unreachable: bool
```

`backend/sub_samples/routes.py` — add (import `VarianceEntitlementResponse` alongside the existing schema imports; place the route near the other parent-scoped GETs):

```python
@router.get(
    "/{parent_sample_id}/variance-entitlement",
    response_model=VarianceEntitlementResponse,
)
def get_variance_entitlement(
    parent_sample_id: str,
    current_user=Depends(get_current_user),
):
    """FE gating data for the Verify (Variance) action. Read-only; no DB."""
    services = service._fetch_wp_services_for_parent(parent_sample_id)
    if services is None:
        return VarianceEntitlementResponse(variance={}, unreachable=True)
    return VarianceEntitlementResponse(
        variance=service.normalize_variance_entitlement(services),
        unreachable=False,
    )
```

(Match the auth dependency style of the neighboring routes in that file — if they use a different `Depends` import/name, mirror it.)

- [ ] **Step 4: Run to verify it passes + smoke the endpoint**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py -q && python -c 'import main'"`
Expected: PASS + clean import. Smoke (expect `{"variance": {}, ...}` since IS doesn't send variance yet — 401 without a token is also fine as proof of life):

```bash
curl -s http://localhost:5530/api/sub-samples/PB-0076/variance-entitlement | head -c 200
```

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/service.py backend/sub_samples/schemas.py backend/sub_samples/routes.py backend/tests/test_variance_verify.py
git commit -m "feat(variance): variance-entitlement endpoint for FE gating"
```

---

### Task 6: FE — constants, helper, API fn, hook (unit-testable core)

**Files:**
- Modify: `src/lib/api.ts` (`transitionAnalysis` union :3729-3731; new `fetchVarianceEntitlement` near `patchVialAssignment` :5121)
- Modify: `src/components/senaite/AnalysisTable.tsx` (STATUS_COLORS :46-75, STATUS_LABELS :77-92, ALLOWED_TRANSITIONS :135-145, TRANSITION_LABELS :147-153, new exported helper near `isPromotable` :160)
- Create: `src/hooks/use-variance-entitlement.ts`
- Test: `src/test/variance-verify-gating.test.tsx` (create)

- [ ] **Step 1: Write the failing unit tests**

Create `src/test/variance-verify-gating.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  canVarianceVerify,
  ALLOWED_TRANSITIONS_TEST_EXPORT as ALLOWED_TRANSITIONS,
  StatusBadge,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const mk = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:900',
    keyword: 'PUR_GHKCU',
    title: 'GHK-Cu - Purity',
    result: '99',
    review_state: 'to_be_verified',
    promoted_to_parent_id: null,
    ...over,
  }) as SenaiteAnalysis

const ENTITLED = { hplcpurity_identity: 3 }

describe('canVarianceVerify', () => {
  it('true for an mk1 to_be_verified row on an entitled hplc vial', () => {
    expect(canVarianceVerify(mk({}), 'hplc', ENTITLED)).toBe(true)
  })
  it('false without entitlement for the role', () => {
    expect(canVarianceVerify(mk({}), 'hplc', {})).toBe(false)
    expect(canVarianceVerify(mk({}), 'hplc', undefined)).toBe(false)
  })
  it('false for endo role when only hplc variance purchased', () => {
    expect(canVarianceVerify(mk({}), 'endo', ENTITLED)).toBe(false)
  })
  it('true for endo role with endotoxin entitlement', () => {
    expect(canVarianceVerify(mk({}), 'endo', { endotoxin: 2 })).toBe(true)
  })
  it('false for SENAITE rows, wrong states, promoted rows, null role', () => {
    expect(canVarianceVerify(mk({ uid: 'a8c27e69bfa8' }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({ review_state: 'unassigned' }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({ review_state: 'promoted' }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({ promoted_to_parent_id: 77 }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({}), null, ENTITLED)).toBe(false)
  })
})

describe('variance_verified transitions table', () => {
  it('offers retest only', () => {
    expect(ALLOWED_TRANSITIONS['variance_verified']).toEqual(['retest'])
  })
})

describe('StatusBadge — variance', () => {
  it('renders Verified — Variance for the new state', () => {
    render(<StatusBadge state="variance_verified" />)
    expect(screen.getByText('Verified — Variance')).toBeInTheDocument()
  })
  it('varianceReady wins over promotable on to_be_verified', () => {
    render(<StatusBadge state="to_be_verified" promotable varianceReady />)
    expect(screen.getByText('Ready to Verify')).toBeInTheDocument()
    expect(screen.queryByText('Ready to Promote')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx 2>&1 | tail -15"`
Expected: FAIL — `canVarianceVerify` not exported.

- [ ] **Step 3: Implement the FE core**

`src/components/senaite/AnalysisTable.tsx`:

STATUS_COLORS (:46-75) — add:

```ts
  variance_verified:
    'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-400 dark:border-sky-500/20',
```

STATUS_LABELS (:77-92) — add:

```ts
  variance_verified: 'Verified — Variance',
```

ALLOWED_TRANSITIONS (:135-145) — add (and export for tests at the bottom of the constants section):

```ts
  // A variance replicate signed off by a tech. Retest is safe — these rows
  // never touched the parent, so there is no SENAITE lock to collide with
  // (unlike `promoted`).
  variance_verified: ['retest'],
```

```ts
/** Test-only re-export — keeps the table private to this module otherwise. */
export const ALLOWED_TRANSITIONS_TEST_EXPORT = ALLOWED_TRANSITIONS
```

TRANSITION_LABELS (:147-153) — add:

```ts
  variance_verify: 'Verify (Variance)',
```

New helper next to `isPromotable` (:160), exported:

```ts
/** Vial assignment_role → WP service key carrying variance entitlement.
 *  Coarse keys only — never per-analyte (variance addon spec, scoping rule). */
export const ROLE_VARIANCE_KEYS: Record<string, string> = {
  hplc: 'hplcpurity_identity',
  endo: 'endotoxin',
  ster: 'sterility_pcr',
}

/** Verify (Variance) is offered on a native, unpromoted, to_be_verified row
 *  whose host vial's role has purchased variance (n >= 2). Deliberately NOT
 *  gated on isLockedByParent: variance sign-off never touches the parent, so
 *  a verified parent line must not lock replicates out. Backend gate is
 *  authoritative (fail closed); this only controls visibility. */
export function canVarianceVerify(
  a: SenaiteAnalysis,
  vialRole: string | null | undefined,
  entitlement: Record<string, number> | undefined,
): boolean {
  if (!a.uid || !a.uid.startsWith('mk1:')) return false
  if (a.review_state !== 'to_be_verified') return false
  if (a.promoted_to_parent_id != null) return false
  const key = vialRole ? ROLE_VARIANCE_KEYS[vialRole] : undefined
  if (!key || !entitlement) return false
  const n = entitlement[key]
  return typeof n === 'number' && n >= 2
}
```

StatusBadge (:284-296) — add the `varianceReady` prop with precedence over `promotable`:

```tsx
export function StatusBadge({ state, promotable = false, varianceReady = false }: { state: string; promotable?: boolean; varianceReady?: boolean }) {
  const color =
    STATUS_COLORS[state] ??
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20'
  // Sub-sample rows can't self-verify — to_be_verified there means "awaiting
  // promotion" ("Ready to Promote") or, on a variance replicate where promote
  // is no longer the path, "awaiting variance sign-off" ("Ready to Verify").
  const label =
    state === 'to_be_verified' && varianceReady
      ? 'Ready to Verify'
      : promotable && state === 'to_be_verified'
        ? 'Ready to Promote'
        : STATUS_LABELS[state] ?? state.replace(/_/g, ' ')
```

`src/lib/api.ts`:

Widen the transition union (:3729-3731):

```ts
export async function transitionAnalysis(
  uid: string,
  transition: 'submit' | 'verify' | 'retract' | 'reject' | 'retest' | 'variance_verify'
): Promise<AnalysisResultResponse> {
```

Add near `patchVialAssignment` (:5121):

```ts
/** Per-service variance counts the parent's order purchased. Empty when none
 *  or unreachable — callers fail closed (action hidden). */
export async function fetchVarianceEntitlement(
  parentSampleId: string,
): Promise<{ variance: Record<string, number>; unreachable: boolean }> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-entitlement`,
    { headers: getBearerHeaders() },
  )
  if (!response.ok) {
    return { variance: {}, unreachable: true }
  }
  return response.json()
}
```

Create `src/hooks/use-variance-entitlement.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { fetchVarianceEntitlement } from '@/lib/api'

/** Parent-scoped variance entitlement for gating Verify (Variance).
 *  Entitlement changes only when the WP order changes — long staleTime is fine.
 *  Errors resolve to {} (fail closed: action hidden; backend re-checks anyway). */
export function useVarianceEntitlement(parentSampleId: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ['variance-entitlement', parentSampleId],
    queryFn: () => fetchVarianceEntitlement(parentSampleId!),
    enabled: !!parentSampleId,
    staleTime: 5 * 60_000,
  })
  return data?.variance
}
```

If `use-analysis-transition.ts` / `use-bulk-analysis-transition.ts` type their kind parameter as a narrow union, widen it identically — the Step 4 typecheck will flag the exact lines.

- [ ] **Step 4: Run tests + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx src/test/status-badge.test.tsx 2>&1 | tail -6 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'AnalysisTable|api.ts|use-variance|use-analysis-transition|use-bulk' ; echo tsc-done"`
Expected: tests PASS; no tsc lines before `tsc-done`.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/AnalysisTable.tsx src/lib/api.ts src/hooks/use-variance-entitlement.ts src/test/variance-verify-gating.test.tsx
git commit -m "feat(variance): FE core — canVarianceVerify, badge, labels, entitlement hook"
```

---

### Task 7: FE — wire the action into the row menu + vial pages

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (AnalysisRow props :1088-1131 region + row menu :1288-1314 + badge call :1218; AnalysisTable props :1396-1431 + row render ~:1769-1790 to thread the new prop)
- Modify: `src/components/senaite/VialsQuickLookDialog.tsx` (fetch entitlement once, pass to each `VialSection`'s `AnalysisTable`)
- Modify: `src/components/senaite/SampleDetails.tsx` (sub-sample page: fetch + pass)
- Test: `src/test/vials-quicklook.test.tsx` (extend)

- [ ] **Step 1: Write the failing component test**

In `src/test/vials-quicklook.test.tsx`: add `fetchVarianceEntitlement: vi.fn()` to the `vi.mock('@/lib/api', ...)` factory (:33-43) and to the import block (:94-100). In `beforeEach` (:193-207) add:

```ts
  vi.mocked(fetchVarianceEntitlement).mockResolvedValue({
    variance: { hplcpurity_identity: 3 },
    unreachable: false,
  })
```

Then append a test (S01's fixture vial is role `hplc` with one `PUR-HPLC` analysis at `to_be_verified` — see `mkAnalysis` default state and the `beforeEach` analyses mock):

```tsx
  it('offers Verify (Variance) on entitled vial rows and applies the transition', async () => {
    vi.mocked(transitionAnalysis).mockResolvedValue({
      success: true, message: 'ok', new_review_state: 'variance_verified', keyword: 'PUR-HPLC',
    })
    renderDialog()
    await screen.findByText('Purity (HPLC)')
    // S01 (hplc, entitled): open its row actions menu
    const menus = screen.getAllByRole('button', { name: /analysis actions/i })
    await userEvent.click(menus[0]!)
    const item = await screen.findByText('Verify (Variance)')
    await userEvent.click(item)
    await waitFor(() => {
      expect(transitionAnalysis).toHaveBeenCalledWith('mk1:101', 'variance_verify')
    })
  })
```

(`transitionAnalysis` must also be added to the api mock factory + imports, mirroring `patchVialAssignment`.)

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/vials-quicklook.test.tsx -t 'Verify (Variance)' 2>&1 | tail -12"`
Expected: FAIL — menu item not found.

- [ ] **Step 3: Implement the wiring**

`src/components/senaite/AnalysisTable.tsx`:

1. AnalysisTable props (:1396-1431 interface + :1457-1469 destructure): add

```ts
  /** Per-service variance entitlement for the host vial's parent order.
   *  Pass only on vial-scoped surfaces (quicklook sections, sub-sample page);
   *  parent pages omit it and the Verify (Variance) action never appears. */
  varianceEntitlement?: Record<string, number>
```

2. Thread to `AnalysisRow` (find the row render that passes `primaryRole`/`onPromoted` near :1769-1790; add `varianceEntitlement={varianceEntitlement}` and a `vialRole={primaryRole}` prop alongside).

3. AnalysisRow (props :1088-1099, destructure :1062-1076): add `varianceEntitlement?: Record<string, number>` and `vialRole?: string | null`. Compute next to `canPromote` (:1119):

```ts
  const canVarVerify = canVarianceVerify(analysis, vialRole, varianceEntitlement)
```

4. Menu render gate (:1268): extend

```ts
        {analysis.uid && (allowedTransitions.length > 0 || canPromote || canVarVerify) && (
```

5. Menu item — insert after the Promote item (:1289-1295):

```tsx
              {canVarVerify && (
                <DropdownMenuItem
                  onClick={() => {
                    if (!analysis.uid) return
                    void transition.executeTransition(analysis.uid, 'variance_verify')
                  }}
                >
                  Verify (Variance)
                </DropdownMenuItem>
              )}
```

(`transition` is the `useAnalysisTransition` instance already passed into AnalysisRow — match how the `allowedTransitions.map` items invoke it at :1300-1306.)

6. Badge call (:1218):

```tsx
          {analysis.review_state && (
            <StatusBadge
              state={analysis.review_state}
              promotable={isPromotable(analysis)}
              varianceReady={canVarVerify && locked}
            />
          )}
```

(`locked` already exists in row scope — it drives the Lock icon at :1227.)

`src/components/senaite/VialsQuickLookDialog.tsx`:

```ts
import { useVarianceEntitlement } from '@/hooks/use-variance-entitlement'
```

In `VialsQuickLookDialog` body (after the `['sub-samples', parentSampleId]` query):

```ts
  const varianceEntitlement = useVarianceEntitlement(open ? parentSampleId : null)
```

Pass through `VialSection` (add `varianceEntitlement` to `VialSectionProps` + destructure) into its `AnalysisTable`:

```tsx
        varianceEntitlement={varianceEntitlement}
```

(AnalysisTable already receives `primaryRole={vial.assignment_role}` — `vialRole` threading inside AnalysisTable uses that value, so VialSection needs no extra role prop.)

`src/components/senaite/SampleDetails.tsx` (sub-sample page): near the `parentSummary` query (:1917-1921):

```ts
  const varianceEntitlement = useVarianceEntitlement(parentSampleId)
```

and on the main `<AnalysisTable>` (:3631-3641 region):

```tsx
          varianceEntitlement={parentSampleId !== null ? varianceEntitlement : undefined}
```

(import the hook at the top with the other hooks; `primaryRole={currentAssignment}` is already passed at :3635, which supplies `vialRole`.)

- [ ] **Step 4: Run the component tests + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/vials-quicklook.test.tsx src/test/variance-verify-gating.test.tsx src/test/status-badge.test.tsx src/test/bulk-promote-overlay.test.tsx 2>&1 | tail -6 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'AnalysisTable|VialsQuickLook|SampleDetails' ; echo tsc-done"`
Expected: all PASS; no tsc lines.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/AnalysisTable.tsx src/components/senaite/VialsQuickLookDialog.tsx src/components/senaite/SampleDetails.tsx src/test/vials-quicklook.test.tsx
git commit -m "feat(variance): Verify (Variance) row action + Ready to Verify badge on vial surfaces"
```

---

### Task 8: Gates — full suites + live backend verification

**Files:** none (verification only; one throwaway script)

- [ ] **Step 1: Full FE suite**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run 2>&1 | tail -4"`
Expected: only the 2 documented pre-existing failures (`App.test.tsx`, `peptide-requests-list.test.tsx`).

- [ ] **Step 2: Backend suite (affected slices)**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_verify.py tests/test_lims_analyses_state_machine.py tests/test_lims_analyses_service.py tests/test_lims_analyses_routes.py tests/test_vial_retest.py tests/test_promote_writeback_route.py tests/test_parent_retest_cascade.py -q"`
Expected: green except failures already present at the base commit (verify any suspect via `git stash` baseline before chasing).

- [ ] **Step 3: Live backend verification (simulated entitlement, ZZTEST data)**

Full live E2E (FE button → real entitlement) is impossible until IS exposes the variance map (Phase 3) — the FE action correctly stays hidden on real orders. Verify the backend path live with an injected fetcher and throwaway data:

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python - <<'EOF'
from datetime import datetime
from sqlalchemy import text
from database import SessionLocal
from lims_analyses import service
from models import LimsAnalysis, LimsSample, LimsSubSample

db = SessionLocal()
parent = LimsSample(sample_id='ZZTEST-LIVE-VARV', peptide_name='ZZ', status='received')
db.add(parent); db.flush()
vial = LimsSubSample(sample_id='ZZTEST-LIVE-VARV-S01', parent_sample_pk=parent.id,
                     vial_sequence=1, received_at=datetime.utcnow(), assignment_role='hplc')
db.add(vial); db.flush()
svc_id = db.execute(text('SELECT id FROM analysis_services LIMIT 1')).scalar_one()
row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc_id,
                   keyword='ZZTEST-LIVE-KW', title='ZZ', result_value='99',
                   review_state='to_be_verified')
db.add(row); db.commit()
try:
    service.ensure_variance_entitlement(db, analysis_id=row.id,
        fetch_services=lambda sid: {'variance': {'hplcpurity_identity': 3}})
    out = service.apply_transition(db, analysis_id=row.id, kind='variance_verify',
                                   reason='live verification')
    print('STATE:', out.review_state, 'VERIFIED_AT:', out.verified_at)
    new = service.apply_transition(db, analysis_id=row.id, kind='retest')
    print('RETEST ROW:', new.id, new.review_state, 'of', new.retest_of_id)
finally:
    db.rollback()
    db.execute(text(\"DELETE FROM lims_analyses WHERE keyword LIKE 'ZZTEST-LIVE-%'\"))
    db.execute(text(\"DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-LIVE-%'\"))
    db.execute(text(\"DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-LIVE-%'\"))
    db.commit()
    print('CLEANED:', db.execute(text(\"SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST-LIVE-%'\")).scalar_one())
EOF"
```

Expected output: `STATE: variance_verified VERIFIED_AT: <timestamp>`, `RETEST ROW: <id> unassigned of <row id>`, `CLEANED: 0`.

- [ ] **Step 4: Verify the FE action stays hidden on real data (regression)**

In a fresh browser context (HMR caveat): open `http://localhost:5532/#senaite/sample-details?id=PB-0076-S05` and confirm no `Verify (Variance)` menu item appears anywhere (no real order has variance) and "Ready to Promote" badges are unchanged.

- [ ] **Step 5: Final commit (if any stragglers) + report**

```bash
git status --short   # should be clean of plan-scope files
```

Report per-task commits, test counts, and the live-verification output.

---

## Out of scope for this plan (later phases per spec)

- Demand inflation + AssignStep variance sub-rows (Phase 2)
- IS contract: per-service map parse/validate/normalize + payload exposure (Phase 3)
- WP addon product (Phase 4); COA variance section (Phase 5)
- `lock_variance_set` completion guard (lands with Phase 2 when bucket demand is known)
