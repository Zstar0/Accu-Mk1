"""FastAPI router for user groups. Reads for any login, writes admin-only (spec §7.1)."""
from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin
from database import get_db
from groups import service
from groups.access import is_admin
from groups.errors import (BadRequestError, ConflictError, NotFoundError,
                           PermissionDeniedError)
from groups.schemas import (GroupCreate, GroupMembersOut, GroupMembersReplace, GroupOut,
                            GroupRef, GroupUpdate)

router = APIRouter(prefix="/api/groups", tags=["groups"])
logger = logging.getLogger(__name__)


def http_error(e: Exception) -> HTTPException:
    """Shared by groups and boards routes."""
    if isinstance(e, NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, PermissionDeniedError):
        return HTTPException(status_code=403, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, IntegrityError):
        logger.warning("groups/boards integrity conflict: %s", e)
        return HTTPException(status_code=409, detail="conflicting write; retry")
    logger.exception("unhandled groups/boards error")
    return HTTPException(status_code=500, detail="internal error")


def _out(g, counts) -> GroupOut:
    o = GroupOut.model_validate(g)
    o.member_count = counts.get(g.id, 0)
    return o


@router.get("", response_model=List[GroupOut])
def list_groups(include_inactive: bool = Query(False), db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    counts = service.member_counts(db)
    rows = service.list_groups(db, include_inactive=include_inactive and is_admin(user))
    return [_out(g, counts) for g in rows]


@router.get("/mine", response_model=List[GroupRef])
def my_groups(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [GroupRef.model_validate(g) for g in service.my_groups(db, user)]


@router.post("", response_model=GroupOut, status_code=201)
def create_group(body: GroupCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    try:
        g = service.create_group(db, slug=body.slug, name=body.name, description=body.description)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return _out(g, {})


@router.put("/{group_id}", response_model=GroupOut)
def update_group(group_id: int, body: GroupUpdate, db: Session = Depends(get_db),
                 _=Depends(require_admin)):
    try:
        g = service.update_group(db, group_id, **body.model_dump(exclude_unset=True))
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return _out(g, service.member_counts(db))


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    try:
        service.delete_group(db, group_id)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return Response(status_code=204)


@router.get("/{group_id}/members", response_model=GroupMembersOut)
def get_members(group_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    try:
        return GroupMembersOut(group_id=group_id, user_ids=service.list_members(db, group_id))
    except Exception as e:
        raise http_error(e)


@router.put("/{group_id}/members", response_model=GroupMembersOut)
def put_members(group_id: int, body: GroupMembersReplace, db: Session = Depends(get_db),
                _=Depends(require_admin)):
    try:
        ids = service.replace_members(db, group_id, body.user_ids)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return GroupMembersOut(group_id=group_id, user_ids=ids)
