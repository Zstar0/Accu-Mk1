# COA Roll-Up Phase 1 — Data Model + Resolver + Auto Path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data foundation (3 Mk1-local tables) and the pure source-resolver, then hook the resolver into the existing `/wizard/senaite/samples/{sample_id}/generate-coa` endpoint as a pre-flight that writes a per-generation manifest on the happy path (every analyte resolves to exactly one candidate). No UI yet, no behavior change for single-vial samples, full audit trail in the DB.

**Architecture:** Three additive Mk1 tables — `coa_result_pins` (manager intent), `coa_generation_sources` (immutable per-generation manifest, holds a UUID reference to the integration-DB's `coa_generations` row without a hard FK since the two DBs are separate), and `analysis_reportable` (Mk1-side sidecar holding the per-analysis-instance "fit to report" boolean, since SENAITE analyses don't have a Mk1 mirror table to add columns to). A pure resolver module gathers candidates from SENAITE for the parent + every linked sub-sample, applies the 0/1/many decision tree, and returns structured `SourceDecision`s. The generate-coa endpoint pre-flights the resolver; auto path succeeds and writes manifest rows; >1-candidate or 0-candidate paths return a 422 with structured details (UI surfaces in Phase 2/3, not here).

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres (Accu-Mk1 backend), pytest. No frontend changes.

**Spec:** `docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md`

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`).

**Out of scope for this plan:**
- UI work (COA Sources card, pin drawer, reportable toggle) — Phases 2–3.
- COABuilder contract extension (`result_sources` injection on the POST payload) — deferred until the resolver can produce `>1` results that COABuilder needs to disambiguate.
- Historical mode of the panel + activity log entries — Phase 4.
- Variance-set integration as a resolution mode — Phase 5.
- Per-customer additional-COA pin scoping — out of scope (see SPEC).

**How to run tests:**
- Backend unit: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Backend integration: same harness, `-m integration` marker is available on existing suites.

---

## File Structure

**Backend (new):**
- `backend/coa/__init__.py` — empty package marker (if `backend/coa/` doesn't exist).
- `backend/coa/source_resolver.py` — pure function `resolve_sources(parent_sample_id, db, senaite_client) → ResolverResult`.
- `backend/coa/manifest.py` — `write_generation_manifest(db, generation_id, decisions)` + `read_generation_manifest(db, generation_id)`.
- `backend/coa/schemas.py` — `SourceDecision`, `CandidateInfo`, `ResolverResult`, `BlockedReason` Pydantic models (NOT exposed via API yet — internal contracts only).
- `backend/tests/test_coa_source_resolver.py` — unit tests using fake SENAITE responses.
- `backend/tests/test_coa_manifest.py` — round-trip tests against Postgres.

**Backend (modified):**
- `backend/database.py` — append 3 `CREATE TABLE IF NOT EXISTS` to `_run_migrations()`.
- `backend/models.py` — add `CoaResultPin`, `CoaGenerationSource`, `AnalysisReportable` ORM classes.
- `backend/main.py` — extend `generate_sample_coa` to call the resolver pre-flight and to write the manifest after a successful COABuilder generation.

---

## Task 1: DB migrations — 3 new tables

**Files:**
- Modify: `backend/database.py` (append to `_run_migrations()`)

- [ ] **Step 1: Find the `_run_migrations()` function**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -n "_run_migrations" /app/database.py | head
```

Expected: function definition with a list of idempotent `ALTER TABLE … IF NOT EXISTS` statements wrapped in `try/except`.

- [ ] **Step 2: Append the three new tables at the end of the migration list**

Inside `_run_migrations()`, append (preserving the existing per-statement `try/except` style):

```python
# COA result pins — manager intent for which sub-sample's result a parent's
# COA reports for each analyte (COA roll-up design 2026-06-02 §Data model).
try:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS coa_result_pins (
            id                    SERIAL PRIMARY KEY,
            parent_sample_id      TEXT NOT NULL,
            analyte_keyword       TEXT NOT NULL,
            mode                  TEXT NOT NULL
                                  CHECK (mode IN ('pin', 'auto', 'variance_set')),
            source_sample_id      TEXT,
            source_analysis_uid   TEXT,
            reason                TEXT,
            pinned_by_user_id     INTEGER REFERENCES users(id),
            pinned_at             TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE (parent_sample_id, analyte_keyword)
        )
    """))
except Exception as e:
    log.warning("migration coa_result_pins: %s", e)

try:
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_coa_result_pins_parent
            ON coa_result_pins (parent_sample_id)
    """))
except Exception as e:
    log.warning("migration ix_coa_result_pins_parent: %s", e)

# COA generation sources — frozen per-generation manifest. UUID reference
# is to coa_generations.id in the integration DB; no FK constraint because
# the two databases are separate (IS migrations gated on Phase 3b).
try:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS coa_generation_sources (
            id                          SERIAL PRIMARY KEY,
            generation_id               UUID NOT NULL,
            generation_number           INTEGER NOT NULL,
            parent_sample_id            TEXT NOT NULL,
            analyte_keyword             TEXT NOT NULL,
            source_sample_id            TEXT NOT NULL,
            source_analysis_uid         TEXT NOT NULL,
            result_value                TEXT,
            result_unit                 TEXT,
            candidates_count            INTEGER NOT NULL,
            resolution_mode             TEXT NOT NULL
                                        CHECK (resolution_mode IN
                                          ('auto', 'pin', 'variance_set',
                                           'stale_pin_fallback')),
            candidates_snapshot         JSONB,
            created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE (generation_id, analyte_keyword)
        )
    """))
except Exception as e:
    log.warning("migration coa_generation_sources: %s", e)

try:
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_coa_generation_sources_parent
            ON coa_generation_sources (parent_sample_id)
    """))
except Exception as e:
    log.warning("migration ix_coa_generation_sources_parent: %s", e)

try:
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_coa_generation_sources_gen
            ON coa_generation_sources (generation_id)
    """))
except Exception as e:
    log.warning("migration ix_coa_generation_sources_gen: %s", e)

# Analysis reportable — Mk1-side sidecar for the per-instance "fit to report"
# boolean. SENAITE analyses have no Mk1 mirror table, so the flag lives
# keyed by (sample_id, analysis_uid). Default TRUE matches today's implicit
# behavior — every verified result is a candidate unless explicitly excluded.
try:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS analysis_reportable (
            sample_id         TEXT NOT NULL,
            analysis_uid      TEXT NOT NULL,
            reportable        BOOLEAN NOT NULL DEFAULT TRUE,
            reason            TEXT,
            changed_by_user_id INTEGER REFERENCES users(id),
            changed_at        TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (sample_id, analysis_uid)
        )
    """))
except Exception as e:
    log.warning("migration analysis_reportable: %s", e)
```

- [ ] **Step 3: Restart backend so migrations run**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
sleep 5
```

- [ ] **Step 4: Verify all three tables exist**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres \
  psql -U postgres -d accumark_mk1 -c "\dt coa_result_pins coa_generation_sources analysis_reportable"
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres \
  psql -U postgres -d accumark_mk1 -c "\d coa_result_pins"
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres \
  psql -U postgres -d accumark_mk1 -c "\d coa_generation_sources"
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres \
  psql -U postgres -d accumark_mk1 -c "\d analysis_reportable"
```

Expected:
- All three tables listed.
- `coa_result_pins` has unique on `(parent_sample_id, analyte_keyword)`.
- `coa_generation_sources` has unique on `(generation_id, analyte_keyword)` and `generation_id UUID`.
- `analysis_reportable` has composite PK on `(sample_id, analysis_uid)`.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/database.py
git commit -m "feat(mk1): add coa pins, generation-sources manifest, analysis_reportable tables"
```

---

## Task 2: ORM models

**Files:**
- Modify: `backend/models.py`

- [ ] **Step 1: Add imports if missing**

At the top of `backend/models.py`, ensure these are imported (most likely already are; only add what's missing):

```python
from sqlalchemy.dialects.postgresql import UUID, JSONB
```

- [ ] **Step 2: Append `CoaResultPin`**

At the end of `backend/models.py`:

```python
class CoaResultPin(Base):
    """
    Manager intent for which sub-sample's analysis result a parent's COA
    should report for a given analyte. Mutable — one row per (parent, analyte),
    upserted by the override panel. Audit history lives in SampleActivityLog,
    not here.

    See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
    """
    __tablename__ = "coa_result_pins"

    id = Column(Integer, primary_key=True)
    parent_sample_id = Column(Text, nullable=False, index=True)
    analyte_keyword = Column(Text, nullable=False)
    mode = Column(Text, nullable=False)  # 'pin' | 'auto' | 'variance_set'
    source_sample_id = Column(Text, nullable=True)
    source_analysis_uid = Column(Text, nullable=True)
    reason = Column(Text, nullable=True)
    pinned_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    pinned_at = Column(DateTime, nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "parent_sample_id", "analyte_keyword",
            name="uq_coa_result_pins_parent_analyte",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<CoaResultPin(parent={self.parent_sample_id}, "
            f"analyte={self.analyte_keyword}, mode={self.mode})>"
        )
```

- [ ] **Step 3: Append `CoaGenerationSource`**

```python
class CoaGenerationSource(Base):
    """
    Frozen per-generation manifest row. Written once at COA generation time;
    immutable afterwards. One row per (generation, analyte). `generation_id`
    references coa_generations.id in the integration DB (no FK because the
    two databases are separate).

    See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
    """
    __tablename__ = "coa_generation_sources"

    id = Column(Integer, primary_key=True)
    generation_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    generation_number = Column(Integer, nullable=False)
    parent_sample_id = Column(Text, nullable=False, index=True)
    analyte_keyword = Column(Text, nullable=False)
    source_sample_id = Column(Text, nullable=False)
    source_analysis_uid = Column(Text, nullable=False)
    result_value = Column(Text, nullable=True)
    result_unit = Column(Text, nullable=True)
    candidates_count = Column(Integer, nullable=False)
    resolution_mode = Column(Text, nullable=False)
    # Audit snapshot of the candidate list at generation time. Inlined so
    # historical-mode reads don't have to reconstruct from SENAITE (which
    # may have changed values since publish).
    candidates_snapshot = Column(JSONB, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "generation_id", "analyte_keyword",
            name="uq_coa_generation_sources_gen_analyte",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<CoaGenerationSource(gen={self.generation_id}, "
            f"analyte={self.analyte_keyword}, source={self.source_sample_id})>"
        )
```

- [ ] **Step 4: Append `AnalysisReportable`**

```python
class AnalysisReportable(Base):
    """
    Mk1-side sidecar for the "fit to report" boolean on a specific analysis
    instance. SENAITE analyses don't have a Mk1 mirror table, so the flag
    lives here keyed by (sample_id, analysis_uid). Default TRUE — absence
    of a row means the analysis IS reportable. Rows are only inserted when
    a tech/manager toggles the flag.

    See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
    """
    __tablename__ = "analysis_reportable"

    sample_id = Column(Text, primary_key=True)
    analysis_uid = Column(Text, primary_key=True)
    reportable = Column(Boolean, nullable=False, server_default="true")
    reason = Column(Text, nullable=True)
    changed_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    changed_at = Column(DateTime, nullable=False, server_default=func.now())

    def __repr__(self) -> str:
        return (
            f"<AnalysisReportable(sample={self.sample_id}, "
            f"uid={self.analysis_uid}, reportable={self.reportable})>"
        )
```

- [ ] **Step 5: Verify models load without import errors**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from models import CoaResultPin, CoaGenerationSource, AnalysisReportable
for cls in (CoaResultPin, CoaGenerationSource, AnalysisReportable):
    print(cls.__name__, sorted(c.name for c in cls.__table__.columns))
"
```

Expected: three lines listing each model's column names.

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/models.py
git commit -m "feat(mk1): ORM models for CoaResultPin, CoaGenerationSource, AnalysisReportable"
```

---

## Task 3: Resolver schemas

**Files:**
- New: `backend/coa/__init__.py`
- New: `backend/coa/schemas.py`

- [ ] **Step 1: Create the `backend/coa/` package**

```bash
mkdir -p C:/tmp/Accu-Mk1-subvial/backend/coa
```

Touch `backend/coa/__init__.py` with one line of comment so it's not flagged as empty by lint:

```python
# COA roll-up resolver + manifest writer. See:
# docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
```

- [ ] **Step 2: Write `backend/coa/schemas.py`**

```python
"""
Internal contracts for the COA source resolver.

These types are NOT exposed via API endpoints in Phase 1 — they're the shape
the resolver returns to the COA generation handler, and the shape the
manifest writer persists. Phase 2+ frontends will use a parallel public
schema in main.py / sub_samples/schemas.py.

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


ResolutionMode = Literal["auto", "pin", "variance_set", "stale_pin_fallback"]
BlockingReason = Literal["missing", "needs_decision", "stale_pin"]


class CandidateInfo(BaseModel):
    """One reportable-eligible analysis instance for a (parent, analyte)."""
    source_sample_id: str
    source_analysis_uid: str
    value: Optional[str] = None
    unit: Optional[str] = None
    state: str  # SENAITE review_state, e.g. 'verified' | 'published'
    reportable: bool = True
    in_variance_set: bool = False
    # Whether the SENAITE AR for this candidate is the parent (vs. a sub).
    is_parent_ar: bool = False


class ResolvedSource(BaseModel):
    """The single source chosen for a (parent, analyte) when resolution succeeded."""
    source_sample_id: str
    source_analysis_uid: str
    value: Optional[str] = None
    unit: Optional[str] = None


class SourceDecision(BaseModel):
    """
    Per-analyte outcome of the resolver. `mode` indicates how the decision
    was reached; `chosen` is None iff `blocked` is set.
    """
    analyte_keyword: str
    mode: ResolutionMode
    chosen: Optional[ResolvedSource] = None
    candidates: List[CandidateInfo] = Field(default_factory=list)
    blocked: Optional[BlockingReason] = None
    blocked_detail: Optional[str] = None


class ResolverResult(BaseModel):
    """
    Aggregate output of the resolver for one parent's COA. `decisions` is one
    SourceDecision per analyte the resolver considered; `is_blocked` is a
    convenience for the caller (True iff any decision has `blocked` set).
    """
    parent_sample_id: str
    decisions: List[SourceDecision]

    @property
    def is_blocked(self) -> bool:
        return any(d.blocked is not None for d in self.decisions)

    def unresolved_analytes(self) -> List[str]:
        return [d.analyte_keyword for d in self.decisions if d.blocked is not None]
```

- [ ] **Step 3: Verify schemas import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from coa.schemas import (
    SourceDecision, CandidateInfo, ResolvedSource,
    ResolverResult, ResolutionMode, BlockingReason,
)
r = ResolverResult(parent_sample_id='BW-0013', decisions=[])
print('OK', r.is_blocked, r.unresolved_analytes())
"
```

Expected: `OK False []`.

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/coa/
git commit -m "feat(mk1): COA resolver internal schemas"
```

---

## Task 4: Resolver core — candidate gathering

**Files:**
- New: `backend/coa/source_resolver.py`

The resolver has three layers: candidate gathering, pin lookup, decision rule. Task 4 is gathering only; Task 5 wires the decision rule.

- [ ] **Step 1: Write `backend/coa/source_resolver.py` (gathering only — decision rule lives in Task 5)**

```python
"""
COA source resolver. Pure function: given a parent sample and a DB session,
returns one SourceDecision per analyte the parent's order requires. Reads
SENAITE for analysis data; reads Mk1 DB for pins + reportable flags +
sub-sample linkage.

Single-file deliberately; the layering is:
  1. _gather_candidates  — read SENAITE for parent + sub-sample ARs
  2. _apply_reportable   — filter by Mk1 reportable sidecar
  3. _resolve_analyte    — apply the decision rule per analyte
  4. resolve_sources     — orchestration

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

from typing import Dict, List, Optional, Protocol, Set

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.schemas import (
    CandidateInfo,
    ResolvedSource,
    ResolverResult,
    SourceDecision,
)
from models import (
    AnalysisReportable,
    CoaResultPin,
    LimsSample,
    LimsSubSample,
)


class SenaiteAnalysesReader(Protocol):
    """
    Read interface for SENAITE analyses. The resolver doesn't care HOW the
    analyses are fetched — production wires it to the live SENAITE httpx
    client; tests inject a fake. Returns dicts with at least:
      { 'uid': str, 'keyword': str, 'result': str | None,
        'unit': str | None, 'review_state': str }
    """
    async def list_for_sample(self, sample_id: str) -> List[Dict]:  # pragma: no cover
        ...


def _gather_candidates_for(
    sample_id: str,
    is_parent_ar: bool,
    reader_payload: Dict[str, List[Dict]],
    in_variance_set: bool,
) -> Dict[str, List[CandidateInfo]]:
    """
    Build a `analyte_keyword -> [CandidateInfo]` map from one AR's analyses.
    `reader_payload[sample_id]` is the SENAITE analyses list for that AR.
    """
    out: Dict[str, List[CandidateInfo]] = {}
    for an in reader_payload.get(sample_id, []):
        kw = an.get("keyword")
        if not kw:
            continue
        out.setdefault(kw, []).append(
            CandidateInfo(
                source_sample_id=sample_id,
                source_analysis_uid=an["uid"],
                value=an.get("result"),
                unit=an.get("unit"),
                state=an.get("review_state", ""),
                reportable=True,  # Mk1 sidecar overrides in _apply_reportable
                in_variance_set=in_variance_set,
                is_parent_ar=is_parent_ar,
            )
        )
    return out


def _apply_reportable(
    db: Session,
    candidates_by_analyte: Dict[str, List[CandidateInfo]],
) -> Dict[str, List[CandidateInfo]]:
    """
    Look up the Mk1 reportable sidecar for every candidate and stamp the
    `.reportable` field. Absence of a row means reportable=True (default).
    """
    # Collect all (sample_id, analysis_uid) keys we need to look up.
    keys: Set[tuple[str, str]] = {
        (c.source_sample_id, c.source_analysis_uid)
        for cs in candidates_by_analyte.values()
        for c in cs
    }
    if not keys:
        return candidates_by_analyte

    # Bulk fetch. The sidecar is small (only flipped instances have rows).
    rows = db.execute(
        select(
            AnalysisReportable.sample_id,
            AnalysisReportable.analysis_uid,
            AnalysisReportable.reportable,
        )
    ).all()
    reportable_lookup: Dict[tuple[str, str], bool] = {
        (r.sample_id, r.analysis_uid): r.reportable for r in rows
    }
    for cs in candidates_by_analyte.values():
        for c in cs:
            key = (c.source_sample_id, c.source_analysis_uid)
            if key in reportable_lookup:
                c.reportable = reportable_lookup[key]
    return candidates_by_analyte


async def resolve_sources(
    parent_sample_id: str,
    db: Session,
    senaite_reader: SenaiteAnalysesReader,
) -> ResolverResult:
    """
    Gather candidates for the parent + every linked sub-sample, then apply
    the per-analyte decision rule. Decision rule lives in Task 5 and is
    imported here once written.
    """
    # 1. Load parent + sub-samples from Mk1 DB to know what ARs to fetch.
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    sample_ids: List[str] = [parent_sample_id]
    is_parent_lookup: Dict[str, bool] = {parent_sample_id: True}
    variance_lookup: Dict[str, bool] = {
        parent_sample_id: bool(parent.in_variance_set) if parent else True
    }
    if parent:
        subs = db.execute(
            select(LimsSubSample).where(
                LimsSubSample.parent_sample_pk == parent.id
            )
        ).scalars().all()
        for s in subs:
            sample_ids.append(s.sample_id)
            is_parent_lookup[s.sample_id] = False
            variance_lookup[s.sample_id] = bool(s.in_variance_set)

    # 2. Pull analyses for every AR in one round-trip per AR. (Future: bulk
    #    endpoint on the senaite_reader; not premature for Phase 1.)
    reader_payload: Dict[str, List[Dict]] = {}
    for sid in sample_ids:
        reader_payload[sid] = await senaite_reader.list_for_sample(sid)

    # 3. Build candidate map (analyte_keyword -> list[CandidateInfo]) from
    #    every AR's analyses, merging by analyte across ARs.
    merged: Dict[str, List[CandidateInfo]] = {}
    for sid in sample_ids:
        per_ar = _gather_candidates_for(
            sample_id=sid,
            is_parent_ar=is_parent_lookup[sid],
            reader_payload=reader_payload,
            in_variance_set=variance_lookup[sid],
        )
        for kw, cs in per_ar.items():
            merged.setdefault(kw, []).extend(cs)

    # 4. Stamp reportable from the Mk1 sidecar.
    merged = _apply_reportable(db, merged)

    # 5. Decision rule per analyte (Task 5).
    from coa.source_resolver import _resolve_analyte  # forward-import
    decisions: List[SourceDecision] = []
    for kw, cs in merged.items():
        decisions.append(_resolve_analyte(kw, cs, db, parent_sample_id))

    return ResolverResult(
        parent_sample_id=parent_sample_id,
        decisions=decisions,
    )
```

Note: Step 1 references `_resolve_analyte` which doesn't exist yet — Task 5 adds it. The forward import lets you write/test gathering in isolation by stubbing the rule, but DO NOT skip Task 5 before commit — pytest will fail.

- [ ] **Step 2: Verify the file parses**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
import ast
ast.parse(open('/app/coa/source_resolver.py').read())
print('parse ok')
"
```

Expected: `parse ok`.

(Don't commit yet — Task 5 finishes this file.)

---

## Task 5: Resolver decision rule

**Files:**
- Modify: `backend/coa/source_resolver.py`

- [ ] **Step 1: Append the decision rule helper**

At the bottom of `backend/coa/source_resolver.py`, add:

```python
def _resolve_analyte(
    analyte_keyword: str,
    candidates: List[CandidateInfo],
    db: Session,
    parent_sample_id: str,
) -> SourceDecision:
    """
    Apply the resolution rule for one analyte. Decision flow:
      0 reportable+verified candidates -> blocked='missing'
      1 reportable+verified candidate  -> mode='auto'
      >1 reportable+verified, pinned   -> mode='pin' if pin matches a live candidate;
                                          else blocked='stale_pin'
      >1 reportable+verified, no pin   -> blocked='needs_decision'

    Variance-set mode is NOT implemented in Phase 1 — that's Phase 5.
    """
    eligible = [
        c for c in candidates
        if c.reportable and c.state in ("verified", "published")
    ]

    if not eligible:
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=None,
            candidates=candidates,
            blocked="missing",
            blocked_detail=(
                f"no reportable verified result for {analyte_keyword!r} "
                "across parent + sub-samples"
            ),
        )

    if len(eligible) == 1:
        c = eligible[0]
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=ResolvedSource(
                source_sample_id=c.source_sample_id,
                source_analysis_uid=c.source_analysis_uid,
                value=c.value,
                unit=c.unit,
            ),
            candidates=candidates,
            blocked=None,
        )

    # > 1 eligible — consult pins.
    pin = db.execute(
        select(CoaResultPin).where(
            CoaResultPin.parent_sample_id == parent_sample_id,
            CoaResultPin.analyte_keyword == analyte_keyword,
        )
    ).scalar_one_or_none()

    if pin and pin.mode == "pin" and pin.source_sample_id and pin.source_analysis_uid:
        match = next(
            (c for c in eligible
             if c.source_sample_id == pin.source_sample_id
             and c.source_analysis_uid == pin.source_analysis_uid),
            None,
        )
        if match:
            return SourceDecision(
                analyte_keyword=analyte_keyword,
                mode="pin",
                chosen=ResolvedSource(
                    source_sample_id=match.source_sample_id,
                    source_analysis_uid=match.source_analysis_uid,
                    value=match.value,
                    unit=match.unit,
                ),
                candidates=candidates,
                blocked=None,
            )
        # Pin exists but no live candidate matches.
        return SourceDecision(
            analyte_keyword=analyte_keyword,
            mode="auto",
            chosen=None,
            candidates=candidates,
            blocked="stale_pin",
            blocked_detail=(
                f"pin on {pin.source_sample_id}/{pin.source_analysis_uid} "
                "no longer matches a reportable verified candidate"
            ),
        )

    # >1 eligible, no actionable pin -> human decision required.
    return SourceDecision(
        analyte_keyword=analyte_keyword,
        mode="auto",
        chosen=None,
        candidates=candidates,
        blocked="needs_decision",
        blocked_detail=(
            f"{len(eligible)} reportable verified candidates for "
            f"{analyte_keyword!r}; pick one via the COA Sources panel"
        ),
    )
```

- [ ] **Step 2: Verify the resolver loads end-to-end**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from coa.source_resolver import resolve_sources, _resolve_analyte
print('imports ok')
"
```

Expected: `imports ok`.

- [ ] **Step 3: Commit (resolver complete)**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/coa/__init__.py backend/coa/schemas.py backend/coa/source_resolver.py
git commit -m "feat(mk1): COA source resolver — schemas + gathering + decision rule"
```

---

## Task 6: Resolver unit tests

**Files:**
- New: `backend/tests/test_coa_source_resolver.py`

Tests use a fake `SenaiteAnalysesReader` and a real SQLAlchemy session against the test DB. They exercise the decision rule in isolation by handing `_resolve_analyte` synthetic candidate lists.

- [ ] **Step 1: Write `backend/tests/test_coa_source_resolver.py`**

```python
"""Unit tests for the COA source resolver decision rule."""

from __future__ import annotations

import pytest

from coa.schemas import CandidateInfo
from coa.source_resolver import _resolve_analyte
from models import CoaResultPin


def _make_candidate(
    sample_id: str = "BW-0013",
    analysis_uid: str = "uid-1",
    value: str = "98.5",
    unit: str = "%",
    state: str = "verified",
    reportable: bool = True,
    in_variance_set: bool = False,
    is_parent_ar: bool = True,
) -> CandidateInfo:
    return CandidateInfo(
        source_sample_id=sample_id,
        source_analysis_uid=analysis_uid,
        value=value,
        unit=unit,
        state=state,
        reportable=reportable,
        in_variance_set=in_variance_set,
        is_parent_ar=is_parent_ar,
    )


def test_zero_candidates_blocks_missing(db_session):
    d = _resolve_analyte("IDENTITY_HPLC", [], db_session, "BW-0013")
    assert d.blocked == "missing"
    assert d.chosen is None


def test_zero_eligible_after_filter_blocks_missing(db_session):
    cs = [_make_candidate(state="to_be_verified", reportable=True)]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    assert d.blocked == "missing"


def test_zero_eligible_after_reportable_filter_blocks_missing(db_session):
    cs = [_make_candidate(state="verified", reportable=False)]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    assert d.blocked == "missing"


def test_one_eligible_auto_resolves(db_session):
    cs = [_make_candidate(value="98.5", unit="%")]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    assert d.blocked is None
    assert d.mode == "auto"
    assert d.chosen is not None
    assert d.chosen.value == "98.5"
    assert d.chosen.unit == "%"


def test_many_eligible_without_pin_blocks_needs_decision(db_session):
    cs = [
        _make_candidate(sample_id="BW-0013",     analysis_uid="uid-p"),
        _make_candidate(sample_id="BW-0013-S02", analysis_uid="uid-s2", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    assert d.blocked == "needs_decision"
    assert d.chosen is None
    assert len(d.candidates) == 2


def test_many_eligible_with_matching_pin_resolves_to_pinned(db_session):
    db_session.add(CoaResultPin(
        parent_sample_id="BW-0013",
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id="BW-0013-S02",
        source_analysis_uid="uid-s2",
    ))
    db_session.commit()
    cs = [
        _make_candidate(sample_id="BW-0013",     analysis_uid="uid-p",  value="96.2"),
        _make_candidate(sample_id="BW-0013-S02", analysis_uid="uid-s2", value="98.5", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    assert d.blocked is None
    assert d.mode == "pin"
    assert d.chosen is not None
    assert d.chosen.source_sample_id == "BW-0013-S02"
    assert d.chosen.value == "98.5"


def test_pin_referencing_missing_candidate_blocks_stale_pin(db_session):
    db_session.add(CoaResultPin(
        parent_sample_id="BW-0013",
        analyte_keyword="IDENTITY_HPLC",
        mode="pin",
        source_sample_id="BW-0013-S99",   # no such sub-sample
        source_analysis_uid="uid-ghost",
    ))
    db_session.commit()
    cs = [
        _make_candidate(sample_id="BW-0013",     analysis_uid="uid-p"),
        _make_candidate(sample_id="BW-0013-S02", analysis_uid="uid-s2", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    assert d.blocked == "stale_pin"
    assert d.chosen is None


def test_pin_mode_auto_falls_through_to_needs_decision(db_session):
    db_session.add(CoaResultPin(
        parent_sample_id="BW-0013",
        analyte_keyword="IDENTITY_HPLC",
        mode="auto",
        source_sample_id=None,
        source_analysis_uid=None,
    ))
    db_session.commit()
    cs = [
        _make_candidate(sample_id="BW-0013",     analysis_uid="uid-p"),
        _make_candidate(sample_id="BW-0013-S02", analysis_uid="uid-s2", is_parent_ar=False),
    ]
    d = _resolve_analyte("IDENTITY_HPLC", cs, db_session, "BW-0013")
    # mode='auto' pin means "explicitly let the resolver decide" — with >1
    # eligible candidates and no actionable pin, we still need a human.
    assert d.blocked == "needs_decision"
```

- [ ] **Step 2: Confirm the test fixture `db_session` exists**

```bash
docker exec accumark-subvial-accu-mk1-backend grep -rn "def db_session" /app/tests/conftest.py
```

Expected: a fixture definition. If missing, look at how existing tests like `test_variance_set.py` get their session and mirror that.

- [ ] **Step 3: Run the new tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend \
  bash -c "cd /app && python -m pytest tests/test_coa_source_resolver.py -v"
```

Expected: 7 passed.

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/tests/test_coa_source_resolver.py
git commit -m "test(mk1): COA resolver decision-rule unit tests"
```

---

## Task 7: Manifest writer

**Files:**
- New: `backend/coa/manifest.py`
- New: `backend/tests/test_coa_manifest.py`

- [ ] **Step 1: Write `backend/coa/manifest.py`**

```python
"""
Persist a per-generation COA source manifest. Called once at the tail of a
successful COA generation; rows are immutable afterwards.

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

import uuid
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.schemas import ResolverResult, SourceDecision
from models import CoaGenerationSource


def write_generation_manifest(
    db: Session,
    *,
    generation_id: uuid.UUID,
    generation_number: int,
    result: ResolverResult,
) -> None:
    """
    Write one CoaGenerationSource row per resolved decision. Caller must
    have already confirmed `result.is_blocked == False` — this function
    skips any decision that is still blocked (defensive; logs nothing).
    """
    for d in result.decisions:
        if d.blocked is not None or d.chosen is None:
            continue
        db.add(CoaGenerationSource(
            generation_id=generation_id,
            generation_number=generation_number,
            parent_sample_id=result.parent_sample_id,
            analyte_keyword=d.analyte_keyword,
            source_sample_id=d.chosen.source_sample_id,
            source_analysis_uid=d.chosen.source_analysis_uid,
            result_value=d.chosen.value,
            result_unit=d.chosen.unit,
            candidates_count=len(d.candidates),
            resolution_mode=d.mode,
            candidates_snapshot=[c.model_dump() for c in d.candidates],
        ))
    db.commit()


def read_generation_manifest(
    db: Session,
    *,
    generation_id: uuid.UUID,
) -> List[CoaGenerationSource]:
    return list(
        db.execute(
            select(CoaGenerationSource)
            .where(CoaGenerationSource.generation_id == generation_id)
            .order_by(CoaGenerationSource.analyte_keyword)
        ).scalars().all()
    )
```

- [ ] **Step 2: Write `backend/tests/test_coa_manifest.py`**

```python
"""Round-trip tests for the COA generation manifest."""

from __future__ import annotations

import uuid

import pytest

from coa.manifest import read_generation_manifest, write_generation_manifest
from coa.schemas import (
    CandidateInfo,
    ResolvedSource,
    ResolverResult,
    SourceDecision,
)


def _make_resolver_result(parent: str = "BW-0013") -> ResolverResult:
    return ResolverResult(
        parent_sample_id=parent,
        decisions=[
            SourceDecision(
                analyte_keyword="IDENTITY_HPLC",
                mode="pin",
                chosen=ResolvedSource(
                    source_sample_id=f"{parent}-S02",
                    source_analysis_uid="uid-s2",
                    value="98.55",
                    unit="%",
                ),
                candidates=[
                    CandidateInfo(
                        source_sample_id=parent,
                        source_analysis_uid="uid-p",
                        value="96.2", unit="%",
                        state="verified", reportable=True,
                        is_parent_ar=True,
                    ),
                    CandidateInfo(
                        source_sample_id=f"{parent}-S02",
                        source_analysis_uid="uid-s2",
                        value="98.55", unit="%",
                        state="verified", reportable=True,
                        is_parent_ar=False,
                    ),
                ],
            ),
            SourceDecision(
                analyte_keyword="ENDOTOXIN",
                mode="auto",
                chosen=ResolvedSource(
                    source_sample_id=f"{parent}-S01",
                    source_analysis_uid="uid-endo",
                    value="<0.5",
                    unit="EU/mg",
                ),
                candidates=[
                    CandidateInfo(
                        source_sample_id=f"{parent}-S01",
                        source_analysis_uid="uid-endo",
                        value="<0.5", unit="EU/mg",
                        state="verified", reportable=True,
                        is_parent_ar=False,
                    ),
                ],
            ),
        ],
    )


def test_write_and_read_round_trip(db_session):
    gen_id = uuid.uuid4()
    result = _make_resolver_result()
    write_generation_manifest(
        db_session,
        generation_id=gen_id,
        generation_number=2,
        result=result,
    )

    rows = read_generation_manifest(db_session, generation_id=gen_id)
    assert len(rows) == 2
    by_analyte = {r.analyte_keyword: r for r in rows}

    identity = by_analyte["IDENTITY_HPLC"]
    assert identity.resolution_mode == "pin"
    assert identity.source_sample_id == "BW-0013-S02"
    assert identity.result_value == "98.55"
    assert identity.candidates_count == 2
    # Snapshot is round-tripped as JSON
    assert len(identity.candidates_snapshot) == 2

    endo = by_analyte["ENDOTOXIN"]
    assert endo.resolution_mode == "auto"
    assert endo.source_sample_id == "BW-0013-S01"
    assert endo.candidates_count == 1


def test_blocked_decisions_are_skipped(db_session):
    gen_id = uuid.uuid4()
    result = ResolverResult(
        parent_sample_id="BW-0013",
        decisions=[
            SourceDecision(
                analyte_keyword="IDENTITY_HPLC",
                mode="auto",
                chosen=None,
                candidates=[],
                blocked="missing",
                blocked_detail="no candidates",
            ),
        ],
    )
    write_generation_manifest(
        db_session,
        generation_id=gen_id,
        generation_number=1,
        result=result,
    )
    rows = read_generation_manifest(db_session, generation_id=gen_id)
    assert rows == []
```

- [ ] **Step 3: Run the manifest tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend \
  bash -c "cd /app && python -m pytest tests/test_coa_manifest.py -v"
```

Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/coa/manifest.py backend/tests/test_coa_manifest.py
git commit -m "feat(mk1): COA generation manifest writer + round-trip tests"
```

---

## Task 8: Wire resolver pre-flight into /generate-coa

The wiring strategy in Phase 1 is conservative — we **gate** COA generation on the resolver, but we don't yet inject `result_sources` into the COABuilder payload. That cross-repo contract extension lands in Phase 3 once the UI exists to drive `>1`-candidate scenarios into real outcomes. In Phase 1:

- Resolver runs first.
- If blocked, return HTTP 422 with a structured error before calling COABuilder.
- If not blocked, call COABuilder as today; on success, write the manifest using the resolver's decisions and the integration-DB's `generation_id` + `generation_number` from the COABuilder response.

**Files:**
- Modify: `backend/main.py` (the `generate_sample_coa` handler around line 8208)

- [ ] **Step 1: Add the SENAITE-reader adapter near the resolver module**

The resolver expects a `SenaiteAnalysesReader` protocol. Add a thin adapter inside `backend/coa/source_resolver.py` so callers don't have to reimplement it per use site.

Append to `backend/coa/source_resolver.py`:

```python
import httpx


class SenaiteAnalysesHttpReader:
    """
    Production adapter — uses the same SENAITE httpx client the rest of the
    app uses. The resolver receives this instance; tests inject fakes.
    """

    def __init__(self, base_url: str, auth, timeout: float = 30.0):
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._timeout = timeout

    async def list_for_sample(self, sample_id: str) -> List[Dict]:
        url = f"{self._base_url}/senaite/@@API/senaite/v1/Analysis"
        params = {"getRequestID": sample_id, "complete": "yes", "limit": 200}
        async with httpx.AsyncClient(
            timeout=self._timeout, auth=self._auth, follow_redirects=True,
        ) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
        items = data.get("items", []) or []
        out: List[Dict] = []
        for it in items:
            out.append({
                "uid": it.get("uid"),
                "keyword": it.get("getKeyword") or it.get("Keyword"),
                "result": it.get("Result"),
                "unit": it.get("Unit"),
                "review_state": it.get("review_state"),
            })
        return out
```

- [ ] **Step 2: Extend `generate_sample_coa` to run the resolver pre-flight**

Read `backend/main.py:8208` to refresh on the current handler shape. Then modify as follows (high-level — exact code structure depends on the current handler; preserve all existing behavior):

```python
# Near other imports at the top of main.py:
from coa.source_resolver import resolve_sources, SenaiteAnalysesHttpReader
from coa.manifest import write_generation_manifest
import uuid as _uuid

@app.post("/wizard/senaite/samples/{sample_id}/generate-coa")
async def generate_sample_coa(
    sample_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not COA_BUILDER_URL:
        return SampleCOAActionResponse(
            success=False,
            message="COA Builder not configured (COA_BUILDER_URL env var not set)",
        )

    # --- BEGIN Phase 1 addition: resolver pre-flight ---
    # Sub-sample IDs route to their own ARs in SENAITE; the resolver is for
    # PARENT-level COA generation only. If the caller is generating a COA
    # against a sub-sample directly, skip the resolver (existing behavior).
    is_sub = bool(re.search(r"-S\d{2,}$", sample_id))
    resolver_result = None
    if not is_sub and SENAITE_URL:
        reader = SenaiteAnalysesHttpReader(
            base_url=SENAITE_URL,
            auth=_get_senaite_auth(current_user),
        )
        try:
            resolver_result = await resolve_sources(sample_id, db, reader)
        except Exception as e:
            # Resolver failure is non-fatal in Phase 1 — log and fall through
            # so we don't regress single-vial generation if SENAITE Analysis
            # endpoint shape differs from expectations.
            log.warning("COA resolver pre-flight failed for %s: %s", sample_id, e)
            resolver_result = None
        if resolver_result is not None and resolver_result.is_blocked:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "unresolved_sources",
                    "message": (
                        "COA cannot be generated until the source for each "
                        "analyte is resolved. See COA Sources panel."
                    ),
                    "unresolved": [
                        {
                            "analyte_keyword": d.analyte_keyword,
                            "blocked": d.blocked,
                            "detail": d.blocked_detail,
                            "candidates_count": len(d.candidates),
                        }
                        for d in resolver_result.decisions
                        if d.blocked is not None
                    ],
                },
            )
    # --- END Phase 1 addition ---

    # ... existing body up through the COABuilder call ...

    # After COABuilder returns successfully and we've parsed `data`:
    #   verification_code, generation_number, pdf_base64 = ...

    # --- BEGIN Phase 1 addition: write manifest ---
    if (
        resolver_result is not None
        and not resolver_result.is_blocked
        and verification_code
        and generation_number
    ):
        # COABuilder/integration-service produces the canonical
        # generation_id (UUID); we read it back via the existing
        # COA generation lookup. For Phase 1 we accept that we may
        # not have the integration-DB UUID handy at this point and
        # write the manifest keyed by a generated UUID; Phase 2 will
        # tighten this by reading back the IS-side row.
        gen_id_str = data.get("generation_id")
        try:
            gen_id = _uuid.UUID(gen_id_str) if gen_id_str else _uuid.uuid4()
        except (TypeError, ValueError):
            gen_id = _uuid.uuid4()
        try:
            write_generation_manifest(
                db,
                generation_id=gen_id,
                generation_number=generation_number,
                result=resolver_result,
            )
        except Exception as e:
            log.warning(
                "COA manifest write failed for %s gen %s: %s",
                sample_id, generation_number, e,
            )
    # --- END Phase 1 addition ---

    # ... existing return path unchanged ...
```

The key constraints:
- **Single-vial happy path is unchanged from the caller's perspective** — the resolver hits the SENAITE Analysis endpoint, finds one candidate per analyte, auto-resolves, and we write a manifest row per analyte. COA still generates; verification code returns as before.
- **Resolver errors do NOT block** — the `except` falls through. We log but don't fail. The intent is no regression on existing behavior; tightening to "resolver MUST succeed" comes in Phase 3 once we have UI to handle the failure.
- **Sub-sample COA generation is left alone** — those routes haven't been touched by the resolver.

- [ ] **Step 3: Verify the import + the file parses**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
import ast
ast.parse(open('/app/main.py').read())
from coa.source_resolver import SenaiteAnalysesHttpReader
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 4: Restart backend**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend
sleep 5
curl -s http://localhost:5530/health
```

Expected: `{"status":"ok",...}`.

- [ ] **Step 5: Smoke test — single-vial parent should still generate COA**

Pick a single-vial parent that already has verified analyses (e.g. one of the parents used in existing peptide-request tests). Trigger COA generation through the normal UI path (Generate Accumark COA on the parent's sample-details page).

Expected:
- COA generates as today.
- One row in `coa_generation_sources` per reportable analyte.
- All rows show `resolution_mode='auto'`, `candidates_count=1`.

Probe:

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-postgres \
  psql -U postgres -d accumark_mk1 -c \
  "SELECT parent_sample_id, generation_number, analyte_keyword, source_sample_id, resolution_mode, candidates_count FROM coa_generation_sources ORDER BY created_at DESC LIMIT 20;"
```

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/coa/source_resolver.py backend/main.py
git commit -m "feat(mk1): wire COA resolver pre-flight + manifest write into generate-coa"
```

---

## Task 9: End-to-end happy-path integration test

**Files:**
- New: `backend/tests/test_coa_generate_resolver.py`

This test exercises the resolver gate against a stubbed COABuilder + SENAITE. It does NOT hit the live services. Marker: `integration` so it runs alongside other integration suites.

- [ ] **Step 1: Write the test (or stub it as `@pytest.mark.xfail` if monkeypatching `httpx.AsyncClient` at the COABuilder boundary is brittle in this repo's harness — flag with a TODO referencing this plan)**

```python
"""Integration test: generate-coa happy path with resolver pre-flight."""

import pytest

pytestmark = pytest.mark.integration


def test_single_vial_happy_path_writes_manifest():
    """
    Given a parent with one HPLC vial and a verified Identity result,
    generate-coa should:
      - call the resolver (auto-resolves to the parent AR)
      - call COABuilder (stubbed)
      - write one CoaGenerationSource row with resolution_mode='auto'
    """
    # Skeleton — flesh out with the project's existing httpx mocking pattern
    # (see test_e2e_peptide_request.py for the COABuilder mock surface).
    pytest.xfail(
        "Phase 1 happy-path integration test stub — fill in once the "
        "COABuilder + SENAITE Analysis mocks are wired. Tracked in "
        "docs/superpowers/plans/2026-06-02-coa-rollup-phase1.md Task 9."
    )
```

- [ ] **Step 2: Run the test (expect xfail → green)**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend \
  bash -c "cd /app && python -m pytest tests/test_coa_generate_resolver.py -v"
```

Expected: 1 xfailed.

- [ ] **Step 3: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add backend/tests/test_coa_generate_resolver.py
git commit -m "test(mk1): COA generate-coa happy-path integration test stub"
```

(The stub captures intent; the real implementation lands when COABuilder mocking is wired or when Phase 2/3 UI work surfaces the live path.)

---

## Task 10: Smoke-verify resolver against a live multi-vial parent (BW-0013)

This task is verification-only — no code changes.

- [ ] **Step 1: Confirm BW-0013's family state**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from models import LimsSample, LimsSubSample
db = SessionLocal()
p = db.query(LimsSample).filter_by(sample_id='BW-0013').one()
print('parent role', p.assignment_role, 'in_variance_set', p.in_variance_set)
for s in db.query(LimsSubSample).filter_by(parent_sample_pk=p.id).order_by(LimsSubSample.vial_sequence):
    print(' sub', s.sample_id, 'role', s.assignment_role, 'in_variance_set', s.in_variance_set)
db.close()
"
```

Expected: parent + 4 sub-samples per session memory.

- [ ] **Step 2: Run the resolver against BW-0013 in a REPL**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
import asyncio
import os
from database import SessionLocal
from auth import _get_senaite_auth  # or whatever import path returns the auth tuple
from coa.source_resolver import resolve_sources, SenaiteAnalysesHttpReader

async def run():
    db = SessionLocal()
    # Use admin auth for the smoke test; production wires per-user auth.
    auth = (
        os.environ.get('SENAITE_ADMIN_USER', 'admin'),
        os.environ.get('SENAITE_ADMIN_PASSWORD', 'admin'),
    )
    reader = SenaiteAnalysesHttpReader(
        base_url=os.environ['SENAITE_URL'], auth=auth,
    )
    result = await resolve_sources('BW-0013', db, reader)
    print('blocked:', result.is_blocked)
    for d in result.decisions:
        print(f'  {d.analyte_keyword:30s} mode={d.mode:6s} blocked={d.blocked} '
              f'cands={len(d.candidates)}')
    db.close()

asyncio.run(run())
"
```

Expected output structure: one line per analyte that BW-0013's family has. For analytes with results on >1 vial (e.g. variance-set HPLC analytes), expect `blocked=needs_decision`. For single-vial analytes (e.g. ENDO on S01 only), expect `mode=auto blocked=None`.

This is the moment that confirms the resolver is doing what the SPEC promised against real data — no UI yet, but the data structure is correct and ambiguity is correctly surfaced.

- [ ] **Step 3: Record the smoke output in a short notes file (optional but useful for Phase 2 UI work)**

```bash
cd C:/tmp/Accu-Mk1-subvial
mkdir -p docs/superpowers/notes
# Paste the smoke output into:
#   docs/superpowers/notes/2026-06-02-coa-resolver-bw-0013.md
# Free-form notes; no commit required unless you want it tracked.
```

---

## Verification (Phase 1 acceptance)

The following must all be true before declaring Phase 1 complete:

- [ ] Three new tables exist and pass `\d` inspection.
- [ ] `models.py` exports `CoaResultPin`, `CoaGenerationSource`, `AnalysisReportable`; all import cleanly.
- [ ] `backend/coa/source_resolver.py` and `backend/coa/manifest.py` exist.
- [ ] `pytest tests/test_coa_source_resolver.py -v` → 7 passed.
- [ ] `pytest tests/test_coa_manifest.py -v` → 2 passed.
- [ ] `pytest tests/test_coa_generate_resolver.py -v` → 1 xfailed (stub).
- [ ] Full test suite still passes except the 7 pre-existing baseline failures documented in the current handoff.
- [ ] Single-vial parent COA generation still works end-to-end via the UI (manual smoke).
- [ ] A row appears in `coa_generation_sources` for each analyte on that generated COA, with `resolution_mode='auto'` and `candidates_count=1`.
- [ ] Multi-vial parent (BW-0013) resolver REPL run shows the expected mix of `auto` and `needs_decision` decisions — confirming the rule fires correctly against real data.

## Risks and unknowns

- **SENAITE Analysis endpoint field names.** The `SenaiteAnalysesHttpReader` assumes `getKeyword`, `Result`, `Unit`, `review_state`. If the actual response uses different keys in this version of SENAITE, Task 8 step 5 will surface it. Adjust the mapping; don't change the resolver contract.
- **`generation_id` UUID from COABuilder response.** The integration-DB writes the row with its own UUID; the COABuilder response shape may or may not include it. Phase 1 falls back to a generated UUID with a log warning so the manifest is still captured (worst case: the manifest is queryable by `parent_sample_id` + `generation_number` but not joinable to the IS-side row). Phase 2 reads the integration-DB to get the canonical UUID and adopts it.
- **`db_session` fixture.** Tests assume a session-scoped fixture; existing variance / sub-sample tests already use one. If the project uses transactional rollback per test, ensure the resolver's `db.commit()` inside the manifest writer doesn't escape — wrap the manifest test in a savepoint if needed.
- **Resolver pre-flight latency.** One HTTP round-trip per AR (parent + N sub-samples). For a family of 5, that's 5 SENAITE calls before COABuilder runs. Acceptable for Phase 1 (manager-triggered, not automated). Phase 4 can introduce a bulk-Analysis endpoint or in-memory cache if the latency becomes a UX issue.

## Open questions for the planner / reviewer

These are SPEC §Open Questions that this phase leaves untouched; flagged here so they're top-of-mind for Phase 2/3 planning:

1. **Default-pin-on-first-verify policy.** Phase 1's resolver does NOT auto-pin. Adopt this in Phase 3 once the pin upsert endpoint exists?
2. **Where the COABuilder contract extension lives.** Phase 1 does not send `result_sources` to COABuilder. Phase 3 needs to coordinate with the coabuilder repo.
3. **Activity-log entry for `coa_generated`.** Phase 1 writes manifest rows but does NOT add a SampleActivityLog entry. Phase 4 adds entries (per SPEC).

## Out of scope (carried forward)

- COA Sources panel UI (Phase 2).
- Pin upsert / delete endpoints, drawer UI, reportable toggle (Phase 3).
- Historical-mode panel reading frozen manifests via UI (Phase 4).
- Activity-log integration (Phase 4).
- Variance-set integration as a resolution mode (Phase 5).
- COABuilder `result_sources` payload extension (Phase 3 cross-repo).
