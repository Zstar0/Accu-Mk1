"""/admin/agents: Settings > Agents (spec 2026-10-12 section 4). Admin LOGIN only; an agent key
never passes require_admin. Keys appear only in create and rotate responses."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from agents import keys, service
from auth import require_admin
from database import get_db

router = APIRouter(prefix="/admin/agents", tags=["agents"])


class AgentOut(BaseModel):
    id: int
    username: str
    display_name: str
    is_active: bool
    lab_tools: bool
    coa_publishing: bool
    key_hint: str
    created_at: datetime
    created_by_name: Optional[str] = None
    rotated_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    group_ids: List[int] = []


class AgentWithKey(BaseModel):
    agent: AgentOut
    key: str


class AgentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str
    display_name: str
    lab_tools: bool = False
    coa_publishing: bool = False


class AgentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")  # username is immutable: a rename is a 422
    display_name: Optional[str] = None
    is_active: Optional[bool] = None
    lab_tools: Optional[bool] = None
    coa_publishing: Optional[bool] = None


class GroupsReplace(BaseModel):
    group_ids: List[int]


def _out(db, user, cred) -> AgentOut:
    from documents.comments import display_name
    creator = db.get(type(user), cred.created_by_user_id) if cred.created_by_user_id else None
    return AgentOut(id=user.id, username=keys.username_of(user), display_name=user.first_name or "",
                    is_active=user.is_active, lab_tools=cred.lab_tools, coa_publishing=cred.coa_publishing,
                    key_hint=cred.key_hint, created_at=cred.created_at,
                    created_by_name=display_name(creator) if creator else None,
                    rotated_at=cred.rotated_at, last_used_at=cred.last_used_at,
                    group_ids=service.group_ids(db, user.id))


def _http(e: service.AgentError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code})


@router.get("", response_model=List[AgentOut])
def list_agents(db: Session = Depends(get_db), _a=Depends(require_admin)):
    return [_out(db, u, c) for u, c in service.list_agents(db)]


@router.post("", response_model=AgentWithKey, status_code=201)
def create_agent(body: AgentCreate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    try:
        user, key = service.create_agent(db, username=body.username, display_name=body.display_name,
                                         lab_tools=body.lab_tools, coa_publishing=body.coa_publishing,
                                         created_by_user_id=admin.id)
        _, cred = service.get_agent(db, user.id)
    except service.AgentError as e:
        raise _http(e)
    return AgentWithKey(agent=_out(db, user, cred), key=key)


@router.patch("/{agent_id}", response_model=AgentOut)
def update_agent(agent_id: int, body: AgentPatch, db: Session = Depends(get_db),
                 admin=Depends(require_admin)):
    try:
        user, cred = service.update_agent(db, agent_id, **body.model_dump(exclude_unset=True),
                                          acting_user_id=admin.id)
    except service.AgentError as e:
        raise _http(e)
    return _out(db, user, cred)


@router.post("/{agent_id}/rotate-key", response_model=AgentWithKey)
def rotate_key(agent_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    try:
        user, cred, key = service.rotate_key(db, agent_id, acting_user_id=admin.id)
    except service.AgentError as e:
        raise _http(e)
    return AgentWithKey(agent=_out(db, user, cred), key=key)


@router.put("/{agent_id}/groups", response_model=AgentOut)
def put_groups(agent_id: int, body: GroupsReplace, db: Session = Depends(get_db),
               admin=Depends(require_admin)):
    try:
        service.set_groups(db, agent_id, body.group_ids, acting_user_id=admin.id)
        user, cred = service.get_agent(db, agent_id)
    except service.AgentError as e:
        db.rollback()
        raise _http(e)
    return _out(db, user, cred)
