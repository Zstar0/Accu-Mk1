# Mk1-Native Analyses Phase 4a — Promote-to-Parent Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend side of the two-tier verification act. A new `lims_analysis_promotions` table records which vial-tier rows contributed to a parent-tier canonical result; a new `promote_to_parent` service function performs the atomic INSERT-parent-row + INSERT-promotion-rows + write-audit-rows; a new `POST /api/lims-analyses/promote` exposes it.

**Architecture:** Phase 4a is backend-only — no FE changes. The service derives the parent_sample_pk from the supplied sources' host (sub-sample → parent), validates that all sources are in `to_be_verified` and share the same keyword + parent, then in one DB transaction inserts the parent row in `verified` state, the promotion link rows, and one audit transition per source (state-unchanged `auto` kind with reason `"promoted to parent #N (kind=...)"`). Re-promotion is blocked at the partial-unique-index layer (`uq_lims_analyses_parent_service_root`) — caller must retract the existing parent row first. Phase 4b will rewire the FE supervisor verify action through this endpoint.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres. Mk1's hand-rolled migration list (no Alembic). Same patterns as Phase 1 (table creation), Phase 1's `set_reportable` (audit-only state-unchanged transition), and Phase 3.6 (PATCH-style PUT with `_handle_service_error`).

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"Promotion — the verification act" + §"`lims_analysis_promotions`" + §"Phase 4 acceptance" (first three scenarios are 4a's responsibility; the fourth — retract-after-promotion — is also covered here at the data layer).

**Predecessors:** Phase 1 (state machine + tier guards + `lims_analyses` schema), Phase 2/2.5 (sub-sample creation seeds vial-tier rows), Phase 3/3.5/3.6 (bench-tech FE entry, worksheet inbox source switch, method/instrument editing).

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **Service signature derives parent from sources, not from a parameter.** Caller supplies a list of source `lims_analyses.id`s + a chosen value + per-source `contribution_kind`; the service walks the first source's host (sub-sample's `lims_sample_pk`) to get the parent. Subsequent sources must match. This is harder to mis-call than passing both `parent_sample_pk` AND sources — the source-list IS the parent identity.

2. **State on the vial-tier source rows does NOT change.** Per spec §"Promotion": "Each contributing vial-tier row's audit log gets a `transition_kind='auto'` audit row noting 'promoted to parent #N' (state unchanged on the vial; the run record is preserved as-is)." The audit row has `from_state = to_state = to_be_verified`, kind=`auto`.

3. **Existing `apply_transition(kind='verify')` stays unchanged.** It remains the admin in-place verify path for the rare case where the supervisor wants to verify a vial-tier row WITHOUT promoting (e.g. backfilling historical data). Standard supervisor verify becomes `promote_to_parent`. The state_machine.py comment already documents this seam (lines 109-115).

4. **`contribution_kind` is per-source.** Caller specifies `'chosen'` / `'reference'` / `'aggregated_in'` for each source. Service validates that exactly one of the sources has `'chosen'` OR every source has `'aggregated_in'` (the use-mean path). Mixed `'chosen' + 'aggregated_in'` is rejected.

5. **Re-promotion blocked at the index layer.** The existing partial unique index `uq_lims_analyses_parent_service_root` already enforces "one non-retest parent-tier row per (parent, keyword)". Re-promotion attempts surface as an IntegrityError → translate to 409 Conflict in the route layer. Supervisor must retract the existing parent row first.

6. **Promotion table cascade-deletes from both parent + source.** `ON DELETE CASCADE` on both FKs in `lims_analysis_promotions`: deleting either the parent-tier row or any source-tier row cleans the promotion link automatically. Matches `lims_analysis_transitions`'s cascade pattern.

7. **No FE changes in Phase 4a.** AnalysisTable's "Verify" button continues calling `apply_transition(kind='verify')` on the vial-tier row (no behavior change). VarianceSummary continues to be lock-only. Phase 4b wires the FE to call `/promote` instead. Phase 4a is verifiable end-to-end via curl/TestClient.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (modified):**
- `backend/database.py` — append `lims_analysis_promotions` CREATE TABLE + 2 indexes to the `migrations` list.
- `backend/models.py` — add `LimsAnalysisPromotion` ORM class after `LimsAnalysisTransition`.
- `backend/lims_analyses/schemas.py` — add `PromoteSourceRef`, `PromoteRequest`, `PromotionRow`, `PromoteResponse`.
- `backend/lims_analyses/service.py` — add `promote_to_parent` after `set_method_instrument`.
- `backend/lims_analyses/routes.py` — add `POST /promote` after `patch_method_instrument`; translate `IntegrityError` to 409.
- `backend/tests/test_lims_analyses_service.py` — append service-layer tests.
- `backend/tests/test_lims_analyses_routes.py` — append route-layer tests.

**Out of scope (Phase 4b / later phases):**
- FE supervisor verify wiring (VarianceSummary + AnalysisTable changes).
- Per-vial promotion-status display ("Promoted ✓" badge on vial rows after promotion).
- Resolver default-path rewrite to read parent-tier verified rows (Phase 5).
- Family-state derivation endpoint (Phase 5).
- `senaite_shape` adapter surfacing `promoted_to_parent_id` on vial rows (Phase 4b will need this for the badge; out of scope here).

---

## How to run tests

- Single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Filtered: append `-k <substr>`.
- Full backend: same harness, `tests/`. Baseline at end of Phase 3.6: 444 passed, 27 skipped, 13 baseline failures.

If the backend container was recreated, reinstall pytest:
```bash
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio
```

---

## Task 1: `lims_analysis_promotions` migration + ORM

**Files:**
- Modify: `backend/database.py` (the `migrations` list)
- Modify: `backend/models.py`

- [ ] **Step 1: Append migration SQL**

In `backend/database.py`, find the migration list. After the last lims_analyses-related entry (`CREATE INDEX IF NOT EXISTS ix_lims_analysis_transitions_analysis ...`), append:

```python
        # Phase 4a: promotion link table. Records which vial-tier source rows
        # contributed to a parent-tier canonical result, and how (chosen vs
        # reference vs aggregated_in). Written atomically by promote_to_parent.
        """
        CREATE TABLE IF NOT EXISTS lims_analysis_promotions (
            id                       SERIAL PRIMARY KEY,
            parent_analysis_id       INTEGER NOT NULL
                                     REFERENCES lims_analyses(id) ON DELETE CASCADE,
            source_analysis_id       INTEGER NOT NULL
                                     REFERENCES lims_analyses(id) ON DELETE CASCADE,
            contribution_kind        TEXT NOT NULL
                                     CHECK (contribution_kind IN
                                         ('chosen', 'aggregated_in', 'reference')),
            promoted_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
            promoted_at              TIMESTAMP NOT NULL DEFAULT NOW(),
            reason                   TEXT,
            UNIQUE (parent_analysis_id, source_analysis_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_analysis_promotions_parent ON lims_analysis_promotions (parent_analysis_id)",
        "CREATE INDEX IF NOT EXISTS ix_lims_analysis_promotions_source ON lims_analysis_promotions (source_analysis_id)",
```

- [ ] **Step 2: Append ORM model**

In `backend/models.py`, after `class LimsAnalysisTransition(Base)` (which ends around line 1134), append:

```python
class LimsAnalysisPromotion(Base):
    """Phase 4a: one row per (parent-tier row, contributing vial-tier row).

    Written atomically by promote_to_parent. contribution_kind discriminates:
      'chosen' — this source's value was copied verbatim to the parent row.
      'aggregated_in' — this source was one of N inputs to a computed aggregate.
      'reference' — this source informed the decision but its value isn't part
                    of the parent's result (variance sibling not picked).
    """

    __tablename__ = "lims_analysis_promotions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    parent_analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_analyses.id", ondelete="CASCADE"), nullable=False
    )
    source_analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("lims_analyses.id", ondelete="CASCADE"), nullable=False
    )
    contribution_kind: Mapped[str] = mapped_column(Text, nullable=False)
    promoted_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    promoted_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return (
            f"<LimsAnalysisPromotion(parent_id={self.parent_analysis_id}, "
            f"source_id={self.source_analysis_id}, kind={self.contribution_kind})>"
        )
```

- [ ] **Step 3: Restart backend to apply migration**

```bash
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
echo "backend up"
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1
```

- [ ] **Step 4: Verify table created**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
cols = db.execute(text(\"\"\"
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'lims_analysis_promotions' ORDER BY ordinal_position
\"\"\")).all()
print(f'columns:')
for c in cols:
    print(f'  {c[0]} {c[1]}')
idx = db.execute(text(\"\"\"
    SELECT indexname FROM pg_indexes WHERE tablename = 'lims_analysis_promotions' ORDER BY indexname
\"\"\")).all()
print(f'indexes: {[i[0] for i in idx]}')
db.close()
"
```

Expected: 7 columns (id, parent_analysis_id, source_analysis_id, contribution_kind, promoted_by_user_id, promoted_at, reason); 3+ indexes (pk + 2 named indexes + the implicit unique-constraint index).

- [ ] **Step 5: Verify ORM imports**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from models import LimsAnalysisPromotion
print('imports ok; tablename:', LimsAnalysisPromotion.__tablename__)
print('cols:', sorted(c.name for c in LimsAnalysisPromotion.__table__.columns))
"
```

Expected: `imports ok; tablename: lims_analysis_promotions; cols: ['contribution_kind', 'id', 'parent_analysis_id', 'promoted_at', 'promoted_by_user_id', 'reason', 'source_analysis_id']`

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/database.py backend/models.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1): lims_analysis_promotions table + ORM

Phase 4a Task 1. New link table records which vial-tier rows
contributed to a parent-tier canonical result. ON DELETE CASCADE
on both FKs so deleting either side cleans the promotion link.
contribution_kind enum: chosen / aggregated_in / reference.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Promotion schemas

**Files:**
- Modify: `backend/lims_analyses/schemas.py`

- [ ] **Step 1: Append schemas**

After `SetMethodInstrumentRequest` in `backend/lims_analyses/schemas.py`, add:

```python
class PromoteSourceRef(BaseModel):
    """One contributing vial-tier row for a promote_to_parent call."""
    analysis_id: int
    contribution_kind: Literal["chosen", "aggregated_in", "reference"]


class PromoteRequest(BaseModel):
    """Phase 4a: promote one or more vial-tier rows to a single parent-tier row.

    The parent's identity is derived from the sources' host — every source
    must share the same parent_sample_pk (directly or via sub-sample). The
    keyword must match every source's keyword.

    Caller supplies the chosen result_value + result_unit. method_id /
    instrument_id are optional copies onto the new parent-tier row.

    contribution_kind rules (enforced in the service):
      - Exactly one source with 'chosen'  OR  every source with 'aggregated_in'.
      - 'reference' may accompany 'chosen' but not 'aggregated_in'.
    """
    keyword: str
    result_value: str
    result_unit: Optional[str] = None
    method_id: Optional[int] = None
    instrument_id: Optional[int] = None
    sources: List[PromoteSourceRef] = Field(..., min_length=1)
    reason: Optional[str] = None


class PromotionRow(BaseModel):
    """One lims_analysis_promotions row, returned in PromoteResponse."""
    id: int
    parent_analysis_id: int
    source_analysis_id: int
    contribution_kind: str
    promoted_by_user_id: Optional[int]
    promoted_at: datetime
    reason: Optional[str]

    model_config = ConfigDict(from_attributes=True)


class PromoteResponse(BaseModel):
    """Returns the new parent-tier row and the promotion link rows."""
    parent: AnalysisResponse
    promotions: List[PromotionRow]
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.schemas import PromoteRequest, PromoteResponse, PromoteSourceRef, PromotionRow
print('imports ok; PromoteRequest fields:', sorted(PromoteRequest.model_fields.keys()))
print('PromoteSourceRef fields:', sorted(PromoteSourceRef.model_fields.keys()))
"
```

Expected: `PromoteRequest fields` includes `['instrument_id', 'keyword', 'method_id', 'reason', 'result_unit', 'result_value', 'sources']`; `PromoteSourceRef fields` is `['analysis_id', 'contribution_kind']`.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/schemas.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1): promote_to_parent Pydantic schemas

Phase 4a Task 2. Request/response models for the upcoming
POST /api/lims-analyses/promote endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `promote_to_parent` service function

**Files:**
- Modify: `backend/lims_analyses/service.py`

- [ ] **Step 1: Append the service function**

After `set_method_instrument` in `backend/lims_analyses/service.py` (and BEFORE the `# ─── Phase 3 adapter:` section), add:

```python
def promote_to_parent(
    db: Session,
    *,
    keyword: str,
    result_value: str,
    result_unit: Optional[str],
    method_id: Optional[int],
    instrument_id: Optional[int],
    sources: List[Dict[str, Any]],
    user_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> Tuple[LimsAnalysis, List["LimsAnalysisPromotion"]]:
    """Phase 4a: create a parent-tier verified row from N vial-tier sources.

    sources is a list of {analysis_id: int, contribution_kind: str}. The
    parent_sample_pk is derived from the first source's host (sub-sample →
    parent). All sources must:
      - exist
      - be in 'to_be_verified' state
      - share the same keyword (matching the `keyword` arg)
      - hang off the same parent_sample_pk

    contribution_kind rules:
      - exactly one source with 'chosen'  OR  every source with 'aggregated_in'
      - 'reference' may accompany 'chosen' but not 'aggregated_in'

    Performs in one transaction:
      1. INSERT parent-tier lims_analyses row (review_state='verified',
         verified_at=NOW, analyst_user_id=user_id).
      2. INSERT one lims_analysis_promotions per source.
      3. INSERT one audit transition per source (state-unchanged 'auto'
         kind, reason='promoted to parent #N (kind=...)').

    Raises:
      - BadRequestError on validation failures.
      - sqlalchemy.exc.IntegrityError if an existing non-retest parent-tier
        row for (parent, keyword) blocks the partial unique index. The route
        layer translates this to 409.
    """
    from models import LimsAnalysisPromotion, LimsSubSample

    if not sources:
        raise BadRequestError("promote_to_parent requires at least one source")

    # Contribution-kind validation
    kinds = [s["contribution_kind"] for s in sources]
    n_chosen = sum(1 for k in kinds if k == "chosen")
    n_agg = sum(1 for k in kinds if k == "aggregated_in")
    n_ref = sum(1 for k in kinds if k == "reference")
    if n_agg > 0 and (n_chosen > 0 or n_ref > 0):
        raise BadRequestError(
            "aggregated_in cannot mix with chosen or reference; "
            "use either pick-one (one 'chosen' + Ns of 'reference') "
            "or aggregate (every source 'aggregated_in')"
        )
    if n_agg == 0 and n_chosen != 1:
        raise BadRequestError(
            f"pick-one promotion requires exactly one 'chosen' source; "
            f"got {n_chosen}"
        )

    # Bulk-load source rows
    source_ids = [s["analysis_id"] for s in sources]
    source_rows = {
        r.id: r for r in db.execute(
            select(LimsAnalysis).where(LimsAnalysis.id.in_(source_ids))
        ).scalars().all()
    }
    missing = [sid for sid in source_ids if sid not in source_rows]
    if missing:
        raise NotFoundError(f"source analyses not found: {missing}")

    # Validate every source: keyword + state + same parent_sample_pk
    parent_sample_pk: Optional[int] = None
    for sid in source_ids:
        row = source_rows[sid]
        if row.keyword != keyword:
            raise BadRequestError(
                f"source {sid} has keyword={row.keyword!r}, "
                f"expected {keyword!r}"
            )
        if row.review_state != "to_be_verified":
            raise BadRequestError(
                f"source {sid} is in {row.review_state!r}; "
                f"only 'to_be_verified' rows can be promoted"
            )
        # Derive parent from this source's host
        if row.lims_sub_sample_pk is not None:
            sub = db.get(LimsSubSample, row.lims_sub_sample_pk)
            if sub is None:
                raise NotFoundError(f"sub-sample id={row.lims_sub_sample_pk} not found")
            this_parent_pk = sub.lims_sample_pk
        elif row.lims_sample_pk is not None:
            # Parent-attached vial-tier row (variance case where parent acts
            # as a vial mid-run); its parent_sample_pk is itself.
            this_parent_pk = row.lims_sample_pk
        else:
            raise BadRequestError(
                f"source {sid} has neither lims_sample_pk nor lims_sub_sample_pk"
            )
        if parent_sample_pk is None:
            parent_sample_pk = this_parent_pk
        elif parent_sample_pk != this_parent_pk:
            raise BadRequestError(
                f"sources hang off different parents: "
                f"{parent_sample_pk} vs {this_parent_pk}"
            )

    if parent_sample_pk is None:
        raise BadRequestError("could not derive parent_sample_pk from sources")

    # Inherit analysis_service_id from the first source
    first_source = source_rows[source_ids[0]]
    analysis_service_id = first_source.analysis_service_id
    title = first_source.title

    now = datetime.utcnow()

    # 1. Create parent-tier verified row
    parent_row = LimsAnalysis(
        lims_sample_pk=parent_sample_pk,
        lims_sub_sample_pk=None,
        analysis_service_id=analysis_service_id,
        keyword=keyword,
        title=title,
        result_value=result_value,
        result_unit=result_unit,
        review_state="verified",
        method_id=method_id,
        instrument_id=instrument_id,
        analyst_user_id=user_id,
        verified_at=now,
        created_by_user_id=user_id,
    )
    db.add(parent_row)
    db.flush()  # populate parent_row.id

    # Initial audit row on the parent (consistent with create_analysis)
    db.add(LimsAnalysisTransition(
        analysis_id=parent_row.id,
        from_state=None,
        to_state="verified",
        transition_kind="auto",
        user_id=user_id,
        reason=f"promoted from sources {source_ids}",
    ))

    # 2. Create promotion link rows
    promotion_rows: List[LimsAnalysisPromotion] = []
    for s in sources:
        sid = s["analysis_id"]
        kind = s["contribution_kind"]
        prom = LimsAnalysisPromotion(
            parent_analysis_id=parent_row.id,
            source_analysis_id=sid,
            contribution_kind=kind,
            promoted_by_user_id=user_id,
            promoted_at=now,
            reason=reason,
        )
        db.add(prom)
        promotion_rows.append(prom)

    # 3. Audit row on each source — state-unchanged 'auto'
    for s in sources:
        sid = s["analysis_id"]
        kind = s["contribution_kind"]
        src = source_rows[sid]
        db.add(LimsAnalysisTransition(
            analysis_id=sid,
            from_state=src.review_state,
            to_state=src.review_state,  # unchanged
            transition_kind="auto",
            user_id=user_id,
            reason=f"promoted to parent #{parent_row.id} (kind={kind})",
        ))

    db.commit()
    db.refresh(parent_row)
    for p in promotion_rows:
        db.refresh(p)
    return parent_row, promotion_rows
```

Add to the imports at the top of `service.py` (find the existing `from typing import List, Optional` line) and replace with:

```python
from typing import Any, Dict, List, Optional, Tuple
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from lims_analyses.service import promote_to_parent
import inspect
sig = inspect.signature(promote_to_parent)
print('imports ok; params:', list(sig.parameters.keys()))
"
```

Expected: `imports ok; params: ['db', 'keyword', 'result_value', 'result_unit', 'method_id', 'instrument_id', 'sources', 'user_id', 'reason']`

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1): promote_to_parent service function

Phase 4a Task 3. Atomic creation of a parent-tier verified row from
N vial-tier sources. Validates: at-least-one source, all in
to_be_verified, all same keyword, all hanging off the same parent.
contribution_kind rules: exactly-one 'chosen' OR every 'aggregated_in'.
Writes parent row, N promotion links, and N state-unchanged 'auto'
audit rows in one DB transaction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `POST /api/lims-analyses/promote` route

**Files:**
- Modify: `backend/lims_analyses/routes.py`

- [ ] **Step 1: Extend imports + error translation**

In `backend/lims_analyses/routes.py`, extend the `lims_analyses.schemas` import block to add the new types:

```python
from lims_analyses.schemas import (
    AnalysisResponse,
    AnalysisWithTransitions,
    CreateAnalysisRequest,
    HostKind,
    PromoteRequest,
    PromoteResponse,
    PromotionRow,
    SenaiteShapeAnalysisResponse,
    SetMethodInstrumentRequest,
    SetReportableRequest,
    TransitionInfo,
    TransitionRequest,
)
```

Add SQLAlchemy IntegrityError import at the top alongside the existing SQLAlchemy import:

```python
from sqlalchemy.exc import IntegrityError
```

- [ ] **Step 2: Extend `_handle_service_error` to catch IntegrityError → 409**

Find `_handle_service_error` in `backend/lims_analyses/routes.py`. After the `if isinstance(e, (UnknownStateError, UnknownKindError, UnknownTierError)):` block and BEFORE the `# Unknown — let FastAPI 500 it` comment, add:

```python
    if isinstance(e, IntegrityError):
        # The most common case is the partial unique index on
        # (lims_sample_pk, keyword) WHERE retest_of_id IS NULL — i.e. a
        # parent-tier row already exists for this (parent, analyte).
        return HTTPException(
            status_code=409,
            detail={
                "code": "parent_row_already_exists",
                "message": (
                    "A parent-tier row already exists for this parent + "
                    "keyword. Retract the existing parent row first, then "
                    "re-promote."
                ),
            },
        )
```

- [ ] **Step 3: Add the route**

After `patch_method_instrument` in `backend/lims_analyses/routes.py`, add:

```python
@router.post("/promote", response_model=PromoteResponse, status_code=status.HTTP_201_CREATED)
def promote(
    req: PromoteRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        parent_row, promotion_rows = service.promote_to_parent(
            db,
            keyword=req.keyword,
            result_value=req.result_value,
            result_unit=req.result_unit,
            method_id=req.method_id,
            instrument_id=req.instrument_id,
            sources=[s.model_dump() for s in req.sources],
            user_id=getattr(current_user, "id", None),
            reason=req.reason,
        )
        return PromoteResponse(
            parent=AnalysisResponse.model_validate(parent_row),
            promotions=[PromotionRow.model_validate(p) for p in promotion_rows],
        )
    except Exception as e:
        raise _handle_service_error(e)
```

- [ ] **Step 4: Restart + verify OpenAPI**

```bash
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1
curl -sS http://localhost:5530/openapi.json | python -c "
import json, sys
spec = json.load(sys.stdin)
for p in sorted(spec['paths']):
    if 'lims-analyses' in p:
        print(p, list(spec['paths'][p].keys()))
"
```

Expected: 6 paths total, including `/api/lims-analyses/promote ['post']`.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1): POST /api/lims-analyses/promote

Phase 4a Task 4. Thin HTTP shell over promote_to_parent. Adds
IntegrityError -> 409 translation so re-promotion against an
existing parent-tier row surfaces cleanly to the FE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Service-layer tests

**Files:**
- Modify: `backend/tests/test_lims_analyses_service.py`

- [ ] **Step 1: Append the helper for promotion-test setup**

At the end of `backend/tests/test_lims_analyses_service.py`, append:

```python
# ── Phase 4a: promote_to_parent ─────────────────────────────────────────────


def _make_vial_in_to_be_verified(db, sub, svc, result="98.55"):
    """Helper: create a vial-tier analysis and walk it to to_be_verified."""
    row = _create(db, sub, svc)
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: assign for promote")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value=result, reason="TEST: submit for promote")
    return row


def test_promote_single_vial_creates_parent_row_and_one_promotion(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    from models import LimsAnalysisPromotion
    src = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    parent_row, promotions = promote_to_parent(
        db,
        keyword=src.keyword,
        result_value="98.55",
        result_unit=src.result_unit,
        method_id=None,
        instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        user_id=None,
        reason="TEST: single-vial promote",
    )
    assert parent_row.review_state == "verified"
    assert parent_row.lims_sample_pk == sub_sample.lims_sample_pk
    assert parent_row.lims_sub_sample_pk is None
    assert parent_row.result_value == "98.55"
    assert parent_row.verified_at is not None
    assert len(promotions) == 1
    assert promotions[0].source_analysis_id == src.id
    assert promotions[0].contribution_kind == "chosen"
    # Audit row on the source: state-unchanged 'auto'
    src_audit = db.execute(
        select(LimsAnalysisTransition)
        .where(LimsAnalysisTransition.analysis_id == src.id)
        .order_by(LimsAnalysisTransition.occurred_at.desc())
    ).scalars().first()
    assert src_audit.transition_kind == "auto"
    assert src_audit.from_state == "to_be_verified"
    assert src_audit.to_state == "to_be_verified"
    assert f"promoted to parent #{parent_row.id}" in (src_audit.reason or "")
    # Cleanup: parent row title gets TEST: prefix from _create source, so
    # the autouse cleanup will delete it, cascading to promotions + audits.
    parent_row.title = "TEST: parent " + parent_row.title


def test_promote_variance_pick_one_records_chosen_and_reference(db, sub_sample, analysis_service):
    """Variance HPLC pick-one: 3 vials in to_be_verified, supervisor picks
    one as 'chosen' and the others are 'reference'. Spec Phase 4 acceptance #2."""
    from lims_analyses.service import promote_to_parent
    s1 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service, result="98.4")
    # Pick a second sub-sample under the same parent for s2
    other_sub = db.execute(
        select(LimsSubSample)
        .where(LimsSubSample.id != sub_sample.id)
        .where(LimsSubSample.lims_sample_pk == sub_sample.lims_sample_pk)
    ).scalars().first()
    if other_sub is None:
        pytest.skip("need 2+ sub-samples under the same parent for variance test")
    s2 = _make_vial_in_to_be_verified(db, other_sub, analysis_service, result="98.55")
    parent_row, promotions = promote_to_parent(
        db,
        keyword=s1.keyword,
        result_value="98.55",  # the chosen vial's value
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[
            {"analysis_id": s1.id, "contribution_kind": "reference"},
            {"analysis_id": s2.id, "contribution_kind": "chosen"},
        ],
        reason="TEST: variance pick-one",
    )
    assert len(promotions) == 2
    by_source = {p.source_analysis_id: p.contribution_kind for p in promotions}
    assert by_source[s1.id] == "reference"
    assert by_source[s2.id] == "chosen"
    assert parent_row.result_value == "98.55"
    parent_row.title = "TEST: parent " + parent_row.title


def test_promote_aggregate_three_sources_records_aggregated_in(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    s1 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service, result="98.4")
    s2 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service, result="98.5")
    # Third source on a different sub-sample so the partial unique index on
    # (sub_sample_pk, keyword) doesn't reject — but they must share parent.
    other_sub = db.execute(
        select(LimsSubSample)
        .where(LimsSubSample.id != sub_sample.id)
        .where(LimsSubSample.lims_sample_pk == sub_sample.lims_sample_pk)
    ).scalars().first()
    if other_sub is None:
        pytest.skip("need 2+ sub-samples under the same parent for variance test")
    s3 = _make_vial_in_to_be_verified(db, other_sub, analysis_service, result="98.6")
    parent_row, promotions = promote_to_parent(
        db,
        keyword=s1.keyword,
        result_value="98.5",
        result_unit=None,
        method_id=None,
        instrument_id=None,
        sources=[
            {"analysis_id": s1.id, "contribution_kind": "aggregated_in"},
            {"analysis_id": s2.id, "contribution_kind": "aggregated_in"},
            {"analysis_id": s3.id, "contribution_kind": "aggregated_in"},
        ],
        reason="TEST: aggregate mean",
    )
    assert len(promotions) == 3
    assert all(p.contribution_kind == "aggregated_in" for p in promotions)
    assert parent_row.result_value == "98.5"
    parent_row.title = "TEST: parent " + parent_row.title


def test_promote_rejects_empty_sources(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    with pytest.raises(BadRequestError):
        promote_to_parent(
            db, keyword="X", result_value="1", result_unit=None,
            method_id=None, instrument_id=None, sources=[],
        )


def test_promote_rejects_source_not_in_to_be_verified(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    # Source in 'unassigned' — too early to promote
    row = _create(db, sub_sample, analysis_service)
    with pytest.raises(BadRequestError) as ei:
        promote_to_parent(
            db, keyword=row.keyword, result_value="1", result_unit=None,
            method_id=None, instrument_id=None,
            sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
        )
    assert "to_be_verified" in str(ei.value)


def test_promote_rejects_keyword_mismatch(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    src = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    with pytest.raises(BadRequestError) as ei:
        promote_to_parent(
            db, keyword="DOES-NOT-MATCH", result_value="1", result_unit=None,
            method_id=None, instrument_id=None,
            sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
        )
    assert "keyword" in str(ei.value).lower()


def test_promote_rejects_cross_parent_sources(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    # Pick a sub-sample under a different parent
    other_sub = db.execute(
        select(LimsSubSample).where(
            LimsSubSample.lims_sample_pk != sub_sample.lims_sample_pk
        )
    ).scalars().first()
    if other_sub is None:
        pytest.skip("need a sub-sample under a different parent for cross-parent test")
    s1 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    s2 = _make_vial_in_to_be_verified(db, other_sub, analysis_service)
    with pytest.raises(BadRequestError) as ei:
        promote_to_parent(
            db, keyword=s1.keyword, result_value="1", result_unit=None,
            method_id=None, instrument_id=None,
            sources=[
                {"analysis_id": s1.id, "contribution_kind": "chosen"},
                {"analysis_id": s2.id, "contribution_kind": "reference"},
            ],
        )
    assert "parent" in str(ei.value).lower()


def test_promote_rejects_mixed_aggregated_and_chosen(db, sub_sample, analysis_service):
    from lims_analyses.service import promote_to_parent
    s1 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    with pytest.raises(BadRequestError) as ei:
        promote_to_parent(
            db, keyword=s1.keyword, result_value="1", result_unit=None,
            method_id=None, instrument_id=None,
            sources=[
                {"analysis_id": s1.id, "contribution_kind": "aggregated_in"},
                {"analysis_id": s1.id, "contribution_kind": "chosen"},
            ],
        )
    assert "aggregated_in" in str(ei.value)


def test_promote_blocks_re_promotion_via_unique_index(db, sub_sample, analysis_service):
    """Re-promoting against an existing non-retest parent-tier row raises
    IntegrityError (translated to 409 at the route layer)."""
    from lims_analyses.service import promote_to_parent
    from sqlalchemy.exc import IntegrityError
    src = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    parent_row, _ = promote_to_parent(
        db, keyword=src.keyword, result_value="98.55", result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
    )
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()
    # Second promote with the same parent + keyword — should hit the unique index
    src2 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    with pytest.raises(IntegrityError):
        promote_to_parent(
            db, keyword=src2.keyword, result_value="99.0", result_unit=None,
            method_id=None, instrument_id=None,
            sources=[{"analysis_id": src2.id, "contribution_kind": "chosen"}],
        )
    db.rollback()  # leave the session clean for autouse cleanup


def test_promote_succeeds_again_after_parent_row_retracted(db, sub_sample, analysis_service):
    """Spec Phase 4 acceptance #4: retract-after-promotion clears the unique-
    index hold, and a fresh promote on a new vial succeeds.

    Retract: admin path that transitions the parent-tier row from 'verified'
    to 'retracted'. The partial unique index still references 'retracted' rows,
    so retract alone doesn't free the slot — the row must be removed OR its
    retest_of_id must be set. Here we test the cleaner path: delete the
    retracted parent row, which cascade-cleans the promotion link.

    NOTE: the spec leaves the "soft retract" UX flow for Phase 4b. Phase 4a's
    contract is just that the data model allows a clean recovery path.
    """
    from lims_analyses.service import promote_to_parent, apply_transition
    src = _make_vial_in_to_be_verified(db, sub_sample, analysis_service)
    parent_row, _ = promote_to_parent(
        db, keyword=src.keyword, result_value="98.55", result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
    )
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()

    # Admin retract: 'verified' -> 'retracted' on the parent-tier row.
    retracted = apply_transition(db, analysis_id=parent_row.id, kind="retract",
                                 reason="TEST: admin retract for re-promote")
    assert retracted.review_state == "retracted"

    # Delete the retracted row so the partial unique index frees up.
    db.delete(retracted)
    db.commit()

    # Now a fresh promotion on a new vial should succeed.
    src2 = _make_vial_in_to_be_verified(db, sub_sample, analysis_service, result="99.0")
    parent_row2, _ = promote_to_parent(
        db, keyword=src2.keyword, result_value="99.0", result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src2.id, "contribution_kind": "chosen"}],
    )
    assert parent_row2.review_state == "verified"
    assert parent_row2.id != parent_row.id
    parent_row2.title = "TEST: parent " + parent_row2.title
```

- [ ] **Step 2: Run tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_service.py -v -k 'promote' 2>&1 | tail -25"
```

Expected: 10 tests collected; 8+ passed (2 may skip if the env lacks 2 sub-samples under the same parent / a cross-parent sub-sample).

If any UNEXPECTED failure appears, stop and investigate — don't paper over with skips.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_lims_analyses_service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(mk1): promote_to_parent service coverage

Phase 4a Task 5. 10 service-layer tests: single-vial, variance-pick-one,
aggregate-3, empty-sources, wrong-state, keyword-mismatch, cross-parent,
mixed-kind, re-promotion-blocked, retract-then-re-promote.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Route-layer tests

**Files:**
- Modify: `backend/tests/test_lims_analyses_routes.py`

- [ ] **Step 1: Append route tests**

At the end of `backend/tests/test_lims_analyses_routes.py`, append:

```python
# ── Phase 4a: POST /promote ─────────────────────────────────────────────────


def _walk_to_to_be_verified(aid: int, result: str = "98.55"):
    """Helper: assign + submit a freshly-created analysis via HTTP."""
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "assign", "reason": "HTTP-TEST: assign"})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/lims-analyses/{aid}/transitions",
                    json={"kind": "submit", "result_value": result,
                          "reason": "HTTP-TEST: submit"})
    assert r.status_code == 200, r.text


def test_promote_endpoint_happy_path_single_vial(sub_sample, analysis_service):
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    aid = created["id"]
    _walk_to_to_be_verified(aid)
    r = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
            "reason": "HTTP-TEST: promote single",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["parent"]["review_state"] == "verified"
    assert body["parent"]["lims_sub_sample_pk"] is None
    assert len(body["promotions"]) == 1
    # Cleanup: rename so autouse cleanup picks up the parent row
    db = SessionLocal()
    parent_id = body["parent"]["id"]
    db.execute(text("UPDATE lims_analyses SET title = 'HTTP-TEST: ' || title WHERE id = :id"),
               {"id": parent_id})
    db.commit()
    db.close()


def test_promote_endpoint_empty_sources_returns_422():
    """Pydantic validates min_length=1 on sources — 422 before service runs."""
    r = client.post(
        "/api/lims-analyses/promote",
        json={"keyword": "X", "result_value": "1", "sources": []},
    )
    assert r.status_code == 422, r.text


def test_promote_endpoint_missing_source_returns_404(sub_sample, analysis_service):
    r = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "1",
            "sources": [{"analysis_id": 99_999_999, "contribution_kind": "chosen"}],
        },
    )
    assert r.status_code == 404, r.text


def test_promote_endpoint_409_on_existing_parent_row(sub_sample, analysis_service):
    """Re-promoting against an existing parent-tier row hits the partial
    unique index and surfaces as 409 with code=parent_row_already_exists."""
    # First promote
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    _walk_to_to_be_verified(created["id"])
    r1 = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "98.55",
            "sources": [{"analysis_id": created["id"], "contribution_kind": "chosen"}],
        },
    )
    assert r1.status_code == 201, r1.text
    parent_id = r1.json()["parent"]["id"]

    # Second promote with same (parent, keyword)
    created2 = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    _walk_to_to_be_verified(created2["id"])
    r2 = client.post(
        "/api/lims-analyses/promote",
        json={
            "keyword": analysis_service.keyword,
            "result_value": "99.0",
            "sources": [{"analysis_id": created2["id"], "contribution_kind": "chosen"}],
        },
    )
    assert r2.status_code == 409, r2.text
    assert r2.json()["detail"]["code"] == "parent_row_already_exists"

    # Cleanup: rename parent row
    db = SessionLocal()
    db.execute(text("UPDATE lims_analyses SET title = 'HTTP-TEST: ' || title WHERE id = :id"),
               {"id": parent_id})
    db.commit()
    db.close()
```

Also at the top of the file, add the `text` import:

```python
from sqlalchemy import delete, select, text
```

- [ ] **Step 2: Run tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_routes.py -v -k 'promote' 2>&1 | tail -15"
```

Expected: 4 tests, all passed.

Important: between test runs, the autouse cleanup wipes `HTTP-TEST:%` rows. If a test fails partway through and leaves an orphan parent-tier row WITHOUT the `HTTP-TEST:` prefix, subsequent runs will hit the 409. Fix: in that case manually delete via psql or rename the orphan to start with `HTTP-TEST:`.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_lims_analyses_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(mk1): POST /api/lims-analyses/promote endpoint coverage

Phase 4a Task 6. 4 route tests: happy single-vial, 422 on empty
sources, 404 on missing source, 409 on re-promotion against an
existing parent-tier row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full suite + live HTTP smoke

Verification-only — no commit.

- [ ] **Step 1: Full backend suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -q --tb=no 2>&1 | tail -5"
```

Expected: at least 454 passed (was 444 at end of Phase 3.6; Phase 4a adds 10 service + 4 route = 14 new, minus the 2 that may skip in envs lacking ≥2 sub-samples under one parent / a cross-parent sub-sample). Floor: 452 passed. 13 baseline failures unchanged. Zero new regressions.

- [ ] **Step 2: End-to-end HTTP smoke through live uvicorn**

```bash
docker exec accumark-subvial-accu-mk1-backend bash -c "cat > /app/_smoke_p4a.py << 'PYEOF'
from sqlalchemy import select, delete, text
from database import SessionLocal
from main import app
from auth import get_current_user
from models import (
    LimsSample, LimsSubSample, LimsAnalysis, LimsAnalysisTransition,
    LimsAnalysisPromotion, HplcMethod, Instrument,
)
from sub_samples.photo_storage import get_storage
from sub_samples import service as ss, senaite
from lims_analyses.service import apply_transition
from fastapi.testclient import TestClient

# Pick a parent + create a fresh vial under it
db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == 'BW-0013')).scalar_one()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub = ss.create_sub_sample(db, parent.sample_id, png, 'p4a.png', 'P4a smoke', 1)
ss.set_assignment_role(db, sub.sample_id, 'endo')
db.refresh(sub)

# Walk the vial's endo analysis to to_be_verified
endo = db.execute(
    select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub.id)
).scalars().first()
apply_transition(db, analysis_id=endo.id, kind='assign', reason='smoke: assign')
apply_transition(db, analysis_id=endo.id, kind='submit', result_value='<0.5 EU/mg', reason='smoke: submit')
print(f'setup: sub={sub.sample_id} endo_id={endo.id} parent_pk={parent.id}')
db.close()

class _U:
    id = 1
app.dependency_overrides[get_current_user] = lambda: _U()
with TestClient(app) as c:
    # Promote endo to parent
    r = c.post('/api/lims-analyses/promote', json={
        'keyword': endo.keyword,
        'result_value': '<0.5 EU/mg',
        'result_unit': 'EU/mg',
        'sources': [{'analysis_id': endo.id, 'contribution_kind': 'chosen'}],
        'reason': 'smoke: promote endo single-vial',
    })
    print(f'POST /promote -> {r.status_code}')
    j = r.json()
    if r.status_code == 201:
        parent_row = j['parent']
        promotions = j['promotions']
        print(f'  parent.id={parent_row[\"id\"]} state={parent_row[\"review_state\"]} value={parent_row[\"result_value\"]!r}')
        print(f'  promotions: {len(promotions)} row(s); first kind={promotions[0][\"contribution_kind\"]}')

        # Verify the source has an audit row, state unchanged
        r2 = c.get(f'/api/lims-analyses/{endo.id}')
        src = r2.json()
        last_txn = src['transitions'][-1]
        print(f'  source state still={src[\"review_state\"]}; last audit kind={last_txn[\"transition_kind\"]} reason={last_txn[\"reason\"]!r}')

        # Re-promotion should 409
        r3 = c.post('/api/lims-analyses/promote', json={
            'keyword': endo.keyword,
            'result_value': '<0.6',
            'sources': [{'analysis_id': endo.id, 'contribution_kind': 'chosen'}],
        })
        print(f'  re-promote -> {r3.status_code} code={r3.json().get(\"detail\", {}).get(\"code\")}')
    else:
        print(f'  FAIL body={j}')

# Cleanup: delete the parent row (cascade kills promotions + transitions),
# delete vial analyses, delete sub-sample, delete photo, delete SENAITE secondary.
db = SessionLocal()
if r.status_code == 201:
    db.execute(text('DELETE FROM lims_analyses WHERE id = :id'), {'id': parent_row['id']})
get_storage().delete_photo(sub.photo_external_uid[len('mk1://'):])
aids = db.execute(select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk == sub.id)).scalars().all()
if aids:
    db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id.in_(aids)))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(aids)))
db.execute(delete(LimsSubSample).where(LimsSubSample.id == sub.id))
db.commit()
try:
    senaite.delete_secondary(sub.external_lims_uid)
except Exception:
    pass
db.close()
print('CLEAN')
PYEOF
python /app/_smoke_p4a.py; rc=\$?; rm -f /app/_smoke_p4a.py; exit \$rc"
```

Expected:
- `POST /promote -> 201`
- `parent.id=<N> state=verified value='<0.5 EU/mg'`
- `promotions: 1 row(s); first kind=chosen`
- `source state still=to_be_verified; last audit kind=auto reason='promoted to parent #N (kind=chosen)'`
- `re-promote -> 409 code=parent_row_already_exists`
- `CLEAN`

- [ ] **Step 3: psql sanity — promotion table populated then cleaned**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
n = db.execute(text('SELECT COUNT(*) FROM lims_analysis_promotions')).scalar()
print(f'lims_analysis_promotions row count after smoke: {n}')
db.close()
"
```

Expected: 0 (the smoke's CLEAN step cascade-deletes everything). If non-zero, a prior run left orphans — fine for the live stack but flag it for the user.

---

## Verification (Phase 4a acceptance)

- [ ] **`lims_analysis_promotions` table exists with correct columns + indexes** (Task 1 Step 4)
- [ ] **`LimsAnalysisPromotion` ORM imports** (Task 1 Step 5)
- [ ] **`PromoteRequest` / `PromoteResponse` / `PromoteSourceRef` / `PromotionRow` schemas import** (Task 2 Step 2)
- [ ] **`promote_to_parent` service: single-vial creates parent row + 1 promotion + audit on source** (Task 5 + Task 7 smoke)
- [ ] **`promote_to_parent` service: aggregate-3 records 3 'aggregated_in' rows** (Task 5)
- [ ] **`promote_to_parent` service: variance pick-one records 1 chosen + N reference** (Task 5)
- [ ] **`promote_to_parent` service: empty / wrong-state / keyword-mismatch / cross-parent / mixed-kind → BadRequestError** (Task 5)
- [ ] **`promote_to_parent` service: re-promotion raises IntegrityError; retract-then-re-promote succeeds** (Task 5 + Task 7 smoke)
- [ ] **`POST /api/lims-analyses/promote` returns 201 with parent + promotions body** (Task 6 + Task 7 smoke)
- [ ] **`POST /api/lims-analyses/promote`: 422 empty sources, 404 missing source, 409 re-promotion** (Task 6 + Task 7 smoke)
- [ ] **Vial-tier source row's review_state stays `to_be_verified` after promotion; new audit row records the promotion** (Task 7 smoke)
- [ ] **Full backend suite ≥ 452 passed, 13 baseline failures unchanged, zero regressions** (Task 7 Step 1)

---

## Risks and unknowns

- **Phase 4b's FE will need to surface "this vial has been promoted" somehow** — otherwise the AnalysisTable shows a vial perpetually in `to_be_verified` even though the supervisor verified it. Options: extend the `senaite_shape` adapter to join `lims_analysis_promotions` and emit a `promoted_to_parent_id` field; or add a sibling endpoint `GET /api/lims-analyses/{id}/promotions`. Phase 4b decision.

- **The `parent` field on the new parent-tier row inherits `analysis_service_id` + `title` from the first source.** If the supervisor promotes from a mixed-method set (rare; same analyte, different method per vial), the title may be inaccurate. Acceptable for Phase 4a; tighten in Phase 4b if needed.

- **`apply_transition(kind='verify')` is still wired and still moves a vial-tier row to `verified` state in place.** This bypasses `promote_to_parent` entirely. Phase 4a doesn't break it (admin path remains). Phase 4b should consider deprecating the vial-tier `verify` path or rerouting it through `promote_to_parent`. Open question for Phase 4b.

- **The partial unique index on `(lims_sample_pk, keyword)` blocks re-promotion but ALSO blocks the legitimate case of multiple analytes per parent.** It's `keyword`-scoped, so different keywords coexist — only same-keyword re-promotion is blocked. This is the intended behavior; documented here so a reader doesn't second-guess.

- **`LimsAnalysisPromotion` has no back-relationship to `LimsAnalysis`.** Keeping the ORM minimal — promotions are queried directly via the FKs, not navigated through the parent's `relationship()`. If Phase 5's resolver wants `analysis.promotions`, add the relationship there.

- **Promotion rows DO get cleaned up via cascade when the parent-tier row deletes** — verified in the smoke's CLEAN step. But there's no separate "unpromote" endpoint. To unwind a promotion, the supervisor retracts the parent-tier row (which cascade-deletes the promotion rows) and starts over. Phase 4b can layer a softer "edit" affordance if needed.

## Open questions (carried to Phase 4b)

1. **Should `apply_transition(kind='verify')` on a vial-tier row be deprecated, or stay as an admin path?**
2. **How does the FE surface vial-tier-row promotion status — adapter field, sibling endpoint, or per-row badge?**
3. **VarianceSummary post-lock behavior — does "lock" disable the variance set OR does locking auto-promote with the mean?**
4. **Single-vial verify UI affordance — one-click "Verify" button (calls /promote with chosen kind=chosen) replaces the existing transitionAnalysis verify call?**

## Out of scope (carried forward)

- All FE changes (Phase 4b).
- COA resolver default-path rewrite (Phase 5).
- Family-state derivation + WP signaling (Phase 5).
- Customer prelim-COA opt-in (Phase 6).
