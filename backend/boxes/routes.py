from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user

from . import service
from .schemas import BoxResponse, CreateBoxRequest, AssignVialsRequest

router = APIRouter(prefix="/api/boxes", tags=["boxes"])


def _serialize(db: Session, box) -> BoxResponse:
    return BoxResponse(
        id=box.id,
        order_key=box.order_key,
        box_number=box.box_number,
        role=box.role,
        label_code=service.box_label_code(box),
        vial_count=service.vial_count(db, box.id),
        printed_at=box.printed_at,
    )


@router.get("", response_model=list[BoxResponse])
def list_boxes(order_key: str = Query(...), db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    return [_serialize(db, b) for b in service.list_for_order(db, order_key)]


@router.post("", response_model=BoxResponse, status_code=201)
def create_box(body: CreateBoxRequest, db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    try:
        box = service.next_box(db, body.order_key, body.role, user_id=user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _serialize(db, box)


@router.post("/{box_id}/assign", response_model=BoxResponse)
def assign(box_id: int, body: AssignVialsRequest, db: Session = Depends(get_db),
           user=Depends(get_current_user)):
    try:
        box = service.assign_vials(db, box_id, body.sub_sample_ids)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _serialize(db, box)


@router.post("/unassign")
def unassign(body: AssignVialsRequest, db: Session = Depends(get_db),
             user=Depends(get_current_user)):
    """Clear box membership for the given vials (drag back out to Unboxed).
    No role check — removing from a box is always allowed."""
    count = service.unassign_vials(db, body.sub_sample_ids)
    return {"unassigned": count}


@router.post("/{box_id}/print", response_model=BoxResponse)
def print_box(box_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        box = service.mark_printed(db, box_id, user_id=user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _serialize(db, box)


@router.delete("/{box_id}", status_code=204)
def delete_box(box_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        service.delete_box(db, box_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.BoxNotEmptyError as e:
        raise HTTPException(status_code=409, detail=str(e))
