# Order-Upsert Placeholder Seeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed native parent-tier placeholders from the Integration Service's post-commit order upsert (which now carries per-sample services), so multi-sample orders stop losing every sample but the last; make the registration fallback loud instead of silent; ship a heal script for the nine affected parents.

**Architecture:** IS's pure `build_order_upsert` adds `services`/`package` to each sample stamp. Mk1 gains a small `lims_analyses/order_seed.py` module (seed-from-services + a missing-placeholder finder) used by three callers: the `/s2s/orders/upsert` handler (new second phase after the stamp commit), the existing registration background task (refactored to delegate, and to WARN instead of silently return), and a new heal script. Backward compatible in both directions; deploy Mk1 before IS.

**Tech Stack:** Accu-Mk1 backend = FastAPI + SQLAlchemy 2 + pytest (in-memory SQLite, StaticPool for route tests). Integration Service = FastAPI + pydantic v2 + pytest. Windows dev host; run tests with each repo's `.venv` python.

**Spec:** `docs/superpowers/specs/2026-09-08-order-upsert-placeholder-seed-design.md` (same branch). Read it first.

## Global Constraints

- **Worktrees (already created):** Mk1 `C:\tmp\Accu-Mk1-order-seed` (branch `feat/order-upsert-placeholder-seed` from `2b495ff1`); IS `C:\tmp\integration-service-order-seed` (branch `feat/order-upsert-sample-services` from `60b7bb3`). All paths below are relative to these.
- **Mk1 backend test command:** `cd C:\tmp\Accu-Mk1-order-seed\backend && C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <targets>`. Do NOT create a `backend/.env`.
- **IS test command:** `cd C:\tmp\integration-service-order-seed && C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\integration-service\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <targets>`.
- **Test gate = failure-SET diff** against the baselines captured in Task 0 (`.seed_baseline_mk1.txt`, `.seed_baseline_is.txt` — keep both UNTRACKED; never `git add -A`).
- **Zero new SENAITE coupling.** No new calls to any SENAITE surface.
- **Never silent:** every early return in an S2S background task logs at WARNING with the sample id.
- **Idempotent everywhere:** `seed_parent_placeholders` is idempotent by unique index + pre-check; callers may run it repeatedly.
- Python style: match surrounding code (function-local imports for cross-package imports inside `lims_analyses`/`sub_samples` to avoid cycles).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 0: Baselines (orchestrator inline, not a subagent)

**Files:** none (environment).

- [ ] **Step 1: Mk1 baseline failure set**

```bash
cd C:/tmp/Accu-Mk1-order-seed/backend
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider -rf tests/test_parent_placeholders.py tests/test_s2s_orders_upsert.py tests/test_registry_signal.py tests/test_shadow_analyses_at_registration.py 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > ../.seed_baseline_mk1.txt
wc -l ../.seed_baseline_mk1.txt
```

- [ ] **Step 2: IS baseline failure set**

```bash
cd C:/tmp/integration-service-order-seed
"C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/integration-service/.venv/Scripts/python.exe" -m pytest -q -p no:cacheprovider -rf tests/unit/test_order_upsert_builder.py tests/unit/test_accumk1_upsert_orders.py 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > .seed_baseline_is.txt
wc -l .seed_baseline_is.txt
```

- [ ] **Step 3: Confirm both baseline files are untracked** — `git status --short` in each worktree must show them as `??` and they must never be added.

---

### Task 1: IS — stamps carry services and package

**Files:**
- Modify: `app/services/order_upsert.py` (`build_order_upsert`, the stamps loop)
- Test: `tests/unit/test_order_upsert_builder.py`

**Interfaces:**
- Produces: stamp dict `{"senaite_sample_id": str, "line_item_ids": list[int], "services": dict, "package": str | None}` — Task 3's `S2SOrderSampleStamp` reads exactly these keys.

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/test_order_upsert_builder.py`)

```python
def _payload_two_samples():
    return {
        "order_id": 7001,
        "order_number": "7001",
        "customer": {"user_id": 5, "user_email": "a@b.c", "first_name": "A", "last_name": "B"},
        "submitted_at": "2026-09-08T10:00:00",
        "samples": [
            {"number": 1, "services": {"heavy_metals": True, "endotoxin": False}, "package": "core"},
            {"number": 2, "services": {"sterility_pcr": True}, "package": None,
             "line_item_ids": [11, 12]},
            {"number": 3, "services": {"fentanyl": True}},
        ],
    }


def test_stamps_carry_services_and_package():
    results = {"1": {"senaite_id": "P-7001", "status": "created"},
               "2": {"senaite_id": "P-7002", "status": "created"}}
    out = build_order_upsert(_payload_two_samples(), results)
    by_id = {s["senaite_sample_id"]: s for s in out["samples"]}
    assert by_id["P-7001"]["services"] == {"heavy_metals": True, "endotoxin": False}
    assert by_id["P-7001"]["package"] == "core"
    assert by_id["P-7002"]["services"] == {"sterility_pcr": True}
    assert by_id["P-7002"]["package"] is None
    assert by_id["P-7002"]["line_item_ids"] == [11, 12]


def test_stamp_emitted_without_line_item_ids():
    """wpstar does not send line_item_ids today; a registered sample must
    still be stamped (services are the load-bearing payload now)."""
    results = {"1": {"senaite_id": "P-7001", "status": "created"}}
    out = build_order_upsert(_payload_two_samples(), results)
    assert [s["senaite_sample_id"] for s in out["samples"]] == ["P-7001"]
    assert out["samples"][0]["line_item_ids"] == []


def test_no_stamp_without_senaite_id():
    results = {"3": {"senaite_id": None, "status": "failed"}}
    out = build_order_upsert(_payload_two_samples(), results)
    assert out["samples"] == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd C:/tmp/integration-service-order-seed && <IS python> -m pytest -q -p no:cacheprovider tests/unit/test_order_upsert_builder.py -k "services_and_package or without_line_item_ids or without_senaite_id"`
Expected: FAIL — `KeyError: 'services'` and the no-line-items stamp missing.

- [ ] **Step 3: Implement** — replace the stamps loop in `build_order_upsert`:

```python
    stamps = []
    for s in payload.get("samples") or []:
        num = s.get("number")
        senaite = (results.get(str(num)) or {}).get("senaite_id")
        if not senaite:
            continue
        items = s.get("line_item_ids") or []
        stamps.append({
            "senaite_sample_id": senaite,
            "line_item_ids": [int(i) for i in items],
            # Per-sample services ride the post-commit upsert so Mk1 can seed
            # its parent-tier placeholders without calling back to
            # /explorer/orders/sample-services (2026-09-08: that callback
            # raced this order's commit and lost for every sample but the
            # last in a multi-sample order).
            "services": s.get("services") or {},
            "package": s.get("package"),
        })
```

- [ ] **Step 4: Run the whole builder test file** — existing assertions that expected stamps to be dropped without `line_item_ids` will now fail; update them to the new contract (a stamp with `line_item_ids == []`), and update any exact-dict equality to include the two new keys. Also run `tests/unit/test_accumk1_upsert_orders.py`.

Run: `<IS python> -m pytest -q -p no:cacheprovider tests/unit/test_order_upsert_builder.py tests/unit/test_accumk1_upsert_orders.py`
Expected: all pass; failure-set diff vs `.seed_baseline_is.txt` empty.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/integration-service-order-seed add app/services/order_upsert.py tests/unit/test_order_upsert_builder.py
git -C C:/tmp/integration-service-order-seed commit -m "feat(upsert): sample stamps carry services + package; stamp without line_item_ids

Mk1 seeds native parent placeholders from the post-commit order upsert instead
of racing this order's commit via GET /explorer/orders/sample-services.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Mk1 — `lims_analyses/order_seed.py` (seed-from-services + finder)

**Files:**
- Create: `backend/lims_analyses/order_seed.py`
- Test: `backend/tests/test_order_seed.py` (new)

**Interfaces:**
- Consumes: `lims_analyses.parent_placeholders.seed_parent_placeholders(db, *, parent, services, package=None, reason=None, created_by_user_id=None) -> dict` with keys `created/existing/skipped/created_ids`; `catalog.snapshot.compute_catalog_snapshot(db, services, package) -> dict`; `sub_samples.service._apply_variance_override(sample_id, result: dict|None) -> dict|None`.
- Produces: `seed_parent_from_services(db, *, parent, services: dict, package, source: str) -> dict` (same stats dict; does NOT commit) and `find_parents_missing_native_placeholders(db) -> list[tuple[LimsSample, set[int]]]`.

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_order_seed.py`:

```python
"""lims_analyses/order_seed.py — seed native parent placeholders from a
services dict (order upsert / registration signal / heal) + the finder the
heal script uses. Fixture idiom copied from test_parent_placeholders.py."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from database import Base
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

from lims_analyses.order_seed import (
    find_parents_missing_native_placeholders,
    seed_parent_from_services,
)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent(db):
    p = LimsSample(sample_id="P-9001", sample_type="x", status="received")
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _svc(db, keyword, origin="mk1"):
    s = AnalysisService(title=keyword, keyword=keyword, origin=origin)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _profile(db, key, members):
    prof = AnalysisProfile(key=key, name=key, is_addon=True, coa_archetype="limit_table")
    for m in members:
        prof.analysis_services.append(m)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


@pytest.fixture
def pcr_profile(db):
    return _profile(db, "sterility_pcr", [_svc(db, "STERILITY-PCR")])


def _ordered_rows(db, parent):
    return db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == parent.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == PROVENANCE_ORDERED,
    )).scalars().all()


def test_seeds_one_ordered_row_per_native_member(db, parent, pcr_profile):
    with patch("lims_analyses.order_seed.compute_catalog_snapshot", return_value={"profiles": []}):
        stats = seed_parent_from_services(
            db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert stats["created"] == 1
    rows = _ordered_rows(db, parent)
    assert [r.keyword for r in rows] == ["STERILITY-PCR"]


def test_second_call_is_idempotent(db, parent, pcr_profile):
    with patch("lims_analyses.order_seed.compute_catalog_snapshot", return_value={"profiles": []}):
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
        db.commit()
        stats = seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert stats["created"] == 0 and stats["existing"] == 1
    assert len(_ordered_rows(db, parent)) == 1


def test_snapshot_stamped_once_only(db, parent, pcr_profile):
    with patch("lims_analyses.order_seed.compute_catalog_snapshot", return_value={"profiles": ["first"]}) as snap:
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
        db.commit()
        assert parent.catalog_snapshot == {"profiles": ["first"]}
        snap.return_value = {"profiles": ["second"]}
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
        db.commit()
    assert parent.catalog_snapshot == {"profiles": ["first"]}
    assert snap.call_count == 1


def test_snapshot_failure_keeps_seeded_rows(db, parent, pcr_profile):
    with patch("lims_analyses.order_seed.compute_catalog_snapshot", side_effect=RuntimeError("bad catalog")):
        stats = seed_parent_from_services(
            db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert stats["created"] == 1
    assert len(_ordered_rows(db, parent)) == 1
    assert parent.catalog_snapshot is None


# ── finder ────────────────────────────────────────────────────────────────


def _vial(db, parent, seq):
    v = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"mk1://{seq}",
                      sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _vial_row(db, vial, svc, state="unassigned"):
    r = LimsAnalysis(lims_sub_sample_pk=vial.id, lims_sample_pk=None,
                     analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
                     provenance="canonical", review_state=state)
    db.add(r)
    db.commit()
    return r


def test_finder_reports_parent_with_native_vial_row_and_no_parent_row(db, parent, pcr_profile):
    svc = pcr_profile.analysis_services[0]
    _vial_row(db, _vial(db, parent, 5), svc)
    found = find_parents_missing_native_placeholders(db)
    assert [(p.sample_id, missing) for p, missing in found] == [("P-9001", {svc.id})]


def test_finder_ignores_parent_once_placeholder_exists(db, parent, pcr_profile):
    svc = pcr_profile.analysis_services[0]
    _vial_row(db, _vial(db, parent, 5), svc)
    with patch("lims_analyses.order_seed.compute_catalog_snapshot", return_value={}):
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert find_parents_missing_native_placeholders(db) == []


def test_finder_ignores_senaite_origin_and_dead_vial_rows(db, parent):
    legacy = _svc(db, "HPLC-PUR", origin="senaite")
    native = _svc(db, "LEAD-PPM", origin="mk1")
    vial = _vial(db, parent, 1)
    _vial_row(db, vial, legacy)
    _vial_row(db, vial, native, state="rejected")
    assert find_parents_missing_native_placeholders(db) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd C:/tmp/Accu-Mk1-order-seed/backend && <Mk1 python> -m pytest -q -p no:cacheprovider tests/test_order_seed.py`
Expected: FAIL at import — `ModuleNotFoundError: lims_analyses.order_seed`.

- [ ] **Step 3: Implement** — create `backend/lims_analyses/order_seed.py`:

```python
"""Seed native parent-tier placeholders from a services dict, whoever hands
it to us (order upsert, registration signal, heal script), plus the finder
the heal script uses.

Why this exists (2026-09-08): the registration-time background task used to
ask IS for the sample's services and IS answered 404 until it committed the
whole order — so every sample but the last in a multi-sample order silently
got no placeholders (P-2687/88/89 vs P-2690). The order upsert now carries
the services, and every caller funnels through here.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy import select

from catalog.snapshot import compute_catalog_snapshot
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

logger = logging.getLogger(__name__)

_DEAD_STATES = ("rejected", "retracted")


def seed_parent_from_services(db, *, parent: LimsSample, services: Optional[dict],
                              package, source: str) -> dict:
    """Mint pending parent-tier rows for the parent's ordered native services
    and stamp the once-only catalog snapshot. Does NOT commit.

    `source` is a log tag only ("order_upsert" / "registration_signal" /
    "heal") so the three callers stay distinguishable in prod logs.
    """
    from sub_samples.service import _apply_variance_override  # local: avoids the cycle

    raw = _apply_variance_override(parent.sample_id,
                                   {"services": services or {}, "package": package}) or {}
    services = raw.get("services") or {}
    package = raw.get("package")
    stats = seed_parent_placeholders(db, parent=parent, services=services, package=package)
    # Once-only: freeze what was resolved the FIRST time. Isolated so a
    # snapshot failure never undoes the seed above (bench visibility is the
    # load-bearing guarantee); catalog_snapshot stays NULL and the next
    # caller retries.
    if parent.catalog_snapshot is None:
        try:
            parent.catalog_snapshot = compute_catalog_snapshot(db, services, package)
        except Exception as snapshot_err:  # noqa: BLE001
            logger.warning("catalog_snapshot.stamp_failed source=%s sample_id=%s err=%s",
                           source, parent.sample_id, snapshot_err)
    logger.info("registry.native_placeholder_seed source=%s sample_id=%s created=%s existing=%s skipped=%s",
                source, parent.sample_id, stats["created"], stats["existing"], stats["skipped"])
    return stats


def find_parents_missing_native_placeholders(db) -> List[Tuple[LimsSample, Set[int]]]:
    """Parents whose LIVE native (origin='mk1') vial-tier rows reference a
    service with no parent-tier row (live canonical or any 'ordered').
    Read-only. Returns [(parent, missing_service_ids)]."""
    mk1_ids: Set[int] = set(db.execute(
        select(AnalysisService.id).where(AnalysisService.origin == "mk1")).scalars().all())
    if not mk1_ids:
        return []
    out: List[Tuple[LimsSample, Set[int]]] = []
    for parent in db.execute(select(LimsSample).order_by(LimsSample.id)).scalars().all():
        sub_ids = list(db.execute(
            select(LimsSubSample.id).where(LimsSubSample.parent_sample_pk == parent.id)).scalars().all())
        if not sub_ids:
            continue
        vial_rows = db.execute(select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk.in_(sub_ids),
            LimsAnalysis.analysis_service_id.in_(mk1_ids),
        )).scalars().all()
        wanted = {r.analysis_service_id for r in vial_rows if r.review_state not in _DEAD_STATES}
        if not wanted:
            continue
        parent_rows = db.execute(select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.lims_sub_sample_pk.is_(None),
        )).scalars().all()
        have = {r.analysis_service_id for r in parent_rows
                if r.provenance == PROVENANCE_ORDERED
                or (r.provenance == "canonical" and r.review_state not in _DEAD_STATES)}
        missing = wanted - have
        if missing:
            out.append((parent, missing))
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `<Mk1 python> -m pytest -q -p no:cacheprovider tests/test_order_seed.py tests/test_parent_placeholders.py`
Expected: all pass. If `_apply_variance_override` needs a real session in tests (it opens its own `SessionLocal`), it is fail-soft and returns the payload unchanged on error — the tests above do not depend on it.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-order-seed add backend/lims_analyses/order_seed.py backend/tests/test_order_seed.py
git -C C:/tmp/Accu-Mk1-order-seed commit -m "feat(lims): order_seed — seed native parent placeholders from a services dict + missing-placeholder finder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Mk1 — `/s2s/orders/upsert` seeds from the stamp

**Files:**
- Modify: `backend/main.py` — `S2SOrderSampleStamp` (~21805), `S2SOrdersUpsertResponse` (~21832), `s2s_upsert_orders` (~21838)
- Test: `backend/tests/test_s2s_orders_upsert.py`

**Interfaces:**
- Consumes: `seed_parent_from_services` from Task 2.
- Produces: request stamp fields `services: Optional[dict]`, `package: Optional[str]`; response field `placeholders_created: int`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_s2s_orders_upsert.py`; reuse its `client`/`db_session` fixtures and `HDR`/`URL`/`SVC_TOKEN`)

```python
from unittest.mock import patch

from models import AnalysisProfile, AnalysisService, LimsAnalysis
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED


def _native_pcr_profile(db):
    svc = AnalysisService(title="Sterility PCR", keyword="STERILITY-PCR", origin="mk1")
    db.add(svc)
    db.commit()
    prof = AnalysisProfile(key="sterility_pcr", name="Sterility PCR", is_addon=True,
                           coa_archetype="limit_table")
    prof.analysis_services.append(svc)
    db.add(prof)
    db.commit()
    return prof


def _order_with_services(sample_id="P-8001", services=None, line_item_ids=None):
    stamp = {"senaite_sample_id": sample_id, "line_item_ids": line_item_ids or []}
    if services is not None:
        stamp["services"] = services
        stamp["package"] = None
    return {"orders": [{"wp_order_id": 8001, "order_number": "WP-8001",
                        "status": "order-submitted", "samples": [stamp]}]}


def _ordered_rows(db, parent_id):
    return db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_id, lims_sub_sample_pk=None, provenance=PROVENANCE_ORDERED).all()


def test_stamp_with_services_seeds_placeholders(client, db_session):
    _native_pcr_profile(db_session)
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("lims_analyses.order_seed.compute_catalog_snapshot", return_value={"profiles": []}):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True}), headers=HDR)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["samples_stamped"] == 1
    assert body["placeholders_created"] == 1
    assert [x.keyword for x in _ordered_rows(db_session, parent.id)] == ["STERILITY-PCR"]


def test_re_upsert_is_idempotent(client, db_session):
    _native_pcr_profile(db_session)
    db_session.add(LimsSample(sample_id="P-8001", sample_type="x", status="received"))
    db_session.commit()
    body = _order_with_services(services={"sterility_pcr": True})
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("lims_analyses.order_seed.compute_catalog_snapshot", return_value={}):
        client.post(URL, json=body, headers=HDR)
        r = client.post(URL, json=body, headers=HDR)
    assert r.json()["placeholders_created"] == 0
    parent = db_session.query(LimsSample).filter_by(sample_id="P-8001").one()
    assert len(_ordered_rows(db_session, parent.id)) == 1


def test_stamp_without_services_seeds_nothing(client, db_session):
    _native_pcr_profile(db_session)
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=_order_with_services(), headers=HDR)
    assert r.json()["placeholders_created"] == 0
    assert _ordered_rows(db_session, parent.id) == []


def test_empty_line_item_ids_does_not_clear_existing(client, db_session):
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received", wc_line_item_ids=[41, 42])
    db_session.add(parent)
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        client.post(URL, json=_order_with_services(), headers=HDR)
    db_session.refresh(parent)
    assert parent.wc_line_item_ids == [41, 42]


def test_seed_failure_does_not_fail_upsert(client, db_session):
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         patch("main.seed_parent_from_services", side_effect=RuntimeError("boom")):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True},
                                                       line_item_ids=[7]), headers=HDR)
    assert r.status_code == 200
    assert r.json()["samples_stamped"] == 1
    assert r.json()["placeholders_created"] == 0
    db_session.refresh(parent)
    assert parent.wc_line_item_ids == [7]
```

- [ ] **Step 2: Run to verify they fail**

Run: `<Mk1 python> -m pytest -q -p no:cacheprovider tests/test_s2s_orders_upsert.py`
Expected: the new tests FAIL (`KeyError: 'placeholders_created'`, patch target `main.seed_parent_from_services` missing, cleared line items).

- [ ] **Step 3: Implement** in `backend/main.py`:

Models:

```python
class S2SOrderSampleStamp(BaseModel):
    senaite_sample_id: str
    line_item_ids: list[int] = []
    # 2026-09-08: per-sample services ride the post-commit upsert so the
    # parent-tier placeholders seed here instead of racing IS's commit from
    # the registration signal's callback. Optional for old-IS compatibility.
    services: Optional[dict] = None
    package: Optional[str] = None


class S2SOrdersUpsertResponse(BaseModel):
    upserted: int
    samples_stamped: int
    samples_missing: int
    placeholders_created: int = 0
```

Module-level import next to the other `lims_analyses` imports in main.py (so tests can patch `main.seed_parent_from_services`):

```python
from lims_analyses.order_seed import seed_parent_from_services
```

Handler — replace the stamping loop's `sample.wc_line_item_ids = list(s.line_item_ids)` with a guard, and add phase 2 after the existing `db.commit()`:

```python
        for s in o.samples:
            sample = db.query(LimsSample).filter_by(sample_id=s.senaite_sample_id).first()
            if sample is None:
                missing += 1
                continue
            if s.line_item_ids:  # never clear a stamped list with an empty one
                sample.wc_line_item_ids = list(s.line_item_ids)
            stamped += 1
    db.commit()

    # Phase 2 — native parent placeholders from the stamp's services. Runs
    # AFTER the stamp commit and commits per sample so a seeding failure can
    # never roll back the order stamps and one bad sample never blocks its
    # siblings (idempotent: re-pushes report 0 created).
    placeholders_created = 0
    for o in req.orders:
        for s in o.samples:
            if s.services is None:
                continue
            sample = db.query(LimsSample).filter_by(sample_id=s.senaite_sample_id).first()
            if sample is None:
                continue
            try:
                stats = seed_parent_from_services(
                    db, parent=sample, services=s.services, package=s.package,
                    source="order_upsert",
                )
                db.commit()
                placeholders_created += stats["created"]
            except Exception as seed_err:  # noqa: BLE001
                db.rollback()
                logger.warning("registry.order_upsert_seed_failed sample_id=%s err=%s",
                               s.senaite_sample_id, seed_err)
    return S2SOrdersUpsertResponse(upserted=upserted, samples_stamped=stamped,
                                    samples_missing=missing,
                                    placeholders_created=placeholders_created)
```

- [ ] **Step 4: Run to verify they pass**

Run: `<Mk1 python> -m pytest -q -p no:cacheprovider tests/test_s2s_orders_upsert.py tests/test_order_seed.py`
Expected: all pass, including the pre-existing upsert tests (they send no `services`, so phase 2 is a no-op).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-order-seed add backend/main.py backend/tests/test_s2s_orders_upsert.py
git -C C:/tmp/Accu-Mk1-order-seed commit -m "feat(s2s): order upsert seeds native parent placeholders from sample stamps

Second phase after the stamp commit; per-sample commit; never fails the
upsert. Empty line_item_ids no longer clears a stamped list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Mk1 — registration fallback delegates and stops being silent

**Files:**
- Modify: `backend/main.py` — `_native_placeholders_at_registration_bg` (~16491-16545)
- Test: `backend/tests/test_native_placeholders_bg.py` (new)

**Interfaces:**
- Consumes: `seed_parent_from_services` (Task 2); `sub_samples.service.fetch_sample_services(sample_id) -> dict | None`.

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_native_placeholders_bg.py`:

```python
"""_native_placeholders_at_registration_bg — the registration-signal fallback
must log when IS has no services for the sample (it used to return silently:
2026-09-08 multi-sample race) and must delegate seeding to order_seed."""
import logging
from unittest.mock import patch

import main


def test_logs_warning_when_is_has_no_services(caplog):
    with patch("sub_samples.service.fetch_sample_services", return_value=None), \
         patch("main.seed_parent_from_services") as seed:
        with caplog.at_level(logging.WARNING):
            main._native_placeholders_at_registration_bg("P-7777")
    assert any("registry.native_placeholder_seed_skipped" in r.getMessage()
               and "P-7777" in r.getMessage() for r in caplog.records)
    seed.assert_not_called()


def test_delegates_to_seed_parent_from_services():
    fake_parent = object()

    class _Q:
        def filter_by(self, **kw):
            return self
        def one_or_none(self):
            return fake_parent

    class _Session:
        def query(self, *a):
            return _Q()
        def commit(self):
            pass
        def rollback(self):
            pass
        def close(self):
            pass

    with patch("sub_samples.service.fetch_sample_services",
               return_value={"services": {"sterility_pcr": True}, "package": "core"}), \
         patch("database.SessionLocal", return_value=_Session()), \
         patch("main.seed_parent_from_services",
               return_value={"created": 1, "existing": 0, "skipped": 0}) as seed:
        main._native_placeholders_at_registration_bg("P-7777")
    seed.assert_called_once()
    kwargs = seed.call_args.kwargs
    assert kwargs["parent"] is fake_parent
    assert kwargs["services"] == {"sterility_pcr": True}
    assert kwargs["package"] == "core"
    assert kwargs["source"] == "registration_signal"
```

- [ ] **Step 2: Run to verify it fails**

Run: `<Mk1 python> -m pytest -q -p no:cacheprovider tests/test_native_placeholders_bg.py`
Expected: FAIL — no `registry.native_placeholder_seed_skipped` record; delegation assertion fails.

- [ ] **Step 3: Implement** — replace the body of `_native_placeholders_at_registration_bg` (keep the docstring, add one paragraph noting it is now the fallback behind the order upsert):

```python
    db = None
    try:
        from database import SessionLocal
        from sub_samples.service import fetch_sample_services
        from models import LimsSample

        raw = fetch_sample_services(sample_id)
        if not raw:
            # Never silent (2026-09-08): IS answers 404 until it commits the
            # whole order, so this fallback loses the race for every sample
            # but the last of a multi-sample order. The order upsert is the
            # primary seed now; this line is how we know the fallback fired
            # and found nothing.
            logger.warning(
                "registry.native_placeholder_seed_skipped sample_id=%s reason=no_services_from_is",
                sample_id,
            )
            return
        db = SessionLocal()
        parent = db.query(LimsSample).filter_by(sample_id=sample_id).one_or_none()
        if parent is None:
            logger.warning(
                "registry.native_placeholder_seed_skipped sample_id=%s reason=parent_not_in_registry",
                sample_id,
            )
            return
        seed_parent_from_services(
            db, parent=parent, services=raw.get("services") or {},
            package=raw.get("package"), source="registration_signal",
        )
        db.commit()
    except Exception as seed_err:  # noqa: BLE001
        if db is not None:
            try:
                db.rollback()
            except Exception:
                pass
        logger.warning(
            "registry.native_placeholder_seed_failed sample_id=%s err=%s",
            sample_id, seed_err,
        )
    finally:
        if db is not None:
            db.close()
```

Note: `seed_parent_from_services` is patched as `main.seed_parent_from_services` in tests, so it must be referenced via the module-level import added in Task 3, not re-imported locally here. Remove the now-unused local imports of `seed_parent_placeholders` and `compute_catalog_snapshot` from this function.

- [ ] **Step 4: Run to verify they pass** (plus the registration suites to prove no regression)

Run: `<Mk1 python> -m pytest -q -p no:cacheprovider tests/test_native_placeholders_bg.py tests/test_registry_signal.py tests/test_shadow_analyses_at_registration.py tests/test_parent_placeholders.py`
Expected: all pass; failure-set diff vs `.seed_baseline_mk1.txt` empty.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-order-seed add backend/main.py backend/tests/test_native_placeholders_bg.py
git -C C:/tmp/Accu-Mk1-order-seed commit -m "fix(s2s): registration placeholder fallback delegates to order_seed and warns instead of returning silently

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Mk1 — heal script

**Files:**
- Create: `backend/scripts/heal_missing_placeholders.py`

**Interfaces:**
- Consumes: `find_parents_missing_native_placeholders`, `seed_parent_from_services` (Task 2); `fetch_sample_services`.

The finder is unit-tested in Task 2; the script is a thin CLI over it. Model it on `backend/scripts/backfill_parent_analysis_shadows.py` for the session/`sys.path` conventions used by the other scripts in that folder.

- [ ] **Step 1: Create the script**

```python
#!/usr/bin/env python3
"""Convergence heal: parents with live native vial-tier analyses whose services
have no parent-tier row (no 'ordered' placeholder, no live canonical) get their
placeholders seeded from IS's services dict.

Born 2026-09-08 to heal the nine parents that lost the registration race
(P-2586, P-2655, P-2659, P-2660, P-2687, P-2688, P-2689, P-2693, P-2694); safe
to run any time (idempotent) and cron-able via `docker exec accu-mk1-backend
python scripts/heal_missing_placeholders.py --apply`.

Dry-run by default. --sample restricts to the given ids.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="seed (default: report only)")
    ap.add_argument("--sample", action="append", default=[], help="restrict to sample id(s)")
    args = ap.parse_args()

    from database import SessionLocal
    from models import AnalysisService
    from lims_analyses.order_seed import (
        find_parents_missing_native_placeholders, seed_parent_from_services,
    )
    from sub_samples.service import fetch_sample_services

    db = SessionLocal()
    try:
        kw = {a.id: a.keyword for a in db.query(AnalysisService).all()}
        found = find_parents_missing_native_placeholders(db)
        if args.sample:
            found = [(p, m) for p, m in found if p.sample_id in set(args.sample)]
        print(f"parents missing native placeholders: {len(found)}  ({'APPLY' if args.apply else 'dry-run'})")
        for parent, missing in found:
            names = ", ".join(sorted(kw.get(i, str(i)) for i in missing))
            if not args.apply:
                print(f"  {parent.sample_id}: missing {names}")
                continue
            raw = fetch_sample_services(parent.sample_id)
            if not raw:
                print(f"  {parent.sample_id}: SKIP no services from IS (missing {names})")
                continue
            try:
                stats = seed_parent_from_services(
                    db, parent=parent, services=raw.get("services") or {},
                    package=raw.get("package"), source="heal",
                )
                db.commit()
                print(f"  {parent.sample_id}: created={stats['created']} existing={stats['existing']} "
                      f"skipped={stats['skipped']} (was missing {names})")
            except Exception as e:  # noqa: BLE001
                db.rollback()
                print(f"  {parent.sample_id}: FAILED {type(e).__name__}: {e}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke it against the in-memory test DB path** — `<Mk1 python> -c "import ast,sys; ast.parse(open('scripts/heal_missing_placeholders.py').read()); print('ok')"` from `backend/`. (The real run happens on prod in Task 7; the finder it wraps is covered by Task 2's tests.)

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-order-seed add backend/scripts/heal_missing_placeholders.py
git -C C:/tmp/Accu-Mk1-order-seed commit -m "feat(scripts): heal_missing_placeholders — converge parents whose native vial rows have no parent-tier placeholder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Version, CHANGELOG, specs on both branches; push and PR

**Files:**
- Modify (Mk1): `package.json` and `src-tauri/tauri.conf.json` (version `1.15.0` → `1.15.1`), `CHANGELOG.md` (new `## v1.15.1 — 2026-09-08` section at top: Fixed — multi-sample orders lost parent placeholders for every sample but the last; order upsert now seeds them; registration fallback warns; heal script).
- Modify (IS): `CHANGELOG.md` if present (check `ls`), entry: sample stamps carry services + package; stamps no longer require line_item_ids.
- The spec + this plan are already in the Mk1 worktree under `docs/superpowers/`; commit them.

- [ ] **Step 1: Bump + changelog + docs commit (Mk1)**

```bash
cd C:/tmp/Accu-Mk1-order-seed
git add package.json src-tauri/tauri.conf.json CHANGELOG.md docs/superpowers/specs/2026-09-08-order-upsert-placeholder-seed-design.md docs/superpowers/plans/2026-09-08-order-upsert-placeholder-seed.md
git commit -m "chore(release): 1.15.1 — order-upsert placeholder seeding; spec + plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Full backend suites, failure-set diff** — run the complete backend suite in each worktree and diff `FAILED/ERROR` sets against the Task 0 baselines. Expected: no new failures.

- [ ] **Step 3: Push both branches and open PRs** (`gh pr create` with the spec summary; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`). Handler merges per the release train (or orders same-day master commits per the hotfix precedent of 2026-08-30).

---

### Task 7: Deploy, heal, verify

**Files:** none (operations; use the `accumark-deploy` skill for the exact recipes).

- [ ] **Step 1: Deploy Mk1 first** — `bash scripts/deploy.sh` from the merged checkout; confirm `curl https://accumk1.valenceanalytical.com/api/health` → `{"status":"ok","version":"1.15.1"}`.
- [ ] **Step 2: Deploy IS** — `bash scripts/deploy.sh` (no alembic); confirm `curl http://165.227.241.81:8000/v1/readyz`.
- [ ] **Step 3: Heal dry-run** — `ssh root@165.227.241.81 "docker exec accu-mk1-backend python scripts/heal_missing_placeholders.py"`; expected: the nine parents listed with their missing keywords.
- [ ] **Step 4: Heal apply** — same with `--apply`; expected: `created=` counts (P-2689: 6).
- [ ] **Step 5: Verify P-2689** — rerun the read-only probe (parent-tier rows now include six `ordered` rows) and load `#senaite/sample-details?id=P-2689`: heavy metals, endotoxin, and PCR appear under their profile sections with live vial-state badges.
- [ ] **Step 6: Watch the next multi-sample order** (or register a 2-sample order on arcitest) and confirm both samples carry placeholders and the prod log shows `registry.native_placeholder_seed source=order_upsert` for each.
- [ ] **Step 7: Session log + memory** per the Obsidian protocol.
