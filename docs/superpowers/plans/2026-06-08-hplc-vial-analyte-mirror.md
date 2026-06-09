# HPLC Vial Analyte Mirror + Per-Analyte Prep Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assigning a sub-sample vial to HPLC mirrors the parent's full Analytics analyte set onto the vial (per-analyte purity/quantity/identity, blend purity, peptide ID/total); a vial prep's result then routes to the correct per-analyte row.

**Architecture:** Two coupled changes. (1) The seeder's HPLC branch reads the parent's SENAITE analyses, keeps Analytics-group keywords, and creates matching `lims_analyses` on the vial — fail-hard (atomic with the role flip). (2) The prep bridge resolves the prep's peptide → analyte slot (from the parent's SENAITE `Analyte{N}Peptide`) and routes purity→`ANALYTE-N-PUR`, quantity→`ANALYTE-N-QTY`, with backward-compat to legacy generic rows.

**Tech Stack:** FastAPI + SQLAlchemy (`models.py`), raw SENAITE REST via `requests` (`sub_samples/senaite.py`), pytest (seeder tests run against the live `accumark_mk1` DB; bridge tests use in-memory SQLite).

**Grounded facts (don't re-derive):**
- Parent SENAITE analysis keywords == Mk1 catalog keywords (`ANALYTE-1-PUR`, `ID_GHKCU`, `BLEND-PUR`, `PEPT-Total`, `HPLC-ID`, …).
- Analytics service group = `service_groups.name == "Analytics"` (id 1 in this DB; resolve by name, don't hardcode). Micro (`ENDO-LAL`/`STER-PCR`) is excluded by group.
- Parent AR carries `Analyte{N}Peptide` (N=1..4), values are identity-service titles e.g. `"GHK-Cu - Identity (HPLC)"`; `None` for unused slots.
- `lims_analyses` dedup: partial unique index on `(lims_sub_sample_pk, keyword)`.
- SENAITE access: `backend/sub_samples/senaite.py` `_get(url)` (returns `requests.Response`, auth baked in), `SENAITE_BASE_URL`. Catalog query for keywords: `GET {BASE}/@@API/senaite/v1/search?getRequestID=<sid>&catalog=senaite_catalog_analysis&complete=true` → items with `getKeyword`. AR detail (carries `Analyte{N}Peptide`): `GET {BASE}/@@API/senaite/v1/search?getId=<sid>&catalog=senaite_catalog_sample&complete=true` → items[0].
- `LimsSubSample.parent_sample_pk` → `LimsSample.id`; `LimsSample.sample_id` is the parent SENAITE id.
- Existing seeder tests: `backend/tests/test_lims_analyses_seeder.py` (fixtures `db` = live session, `sub_sample` = first existing vial). Bridge tests: `backend/tests/test_prep_bridge.py` (`db_session` = in-memory SQLite).
- Run pytest in container: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q"`.

---

## Task 1: SENAITE reads — parent analysis keywords + analyte slots

**Files:**
- Modify: `backend/sub_samples/senaite.py` (add two functions near `fetch_parent_metadata`, ~237)
- Test: `backend/tests/test_parent_analysis_reads.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_parent_analysis_reads.py`:

```python
"""Unit tests for the parent-analysis SENAITE reads (response parsing only;
the HTTP layer is monkeypatched)."""
import sub_samples.senaite as sn


class _Resp:
    def __init__(self, payload, status=200):
        self._p = payload
        self.status_code = status
    def json(self):
        return self._p
    def raise_for_status(self):
        if self.status_code >= 300:
            raise RuntimeError(f"status {self.status_code}")


def test_fetch_parent_analysis_keywords_parses_getKeyword(monkeypatch):
    payload = {"items": [
        {"getKeyword": "ANALYTE-1-PUR"},
        {"getKeyword": "ID_GHKCU"},
        {"getKeyword": "HPLC-ID"},
        {"getKeyword": None},          # skipped
    ]}
    monkeypatch.setattr(sn, "_get", lambda url, **kw: _Resp(payload))
    kws = sn.fetch_parent_analysis_keywords("PB-0076")
    assert kws == ["ANALYTE-1-PUR", "ID_GHKCU", "HPLC-ID"]


def test_fetch_parent_analysis_keywords_raises_on_http_error(monkeypatch):
    monkeypatch.setattr(sn, "_get", lambda url, **kw: _Resp({}, status=502))
    try:
        sn.fetch_parent_analysis_keywords("PB-0076")
        assert False, "expected raise"
    except Exception:
        pass


def test_fetch_parent_analyte_slots_parses_AnalyteNPeptide(monkeypatch):
    payload = {"items": [{
        "Analyte1Peptide": "GHK-Cu - Identity (HPLC)",
        "Analyte2Peptide": {"title": "BPC-157 - Identity (HPLC)"},  # dict shape
        "Analyte3Peptide": None,
        "Analyte4Peptide": "",
    }]}
    monkeypatch.setattr(sn, "_get", lambda url, **kw: _Resp(payload))
    slots = sn.fetch_parent_analyte_slots("PB-0076")
    assert slots == {1: "GHK-Cu - Identity (HPLC)", 2: "BPC-157 - Identity (HPLC)"}
```

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_parent_analysis_reads.py -q"`
Expected: FAIL — `AttributeError: module 'sub_samples.senaite' has no attribute 'fetch_parent_analysis_keywords'`.

- [ ] **Step 3: Implement the two reads**

In `backend/sub_samples/senaite.py`, add (after `fetch_parent_metadata`):

```python
def fetch_parent_analysis_keywords(parent_sample_id: str) -> list[str]:
    """Return the parent AR's analysis keywords (e.g. ANALYTE-1-PUR, ID_GHKCU,
    HPLC-ID). Raises on SENAITE HTTP error — callers that must fail-hard rely
    on this propagating."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/search"
    resp = _get(url, params={
        "getRequestID": parent_sample_id,
        "catalog": "senaite_catalog_analysis",
        "complete": "true",
    })
    resp.raise_for_status()
    out: list[str] = []
    for item in resp.json().get("items", []):
        kw = item.get("getKeyword")
        if kw:
            out.append(kw)
    return out


def _coerce_label(v) -> Optional[str]:
    """SENAITE reference fields come back as str or {title/uid} dict."""
    if isinstance(v, dict):
        return v.get("title") or v.get("uid")
    return v or None


def fetch_parent_analyte_slots(parent_sample_id: str) -> dict[int, str]:
    """Return {slot: AnalyteNPeptide title} for slots 1-4 that are populated.
    Values are identity-service titles, e.g. 'GHK-Cu - Identity (HPLC)'.
    Raises on SENAITE HTTP error."""
    url = f"{SENAITE_BASE_URL}/@@API/senaite/v1/search"
    resp = _get(url, params={
        "getId": parent_sample_id,
        "catalog": "senaite_catalog_sample",
        "complete": "true",
    })
    resp.raise_for_status()
    items = resp.json().get("items", [])
    if not items:
        return {}
    ar = items[0]
    out: dict[int, str] = {}
    for n in range(1, 5):
        label = _coerce_label(ar.get(f"Analyte{n}Peptide"))
        if label:
            out[n] = label
    return out
```

Confirm `Optional` is imported in this module (it is — used by `uid_exists`). If not, add `from typing import Optional`.

- [ ] **Step 4: Run, verify pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_parent_analysis_reads.py -q"`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/sub_samples/senaite.py backend/tests/test_parent_analysis_reads.py
git commit -m "feat(senaite): read parent analysis keywords + analyte-slot map"
```
(End every commit with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.)

---

## Task 2: Seeder mirrors the parent's Analytics analyses

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (add `mirror_parent_hplc_analyses`, rework HPLC branch of `seed_analyses_for_vial`, add `parent_sample_id` param, retire `_seed_peptide_identity_services` + the `"hplc"` entry of `ROLE_TO_KEYWORDS`)
- Modify call sites: `backend/sub_samples/service.py` (`set_assignment_role`, `_seed_analyses_if_role`) — pass `parent_sample_id`
- Test: `backend/tests/test_seeder_mirror.py` (new)

- [ ] **Step 1: Write the failing test (live DB + monkeypatched SENAITE read)**

Create `backend/tests/test_seeder_mirror.py`:

```python
"""Mirror seeding against the live catalog; SENAITE keyword read is monkeypatched.
Skips if no sub-sample is seeded (mirrors test_lims_analyses_seeder.py)."""
import pytest
from sqlalchemy import select

import lims_analyses.seeder as seeder
from lims_analyses.seeder import seed_analyses_for_vial
from models import LimsAnalysis, LimsSubSample
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no lims_sub_samples row available")
    return sub


def test_mirror_seeds_only_analytics_keywords(db, sub_sample, monkeypatch):
    # Parent (per SENAITE) carries a blend HPLC set + Micro rows. Mirror must
    # keep Analytics-group keywords and drop ENDO-LAL/STER-PCR.
    parent_keywords = [
        "ANALYTE-1-PUR", "ANALYTE-2-PUR", "ANALYTE-1-QTY", "BLEND-PUR",
        "ID_GHKCU", "ID_BPC157", "HPLC-ID", "PEPT-Total",
        "ENDO-LAL", "STER-PCR",          # Micro — must be excluded
    ]
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: parent_keywords,
    )
    inserted = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id="PARENT-X",
    )
    kws = {r.keyword for r in inserted}
    # Every Analytics keyword that exists in the catalog is mirrored; Micro excluded.
    assert "ENDO-LAL" not in kws and "STER-PCR" not in kws
    assert {"ANALYTE-1-PUR", "BLEND-PUR", "ID_GHKCU", "HPLC-ID"} <= kws
    # Rows actually exist on the vial.
    on_vial = set(db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id)
    ).scalars().all())
    assert {"ANALYTE-1-PUR", "ID_GHKCU"} <= on_vial


def test_mirror_is_idempotent(db, sub_sample, monkeypatch):
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["ANALYTE-1-PUR", "HPLC-ID"],
    )
    first = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="P",
    )
    second = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="P",
    )
    assert len(second) == 0 and len(first) >= 1


def test_mirror_propagates_senaite_failure(db, sub_sample, monkeypatch):
    def _boom(pid):
        raise RuntimeError("SENAITE down")
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords", _boom)
    with pytest.raises(RuntimeError):
        seed_analyses_for_vial(
            db, sub_sample=sub_sample, role="hplc",
            wp_services={"hplcpurity_identity": True}, parent_sample_id="P",
        )
```

(The vial may already carry some of these keywords from prior runs; the assertions use subset checks and idempotency so they hold regardless. If `test_mirror_is_idempotent`'s `first` is empty because the vial already has those rows, pick a keyword guaranteed novel — or clear the two rows at test start with a direct delete. Keep assertions about behavior, not exact counts.)

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_seeder_mirror.py -q"`
Expected: FAIL — `TypeError: seed_analyses_for_vial() got an unexpected keyword argument 'parent_sample_id'`.

- [ ] **Step 3: Implement the mirror + rework the HPLC branch**

In `backend/lims_analyses/seeder.py`:

(a) Add an Analytics-group resolver and the mirror function:

```python
from models import AnalysisService, LimsAnalysis, LimsSubSample, ServiceGroup, service_group_members


def _analytics_group_id(db: Session) -> Optional[int]:
    """Resolve the Analytics service group id by name (don't hardcode)."""
    return db.execute(
        select(ServiceGroup.id).where(ServiceGroup.name == "Analytics")
    ).scalar_one_or_none()


def mirror_parent_hplc_analyses(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    parent_sample_id: str,
    existing_kw: set,
    created_by_user_id: Optional[int],
) -> List[LimsAnalysis]:
    """Mirror the parent's Analytics-group analyses 1:1 onto the HPLC vial.

    Reads the parent's SENAITE analysis keywords, keeps those whose Mk1
    analysis_service is in the Analytics group, and creates a lims_analyses row
    per keyword not already present. Raises on SENAITE read failure (fail-hard).
    """
    from sub_samples.senaite import fetch_parent_analysis_keywords

    group_id = _analytics_group_id(db)
    if group_id is None:
        log.warning("seeder.mirror.no_analytics_group sub=%s", sub_sample.sample_id)
        return []

    # Analytics-group services indexed by keyword.
    svc_rows = db.execute(
        select(AnalysisService)
        .join(service_group_members,
              service_group_members.c.analysis_service_id == AnalysisService.id)
        .where(service_group_members.c.service_group_id == group_id)
    ).scalars().all()
    svc_by_kw = {s.keyword: s for s in svc_rows}

    parent_keywords = fetch_parent_analysis_keywords(parent_sample_id)  # raises -> fail-hard

    inserted: List[LimsAnalysis] = []
    for kw in parent_keywords:
        svc = svc_by_kw.get(kw)
        if svc is None:          # not an Analytics service (e.g. ENDO-LAL/STER-PCR)
            continue
        if svc.keyword in existing_kw:
            continue
        row = la_service.create_analysis(
            db,
            host_kind="sub_sample",
            host_pk=sub_sample.id,
            analysis_service_id=svc.id,
            keyword=svc.keyword,
            title=svc.title or svc.keyword,
            created_by_user_id=created_by_user_id,
        )
        inserted.append(row)
        existing_kw.add(svc.keyword)
        log.info("seeder.mirror.seeded sub=%s keyword=%s", sub_sample.sample_id, svc.keyword)
    return inserted
```

(b) Change `seed_analyses_for_vial`'s signature to accept `parent_sample_id: Optional[str] = None` and rework the HPLC branch. Replace the body from the `services = select_services_for_role(...)` section so that for `role == "hplc"` it mirrors, and for endo/ster it keeps the whitelist:

```python
def seed_analyses_for_vial(
    db: Session,
    *,
    sub_sample: LimsSubSample,
    role: str,
    wp_services: Dict[str, bool],
    parent_sample_id: Optional[str] = None,
    created_by_user_id: Optional[int] = None,
) -> List[LimsAnalysis]:
    if not role_implies_seeding(role, wp_services):
        log.info("seeder.skip_no_seeding sub=%s role=%s", sub_sample.sample_id, role)
        return []

    existing = db.execute(
        select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == sub_sample.id)
    ).scalars().all()
    existing_kw = set(existing)

    if role == "hplc":
        if not parent_sample_id:
            raise ValueError("seed_analyses_for_vial(role='hplc') requires parent_sample_id")
        return mirror_parent_hplc_analyses(
            db,
            sub_sample=sub_sample,
            parent_sample_id=parent_sample_id,
            existing_kw=existing_kw,
            created_by_user_id=created_by_user_id,
        )

    # endo / ster: fixed single-keyword whitelist (unchanged)
    services = select_services_for_role(db, role)
    if not services:
        log.warning("seeder.no_matching_services sub=%s role=%s", sub_sample.sample_id, role)
        return []
    inserted: List[LimsAnalysis] = []
    for svc in services:
        if svc.keyword in existing_kw:
            continue
        row = la_service.create_analysis(
            db, host_kind="sub_sample", host_pk=sub_sample.id,
            analysis_service_id=svc.id, keyword=svc.keyword,
            title=svc.title or svc.keyword, created_by_user_id=created_by_user_id,
        )
        inserted.append(row)
        existing_kw.add(svc.keyword)
    return inserted
```

(c) Delete `_seed_peptide_identity_services` and `select_identity_service_by_title` (now unused) and the `"hplc"` entry from `ROLE_TO_KEYWORDS` (leave `endo`/`ster`/`xtra`). Update the module docstring's "GENERIC services" paragraph to describe the mirror.

- [ ] **Step 4: Thread `parent_sample_id` from the callers**

In `backend/sub_samples/service.py`:
- `_seed_analyses_if_role` (~310): it already computes `parent_sample_id` from the call? It receives `parent_sample_id` as a param — pass it: `seed_analyses_for_vial(db, sub_sample=sub, role=sub.assignment_role, wp_services=wp_services, parent_sample_id=parent_sample_id, created_by_user_id=user_id)`.
- `set_assignment_role` (~318): it computes `parent_sid` — pass `parent_sample_id=parent_sid` into `seed_analyses_for_vial`. (Transaction restructure is Task 3; for now just add the kwarg.)

- [ ] **Step 5: Run mirror + existing seeder tests**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_seeder_mirror.py -q"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_seeder.py tests/test_seed_peptide_identity.py -q"
```
Expected: mirror tests pass. The OLD tests `test_seed_for_hplc_creates_lims_analyses_rows` (asserts generic HPLC-PUR/HPLC-ID) and the whole `test_seed_peptide_identity.py` assert the RETIRED behavior — they are now stale. Per the project's "failing test defaults to stale, not code wrong" rule: update those HPLC-branch assertions to the new mirror behavior (or mark the peptide-identity-seeding ones obsolete with a clear skip+reason). Do NOT weaken; rewrite them to assert the mirror. The endo/ster/xtra/`role_implies_seeding` tests must stay green unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/lims_analyses/seeder.py backend/sub_samples/service.py backend/tests/test_seeder_mirror.py backend/tests/test_lims_analyses_seeder.py backend/tests/test_seed_peptide_identity.py
git commit -m "feat(seeder): HPLC vial mirrors parent Analytics analyses (retire generic whitelist)"
```

---

## Task 3: Fail-hard atomic role assignment

**Files:**
- Modify: `backend/sub_samples/service.py` (`set_assignment_role` sub-sample branch, `_seed_analyses_if_role`)
- Modify: `backend/sub_samples/routes.py` (~235-264 — surface SENAITE failure as 502/503)
- Test: `backend/tests/test_assign_role_fail_hard.py` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_assign_role_fail_hard.py`:

```python
"""Role assignment is atomic with seeding: a seeding failure rolls back the
role flip and propagates."""
import pytest
from sqlalchemy import select

import sub_samples.service as svc
from models import LimsSubSample
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_failed_mirror_rolls_back_role(db, monkeypatch):
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no sub-sample available")
    original = sub.assignment_role
    # Force the mirror's SENAITE read to fail.
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: (_ for _ in ()).throw(RuntimeError("SENAITE down")),
    )
    with pytest.raises(Exception):
        svc.set_assignment_role(db, sub.sample_id, "hplc", user_id=1)
    # Re-read from a fresh session: role must be unchanged (rolled back).
    db2 = SessionLocal()
    try:
        again = db2.execute(
            select(LimsSubSample).where(LimsSubSample.id == sub.id)
        ).scalar_one()
        assert again.assignment_role == original
    finally:
        db2.close()
```

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assign_role_fail_hard.py -q"`
Expected: FAIL — today's code commits the role flip before seeding and swallows the error, so the role IS changed (assert fails) and no exception propagates.

- [ ] **Step 3: Make role-flip + seeding atomic**

In `backend/sub_samples/service.py` `set_assignment_role`, sub-sample branch — replace the "commit then best-effort seed" block so the commit happens AFTER seeding, with no swallow:

```python
    if sub is not None:
        old_role = sub.assignment_role
        sub.assignment_role = role
        db.add(LimsSubSampleEvent(
            sub_sample_pk=sub.id,
            event="role_assigned",
            details={"from": old_role, "to": role},
            user_id=user_id,
        ))
        # Seed BEFORE commit so role-flip + event + analyses are atomic.
        # Fail-hard: a seeding/SENAITE failure rolls the whole thing back.
        if role and role != "xtra":
            parent_row = db.get(LimsSample, sub.parent_sample_pk)
            parent_sid = parent_row.sample_id if parent_row else None
            if parent_sid:
                wp_services = _fetch_wp_services_for_parent(parent_sid) or {}
                from lims_analyses.seeder import seed_analyses_for_vial
                seed_analyses_for_vial(
                    db,
                    sub_sample=sub,
                    role=role,
                    wp_services=wp_services,
                    parent_sample_id=parent_sid,
                    created_by_user_id=user_id,
                )
        db.commit()
        return {"sample_id": sample_id, "assignment_role": role}
```

(Remove the old `db.commit()` that preceded the try/except and the `try/except` swallow entirely. On any exception the request handler's session teardown rolls back; the exception propagates.)

Apply the same atomic shape to `_seed_analyses_if_role` (the create path): seed before the vial-creating commit, or if the vial is already committed, let a seeding failure propagate (drop the try/except swallow). Keep it consistent — fail-hard, no swallow.

- [ ] **Step 4: Surface the failure in the route**

In `backend/sub_samples/routes.py`, the role-assign handler (~264 `return service.set_assignment_role(...)`) — wrap so SENAITE/network failures become a 502/503 and other errors a 500, instead of an opaque 500 stacktrace:

```python
    import requests as _rq
    try:
        return service.set_assignment_role(db, sample_id, body.role, user_id=user.id)
    except _rq.RequestException as e:
        raise HTTPException(status_code=502, detail=f"SENAITE unavailable while seeding analyses: {e}")
```

(Confirm `HTTPException` is imported in this module. The mirror raises `requests` exceptions on SENAITE HTTP errors via `raise_for_status`; non-network seeding errors fall through as 500.)

- [ ] **Step 5: Run the test + the seeder suite**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_assign_role_fail_hard.py tests/test_seeder_mirror.py -q"
```
Expected: pass. Confirm `python -c 'import main'` is clean.

- [ ] **Step 6: Commit**

```bash
git add backend/sub_samples/service.py backend/sub_samples/routes.py backend/tests/test_assign_role_fail_hard.py
git commit -m "feat(assign): fail-hard atomic role assignment + analyses seeding"
```

---

## Task 4: Prep bridge routes to per-analyte rows

**Files:**
- Modify: `backend/lims_analyses/prep_bridge.py` (`_category`, `_pick_target`, add `_resolve_slot`, thread slot + parent through `bridge_prep_result_to_vial`)
- Test: extend `backend/tests/test_prep_bridge.py`

- [ ] **Step 1: Write the failing tests (extend `test_prep_bridge.py`)**

Add to `backend/tests/test_prep_bridge.py` (helpers `_peptide`, `_vial`, `_hplc`, `create_analysis` already exist there):

```python
def test_routes_purity_quantity_to_analyte_slot(db_session, monkeypatch):
    db = db_session
    pep = _peptide(db, name="BPC-157", abbr="BPC-157")
    vial = _vial(db)
    a1p = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=85, keyword="ANALYTE-1-PUR", title="Analyte 1 (Purity)")
    a2p = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=86, keyword="ANALYTE-2-PUR", title="Analyte 2 (Purity)")
    a2q = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=87, keyword="ANALYTE-2-QTY", title="Analyte 2 (Quantity)")
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    # Parent slot map: BPC-157 is Analyte 2.
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots",
                        lambda pid: {1: "GHK-Cu - Identity (HPLC)", 2: "BPC-157 - Identity (HPLC)"})
    from lims_analyses.prep_bridge import bridge_prep_result_to_vial
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert set(ids) == {a2p.id, a2q.id, idr.id}        # slot-2 purity+qty, specific identity
    db.refresh(a1p); db.refresh(a2p); db.refresh(a2q)
    assert a1p.review_state == "unassigned"            # other slot untouched
    assert a2p.result_value == "98.5" and a2p.review_state == "to_be_verified"
    assert a2q.result_value == "4.2"


def test_legacy_generic_purity_still_routed(db_session, monkeypatch):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    a = _hplc(db, pep, purity=99.0)
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})
    from lims_analyses.prep_bridge import bridge_prep_result_to_vial
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert ids == [pur.id]


def test_analyte_purity_skipped_when_slot_unresolved(db_session, monkeypatch):
    db = db_session
    pep = _peptide(db, name="BPC-157", abbr="BPC-157")
    vial = _vial(db)
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=85, keyword="ANALYTE-1-PUR", title="Analyte 1 (Purity)")
    a = _hplc(db, pep, purity=98.5)
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})  # no slot
    from lims_analyses.prep_bridge import bridge_prep_result_to_vial
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert ids == []
```

The existing `_vial` helper sets `parent_sample_pk=1`; ensure a parent `LimsSample` row exists for the bridge's parent lookup — add to `_vial` (or a new helper) a `LimsSample(id matches, sample_id="P-TEST")`. Read the current `_vial`/`_peptide`/`_hplc` helpers and the existing parent handling; adjust minimally so `db.get(LimsSample, sub.parent_sample_pk)` resolves. Keep existing tests passing.

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py -q"`
Expected: the 3 new tests FAIL (ANALYTE-* not categorized; slot routing absent). Existing 9 still pass.

- [ ] **Step 3: Implement per-analyte routing**

In `backend/lims_analyses/prep_bridge.py`:

(a) Add `LimsSample`, `LimsSubSample` imports and a slot regex. Update `_category`:

```python
import re
from models import HPLCAnalysis, LimsAnalysis, LimsSample, LimsSubSample, Peptide

_ANALYTE_PUR = re.compile(r"^ANALYTE-[1-4]-PUR$")
_ANALYTE_QTY = re.compile(r"^ANALYTE-[1-4]-QTY$")


def _category(keyword: Optional[str]) -> Optional[str]:
    kw = (keyword or "").upper()
    if kw == "HPLC-PUR" or _ANALYTE_PUR.match(kw):
        return "purity"
    if kw == "HPLC-ID" or kw.startswith("ID_"):
        return "identity"
    if kw.startswith("QTY_") or _ANALYTE_QTY.match(kw):
        return "quantity"
    return None
```

(b) Add the slot resolver:

```python
def _resolve_slot(db: Session, *, parent_sample_id: Optional[str], peptide: Optional[Peptide]) -> Optional[int]:
    """Return the parent's analyte slot (1-4) for `peptide`, else None."""
    if not parent_sample_id or not peptide:
        return None
    from sub_samples.senaite import fetch_parent_analyte_slots
    slots = fetch_parent_analyte_slots(parent_sample_id)
    want = _norm(peptide.abbreviation or peptide.name)
    for n, title in slots.items():
        name = re.sub(r"\s*-\s*identity\s*\(hplc\)\s*$", "", title or "", flags=re.I)
        if _norm(name) == want:
            return n
    return None
```

(c) Replace `_pick_target` to take the slot, and route purity/quantity per-analyte with legacy fallback:

```python
def _pick_target(category: str, candidates: list[LimsAnalysis], *, slot: Optional[int]) -> Optional[LimsAnalysis]:
    if category == "identity":
        specific = [r for r in candidates if (r.keyword or "").upper().startswith("ID_")]
        generic = [r for r in candidates if (r.keyword or "").upper() == "HPLC-ID"]
        if len(specific) == 1:
            return specific[0]
        if not specific and len(generic) == 1:
            return generic[0]
        return None
    # purity / quantity
    suffix = "PUR" if category == "purity" else "QTY"
    analyte = [r for r in candidates if re.match(r"^ANALYTE-[1-4]-" + suffix + "$", (r.keyword or "").upper())]
    generic = [r for r in candidates
               if (r.keyword or "").upper() == "HPLC-PUR"
               or (r.keyword or "").upper().startswith("QTY_")]
    if analyte:
        if slot is None:
            return None
        want = f"ANALYTE-{slot}-{suffix}"
        match = [r for r in analyte if (r.keyword or "").upper() == want]
        return match[0] if len(match) == 1 else None
    return generic[0] if len(generic) == 1 else None
```

(d) In `bridge_prep_result_to_vial`, resolve the parent + slot before the per-category loop, and pass `slot` to `_pick_target`:

```python
    sub = db.get(LimsSubSample, lims_sub_sample_pk)
    parent = db.get(LimsSample, sub.parent_sample_pk) if sub else None
    parent_sample_id = parent.sample_id if parent else None
    slot = _resolve_slot(db, parent_sample_id=parent_sample_id, peptide=peptide)
    ...
    for category, candidates in by_category.items():
        row = _pick_target(category, candidates, slot=slot)
        ...
```

(Leave the rest — `_result_for`, `_norm`, the peptide guard on `ID_*`, the `instrument_id` set + `apply_transition` — unchanged.)

- [ ] **Step 4: Run the full bridge suite**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py -q"`
Expected: all pass (12 = original 9 + 3 new). If an original test broke because `_pick_target` now needs `slot`, pass `slot=None` at those call sites — but the only call site is inside `bridge_prep_result_to_vial`, so they should pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge.py
git commit -m "feat(prep): bridge routes results to per-analyte ANALYTE-N rows by slot"
```

---

## Task 5: Live end-to-end verification

**No code.** Stack: FE :5532, API :5530, Postgres `accumark_mk1`; login `forrest@valenceanalytical.com / test123`; browser tab 0 sessionStorage overrides `accu_mk1_api_url_override='http://localhost:5530'` + `accu_mk1_wp_url_override='http://localhost:5535'`.

- [ ] **Step 1: Apply nothing / confirm imports**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main' && python -m pytest tests/test_prep_bridge.py tests/test_seeder_mirror.py tests/test_assign_role_fail_hard.py tests/test_parent_analysis_reads.py -q"`
Expected: clean import + all green.

- [ ] **Step 2: Mirror — assign a blend vial to HPLC**

Pick a sub-sample of a blend parent (e.g. a `PB-0076` vial; create one via the Receive wizard if needed). Assign it to HPLC (Vials Quick Look / role control). Then:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, review_state FROM lims_analyses WHERE lims_sub_sample_pk = <PK> ORDER BY keyword;"
```
Expected: the vial carries the parent's Analytics rows — `ANALYTE-1..N-PUR`, `ANALYTE-1..N-QTY`, `PEPT-Total`, `BLEND-PUR`, every `ID_<analyte>`, `HPLC-ID` — and NOT `ENDO-LAL`/`STER-PCR`, NOT generic `HPLC-PUR`. Cross-check against the parent's analyses table in the UI.

- [ ] **Step 3: Bridge — run a vial prep for one analyte**

Create a vial-scoped prep for one analyte (e.g. BPC-157) on that vial, record the HPLC result (`/hplc/analyze`). Then:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, result_value, review_state FROM lims_analyses WHERE lims_sub_sample_pk = <PK> AND review_state='to_be_verified' ORDER BY keyword;"
```
Expected: the prep's result landed on `ANALYTE-{slot}-PUR` + `ANALYTE-{slot}-QTY` (the slot matching that analyte) + `ID_<analyte>`, all `to_be_verified`; other analytes' rows untouched.

- [ ] **Step 4: Fail-hard smoke (optional)**

Temporarily point SENAITE creds wrong or assign a vial whose parent isn't in SENAITE → the assign call returns 502 and the vial's role is unchanged (no partial rows). Revert.

---

## Self-review notes

- **Spec coverage:** mirror (T1 reads, T2 seeder) ✓; Analytics-group filter (T2 `_analytics_group_id` + join) ✓; fail-hard atomic (T3) ✓; HPLC-only (endo/ster branch untouched in T2) ✓; idempotent (existing_kw + DB unique index) ✓; bridge per-analyte purity/quantity + slot resolver + legacy fallback (T4) ✓; identity unchanged (T4 keeps `_pick_target` identity branch) ✓; blend-level rows not bridged (no ANALYTE/HPLC-PUR match for BLEND-PUR/PEPT-Total — `_category` returns None for them) ✓; testing unit + live (T1-T5) ✓.
- **Type consistency:** `seed_analyses_for_vial(..., parent_sample_id=...)` keyword used identically in T2 + T3 callers. `mirror_parent_hplc_analyses(..., existing_kw=...)`, `_pick_target(category, candidates, *, slot=...)`, `_resolve_slot(db, *, parent_sample_id, peptide)`, `fetch_parent_analysis_keywords(pid) -> list[str]`, `fetch_parent_analyte_slots(pid) -> dict[int,str]` consistent across tasks.
- **Adaptation points (flagged inline, not placeholders):** exact `_vial`/`_peptide`/`_hplc` helper tweak for the parent `LimsSample` row (T4 Step 1); which old HPLC-branch assertions in `test_lims_analyses_seeder.py` / `test_seed_peptide_identity.py` to rewrite vs skip (T2 Step 5); confirming `Optional`/`HTTPException` imports (T1/T3). Each names the grep/read to do.
- **Known interaction:** `BLEND-PUR`/`PEPT-Total`/`BLEND-IDENT` are seeded (mirror) but not bridge-filled — intended (manual/computed).
