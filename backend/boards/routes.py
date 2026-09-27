"""FastAPI router for boards (spec §7.2, §7.3). Every route needs a login; boards the
caller cannot view are 404 on every route (spec §9)."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from auth import get_current_user
from boards import service
from boards.schemas import (BoardCreate, BoardDetail, BoardOut, BoardPatch, EntityBoardRef,
                            GrantIn, GrantOut)
from database import get_db
from groups.routes import http_error

router = APIRouter(prefix="/api/boards", tags=["boards"])


@router.get("", response_model=List[BoardOut])
def list_boards(db: Session = Depends(get_db), user=Depends(get_current_user)):
    boards = service.list_boards(db, user)
    counts = service.node_counts(db, [b.id for b in boards])
    return [service.board_out(db, user, b, counts) for b in boards]


@router.post("", response_model=BoardOut, status_code=201)
def create_board(body: BoardCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        b = service.create_board(db, user, slug=body.slug, name=body.name, kind=body.kind,
                                 visibility=body.visibility)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return service.board_out(db, user, b)


# Literal route ABOVE /{slug} so it wins the match (literal-before-param, flags convention).
@router.get("/for-entity", response_model=List[EntityBoardRef])
def boards_for_entity(entity_type: str = Query(...), entity_id: str = Query(...),
                      db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [EntityBoardRef(board_id=b.id, board_slug=b.slug, board_name=b.name,
                           node_id=n.id, node_label=n.label)
            for b, n in service.boards_for_entity(db, user, entity_type, entity_id)]


@router.get("/{slug}", response_model=BoardDetail)
def get_board(slug: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        board = service.get_board(db, user, slug)
        return service.board_detail_payload(db, user, board)
    except Exception as e:
        raise http_error(e)


@router.patch("/{slug}", response_model=BoardOut)
def patch_board(slug: str, body: BoardPatch, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    try:
        b = service.patch_board(db, user, slug, **body.model_dump(exclude_unset=True))
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return service.board_out(db, user, b)


@router.delete("/{slug}", status_code=204)
def delete_board(slug: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.delete_board(db, user, slug)
    except Exception as e:
        db.rollback()
        raise http_error(e)
    return Response(status_code=204)


@router.put("/{slug}/grants", response_model=List[GrantOut])
def put_grants(slug: str, body: List[GrantIn], db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    try:
        return service.replace_grants(db, user, slug, body)
    except Exception as e:
        db.rollback()
        raise http_error(e)
