"""Admin CRUD + graph API for the workflow catalog (phase-out slice 3).

Edits touch CATALOG rows only (documentation while SENAITE is authority) —
no live sample/analysis state is ever read from or written through here.
Guardrails are fail-loud (409/422, spec §9.4); routes own their commits
(flags routes convention).
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from auth import require_admin
from database import get_db
from models import LimsWorkflowState, LimsWorkflowTransition
from workflow.catalog import graph_payload, usage_counts, validate_requirements

router = APIRouter(prefix="/api/workflow", tags=["workflow"],
                   dependencies=[Depends(require_admin)])

Scope = Literal["sample", "analysis"]
Category = Literal["active", "terminal", "exception"]


# ── request bodies ───────────────────────────────────────────────────────

class StateCreate(BaseModel):
    entity_scope: Scope
    slug: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1)
    description: Optional[str] = None
    category: Category = "active"
    color: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True


class StateUpdate(BaseModel):
    # slug/entity_scope immutable by omission (unknown body keys are ignored).
    label: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    category: Optional[Category] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class TransitionCreate(BaseModel):
    # entity_scope is derived from the endpoint states, never client-supplied.
    from_state_id: int
    to_state_id: int
    verb: str = Field(min_length=1, max_length=100)
    label: Optional[str] = None
    description: Optional[str] = None
    requirements: list = Field(default_factory=list)
    sort_order: int = 0
    is_active: bool = True


class TransitionUpdate(BaseModel):
    # entity_scope immutable by omission; endpoints may move within the scope.
    from_state_id: Optional[int] = None
    to_state_id: Optional[int] = None
    verb: Optional[str] = Field(default=None, min_length=1, max_length=100)
    label: Optional[str] = None
    description: Optional[str] = None
    requirements: Optional[list] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


# ── serializers (match graph_payload entry shape) ────────────────────────

def _state_out(s: LimsWorkflowState, usage_count: int = 0) -> dict:
    return {
        "id": s.id, "slug": s.slug, "label": s.label,
        "description": s.description, "category": s.category,
        "color": s.color, "sort_order": s.sort_order,
        "is_builtin": s.is_builtin, "is_active": s.is_active,
        "usage_count": usage_count,
    }


def _transition_out(t: LimsWorkflowTransition) -> dict:
    return {
        "id": t.id, "from_state_id": t.from_state_id,
        "to_state_id": t.to_state_id, "verb": t.verb, "label": t.label,
        "description": t.description, "requirements": t.requirements,
        "is_builtin": t.is_builtin, "is_active": t.is_active,
    }


def _clean_requirements(entries) -> list:
    try:
        return validate_requirements(entries)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _reject_null_for(non_nullable: frozenset, data: dict) -> None:
    """Explicit JSON nulls on non-nullable columns fail loud (422), not as a
    DB NOT NULL violation (500). Pydantic's Optional[...] update fields let
    null through — this is the backstop."""
    for k in non_nullable & data.keys():
        if data[k] is None:
            raise HTTPException(status_code=422,
                                detail=f"{k} cannot be null")


_STATE_NON_NULLABLE = frozenset({"label", "category", "sort_order", "is_active"})
_TRANSITION_NON_NULLABLE = frozenset({"from_state_id", "to_state_id", "verb",
                                      "requirements", "sort_order", "is_active"})


# ── graph ────────────────────────────────────────────────────────────────

@router.get("/graph")
def get_graph(scope: Scope = Query(...), db: Session = Depends(get_db)):
    return graph_payload(db, scope)


# ── states ───────────────────────────────────────────────────────────────

@router.post("/states")
def create_state(body: StateCreate, db: Session = Depends(get_db)):
    dup = (db.query(LimsWorkflowState)
           .filter_by(entity_scope=body.entity_scope, slug=body.slug)
           .one_or_none())
    if dup is not None:
        raise HTTPException(
            status_code=409,
            detail=f"state '{body.slug}' already exists in scope "
                   f"'{body.entity_scope}'")
    row = LimsWorkflowState(**body.model_dump(), is_builtin=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _state_out(row)


@router.patch("/states/{state_id}")
def update_state(state_id: int, body: StateUpdate,
                 db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowState, state_id)
    if row is None:
        raise HTTPException(status_code=404, detail="state not found")
    data = body.model_dump(exclude_unset=True)
    _reject_null_for(_STATE_NON_NULLABLE, data)
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return _state_out(row, usage_counts(db, row.entity_scope).get(row.slug, 0))


@router.delete("/states/{state_id}", status_code=204)
def delete_state(state_id: int, db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowState, state_id)
    if row is None:
        raise HTTPException(status_code=404, detail="state not found")
    if row.is_builtin:
        raise HTTPException(
            status_code=409,
            detail="built-in state cannot be deleted — deactivate instead")
    usage = usage_counts(db, row.entity_scope).get(row.slug, 0)
    if usage:
        raise HTTPException(
            status_code=409,
            detail=f"state '{row.slug}' has {usage} live row(s) — "
                   "deactivate instead")
    refs = (db.query(LimsWorkflowTransition)
            .filter(or_(LimsWorkflowTransition.from_state_id == row.id,
                        LimsWorkflowTransition.to_state_id == row.id))
            .count())
    if refs:
        raise HTTPException(
            status_code=409,
            detail=f"{refs} transition(s) reference state '{row.slug}' — "
                   "remove them or deactivate instead")
    db.delete(row)
    db.commit()


# ── transitions ──────────────────────────────────────────────────────────

@router.post("/transitions")
def create_transition(body: TransitionCreate, db: Session = Depends(get_db)):
    frm = db.get(LimsWorkflowState, body.from_state_id)
    to = db.get(LimsWorkflowState, body.to_state_id)
    if frm is None or to is None:
        raise HTTPException(status_code=422,
                            detail="from/to state does not exist")
    if frm.entity_scope != to.entity_scope:
        raise HTTPException(
            status_code=422,
            detail=f"cross-scope edge rejected: '{frm.slug}' is "
                   f"{frm.entity_scope}-scope, '{to.slug}' is "
                   f"{to.entity_scope}-scope")
    reqs = _clean_requirements(body.requirements)
    dup = (db.query(LimsWorkflowTransition)
           .filter_by(entity_scope=frm.entity_scope,
                      from_state_id=frm.id, verb=body.verb)
           .one_or_none())
    if dup is not None:
        raise HTTPException(
            status_code=409,
            detail=f"transition '{body.verb}' from '{frm.slug}' already exists")
    row = LimsWorkflowTransition(
        entity_scope=frm.entity_scope, from_state_id=frm.id, to_state_id=to.id,
        verb=body.verb, label=body.label, description=body.description,
        requirements=reqs, sort_order=body.sort_order,
        is_active=body.is_active, is_builtin=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _transition_out(row)


@router.patch("/transitions/{transition_id}")
def update_transition(transition_id: int, body: TransitionUpdate,
                      db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowTransition, transition_id)
    if row is None:
        raise HTTPException(status_code=404, detail="transition not found")
    data = body.model_dump(exclude_unset=True)
    _reject_null_for(_TRANSITION_NON_NULLABLE, data)

    # Resolve the post-patch endpoints; both must exist and stay inside the
    # transition's (immutable) scope.
    frm = (db.get(LimsWorkflowState, data["from_state_id"])
           if "from_state_id" in data
           else db.get(LimsWorkflowState, row.from_state_id))
    to = (db.get(LimsWorkflowState, data["to_state_id"])
          if "to_state_id" in data
          else db.get(LimsWorkflowState, row.to_state_id))
    if frm is None or to is None:
        raise HTTPException(status_code=422,
                            detail="from/to state does not exist")
    if frm.entity_scope != row.entity_scope or to.entity_scope != row.entity_scope:
        raise HTTPException(
            status_code=422,
            detail=f"cross-scope edge rejected: transition is "
                   f"{row.entity_scope}-scope")

    if "requirements" in data:
        data["requirements"] = _clean_requirements(data["requirements"])

    new_verb = data.get("verb", row.verb)
    if new_verb != row.verb or frm.id != row.from_state_id:
        dup = (db.query(LimsWorkflowTransition)
               .filter_by(entity_scope=row.entity_scope,
                          from_state_id=frm.id, verb=new_verb)
               .filter(LimsWorkflowTransition.id != row.id)
               .one_or_none())
        if dup is not None:
            raise HTTPException(
                status_code=409,
                detail=f"transition '{new_verb}' from '{frm.slug}' "
                       "already exists")

    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return _transition_out(row)


@router.delete("/transitions/{transition_id}", status_code=204)
def delete_transition(transition_id: int, db: Session = Depends(get_db)):
    row = db.get(LimsWorkflowTransition, transition_id)
    if row is None:
        raise HTTPException(status_code=404, detail="transition not found")
    if row.is_builtin:
        raise HTTPException(
            status_code=409,
            detail="built-in transition cannot be deleted — deactivate instead")
    db.delete(row)
    db.commit()
