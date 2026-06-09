# Substance-Correct Analyte Services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a blend vial is assigned to HPLC, seed per-substance purity/quantity services (`PUR_<X>`/`QTY_<X>`, e.g. "GHK-Cu — Purity") instead of generic `ANALYTE-N`, and route prep results to them by peptide.

**Architecture:** (1) An idempotent migration creates `PUR_<X>`/`QTY_<X>` services for every identity peptide, derived from the existing `ID_<X>` services (authoritative suffix + `peptide_id`), grouped into Analytics. (2) The mirror translates the parent's generic `ANALYTE-{n}-PUR/QTY` keywords into the slot peptide's per-substance service (slot→substance from the parent's `Analyte{N}Peptide`; exact ID-service-title→`peptide_id` join). (3) The prep bridge matches the prep's peptide directly to its `PUR_<X>`/`QTY_<X>` row, keeping `ANALYTE-{slot}` + generic `HPLC-PUR` as legacy fallbacks.

**Tech Stack:** FastAPI + SQLAlchemy, raw SQL idempotent migrations in `backend/database.py` `_run_migrations`, pytest (seeder/migration tests against live `accumark_mk1` Postgres; bridge tests in-memory SQLite).

**Grounded facts (don't re-derive):**
- `ID_<X>` services exist for every analyte peptide, with `peptide_id` set and title `"{Name} - Identity (HPLC)"` (e.g. `ID_GHKCU`/peptide 26/"GHK-Cu - Identity (HPLC)"; `ID_TB500BETA4`/peptide 63/"TB500 (Thymosin Beta 4) - Identity (HPLC)"). They are in the **Analytics** group.
- The parent's `fetch_parent_analyte_slots(pid) -> {n: "{Name} - Identity (HPLC)"}` returns titles that **exactly equal** the corresponding `ID_<X>` service titles. So slot title → `ID_<X>` service (exact title match) → `peptide_id`.
- `PUR_BPC157`/`QTY_BPC157` already exist (peptide 10, titles "BPC-157 - Purity"/"- Quantity") — the migration must be a no-op for them.
- `analysis_services.keyword` is **not unique** (no `ON CONFLICT (keyword)`); use `WHERE NOT EXISTS`. `service_group_members` has `uq_service_group_member(service_group_id, analysis_service_id)` → `ON CONFLICT DO NOTHING` works there.
- `analysis_services` NOT NULL cols: `title`; `active` defaults True (Python-side — set explicitly in raw SQL); `created_at`/`updated_at` (set `NOW()` in raw SQL). `keyword`, `category`, `unit`, `peptide_id` nullable.
- `create_analysis(db, *, host_kind, host_pk, analysis_service_id, keyword, title, ..., commit=True)` — no `peptide_id` param (don't add one; the bridge resolves per-substance by catalog lookup, not by row `peptide_id`).
- Mirror is `backend/lims_analyses/seeder.py` `mirror_parent_hplc_analyses`; it already builds `svc_by_kw` over the whole catalog, excludes Microbiology, and honors `existing_kw` + `commit`. SENAITE reads via `from sub_samples import senaite as senaite_mod` (so monkeypatch works).
- Bridge is `backend/lims_analyses/prep_bridge.py`; `_category`, `_pick_target(category, candidates, *, slot)`, lazy slot gate in `bridge_prep_result_to_vial`.
- Run pytest in container: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q"`. Apply a migration to the sandbox: `... python -c 'from database import _run_migrations; _run_migrations()'`.

---

## Task 1: Migration — create `PUR_<X>`/`QTY_<X>` services for every identity peptide

**Files:**
- Modify: `backend/database.py` (append to the `migrations` list in `_run_migrations`)
- Test: `backend/tests/test_per_substance_services_migration.py` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_per_substance_services_migration.py`:

```python
"""The per-substance PUR_/QTY_ services exist for every identity peptide,
share the identity service's peptide_id, and are in the Analytics group.
Runs against the live accumark_mk1 catalog."""
from sqlalchemy import select, text
from database import SessionLocal, _run_migrations


def _missing(db):
    # identity peptides lacking a PUR_ or QTY_ sibling (same peptide_id)
    return db.execute(text(
        """
        SELECT idsvc.keyword
        FROM analysis_services idsvc
        WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
          AND (NOT EXISTS (SELECT 1 FROM analysis_services p
                           WHERE p.peptide_id = idsvc.peptide_id AND left(p.keyword,4) = 'PUR_')
            OR NOT EXISTS (SELECT 1 FROM analysis_services q
                           WHERE q.peptide_id = idsvc.peptide_id AND left(q.keyword,4) = 'QTY_'))
        """
    )).scalars().all()


def test_migration_creates_per_substance_services_for_all_identity_peptides():
    _run_migrations()
    db = SessionLocal()
    try:
        assert _missing(db) == []
        # spot-check GHK-Cu (peptide 26) got PUR_GHKCU/QTY_GHKCU with its peptide_id
        rows = db.execute(text(
            "SELECT keyword, peptide_id, title FROM analysis_services "
            "WHERE keyword IN ('PUR_GHKCU','QTY_GHKCU') ORDER BY keyword"
        )).all()
        kws = {r[0] for r in rows}
        assert kws == {"PUR_GHKCU", "QTY_GHKCU"}
        assert all(r[1] == 26 for r in rows)
        # both are in the Analytics group
        grouped = db.execute(text(
            """
            SELECT s.keyword FROM analysis_services s
            JOIN service_group_members m ON m.analysis_service_id = s.id
            JOIN service_groups g ON g.id = m.service_group_id
            WHERE g.name = 'Analytics' AND s.keyword IN ('PUR_GHKCU','QTY_GHKCU')
            """
        )).scalars().all()
        assert set(grouped) == {"PUR_GHKCU", "QTY_GHKCU"}
    finally:
        db.close()


def test_migration_is_idempotent_no_duplicate_for_existing():
    _run_migrations()
    db = SessionLocal()
    try:
        # PUR_BPC157 pre-existed; must remain exactly one row
        n = db.execute(text(
            "SELECT count(*) FROM analysis_services WHERE keyword = 'PUR_BPC157'"
        )).scalar_one()
        assert n == 1
    finally:
        db.close()
```

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_per_substance_services_migration.py -q"`
Expected: FAIL — `_missing(db)` is non-empty (GHK-Cu/TB500/etc. have no `PUR_`/`QTY_`).

- [ ] **Step 3: Add the migration statements**

In `backend/database.py`, append to the END of the `migrations` list inside `_run_migrations` (after the PCR-into-Microbiology entry added previously). Read the surrounding list first to match formatting; statements are plain strings executed under the existing per-statement loop.

```python
        # Per-substance purity/quantity services. Derived from the per-peptide
        # identity services (ID_<X>) so the keyword suffix + peptide_id are
        # authoritative (the suffix is NOT derivable from the peptide name, e.g.
        # ID_TB500BETA4). The HPLC vial analyte mirror seeds these so a blend
        # vial's purity/quantity rows name the real substance instead of the
        # generic "Analyte N". Idempotent via NOT EXISTS (analysis_services.keyword
        # is not unique). No-op for the pre-existing PUR_BPC157/QTY_BPC157 and on
        # fresh installs with no identity services.
        """
        INSERT INTO analysis_services (title, keyword, category, unit, peptide_id, active, created_at, updated_at)
        SELECT p.name || ' - Purity', 'PUR_' || substring(idsvc.keyword from 4), 'HPLC', '%',
               idsvc.peptide_id, TRUE, NOW(), NOW()
        FROM analysis_services idsvc
        JOIN peptides p ON p.id = idsvc.peptide_id
        WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM analysis_services x
            WHERE x.keyword = 'PUR_' || substring(idsvc.keyword from 4))
        """,
        """
        INSERT INTO analysis_services (title, keyword, category, unit, peptide_id, active, created_at, updated_at)
        SELECT p.name || ' - Quantity', 'QTY_' || substring(idsvc.keyword from 4), 'HPLC', 'mg',
               idsvc.peptide_id, TRUE, NOW(), NOW()
        FROM analysis_services idsvc
        JOIN peptides p ON p.id = idsvc.peptide_id
        WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM analysis_services x
            WHERE x.keyword = 'QTY_' || substring(idsvc.keyword from 4))
        """,
        # Group all per-substance purity/quantity services into Analytics
        # (consistent with the ID_<X> identity services). Idempotent.
        """
        INSERT INTO service_group_members (service_group_id, analysis_service_id)
        SELECT g.id, s.id
        FROM service_groups g
        JOIN analysis_services s ON left(s.keyword, 4) IN ('PUR_', 'QTY_')
        WHERE g.name = 'Analytics'
        ON CONFLICT (service_group_id, analysis_service_id) DO NOTHING
        """,
```

- [ ] **Step 4: Apply to the sandbox + run the test**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'from database import _run_migrations; _run_migrations(); print(\"MIGRATED\")'"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_per_substance_services_migration.py -q"
```
Expected: `MIGRATED` then 2 passed. Run the migrate command a second time → still `MIGRATED`, test still green (idempotent).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/database.py backend/tests/test_per_substance_services_migration.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(catalog): per-substance PUR_/QTY_ services derived from ID_ services"
```
End with a real newline then: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## Task 2: Mirror translates `ANALYTE-{n}` → per-substance `PUR_<X>`/`QTY_<X>`

**Files:**
- Modify: `backend/lims_analyses/seeder.py` (`mirror_parent_hplc_analyses`)
- Modify: `backend/tests/test_seeder_mirror.py` (update the existing mirror test to the per-substance behavior; add an empty-slot test)

- [ ] **Step 1: Update/add the failing tests**

In `backend/tests/test_seeder_mirror.py`, the existing `test_mirror_seeds_analyte_rows_and_excludes_micro` asserts the generic `ANALYTE-1-PUR`/`ANALYTE-1-QTY` land — that's now stale (those translate to per-substance). REWRITE it to monkeypatch the slot map and assert per-substance keywords. Replace that test with the two below (keep the `_throwaway_vial` helper, the `db` fixture, and the other mirror tests as-is). These run against the live catalog (Task 1's `PUR_GHKCU`/`QTY_GHKCU` must exist — Task 1 applied the migration).

```python
def test_mirror_translates_analyte_to_per_substance(db, monkeypatch):
    vial = _throwaway_vial(db)
    parent_keywords = [
        "ANALYTE-1-PUR", "ANALYTE-1-QTY",          # slot 1 -> GHK-Cu
        "ANALYTE-4-PUR",                            # empty slot -> skipped
        "BLEND-PUR", "ID_GHKCU", "HPLC-ID", "PEPT-Total",
        "ENDO-LAL", "STER-PCR",                     # Micro -> excluded
    ]
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords", lambda pid: parent_keywords)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots",
        lambda pid: {1: "GHK-Cu - Identity (HPLC)"})   # only slot 1 populated
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    kws = {r.keyword for r in inserted}
    # per-substance purity/quantity for the mapped slot
    assert {"PUR_GHKCU", "QTY_GHKCU"} <= kws
    # generic ANALYTE-N NOT seeded; empty slot 4 skipped; Micro excluded
    assert not any(k.startswith("ANALYTE-") for k in kws)
    assert "ENDO-LAL" not in kws and "STER-PCR" not in kws
    # identity + blend + total mirrored unchanged
    assert {"ID_GHKCU", "BLEND-PUR", "HPLC-ID", "PEPT-Total"} <= kws


def test_mirror_skips_unmapped_analyte_slot(db, monkeypatch):
    vial = _throwaway_vial(db)
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: ["ANALYTE-2-PUR", "ANALYTE-2-QTY"])
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})  # no slots
    inserted = seed_analyses_for_vial(
        db, sub_sample=vial, role="hplc",
        wp_services={"hplcpurity_identity": True}, parent_sample_id="X", commit=False)
    assert inserted == []   # nothing maps -> nothing seeded
```

Also update `test_mirror_is_idempotent` and `test_mirror_propagates_senaite_failure` if they pass `ANALYTE-*` keywords: give them a `fetch_parent_analyte_slots` monkeypatch returning `{1: "GHK-Cu - Identity (HPLC)"}` (idempotent test) so they don't hit real SENAITE, and assert on `PUR_GHKCU`/`QTY_GHKCU` where they previously asserted `ANALYTE-1-*`. (Read those tests; if they use non-analyte keywords like `HPLC-ID` only, leave them.)

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_seeder_mirror.py -q"`
Expected: the new translation tests FAIL — today's mirror seeds `ANALYTE-1-PUR` verbatim (no translation), so `PUR_GHKCU` is absent and `ANALYTE-1-PUR` present.

- [ ] **Step 3: Implement the translation in `mirror_parent_hplc_analyses`**

In `backend/lims_analyses/seeder.py`, add a module-level regex near the top (after the existing imports / constants):

```python
import re  # confirm imported at module top; add if missing
_PARENT_ANALYTE = re.compile(r"^ANALYTE-([1-4])-(PUR|QTY)$")
```

Inside `mirror_parent_hplc_analyses`, after `svc_by_kw` and `micro_kw` are built and after `parent_keywords = senaite_mod.fetch_parent_analysis_keywords(...)`, add catalog indexes + a lazy slot-map fetch, then route each keyword. Replace the existing `for kw in parent_keywords:` loop body:

```python
    # Per-substance translation indexes (built once from the catalog already loaded).
    id_svc_by_title = {
        s.title: s for s in svc_rows
        if s.keyword and s.keyword.startswith("ID_") and s.title
    }
    pur_by_pep = {
        s.peptide_id: s for s in svc_rows
        if s.keyword and s.keyword.startswith("PUR_") and s.peptide_id
    }
    qty_by_pep = {
        s.peptide_id: s for s in svc_rows
        if s.keyword and s.keyword.startswith("QTY_") and s.peptide_id
    }

    # Slot->substance map: only read SENAITE when a generic ANALYTE-{n} keyword is
    # present (single-peptide HPLC vials carry HPLC-PUR/HPLC-ID, never ANALYTE-N).
    # fetch_parent_analyte_slots raises on error -> fail-hard (consistent).
    needs_slots = any(_PARENT_ANALYTE.match(kw) for kw in parent_keywords)
    slot_map = senaite_mod.fetch_parent_analyte_slots(parent_sample_id) if needs_slots else {}

    inserted: List[LimsAnalysis] = []
    for kw in parent_keywords:
        m = _PARENT_ANALYTE.match(kw)
        if m:
            slot_n, cat = int(m.group(1)), m.group(2)
            title = slot_map.get(slot_n)
            if not title:
                log.info(
                    "seeder.mirror.skip_empty_slot sub=%s slot=%s kw=%s",
                    sub_sample.sample_id, slot_n, kw,
                )
                continue
            id_svc = id_svc_by_title.get(title)
            per = None
            if id_svc is not None and id_svc.peptide_id is not None:
                per = (pur_by_pep if cat == "PUR" else qty_by_pep).get(id_svc.peptide_id)
            if per is not None:
                svc = per
            else:
                # Safety fallback: per-substance service missing — keep the generic
                # row so the analyte is never silently dropped.
                svc = svc_by_kw.get(kw)
                log.warning(
                    "seeder.mirror.no_per_substance sub=%s slot=%s title=%r kw=%s — fell back to generic",
                    sub_sample.sample_id, slot_n, title, kw,
                )
                if svc is None:
                    continue
        else:
            svc = svc_by_kw.get(kw)
            if svc is None:          # keyword not in the Mk1 catalog at all
                continue

        if svc.keyword in micro_kw:   # Microbiology analysis (ENDO-LAL/STER-PCR/KF)
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
            commit=commit,
        )
        inserted.append(row)
        existing_kw.add(svc.keyword)
        log.info(
            "seeder.mirror.seeded sub=%s analysis_id=%s keyword=%s",
            sub_sample.sample_id, row.id, svc.keyword,
        )
    return inserted
```

Update the function docstring's first paragraph to note that generic per-analyte `ANALYTE-{n}-PUR/QTY` are translated to the slot peptide's per-substance `PUR_<X>`/`QTY_<X>` (slot from `Analyte{N}Peptide`; empty slots skipped; safety-fallback to generic if a per-substance service is missing).

- [ ] **Step 4: Run mirror + migration tests**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_seeder_mirror.py tests/test_per_substance_services_migration.py tests/test_lims_analyses_seeder.py -q"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main'"
```
Expected: all green + clean import. (The throwaway-vial isolation + `commit=False` means no live-DB pollution.) Confirm no `ZZTEST%` rows persist:
`MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT count(*) FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST%';"` → 0.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/seeder.py backend/tests/test_seeder_mirror.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(seeder): mirror translates generic ANALYTE-N to per-substance PUR_/QTY_"
```
Co-Authored-By trailer.

---

## Task 3: Bridge matches the prep's peptide to its `PUR_<X>`/`QTY_<X>` row

**Files:**
- Modify: `backend/lims_analyses/prep_bridge.py`
- Modify: `backend/tests/test_prep_bridge.py` (add per-substance tests; keep the 14 existing tests green)

- [ ] **Step 1: Add the failing tests**

In `backend/tests/test_prep_bridge.py`, add `AnalysisService` to imports (`from models import AnalysisService, HPLCAnalysis, LimsAnalysis, LimsSample, LimsSubSample, Peptide`) and a helper that registers a per-substance catalog service, then add the tests. (The bridge resolves the per-substance keyword from the catalog, so the SQLite test DB must carry the `AnalysisService` rows.)

```python
def _svc(db, *, keyword, peptide, title):
    s = AnalysisService(keyword=keyword, peptide_id=peptide.id, title=title)
    db.add(s); db.flush()
    return s


def test_routes_to_per_substance_by_peptide(db_session):
    db = db_session
    pep = _peptide(db, name="BPC-157", abbr="BPC-157")
    other = _peptide(db, name="GHK-Cu", abbr="GHK-Cu")
    vial = _vial(db)  # parent lookup not needed: no ANALYTE-* rows, so no SENAITE
    _svc(db, keyword="PUR_BPC157", peptide=pep, title="BPC-157 - Purity")
    _svc(db, keyword="QTY_BPC157", peptide=pep, title="BPC-157 - Quantity")
    pur_b = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=200, keyword="PUR_BPC157", title="BPC-157 - Purity")
    qty_b = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=201, keyword="QTY_BPC157", title="BPC-157 - Quantity")
    pur_g = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=202, keyword="PUR_GHKCU", title="GHK-Cu - Purity")
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    a = _hplc(db, pep, purity=98.5, conforms=True, qty=4.2)
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert set(ids) == {pur_b.id, qty_b.id, idr.id}
    db.refresh(pur_b); db.refresh(qty_b); db.refresh(pur_g)
    assert pur_b.result_value == "98.5" and pur_b.review_state == "to_be_verified"
    assert qty_b.result_value == "4.2"
    assert pur_g.review_state == "unassigned"   # other analyte untouched


def test_per_substance_does_not_call_senaite(db_session, monkeypatch):
    # A per-substance vial (no ANALYTE-* rows) must never read SENAITE.
    db = db_session
    pep = _peptide(db, name="BPC-157", abbr="BPC-157")
    vial = _vial(db)
    _svc(db, keyword="PUR_BPC157", peptide=pep, title="BPC-157 - Purity")
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=200, keyword="PUR_BPC157", title="BPC-157 - Purity")
    a = _hplc(db, pep, purity=90.0)
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots",
                        lambda pid: (_ for _ in ()).throw(AssertionError("SENAITE must not be called")))
    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    assert len(ids) == 1
```

- [ ] **Step 2: Run, verify fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py -q"`
Expected: the new tests FAIL — `PUR_<X>` isn't categorized/matched yet, so the prep's purity/quantity don't land on `PUR_BPC157`/`QTY_BPC157`.

- [ ] **Step 3: Implement per-substance matching in `prep_bridge.py`**

(a) Add `AnalysisService` to the import and a resolver helper:

```python
from models import AnalysisService, HPLCAnalysis, LimsAnalysis, LimsSample, LimsSubSample, Peptide


def _peptide_service_keyword(db: Session, *, peptide: Optional[Peptide], prefix: str) -> Optional[str]:
    """The per-substance service keyword for `peptide` and prefix ('PUR_'/'QTY_'),
    e.g. PUR_BPC157, or None. Catalog lookup by peptide_id — no SENAITE."""
    if not peptide:
        return None
    return db.execute(
        select(AnalysisService.keyword).where(
            AnalysisService.peptide_id == peptide.id,
            AnalysisService.keyword.like(prefix + "%"),
        ).limit(1)
    ).scalar_one_or_none()
```

(b) Extend `_category` to classify `PUR_<X>` as purity (quantity already covers `QTY_`):

```python
    if kw == "HPLC-PUR" or kw.startswith("PUR_") or _ANALYTE_PUR.match(kw):
        return "purity"
```

(c) Change `_pick_target` to take the prep's per-substance keyword for the category and try it first:

```python
def _pick_target(category: str, candidates: list[LimsAnalysis], *, slot: Optional[int],
                 peptide_kw: Optional[str]) -> Optional[LimsAnalysis]:
    if category == "identity":
        specific = [r for r in candidates if (r.keyword or "").upper().startswith("ID_")]
        generic = [r for r in candidates if (r.keyword or "").upper() == "HPLC-ID"]
        if len(specific) == 1:
            return specific[0]
        if not specific and len(generic) == 1:
            return generic[0]
        return None
    # purity / quantity
    # 1. per-substance: the prep peptide's own PUR_<X>/QTY_<X> row (handles blends
    #    with multiple PUR_/QTY_ rows — the peptide selects which).
    if peptide_kw:
        ps = [r for r in candidates if (r.keyword or "").upper() == peptide_kw.upper()]
        if len(ps) == 1:
            return ps[0]
        if ps:
            return None
    # 2. legacy per-analyte ANALYTE-{slot}-*
    suffix = "PUR" if category == "purity" else "QTY"
    analyte = [r for r in candidates if re.match(r"^ANALYTE-[1-4]-" + suffix + "$", (r.keyword or "").upper())]
    if analyte:
        if slot is None:
            return None
        want = f"ANALYTE-{slot}-{suffix}"
        match = [r for r in analyte if (r.keyword or "").upper() == want]
        return match[0] if len(match) == 1 else None
    # 3. legacy generic
    if category == "purity":
        generic = [r for r in candidates if (r.keyword or "").upper() == "HPLC-PUR"]
    else:
        generic = [r for r in candidates if (r.keyword or "").upper().startswith("QTY_")]
    return generic[0] if len(generic) == 1 else None
```

(d) In `bridge_prep_result_to_vial`, resolve the two per-substance keywords once and thread them into `_pick_target`. After `pep_token = ...` (or wherever convenient before the loop) add:

```python
    pur_kw = _peptide_service_keyword(db, peptide=peptide, prefix="PUR_")
    qty_kw = _peptide_service_keyword(db, peptide=peptide, prefix="QTY_")
```

Then change the loop's `_pick_target` call:

```python
    for category, candidates in by_category.items():
        peptide_kw = pur_kw if category == "purity" else (qty_kw if category == "quantity" else None)
        row = _pick_target(category, candidates, slot=slot, peptide_kw=peptide_kw)
```

Leave the lazy `needs_slot`/`slot` resolution unchanged — it still only fires when a legacy `ANALYTE-*` candidate is present, so per-substance vials never touch SENAITE. Update the module/function docstring to note per-substance routing is primary, with ANALYTE-{slot} and generic as fallbacks.

- [ ] **Step 4: Run the full bridge suite**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py -q"`
Expected: all pass (14 existing + 2 new = 16). The existing tests have no `AnalysisService` rows in SQLite, so `pur_kw`/`qty_kw` resolve to None and the legacy `ANALYTE-{slot}`/generic paths run exactly as before.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(prep): bridge matches prep peptide to per-substance PUR_/QTY_ rows"
```
Co-Authored-By trailer.

---

## Task 4: Live end-to-end verification

**No code.** Stack: API :5530, Postgres `accumark_mk1`. PB-0071 is a 3-analyte blend (slots GHK-Cu/BPC-157/TB500; `ANALYTE-4` empty).

- [ ] **Step 1: Confirm imports + all feature suites green**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main'"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_per_substance_services_migration.py tests/test_seeder_mirror.py tests/test_prep_bridge.py tests/test_lims_analyses_seeder.py tests/test_assign_role_fail_hard.py tests/test_parent_analysis_reads.py -q"
```
Expected: clean import + all green.

- [ ] **Step 2: Mirror — assign PB-0071-S01 to HPLC**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c \"
from database import SessionLocal; import sub_samples.service as svc
db=SessionLocal()
try: print(svc.set_assignment_role(db,'PB-0071-S01','hplc',user_id=1))
finally: db.close()\""
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, review_state FROM lims_analyses la JOIN lims_sub_samples ss ON ss.id=la.lims_sub_sample_pk WHERE ss.sample_id='PB-0071-S01' ORDER BY keyword;"
```
Expected: `PUR_GHKCU, QTY_GHKCU, PUR_BPC157, QTY_BPC157, PUR_TB500BETA4, QTY_TB500BETA4, ID_GHKCU, ID_BPC157, ID_TB500BETA4, BLEND-PUR, PEPT-Total` (and `HPLC-ID` if the parent carries it). **No** `ANALYTE-*`, **no** generic `HPLC-PUR`, **no** Micro, **no** slot-4 row.

- [ ] **Step 3: Bridge — run a BPC-157 prep**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c \"
from database import SessionLocal; from sqlalchemy import select
from models import Peptide, HPLCAnalysis, LimsSubSample
from lims_analyses.prep_bridge import bridge_prep_result_to_vial
db=SessionLocal()
try:
    pep=db.execute(select(Peptide).where(Peptide.name=='BPC-157')).scalars().first()
    sub=db.execute(select(LimsSubSample).where(LimsSubSample.sample_id=='PB-0071-S01')).scalar_one()
    a=HPLCAnalysis(sample_id_label='PB-0071-S01', peptide_id=pep.id,
        stock_vial_empty=1.0,stock_vial_with_diluent=2.0,dil_vial_empty=1.0,
        dil_vial_with_diluent=2.0,dil_vial_with_diluent_and_sample=3.0,
        purity_percent=98.5, identity_conforms=True, quantity_mg=4.2)
    db.add(a); db.flush()
    print('BRIDGED', bridge_prep_result_to_vial(db, lims_sub_sample_pk=sub.id, analysis=a, peptide=pep, user_id=1))
    db.commit()
finally: db.close()\""
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT keyword, review_state, result_value FROM lims_analyses la JOIN lims_sub_samples ss ON ss.id=la.lims_sub_sample_pk WHERE ss.sample_id='PB-0071-S01' ORDER BY keyword;"
```
Expected: `PUR_BPC157`=98.5, `QTY_BPC157`=4.2, `ID_BPC157`="BPC-157" all `to_be_verified`; `PUR_GHKCU`/`QTY_GHKCU`/`PUR_TB500BETA4`/`QTY_TB500BETA4` and blend rows still `unassigned`.

- [ ] **Step 4: Clean up the live-test vial**

Reset PB-0071-S01 to baseline (role NULL, no rows) — delete its `lims_analysis_transitions`, `lims_analyses`, `role_assigned` `lims_sub_sample_events`, set `assignment_role=NULL` (scoped to that one sub-sample pk). This mirrors the prior session's cleanup; the user authorizes dev-data curation on the isolated stack.

---

## Self-review notes
- **Spec coverage:** catalog migration (T1) ✓; mirror translation via `Analyte{N}Peptide` slot source + skip empty slots + replace generic + safety fallback (T2) ✓; bridge per-substance direct match by peptide with legacy ANALYTE-{slot}/generic fallback + lazy SENAITE (T3) ✓; backward compat (legacy paths retained, ANALYTE-N services kept) ✓; Analytics grouping ✓; live E2E (T4) ✓.
- **Type consistency:** `_pick_target(category, candidates, *, slot, peptide_kw)` signature updated at its only call site (T3d). `_peptide_service_keyword(db, *, peptide, prefix)` used with prefixes `'PUR_'`/`'QTY_'`. `_PARENT_ANALYTE` regex defined once in seeder.py. Migration keyword forms (`PUR_<X>`/`QTY_<X>`) consistent across T1 (create), T2 (seed), T3 (match).
- **No placeholders:** every code/step is concrete; the only adaptive notes (read surrounding migration-list formatting; check whether `test_mirror_is_idempotent` uses analyte keywords) name the exact file/check to do.
- **Hermeticity:** existing 14 bridge tests have no `AnalysisService` rows → `pur_kw`/`qty_kw` None → legacy paths unchanged; per-substance vials never call SENAITE (catalog lookup only). Mirror tests use throwaway vial + `commit=False` (no live-DB pollution); they monkeypatch both SENAITE reads.
- **Known interaction:** `QTY_<X>` is both the per-substance and the legacy-"generic" namespace; `_pick_target` step 1 (peptide_kw) selects the right one for blends; step 3 preserves single-`QTY_`-row behavior for old vials.
