# Mk1-Native Analyses Phase 5b — Family-State Derivation Endpoint

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the family-state derivation endpoint `GET /api/families/{parent_sample_id}/state`. Returns a single enum value (`pending` / `to_be_verified` / `waiting_for_addon_results` / `verified` / `published`) plus a per-analyte breakdown showing what's settled vs in flight. This is the foundation IS will subscribe to in Phase 5c for WP signaling, and the same state powers a customer-facing progress indicator on the parent sample detail page later.

**Architecture:** A pure derivation function `derive_family_state(db, parent_sample_id) -> FamilyStateView` runs a single aggregate query over `lims_analyses` for the parent + all its sub-samples, partitions rows into `parent_tier_by_keyword` and `vial_tier_by_keyword`, then applies the 5-rule precedence ladder from the spec. HPLC vs addon classification uses a keyword-prefix heuristic (`ENDO-*` / `STER-*` are addons, rest is HPLC) — extensible to a service-group-based classifier in Phase 5c if needed. The HTTP route is a thin Pydantic shell. No DB schema changes, no FE work, no cross-repo changes.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Postgres. Pure read endpoint; no writes.

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"Family state derivation" (lines 175-203) + §"Phase 5 acceptance" scenario #3 ("Family-state endpoint returns `waiting_for_addon_results` for a parent whose HPLC parent-tier row is verified but whose endo parent-tier row hasn't been promoted yet").

**Predecessors:** Phase 4a (parent-tier `lims_analyses` rows + `promote_to_parent` so there's something to derive from). Phase 5a (resolver default-path — not strictly required by 5b but they share the parent-tier-row concept).

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **HPLC vs addon classifier is keyword-prefix-based.** `ENDO-*` and `STER-*` keywords are addons; everything else is HPLC. This matches the Phase 2 seeder's `assignment_role → keyword` mapping (`endo role → ENDO-LAL`, `ster role → STER-PCR`, `hplc role → all other analytes`). A more rigorous classifier — looking up `analysis_services.service_group_id` — is a Phase 5c refinement when WP signaling needs to be water-tight. For Phase 5b the heuristic is correct for every keyword in production today.

2. **"Required analytes" = union of analyte keywords seen anywhere in `lims_analyses` for this family.** Per the spec deferred decision in Phase 5a, the order-profile lookup is too speculative without IS coordination. Phase 5b uses what's in the DB: if there's no row for an analyte (Mk1 parent-tier OR vial-tier OR SENAITE), it's not "required" for derivation purposes. This is conservative — a family with no analyses at all returns `pending`.

3. **`verified` requires every keyword seen anywhere to have a parent-tier verified-or-published row.** Per the spec rule. If a vial-tier row exists for keyword K but no parent-tier row, the family is NOT in `verified` state — it's in `to_be_verified` (or `pending` if the vial is earlier-stage).

4. **`published` requires every parent-tier row to be in `published` state** (not `verified`). One non-published row keeps the family in `verified`. Matches the spec's "every parent-tier row published" rule.

5. **SENAITE parent-AR analyses are queried via the existing reader and merged.** Same shape as Phase 5a — SENAITE results count toward "what keywords exist" (required analytes) but a SENAITE analysis in `verified` state does NOT count as a parent-tier verified row (only Mk1 parent-tier rows do, per the spec). This means a SENAITE-only parent (no Mk1 rows) always returns `pending` or `to_be_verified` if there's vial activity, or `verified` only when every SENAITE analyte has a `verified` state — handled by the legacy SENAITE path within the same derivation.

   Actually — re-reading the spec line 185-186: "SENAITE parent AR analyses where reportable=true (until parent analyses migrate to Mk1)". SENAITE analyses' review_state DOES count for parent-tier signal in legacy mode. So: a SENAITE analysis in `verified` state contributes to "this analyte is settled" the same way a Mk1 parent-tier `verified` row would. This is the transition-window concession: legacy SENAITE analyses can be the canonical verified result for an analyte if no Mk1 row exists for it. This rule applies to derivation, not to the resolver (which already merges them).

6. **Endpoint path: `GET /api/families/{parent_sample_id}/state`.** Per the spec exactly. The path parameter is the human-readable sample_id (e.g. `BW-0013`), matching the resolver's `parent_sample_id` convention. 404 if the parent_sample_id doesn't exist in `lims_samples` AND has zero SENAITE analyses (i.e., we can't compute state for an unknown family).

7. **No FE changes.** The endpoint is for IS consumption + future FE indicators; Phase 5b only ships the backend contract.

8. **No event emission.** WP signaling (firing events on state transitions) is Phase 5c. Phase 5b's endpoint is a pull-only API. IS can poll for 5c interim.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (created):**
- `backend/families/__init__.py` (CREATE) — package marker.
- `backend/families/schemas.py` (CREATE) — `FamilyState` enum literal, `AnalyteBreakdown`, `FamilyStateResponse` Pydantic models.
- `backend/families/service.py` (CREATE) — `derive_family_state(db, parent_sample_id, senaite_reader) -> FamilyStateResponse`. Pure derivation logic.
- `backend/families/routes.py` (CREATE) — `GET /api/families/{parent_sample_id}/state` HTTP shell.

**Backend (modified):**
- `backend/main.py` — register the new `families.routes.router`.

**Tests (created):**
- `backend/tests/test_families_service.py` (CREATE) — unit tests for `derive_family_state` with synthetic DB fixtures.
- `backend/tests/test_families_routes.py` (CREATE) — HTTP-level tests for the new route.

**Out of scope (Phase 5c / later):**
- WP signaling event emission on family-state transitions (Phase 5c).
- IS consumer for the events (Phase 5c, cross-repo).
- Stricter HPLC/addon classifier (service_group-based) (Phase 5c if needed).
- FE family-state badge on parent SampleDetails page (later phase).
- Required-analytes-from-order-profile check (deferred indefinitely — current heuristic covers production).

---

## How to run tests

- Single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Full backend: same harness, `tests/`. Baseline at end of Phase 5a: 472 passed, 27 skipped, 13 baseline failures.

---

## Task 1: Pydantic schemas

**Files:**
- Create: `backend/families/__init__.py`
- Create: `backend/families/schemas.py`

- [ ] **Step 1: Create the package marker**

```bash
docker exec accumark-subvial-accu-mk1-backend bash -c "touch /app/families/__init__.py 2>/dev/null || mkdir -p /app/families && touch /app/families/__init__.py"
```

The package needs to exist in the bind-mounted source tree too. The directory will be created by the Write below.

Write `backend/families/__init__.py` (empty file):

```python
```

- [ ] **Step 2: Write the schemas**

Write `backend/families/schemas.py`:

```python
"""Pydantic models for the family-state endpoint.

Family state aggregates `lims_analyses` for {parent + all subs} into a
single enum value summarizing where the family is in the workflow. The
breakdown lets callers (IS, FE) inspect WHY the family is in that state
without re-running the derivation themselves.
"""

from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


FamilyState = Literal[
    "pending",
    "to_be_verified",
    "waiting_for_addon_results",
    "verified",
    "published",
]


class AnalyteBreakdown(BaseModel):
    """Per-analyte facts that drove the family-state decision.

    `keyword` is the analyte (e.g. 'ENDO-LAL', 'IDENTITY_HPLC').
    `is_hplc` discriminates HPLC vs addon — drives waiting_for_addon_results.
    `parent_state` is the parent-tier row's review_state if one exists,
    else None. (Sourced from Mk1 lims_analyses OR legacy SENAITE.)
    `vial_states` is the multiset of vial-tier review_states for this
    analyte across all sub-samples — used to discriminate pending vs
    to_be_verified.
    """
    keyword: str
    is_hplc: bool
    parent_state: Optional[str] = None
    vial_states: List[str] = Field(default_factory=list)


class FamilyStateResponse(BaseModel):
    """`GET /api/families/{parent_sample_id}/state` response."""
    parent_sample_id: str
    state: FamilyState
    analytes: List[AnalyteBreakdown]
```

- [ ] **Step 3: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from families.schemas import FamilyState, AnalyteBreakdown, FamilyStateResponse
print('imports ok')
print('FamilyState literals:', FamilyState)
print('FamilyStateResponse fields:', sorted(FamilyStateResponse.model_fields.keys()))
"
```

Expected: imports ok, FamilyState literal is the 5-state union, `FamilyStateResponse fields: ['analytes', 'parent_sample_id', 'state']`.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/families/__init__.py backend/families/schemas.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(families): Pydantic schemas for family-state endpoint

Phase 5b Task 1. FamilyState literal (5 enum values from the spec),
AnalyteBreakdown (per-analyte facts that drove the decision),
FamilyStateResponse for GET /api/families/{id}/state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `derive_family_state` service function

**Files:**
- Create: `backend/families/service.py`

- [ ] **Step 1: Write the service**

```python
"""Family-state derivation. Pure read function over lims_analyses + the
optional SENAITE proxy for legacy parent-AR analyses.

The function is intentionally split out from the route so it can be unit-
tested in isolation, called from Phase 5c event-emission paths, and
re-used by future FE consumers without re-implementing the rule.

Spec: docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md
§"Family state derivation" lines 175-203.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from families.schemas import AnalyteBreakdown, FamilyState, FamilyStateResponse
from models import LimsAnalysis, LimsSample, LimsSubSample


class SenaiteAnalysesReader(Protocol):
    """Same Protocol shape as coa.source_resolver — duck-typed."""
    async def list_for_sample(self, sample_id: str) -> List[Dict]:  # pragma: no cover
        ...


# ─── HPLC classifier ─────────────────────────────────────────────────────────

# Phase 5b heuristic: keywords starting with ENDO- or STER- are addons.
# Everything else is HPLC. This matches the Phase 2 seeder's role→keyword
# mapping: endo role seeds ENDO-LAL, ster role seeds STER-PCR, hplc role
# seeds the analyte-specific keywords (IDENTITY_*, BPC-*, etc).
# Phase 5c may switch to a service_group-based classifier if needed.
_ADDON_PREFIXES = ("ENDO-", "STER-")


def _is_hplc(keyword: str) -> bool:
    return not keyword.upper().startswith(_ADDON_PREFIXES)


# ─── Internal: gather per-analyte facts ──────────────────────────────────────


def _gather_analytes(
    db: Session,
    parent: LimsSample,
    senaite_parent_payload: List[Dict],
) -> Dict[str, AnalyteBreakdown]:
    """Build {keyword: AnalyteBreakdown} merging:
      - Mk1 parent-tier rows (parent.id, lims_sub_sample_pk IS NULL)
      - Mk1 vial-tier rows (parent.id, sub-samples)
      - SENAITE parent-AR analyses (legacy)

    For SENAITE-only analytes, parent_state comes from the SENAITE
    review_state. A Mk1 parent-tier row shadows SENAITE for the same
    keyword (Mk1 is the canonical source post-Phase-4).
    """
    breakdown: Dict[str, AnalyteBreakdown] = {}

    # Mk1 parent-tier rows
    parent_rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sample_pk == parent.id,
            LimsAnalysis.reportable == True,  # noqa: E712
            LimsAnalysis.retest_of_id.is_(None),
        )
    ).scalars().all()
    for r in parent_rows:
        breakdown[r.keyword] = AnalyteBreakdown(
            keyword=r.keyword,
            is_hplc=_is_hplc(r.keyword),
            parent_state=r.review_state,
            vial_states=[],
        )

    # Mk1 vial-tier rows (on sub-samples)
    sub_ids = [
        s.id for s in db.execute(
            select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
        ).scalars().all()
    ]
    if sub_ids:
        vial_rows = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sub_sample_pk.in_(sub_ids),
                LimsAnalysis.reportable == True,  # noqa: E712
                LimsAnalysis.retest_of_id.is_(None),
            )
        ).scalars().all()
        for r in vial_rows:
            ab = breakdown.setdefault(r.keyword, AnalyteBreakdown(
                keyword=r.keyword,
                is_hplc=_is_hplc(r.keyword),
                parent_state=None,
                vial_states=[],
            ))
            ab.vial_states.append(r.review_state)

    # SENAITE parent-AR analyses (legacy). Mk1 parent-tier row shadows.
    for an in senaite_parent_payload:
        kw = an.get("keyword")
        state = an.get("review_state")
        if not kw or not state:
            continue
        if kw in breakdown and breakdown[kw].parent_state is not None:
            # Mk1 parent-tier row already captured — SENAITE shadowed.
            continue
        ab = breakdown.setdefault(kw, AnalyteBreakdown(
            keyword=kw,
            is_hplc=_is_hplc(kw),
            parent_state=None,
            vial_states=[],
        ))
        # SENAITE-derived parent_state. Treat 'verified' / 'published' as
        # parent-tier-equivalent for this analyte (transition-window rule).
        ab.parent_state = state

    return breakdown


# ─── Derivation: apply the precedence ladder ─────────────────────────────────


_PARENT_SETTLED = ("verified", "published")
_VIAL_PENDING = ("unassigned", "assigned")


def _derive_state(analytes: Dict[str, AnalyteBreakdown]) -> FamilyState:
    """Apply the spec's precedence ladder. Earliest match wins.

    If `analytes` is empty (no rows anywhere for this family), the family
    is `pending` — nothing has happened yet.
    """
    if not analytes:
        return "pending"

    # Helper predicates per analyte
    def is_settled(ab: AnalyteBreakdown) -> bool:
        return ab.parent_state in _PARENT_SETTLED

    def is_published(ab: AnalyteBreakdown) -> bool:
        return ab.parent_state == "published"

    def has_pending_vial(ab: AnalyteBreakdown) -> bool:
        return any(v in _VIAL_PENDING for v in ab.vial_states)

    def has_to_be_verified_vial(ab: AnalyteBreakdown) -> bool:
        return any(v == "to_be_verified" for v in ab.vial_states)

    # Rule 1: pending — any unsettled analyte has unassigned/assigned vial
    for ab in analytes.values():
        if not is_settled(ab) and has_pending_vial(ab):
            return "pending"

    # Rule 2: to_be_verified — any unsettled analyte has to_be_verified vial
    for ab in analytes.values():
        if not is_settled(ab) and has_to_be_verified_vial(ab):
            return "to_be_verified"

    # Rule 3: waiting_for_addon_results — every HPLC settled AND any addon unsettled
    hplc_settled = all(
        is_settled(ab) for ab in analytes.values() if ab.is_hplc
    )
    has_unsettled_addon = any(
        not is_settled(ab) for ab in analytes.values() if not ab.is_hplc
    )
    has_any_hplc = any(ab.is_hplc for ab in analytes.values())
    if has_any_hplc and hplc_settled and has_unsettled_addon:
        return "waiting_for_addon_results"

    # Rule 4 / 5: verified vs published — every analyte settled
    if all(is_settled(ab) for ab in analytes.values()):
        if all(is_published(ab) for ab in analytes.values()):
            return "published"
        return "verified"

    # Fallback: any unsettled analyte with no vial activity → pending
    # (e.g. an addon row exists at the SENAITE level but no Mk1 vials yet).
    return "pending"


# ─── Public ──────────────────────────────────────────────────────────────────


class FamilyNotFoundError(LookupError):
    """Raised when no parent + no SENAITE candidates exist for the given id."""


async def derive_family_state(
    db: Session,
    parent_sample_id: str,
    senaite_reader: SenaiteAnalysesReader,
) -> FamilyStateResponse:
    """Compute family state for a parent_sample_id.

    Raises FamilyNotFoundError if the parent has no Mk1 row AND the
    SENAITE reader returns nothing — we can't infer state for a family
    we've never heard of.
    """
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)
    ).scalar_one_or_none()

    senaite_payload: List[Dict] = await senaite_reader.list_for_sample(parent_sample_id)

    if parent is None and not senaite_payload:
        raise FamilyNotFoundError(
            f"no parent {parent_sample_id!r} in lims_samples and no SENAITE analyses"
        )

    if parent is None:
        # SENAITE-only: build breakdown directly from the SENAITE payload.
        analytes: Dict[str, AnalyteBreakdown] = {}
        for an in senaite_payload:
            kw = an.get("keyword")
            state = an.get("review_state")
            if not kw:
                continue
            analytes[kw] = AnalyteBreakdown(
                keyword=kw,
                is_hplc=_is_hplc(kw),
                parent_state=state,
                vial_states=[],
            )
    else:
        analytes = _gather_analytes(db, parent, senaite_payload)

    state = _derive_state(analytes)
    return FamilyStateResponse(
        parent_sample_id=parent_sample_id,
        state=state,
        analytes=sorted(analytes.values(), key=lambda a: a.keyword),
    )
```

- [ ] **Step 2: Verify import**

```bash
docker exec accumark-subvial-accu-mk1-backend python -c "
from families.service import derive_family_state, _derive_state, _is_hplc, FamilyNotFoundError
print('imports ok')
print('_is_hplc(ENDO-LAL):', _is_hplc('ENDO-LAL'))
print('_is_hplc(STER-PCR):', _is_hplc('STER-PCR'))
print('_is_hplc(IDENTITY_HPLC):', _is_hplc('IDENTITY_HPLC'))
print('_is_hplc(BPC-157):', _is_hplc('BPC-157'))
"
```

Expected:
```
imports ok
_is_hplc(ENDO-LAL): False
_is_hplc(STER-PCR): False
_is_hplc(IDENTITY_HPLC): True
_is_hplc(BPC-157): True
```

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/families/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(families): derive_family_state service function

Phase 5b Task 2. Pure read function: builds {keyword: AnalyteBreakdown}
by merging Mk1 parent-tier rows, Mk1 vial-tier rows, and SENAITE
parent-AR analyses, then applies the 5-rule precedence ladder
from the spec. HPLC classifier is keyword-prefix-based (ENDO-/STER-
are addons; rest is HPLC) — extensible to service_group-based in
Phase 5c if needed.

Spec: 2026-06-02-mk1-native-analyses-design.md §"Family state
derivation" lines 175-203.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: HTTP route + main.py registration

**Files:**
- Create: `backend/families/routes.py`
- Modify: `backend/main.py`

- [ ] **Step 1: Write the route**

Write `backend/families/routes.py`:

```python
"""HTTP route for the family-state endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from families.schemas import FamilyStateResponse
from families.service import (
    FamilyNotFoundError,
    derive_family_state,
)


router = APIRouter(prefix="/api/families", tags=["families"])


def _get_senaite_reader_dep(current_user=Depends(get_current_user)):
    """Build a SENAITE reader bound to the caller's auth.

    Re-uses the same adapter the COA resolver uses so caller-auth
    propagation stays consistent.
    """
    from coa.source_resolver import SenaiteAnalysesHttpReader
    from main import SENAITE_URL, _get_senaite_auth
    return SenaiteAnalysesHttpReader(
        base_url=SENAITE_URL, auth=_get_senaite_auth(current_user),
    )


@router.get("/{parent_sample_id}/state", response_model=FamilyStateResponse)
async def get_family_state(
    parent_sample_id: str,
    db: Session = Depends(get_db),
    reader=Depends(_get_senaite_reader_dep),
):
    try:
        return await derive_family_state(db, parent_sample_id, reader)
    except FamilyNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
```

- [ ] **Step 2: Register the router in main.py**

Find where other Phase routers are included in `backend/main.py`:

```bash
grep -n "include_router" /c/tmp/Accu-Mk1-subvial/backend/main.py | head -5
```

After the `lims_analyses` router registration, add:

```python
from families.routes import router as families_router  # Phase 5b
app.include_router(families_router)
```

The exact line numbers vary; place the `include_router(families_router)` call alongside the other Phase 4+ router registrations to keep them grouped.

- [ ] **Step 3: Restart + verify OpenAPI**

```bash
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1
curl -sS http://localhost:5530/openapi.json | python -c "
import json, sys
spec = json.load(sys.stdin)
for p in sorted(spec['paths']):
    if 'families' in p:
        print(p, list(spec['paths'][p].keys()))
"
```

Expected: `/api/families/{parent_sample_id}/state ['get']`

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/families/routes.py backend/main.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(families): GET /api/families/{id}/state route

Phase 5b Task 3. Thin HTTP shell over derive_family_state.
Reuses the COA resolver's SENAITE reader adapter so caller-auth
propagation stays consistent. 404 if the parent is unknown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Unit tests for `_derive_state`

**Files:**
- Create: `backend/tests/test_families_service.py`

These are pure-Python unit tests of the rule ladder — no DB session needed.

- [ ] **Step 1: Write the unit tests**

```python
"""Unit tests for the family-state derivation rule ladder.

These tests use only the AnalyteBreakdown shape — no DB, no SENAITE.
The full derivation function is tested at the integration level in
test_families_service_integration tests (TBD if needed; the rule
ladder is the hard part).
"""

from __future__ import annotations

import pytest

from families.schemas import AnalyteBreakdown
from families.service import _derive_state, _is_hplc


def _ab(keyword, parent_state=None, vial_states=None):
    return AnalyteBreakdown(
        keyword=keyword,
        is_hplc=_is_hplc(keyword),
        parent_state=parent_state,
        vial_states=vial_states or [],
    )


def test_empty_analytes_returns_pending():
    assert _derive_state({}) == "pending"


def test_pending_when_any_vial_unassigned():
    """Spec rule 1: pending if any unsettled analyte has an unassigned vial."""
    analytes = {"IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["unassigned"])}
    assert _derive_state(analytes) == "pending"


def test_pending_when_any_vial_assigned():
    analytes = {"IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["assigned"])}
    assert _derive_state(analytes) == "pending"


def test_to_be_verified_when_vial_submitted_no_parent():
    """Spec rule 2: to_be_verified if vial is submitted but no parent-tier row."""
    analytes = {"IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["to_be_verified"])}
    assert _derive_state(analytes) == "to_be_verified"


def test_waiting_for_addon_when_hplc_done_endo_pending():
    """Spec rule 3: HPLC verified + endo still pending → waiting_for_addon_results."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="verified"),
        "ENDO-LAL":       _ab("ENDO-LAL", vial_states=["to_be_verified"]),
    }
    assert _derive_state(analytes) == "waiting_for_addon_results"


def test_waiting_for_addon_when_hplc_done_endo_unstarted():
    """HPLC verified + endo has zero rows yet (still seeded but not run) →
    actually no: if endo doesn't have a row, it's NOT in `analytes`. The
    test instead: endo has a vial but no result yet."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="verified"),
        "ENDO-LAL":       _ab("ENDO-LAL", vial_states=["unassigned"]),
    }
    # The presence of an unassigned vial triggers rule 1 first (pending),
    # NOT rule 3. The spec's precedence ladder is explicit.
    assert _derive_state(analytes) == "pending"


def test_verified_when_all_analytes_have_parent_verified():
    """Spec rule 4: every analyte has parent-tier verified-or-published."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="verified"),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "verified"


def test_published_when_all_analytes_published():
    """Spec rule 5: every parent-tier row in published state."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="published"),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="published"),
    }
    assert _derive_state(analytes) == "published"


def test_verified_not_published_when_some_still_verified():
    """One unpublished row keeps the family in 'verified', not 'published'."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="published"),
        "ENDO-LAL":       _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "verified"


def test_waiting_for_addon_requires_at_least_one_hplc():
    """If only addons exist with no HPLC, waiting_for_addon doesn't fire —
    falls through to verified/pending based on the addon's state."""
    analytes = {
        "ENDO-LAL": _ab("ENDO-LAL", parent_state="verified"),
    }
    assert _derive_state(analytes) == "verified"


def test_pending_when_hplc_unsettled_with_to_be_verified_vial():
    """Rule 2 wins over rule 3: even when waiting_for_addon would otherwise
    apply, a still-submitting analyte forces to_be_verified."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", vial_states=["to_be_verified"]),
        "ENDO-LAL":       _ab("ENDO-LAL", vial_states=["to_be_verified"]),
    }
    assert _derive_state(analytes) == "to_be_verified"


def test_pending_fallback_when_unsettled_with_no_vial_activity():
    """Edge: an unsettled analyte with no vial states at all — fallthrough
    to pending. Practical case: SENAITE legacy analyte registered but with
    no work done yet."""
    analytes = {
        "IDENTITY_HPLC": _ab("IDENTITY_HPLC", parent_state="unassigned"),
    }
    # unassigned parent_state isn't in _PARENT_SETTLED so not settled,
    # but no vial activity either → fallback path
    assert _derive_state(analytes) == "pending"
```

- [ ] **Step 2: Run unit tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_families_service.py -v 2>&1 | tail -20"
```

Expected: 12 passed.

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_families_service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(families): _derive_state rule ladder unit tests

Phase 5b Task 4. 12 unit tests for the precedence ladder:
empty → pending, vial pending → pending, vial submitted →
to_be_verified, hplc done + addon pending → waiting_for_addon,
all verified → verified, all published → published,
mixed verified/published → verified, addons-only → verified,
precedence (rule 2 wins over rule 3), pending fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Route tests + integration test against live DB

**Files:**
- Create: `backend/tests/test_families_routes.py`

- [ ] **Step 1: Write the tests**

```python
"""HTTP-level + integration tests for the family-state route.

Tests are integration-shaped: they seed real lims_analyses rows via
promote_to_parent so the derivation runs end-to-end. Mirrors the
test_coa_source_resolver_integration.py pattern from Phase 5a.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import auth
from database import SessionLocal
from main import app
from lims_analyses.service import (
    apply_transition, create_analysis, promote_to_parent,
)
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
)


class _FakeUser:
    id = None


# Override auth + SENAITE reader for the test client.
app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()


# Override the SENAITE reader dep to return empty payload (no SENAITE in tests).
from families.routes import _get_senaite_reader_dep


class _EmptyReader:
    async def list_for_sample(self, sample_id):
        return []


app.dependency_overrides[_get_senaite_reader_dep] = lambda: _EmptyReader()

client = TestClient(app)


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def analysis_service(db):
    svc = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().first()
    if svc is None:
        pytest.skip("no analysis_services row available")
    return svc


@pytest.fixture
def clean_sub(db, analysis_service):
    stmt = (
        select(LimsSubSample)
        .where(~select(LimsAnalysis.id).where(
            LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
            LimsAnalysis.keyword == analysis_service.keyword,
            LimsAnalysis.retest_of_id.is_(None),
        ).exists())
    )
    sub = db.execute(stmt).scalars().first()
    if sub is None:
        pytest.skip("no sub-sample free of keyword")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.execute(delete(LimsAnalysisPromotion).where(
        LimsAnalysisPromotion.parent_analysis_id.in_(
            select(LimsAnalysis.id).where(LimsAnalysis.title.like("TEST:%"))
        )
    ))
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.reason.like("TEST:%")
    ))
    db.execute(delete(LimsAnalysis).where(LimsAnalysis.title.like("TEST:%")))
    db.commit()


# ── Tests ────────────────────────────────────────────────────────────────────


def test_get_family_state_404_for_unknown_parent():
    r = client.get("/api/families/THIS-DOES-NOT-EXIST-XYZ/state")
    assert r.status_code == 404


def test_get_family_state_pending_when_only_vial_assigned(db, clean_sub, analysis_service):
    """Vial in 'assigned' (post-assign, pre-submit) → family is pending."""
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state pending {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state pending")
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    body = r.json()
    assert body["parent_sample_id"] == parent.sample_id
    assert body["state"] == "pending"


def test_get_family_state_to_be_verified_when_vial_submitted(db, clean_sub, analysis_service):
    """Vial in to_be_verified, no parent-tier row → family is to_be_verified."""
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state tbv {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state tbv")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42.0", reason="TEST: family-state tbv")
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    assert r.json()["state"] == "to_be_verified"


def test_get_family_state_verified_when_only_analyte_promoted(db, clean_sub, analysis_service):
    """One analyte with parent-tier verified row → family is verified."""
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state verified {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state verified")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value="42.0", reason="TEST: family-state verified")
    parent_row, _ = promote_to_parent(
        db, keyword=analysis_service.keyword, result_value="42.0", result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}],
        reason="TEST: family-state verified",
    )
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()
    parent = db.get(LimsSample, parent_row.lims_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "verified"
    # The promoted analyte appears in the breakdown
    keywords = {a["keyword"] for a in body["analytes"]}
    assert analysis_service.keyword in keywords
    matching = next(a for a in body["analytes"] if a["keyword"] == analysis_service.keyword)
    assert matching["parent_state"] == "verified"


def test_get_family_state_breakdown_includes_per_analyte_facts(db, clean_sub, analysis_service):
    """The response.analytes list carries keyword + is_hplc + parent_state +
    vial_states. Verify the shape exists and is sane for one analyte."""
    row = create_analysis(
        db, host_kind="sub_sample", host_pk=clean_sub.id,
        analysis_service_id=analysis_service.id,
        keyword=analysis_service.keyword,
        title=f"TEST: family-state breakdown {analysis_service.keyword}",
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: family-state breakdown")
    parent = db.get(LimsSample, clean_sub.parent_sample_pk)

    r = client.get(f"/api/families/{parent.sample_id}/state")
    assert r.status_code == 200
    body = r.json()
    matching = next((a for a in body["analytes"] if a["keyword"] == analysis_service.keyword), None)
    assert matching is not None
    assert matching["parent_state"] is None  # no promote yet
    assert "assigned" in matching["vial_states"]
    assert isinstance(matching["is_hplc"], bool)
```

- [ ] **Step 2: Run the tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_families_routes.py -v 2>&1 | tail -15"
```

Expected: 5 passed (1 may skip if no `clean_sub` available).

- [ ] **Step 3: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_families_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(families): GET /api/families/{id}/state route + integration tests

Phase 5b Task 5. 5 tests: 404 for unknown parent, pending when
vial is assigned, to_be_verified when vial submitted, verified
when analyte promoted, breakdown shape sanity. Reuses the
promote_to_parent harness from Phase 4a integration tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full suite + live HTTP smoke

Verification-only — no commit.

- [ ] **Step 1: Full backend suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -q --tb=no 2>&1 | tail -5"
```

Expected: ≥ 488 passed (was 472 at end of Phase 5a; +12 unit + 5 route = 17 new minus skips). Floor: 485. 13 baseline failures unchanged. Zero regressions.

- [ ] **Step 2: End-to-end HTTP smoke**

```bash
docker exec accumark-subvial-accu-mk1-backend bash -c "cat > /app/_smoke_p5b.py << 'PYEOF'
import asyncio
from sqlalchemy import select, delete, text
from database import SessionLocal
from models import (
    LimsSample, LimsSubSample, LimsAnalysis, LimsAnalysisTransition,
    LimsAnalysisPromotion,
)
from sub_samples.photo_storage import get_storage
from sub_samples import service as ss, senaite
from lims_analyses.service import apply_transition, promote_to_parent
from families.service import derive_family_state


class _FakeReader:
    async def list_for_sample(self, sample_id):
        return []


db = SessionLocal()
parent = db.execute(select(LimsSample).where(LimsSample.sample_id == 'PB-0071')).scalar_one()
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000004949454e44ae426082')
sub_endo = ss.create_sub_sample(db, parent.sample_id, png, 'p5b_endo.png', 'P5b smoke endo', 1)
ss.set_assignment_role(db, sub_endo.sample_id, 'endo')
sub_hplc = ss.create_sub_sample(db, parent.sample_id, png, 'p5b_hplc.png', 'P5b smoke hplc', 1)
ss.set_assignment_role(db, sub_hplc.sample_id, 'hplc')
db.refresh(sub_endo)
db.refresh(sub_hplc)

# Walk both to to_be_verified
endo_row = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub_endo.id)).scalars().first()
apply_transition(db, analysis_id=endo_row.id, kind='assign', reason='smoke')
apply_transition(db, analysis_id=endo_row.id, kind='submit', result_value='<0.5 EU/mg', reason='smoke')

hplc_rows = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub_hplc.id)).scalars().all()
hplc_promoted = []
for hr in hplc_rows:
    apply_transition(db, analysis_id=hr.id, kind='assign', reason='smoke')
    apply_transition(db, analysis_id=hr.id, kind='submit', result_value='98.5', reason='smoke')

# State BEFORE any promote
res1 = asyncio.run(derive_family_state(db, parent.sample_id, _FakeReader()))
print(f'before promote: state={res1.state} analytes={len(res1.analytes)}')

# Promote ALL HPLC rows to parent
for hr in hplc_rows:
    pr, _ = promote_to_parent(
        db, keyword=hr.keyword, result_value='98.5', result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{'analysis_id': hr.id, 'contribution_kind': 'chosen'}],
        reason='smoke',
    )
    hplc_promoted.append(pr.id)

# State after HPLC promoted but endo NOT
res2 = asyncio.run(derive_family_state(db, parent.sample_id, _FakeReader()))
print(f'after HPLC promote (endo pending): state={res2.state}')

# Promote endo
endo_parent_row, _ = promote_to_parent(
    db, keyword=endo_row.keyword, result_value='<0.5 EU/mg', result_unit='EU/mg',
    method_id=None, instrument_id=None,
    sources=[{'analysis_id': endo_row.id, 'contribution_kind': 'chosen'}],
    reason='smoke',
)

# State after both promoted
res3 = asyncio.run(derive_family_state(db, parent.sample_id, _FakeReader()))
print(f'after endo promote (all settled): state={res3.state}')

# Cleanup
to_delete = [endo_parent_row.id] + hplc_promoted
db.execute(text('DELETE FROM lims_analyses WHERE id = ANY(:ids)'), {'ids': to_delete})
for s in (sub_endo, sub_hplc):
    get_storage().delete_photo(s.photo_external_uid[len('mk1://'):])
    aids = db.execute(select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk == s.id)).scalars().all()
    if aids:
        db.execute(delete(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id.in_(aids)))
        db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(aids)))
    db.execute(delete(LimsSubSample).where(LimsSubSample.id == s.id))
    db.commit()
    try:
        senaite.delete_secondary(s.external_lims_uid)
    except Exception:
        pass
db.close()
print('CLEAN')
PYEOF
python /app/_smoke_p5b.py; rc=\$?; rm -f /app/_smoke_p5b.py; exit \$rc"
```

Expected (assuming a clean stack):
- `before promote: state=to_be_verified analytes=<N>` (mix of HPLC + endo in to_be_verified)
- `after HPLC promote (endo pending): state=waiting_for_addon_results` ← the key signal
- `after endo promote (all settled): state=verified`
- `CLEAN`

If the stack has prior partial state on PB-0071 (e.g. an already-promoted analyte), the before-state may differ. The key acceptance is: **the `waiting_for_addon_results` state fires when HPLC is verified + endo is not**.

---

## Verification (Phase 5b acceptance)

- [ ] **`/api/families/{id}/state` returns 404 for unknown parent** (Task 5 test #1)
- [ ] **state=pending when vial in unassigned/assigned** (Task 4 unit + Task 5 integration)
- [ ] **state=to_be_verified when vial submitted, no parent-tier row** (Task 4 unit + Task 5 integration)
- [ ] **state=waiting_for_addon_results when HPLC parent-tier rows exist but addon doesn't** (Task 4 unit + Task 6 smoke step 2)
- [ ] **state=verified when every analyte has parent-tier verified row** (Task 4 unit + Task 5 integration + Task 6 smoke step 3)
- [ ] **state=published when every parent-tier row published** (Task 4 unit)
- [ ] **Breakdown surfaces per-analyte parent_state + vial_states + is_hplc** (Task 5 test #5)
- [ ] **Existing tests still green** (Task 6 Step 1: ≥485 passed)

---

## Risks and unknowns

- **HPLC classifier may miss edge keywords.** If production has analytes that don't match the ENDO-/STER- prefix but ARE addons, they get classified as HPLC. Phase 5c can switch to a service_group-based classifier if needed; the classifier is a single function call (`_is_hplc`) so the refactor is small.

- **SENAITE legacy parent analyses contribute to `parent_state`.** A SENAITE-verified analyte (no Mk1 row) counts as settled for derivation purposes. This is intentional per spec line 185-186 — the transition-window concession. Once parent analyses migrate to Mk1, the legacy branch dies naturally.

- **No event emission on transitions.** Phase 5b is a pull-only endpoint. IS polling or Phase 5c event emission is required for real-time WP signaling.

- **The endpoint authenticates via the standard `get_current_user` dependency.** Same as other Mk1 routes. IS calls in Phase 5c will use a service account.

- **Family state computation is per-request.** No caching. For high-frequency callers (e.g. polling IS), this becomes a hot path. If it shows up in profiling, cache at the Mk1 row level (invalidate on transition). Phase 5c can layer this if needed.

- **`reportable=False` rows are intentionally excluded from derivation.** Per spec input section: "reportable=true" on both tiers. A rejected/excluded analysis doesn't influence family state.

## Open questions (carried forward)

1. **Service-group-based HPLC classifier** — Phase 5c if production keyword diversity makes the prefix heuristic incorrect.
2. **Required-analytes-from-order-profile** — still deferred. Current heuristic ("union of analytes seen") is conservative; could under-report `verified` if some required analyte is missing entirely. In practice the Phase 2 seeder ensures all required analytes have at least vial-tier rows.
3. **Event emission / caching** — Phase 5c.

## Out of scope (carried forward)

- WP signaling event emission — Phase 5c.
- IS consumer for events — Phase 5c (cross-repo).
- Customer prelim-COA opt-in flow — Phase 6.
- Drop SENAITE secondary AR entirely — Phase 5c cleanup.
- FE family-state badge / customer-facing copy — later FE phase.
