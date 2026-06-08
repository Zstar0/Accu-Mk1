# Sample Prep wizard — sub-sample (vial) support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create HPLC Sample Preps for sub-sample vials; a vial-scoped prep's HPLC result auto-writes onto that vial's `lims_analyses` row and submits it to `to_be_verified` — while parent-sample preps keep working unchanged.

**Architecture:** Additive. Tag a prep with a nullable `lims_sub_sample_pk` (null = today's parent prep, zero behavior change). When the HPLC run produces an `HPLCAnalysis` for a vial-scoped prep, a new bridge service finds the vial's unassigned HPLC `lims_analyses` rows (purity / identity / quantity), writes the matching result, and runs the existing `apply_transition(kind="submit")`. Verify/promote stay the human gate.

**Tech Stack:** FastAPI + SQLAlchemy (main app, `models.py`) and raw psycopg2 (`mk1_db.py`) — both against the same `accumark_mk1` Postgres DB. React + TanStack Query frontend. pytest (in-memory SQLite fixture) + vitest.

**Trigger decision (resolves the spec's open question):** the bridge fires in `POST /hplc/analyses` right after the `HPLCAnalysis` is persisted — the moment the analytical `result_value` (purity_percent / identity_conforms / quantity_mg) actually exists. Not the FE-driven prep status flip (which is a label, set client-side, and may precede the result). The bridge is idempotent (only touches `unassigned` rows), so HPLC re-runs don't double-submit.

**Key conventions discovered (don't re-derive):**
- All eight tables (`sample_preps`, `wizard_sessions`, `hplc_analyses`, `lims_analyses`, `lims_sub_samples`, `instruments`, `hplc_methods`, `analysis_services`) live in `accumark_mk1`. `sample_preps` is reached via raw SQL (`mk1_db.py`); the rest via SQLAlchemy. Same DB, two access layers — **no cross-DB problem**, but **no real FK** on `sample_preps` columns (match the existing `instrument_id INTEGER` convention).
- `lims_analyses` HPLC keywords: `HPLC-PUR` (purity), `HPLC-ID` and per-peptide `ID_<PEPTIDE>` (identity), `QTY_<PEPTIDE>` (quantity).
- `result_value` formats (live): purity `"95.231"` (numeric string), identity `"BPC-157"` (the peptide name when conforming), quantity numeric.
- State machine shortcut: `("unassigned", "submit") -> "to_be_verified"` (`backend/lims_analyses/state_machine.py:96`). `apply_transition` signature: `apply_transition(db, *, analysis_id, kind, result_value=None, reason=None, user_id=None)` (`backend/lims_analyses/service.py:135`). It commits internally.
- Test harness: `backend/tests/conftest.py:24` `db_session` fixture = in-memory SQLite + `Base.metadata.create_all`. `create_analysis(db, *, host_kind="sub_sample", host_pk, analysis_service_id, keyword, title, ...)` (`service.py:79`) inserts an `unassigned` row.

---

## Task 1: Additive schema columns (`lims_sub_sample_pk`)

**Files:**
- Modify: `backend/mk1_db.py` (`ensure_sample_preps_table`, migration block ~120-133; `create_sample_prep` cols list 377-388)
- Modify: `backend/models.py` (`WizardSession`, ~532-583)
- Modify: `backend/database.py` (`_run_migrations` — idempotent ALTER block)

- [ ] **Step 1: Add the `sample_preps` column (raw-SQL migration)**

In `backend/mk1_db.py`, inside `ensure_sample_preps_table`, alongside the existing `ADD COLUMN IF NOT EXISTS` statements (after the `instrument_id INTEGER` line ~128), add:

```python
            cur.execute("ALTER TABLE sample_preps ADD COLUMN IF NOT EXISTS lims_sub_sample_pk INTEGER")
```

- [ ] **Step 2: Allow the column through `create_sample_prep`**

In `backend/mk1_db.py`, append `"lims_sub_sample_pk"` to the `cols` list in `create_sample_prep` (the list at lines 377-388):

```python
        "created_by_user_id", "created_by_email", "updated_by_user_id", "updated_by_email",
        "lims_sub_sample_pk",
    ]
```

- [ ] **Step 3: Add the `wizard_sessions` model column**

In `backend/models.py`, in `class WizardSession`, add (near `sample_id_label`):

```python
    lims_sub_sample_pk: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
```

(`Integer` and `Optional` are already imported in this module.)

- [ ] **Step 4: Add the `wizard_sessions` idempotent migration**

In `backend/database.py` `_run_migrations()`, alongside the other hand-rolled idempotent `ALTER TABLE` statements, add:

```python
    conn.execute(sa_text("ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS lims_sub_sample_pk INTEGER"))
```

(Match the surrounding statements' exact connection/execution idiom — read the neighbors first; some use `conn.exec_driver_sql`, some `sa_text`. Use whichever the file already uses.)

- [ ] **Step 5: Apply migrations to the running container and verify**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import database, mk1_db; database._run_migrations(); mk1_db.ensure_sample_preps_table()'"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT column_name FROM information_schema.columns WHERE table_name IN ('sample_preps','wizard_sessions') AND column_name='lims_sub_sample_pk';"
```
Expected: two rows (one per table).

- [ ] **Step 6: Commit**

```bash
git add backend/mk1_db.py backend/models.py backend/database.py
git commit -m "feat(prep): additive lims_sub_sample_pk column on sample_preps + wizard_sessions"
```

---

## Task 2: Bridge service + unit tests (TDD core)

**Files:**
- Create: `backend/lims_analyses/prep_bridge.py`
- Test: `backend/tests/test_prep_bridge.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_prep_bridge.py`:

```python
"""Unit tests for the vial-prep result bridge."""
from sqlalchemy import select

from models import HPLCAnalysis, LimsAnalysis, LimsSubSample, Peptide
from lims_analyses.service import create_analysis
from lims_analyses.prep_bridge import bridge_prep_result_to_vial


def _peptide(db, name="BPC-157", abbr="BPC-157"):
    p = Peptide(name=name, abbreviation=abbr)
    db.add(p)
    db.flush()
    return p


def _vial(db):
    # Supply any other NOT NULL columns LimsSubSample requires (read models.py).
    v = LimsSubSample(sample_id="P-0142-S01", vial_sequence=0)
    db.add(v)
    db.flush()
    return v


def _hplc(db, pep, *, purity=None, conforms=None, qty=None, instrument_id=None):
    a = HPLCAnalysis(
        sample_id_label="P-0142-S01",
        peptide_id=pep.id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0,
        dil_vial_empty=1.0, dil_vial_with_diluent=2.0,
        dil_vial_with_diluent_and_sample=3.0,
        purity_percent=purity, identity_conforms=conforms, quantity_mg=qty,
        instrument_id=instrument_id,
    )
    db.add(a)
    db.flush()
    return a


def test_bridges_purity_and_identity_and_submits(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    idr = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=30, keyword="ID_BPC157", title="BPC-157 - Identity (HPLC)")
    a = _hplc(db, pep, purity=98.5, conforms=True)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert set(ids) == {pur.id, idr.id}
    db.refresh(pur); db.refresh(idr)
    assert pur.review_state == "to_be_verified" and pur.result_value == "98.5"
    assert idr.review_state == "to_be_verified" and idr.result_value == "BPC-157"


def test_skips_mismatched_identity_analyte(db_session):
    db = db_session
    pep = _peptide(db, name="BPC-157", abbr="BPC-157")
    vial = _vial(db)
    other = create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                            analysis_service_id=33, keyword="ID_PT141", title="PT-141 - Identity (HPLC)")
    a = _hplc(db, pep, conforms=True)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == []
    db.refresh(other)
    assert other.review_state == "unassigned"


def test_idempotent_second_run_is_noop(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    a = _hplc(db, pep, purity=99.0)

    first = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)
    second = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert len(first) == 1 and second == []


def test_no_matching_rows_returns_empty(db_session):
    db = db_session
    pep = _peptide(db)
    vial = _vial(db)
    create_analysis(db, host_kind="sub_sample", host_pk=vial.id,
                    analysis_service_id=77, keyword="ENDO-LAL", title="Endotoxin")
    a = _hplc(db, pep, purity=99.0)

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=vial.id, analysis=a, peptide=pep, user_id=1)

    assert ids == []
```

(If `LimsSubSample` / `Peptide` / `HPLCAnalysis` have additional NOT NULL columns, read `models.py` and add minimal values in the helpers — do NOT change the assertions.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py -q"`
Expected: FAIL — `ModuleNotFoundError: No module named 'lims_analyses.prep_bridge'`.

- [ ] **Step 3: Implement the bridge service**

Create `backend/lims_analyses/prep_bridge.py`:

```python
"""
Bridge a vial-scoped HPLC Sample Prep result onto the vial's lims_analyses rows.

A Sample Prep (accumark_mk1.sample_preps) may carry a lims_sub_sample_pk — the
vial it was prepped for. When the HPLC run for that prep produces an
HPLCAnalysis (purity_percent / identity_conforms / quantity_mg), this writes the
matching result onto the vial's unassigned HPLC lims_analyses rows and runs the
existing 'submit' transition (-> to_be_verified). Verify/promote stay manual.

Idempotent: only 'unassigned' rows are touched.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import HPLCAnalysis, LimsAnalysis, Peptide
from lims_analyses.service import apply_transition

logger = logging.getLogger(__name__)


def _norm(s: Optional[str]) -> str:
    """Uppercase, alphanumerics only — for analyte token matching."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _category(keyword: Optional[str]) -> Optional[str]:
    kw = (keyword or "").upper()
    if kw == "HPLC-PUR":
        return "purity"
    if kw == "HPLC-ID" or kw.startswith("ID_"):
        return "identity"
    if kw.startswith("QTY_"):
        return "quantity"
    return None


def _fmt_num(v: Optional[float]) -> Optional[str]:
    if v is None:
        return None
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _result_for(category: str, analysis: HPLCAnalysis, peptide: Optional[Peptide]) -> Optional[str]:
    if category == "purity":
        return _fmt_num(analysis.purity_percent)
    if category == "quantity":
        return _fmt_num(analysis.quantity_mg)
    if category == "identity":
        if analysis.identity_conforms is None:
            return None
        if analysis.identity_conforms:
            # Conforming identity result_value is the peptide name (matches the
            # live ID_* convention, e.g. ID_BPC157 -> "BPC-157").
            return peptide.name if peptide else "Conforms"
        return "Non-conforming"
    return None


def bridge_prep_result_to_vial(
    db: Session,
    *,
    lims_sub_sample_pk: int,
    analysis: HPLCAnalysis,
    peptide: Optional[Peptide],
    user_id: Optional[int] = None,
) -> list[int]:
    """
    Write `analysis`'s results onto the vial's unassigned HPLC lims_analyses
    rows and submit them. Returns submitted analysis ids.

    Guards: only 'unassigned' rows; peptide-specific identity rows (ID_<PEPTIDE>)
    must match `peptide`; rows with no derivable value are skipped.
    """
    rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == lims_sub_sample_pk,
            LimsAnalysis.review_state == "unassigned",
        )
    ).scalars().all()

    pep_token = _norm(peptide.abbreviation or peptide.name) if peptide else ""
    submitted: list[int] = []

    for row in rows:
        category = _category(row.keyword)
        if category is None:
            continue
        if category == "identity" and (row.keyword or "").upper().startswith("ID_"):
            row_token = _norm((row.keyword or "").upper()[3:])
            if pep_token and row_token and row_token != pep_token:
                logger.info(
                    "prep_bridge: skip vial=%s row=%s kw=%s — analyte %s != prep %s",
                    lims_sub_sample_pk, row.id, row.keyword, row_token, pep_token,
                )
                continue
        value = _result_for(category, analysis, peptide)
        if value is None:
            continue
        if analysis.instrument_id is not None:
            row.instrument_id = analysis.instrument_id
        db.flush()
        apply_transition(
            db,
            analysis_id=row.id,
            kind="submit",
            result_value=value,
            reason=f"auto: HPLC sample-prep result (analysis #{analysis.id})",
            user_id=user_id,
        )
        submitted.append(row.id)

    if not submitted:
        logger.warning(
            "prep_bridge: no unassigned HPLC lims_analyses rows matched for vial=%s (analysis #%s)",
            lims_sub_sample_pk, analysis.id,
        )
    return submitted
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py -q"`
Expected: 4 passed. (If a NOT NULL model column is missing, fix the test helper, not the assertions.)

- [ ] **Step 5: Commit**

```bash
git add backend/lims_analyses/prep_bridge.py backend/tests/test_prep_bridge.py
git commit -m "feat(prep): bridge service — write vial-prep HPLC result onto lims_analyses + submit"
```

---

## Task 3: Wire the bridge into `POST /hplc/analyses`

**Files:**
- Modify: `backend/main.py` (the `POST /hplc/analyses` handler — `HPLCAnalysis(...)` build + commit, ~4000-4060)

- [ ] **Step 1: Call the bridge after the analysis is persisted**

In the `POST /hplc/analyses` handler, after the `analysis` row is committed (and `analysis.id` populated — add a `db.refresh(analysis)` if the handler doesn't already), insert:

```python
    # Bridge: a vial-scoped sample prep pushes its HPLC result onto the vial's
    # lims_analyses row(s) and submits. Never let a bridge failure break HPLC
    # recording — the analysis is already saved.
    if request.sample_prep_id is not None:
        try:
            import mk1_db
            from lims_analyses.prep_bridge import bridge_prep_result_to_vial
            _prep = mk1_db.get_sample_prep(request.sample_prep_id)
            _sub_pk = _prep.get("lims_sub_sample_pk") if _prep else None
            if _sub_pk is not None:
                bridge_prep_result_to_vial(
                    db,
                    lims_sub_sample_pk=_sub_pk,
                    analysis=analysis,
                    peptide=peptide,
                    user_id=current_user.id,
                )
        except Exception:
            logger.exception("prep_bridge: failed for sample_prep_id=%s", request.sample_prep_id)
```

(Confirm `peptide`, `current_user`, `db`, and module-level `logger` are in scope in this handler — they are used elsewhere in the same function. Use the handler's existing import style if `mk1_db` is already imported at module top.)

- [ ] **Step 2: Verify the backend imports cleanly**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main'"`
Expected: no output (clean import). Backend auto-reloads.

- [ ] **Step 3: Commit**

```bash
git add backend/main.py
git commit -m "feat(prep): fire vial-prep bridge on HPLC analysis creation"
```

---

## Task 4: Thread `lims_sub_sample_pk` through wizard-session create → prep

**Files:**
- Modify: `backend/main.py` (`WizardSessionCreate` ~9214, `create_wizard_session` 9676, `WizardSessionResponse` ~9276/9304, prep-from-session `data` dict ~10110)
- Modify: `src/lib/api.ts` (`WizardSession` interface, `createWizardSession` payload type, `SamplePrep` interface)

- [ ] **Step 1: Accept the field on session create (backend)**

In `backend/main.py`:
- Add `lims_sub_sample_pk: Optional[int] = None` to the `WizardSessionCreate` request model (~9214).
- In `create_wizard_session`, when constructing the `WizardSession`, set `lims_sub_sample_pk=data.lims_sub_sample_pk`.
- Add `lims_sub_sample_pk: Optional[int] = None` to `WizardSessionResponse` (~9276) and populate it from `session.lims_sub_sample_pk` wherever the response is built (`_build_session_response` / the `WizardSessionResponse(...)` call near 9652).

- [ ] **Step 2: Carry it into the created prep (backend)**

In the prep-from-session `data` dict (~10110, next to `"senaite_sample_id": session.sample_id_label`), add:

```python
        "lims_sub_sample_pk": session.lims_sub_sample_pk,
```

- [ ] **Step 3: Add the field to the FE types**

In `src/lib/api.ts`:
- Add `lims_sub_sample_pk?: number | null` to the `WizardSession` interface.
- Add `lims_sub_sample_pk?: number | null` to the `createWizardSession` payload type (the object passed to `POST /wizard/sessions`).
- Add `lims_sub_sample_pk: number | null` to the `SamplePrep` interface (after `senaite_sample_id`).

- [ ] **Step 4: Verify typecheck + backend import**

Run:
```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -c 'import main'"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"
```
Expected: clean import; tsc shows only the known baseline `WorksheetsInboxPage.tsx(434,38)` error, nothing new.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py src/lib/api.ts
git commit -m "feat(prep): thread lims_sub_sample_pk through wizard session -> sample prep"
```

---

## Task 5: FE — vial worksheet "Start Prep" carries the vial pk

**Files:**
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (`onStartPrep` ~283-305)
- Modify: `src/store/ui-store.ts` (`startPrepFromWorksheet` / `worksheetPrepPrefill`)
- Modify: `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` (prefill ~154; `createWizardSession` call ~296-299)

- [ ] **Step 1: Find the vial pk on the worksheet item**

In `WorksheetDrawer.tsx`, inspect the worksheet `item` shape (the same object that yields `item.sampleId` / `item.peptideId`). Locate the sub-sample primary key it carries (e.g. `item.limsSubSamplePk` / `item.subSamplePk` — grep `WorksheetDrawerItems.tsx` and the worksheet item type for `sub_sample`/`lims_sub_sample`). If the item already exposes it, pass it; if not, add it to the worksheet item mapping from the backend worksheet payload (which carries `vial_meta_by_uid` with the sub-sample pk).

- [ ] **Step 2: Thread it through the prefill**

In `src/store/ui-store.ts`, add `limsSubSamplePk?: number | null` to the `worksheetPrepPrefill` type and to the `startPrepFromWorksheet(args)` signature. In `WorksheetDrawer.tsx` `onStartPrep`, pass `limsSubSamplePk: item.<pkField> ?? null`.

- [ ] **Step 3: Pass it to session creation**

In `Step1SampleInfo.tsx`, where the prefill is consumed (~154) keep a local `limsSubSamplePk` state seeded from `prefill.limsSubSamplePk`. In the `createWizardSession` call (~296-299), add `data.lims_sub_sample_pk = limsSubSamplePk` when set.

- [ ] **Step 4: Verify typecheck**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"`
Expected: only the known baseline error.

- [ ] **Step 5: Commit**

```bash
git add src/components/hplc/WorksheetDrawer.tsx src/store/ui-store.ts src/components/hplc/wizard/steps/Step1SampleInfo.tsx
git commit -m "feat(prep): worksheet Start Prep tags the wizard session with the vial pk"
```

---

## Task 6: FE — wizard Step1 sub-sample picker

**Files:**
- Modify: `src/components/hplc/wizard/steps/Step1SampleInfo.tsx` (lookup UI ~422-462)
- Reference: `src/lib/api.ts` (sub-sample list/lookup — grep `sub_sample` / `listSubSamples` / `getParentSummary`)

- [ ] **Step 1: Add a vial lookup path**

Today Step1's `handleLookup` calls `lookupSenaiteSample` (parent only; a `P-XXXX-SNN` vial id 404s). Add a sibling lookup: when the entered id matches the vial pattern (`/-S\d+$/`), resolve it via the existing Mk1 sub-sample lookup (find the FE helper that returns a sub-sample's pk + parent `sample_id` — grep `api.ts` for the sub-sample detail/list call already used by `SampleDetails.tsx`). On a hit:
- set `limsSubSamplePk` to the vial's pk,
- run the existing parent `lookupSenaiteSample` against the resolved **parent** id to auto-populate peptide / declared weight (the vial inherits the parent compound),
- set the sample-id label to the vial id for display.

- [ ] **Step 2: Keep the parent path unchanged**

A non-vial id (no `-S\d+` suffix) flows through the existing `lookupSenaiteSample` path exactly as before, with `limsSubSamplePk` left null. No behavior change for parent preps.

- [ ] **Step 3: Verify typecheck + smoke the lookup**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"`
Expected: only the known baseline error. Then in the browser (tab 0, `http://localhost:5532`, sessionStorage overrides set), open the new-analysis wizard, enter a known vial id (`P-XXXX-SNN`), confirm it resolves and the pk is captured (the parent's peptide/weight auto-populate).

- [ ] **Step 4: Commit**

```bash
git add src/components/hplc/wizard/steps/Step1SampleInfo.tsx
git commit -m "feat(prep): wizard Step1 sub-sample (vial) picker"
```

---

## Task 7: Live end-to-end verification (Handler standing pref — tests/review missed prior real bugs)

**No code. Drive the app + DB.** Stack: FE :5532, API :5530, Postgres `accumark_mk1`; login `forrest@valenceanalytical.com / test123`; browser tab 0 with sessionStorage `accu_mk1_api_url_override='http://localhost:5530'` + `accu_mk1_wp_url_override='http://localhost:5535'` (reload after setting).

- [ ] **Step 1: Pick a vial that has unassigned HPLC analyses**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT la.lims_sub_sample_pk, ss.sample_id, la.keyword, la.review_state FROM lims_analyses la JOIN lims_sub_samples ss ON ss.id = la.lims_sub_sample_pk WHERE la.review_state='unassigned' AND (la.keyword='HPLC-PUR' OR la.keyword LIKE 'ID\_%' OR la.keyword='HPLC-ID') ORDER BY 1 LIMIT 10;"
```

- [ ] **Step 2: Create a vial prep end-to-end**

Start a prep for that vial via the worksheet "Start Prep" (or Step1 picker), complete the wizard, and record the HPLC result (`POST /hplc/analyses`).

- [ ] **Step 3: Confirm the write-through**

```bash
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT id, keyword, result_value, instrument_id, review_state FROM lims_analyses WHERE lims_sub_sample_pk = <PK> ORDER BY id;"
MSYS_NO_PATHCONV=1 docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -c "SELECT id, sample_id, senaite_sample_id, lims_sub_sample_pk FROM sample_preps ORDER BY id DESC LIMIT 3;"
```
Expected: the prep row carries `lims_sub_sample_pk`; the vial's HPLC `lims_analyses` row(s) now show the prep's result and `review_state='to_be_verified'`.

- [ ] **Step 4: Confirm parent preps are unaffected + promote still works**

Create a normal parent-sample prep (no vial) — confirm it behaves exactly as before (`lims_sub_sample_pk` null, no bridge). Then promote the bridged vial result through the existing flow to confirm it feeds the parent.

- [ ] **Step 5: Re-run the backend suite**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_prep_bridge.py tests/test_lims_analyses_state_machine.py tests/test_promote_sets_source_promoted.py tests/test_vial_retest.py -q"`
Expected: green (the two pre-existing `test_families_routes.py` failures are known-unrelated and not in this set).

---

## Self-review notes

- **Spec coverage:** data model (T1) ✓; entry points — worksheet (T5) + Step1 picker (T6) ✓; result bridge + auto-submit (T2, T3) ✓; boundaries — stops at `to_be_verified`, null-pk no-op, no `mk1://` gating (keys on pk) ✓; testing — unit (T2) + live (T7) ✓.
- **Trigger:** resolved to `POST /hplc/analyses` (result-exists moment), idempotent — documented in the header.
- **Type consistency:** `lims_sub_sample_pk` used identically across mk1_db col list, WizardSession model, WizardSessionCreate/Response, prep data dict, `SamplePrep`/`WizardSession` TS, and the prefill chain (`limsSubSamplePk` camelCase on the FE store/props, `lims_sub_sample_pk` sn_case on the wire). Bridge entry point `bridge_prep_result_to_vial(db, *, lims_sub_sample_pk, analysis, peptide, user_id)` consistent in T2 and T3.
- **Known non-placeholder adaptation points:** exact NOT NULL columns on `LimsSubSample`/`Peptide`/`HPLCAnalysis` in the T2 test helpers, the worksheet item's pk field name (T5 Step 1), and the FE sub-sample lookup helper name (T6 Step 1) — each flagged inline with the grep to run.
```
