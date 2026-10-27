"""/api/sample-forms (managed dosage-form list) and PATCH /api/lims-samples/{id}/form."""
from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user
from catalog.change_log import apply_and_log, log_create
from database import get_db
from models import LimsSample, LimsSampleForm
from sample_forms import service

router = APIRouter(prefix="/api", tags=["sample-forms"])

FormRoute = Literal["injectable", "nasal_inhaled", "oral"]
FormName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
_LOG_FIELDS = ("name", "route", "is_default", "active", "sort_order")


class SampleFormResponse(BaseModel):
    id: int
    name: str
    route: FormRoute
    is_default: bool
    active: bool
    sort_order: int
    sample_count: int


class SampleFormCreate(BaseModel):
    name: FormName
    route: FormRoute
    sort_order: Optional[int] = None


class SampleFormPatch(BaseModel):
    name: Optional[FormName] = None
    route: Optional[FormRoute] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None
    is_default: Optional[Literal[True]] = None  # the default moves; it is never unset


class SampleFormAssign(BaseModel):
    sample_form_id: int


def _out(db: Session, form: LimsSampleForm) -> SampleFormResponse:
    count = db.execute(
        select(func.count()).where(LimsSample.sample_form_id == form.id)
    ).scalar_one()
    return _response(form, count)


def _response(form: LimsSampleForm, sample_count: int) -> SampleFormResponse:
    return SampleFormResponse(
        id=form.id, name=form.name, route=form.route, is_default=form.is_default,
        active=form.active, sort_order=form.sort_order, sample_count=sample_count)


def _conflict() -> HTTPException:
    # unique violations: the name (case-insensitive) or the single-default flag
    return HTTPException(409, "A sample form with that name already exists, or the default flag changed concurrently")


@router.get("/sample-forms", response_model=list[SampleFormResponse])
def list_sample_forms(include_inactive: bool = False, db: Session = Depends(get_db),
                      _=Depends(get_current_user)):
    q = select(LimsSampleForm).order_by(LimsSampleForm.sort_order, LimsSampleForm.id)
    if not include_inactive:
        q = q.where(LimsSampleForm.active.is_(True))
    counts = dict(db.execute(
        select(LimsSample.sample_form_id, func.count())
        .where(LimsSample.sample_form_id.is_not(None))
        .group_by(LimsSample.sample_form_id)
    ).all())
    return [_response(f, counts.get(f.id, 0)) for f in db.execute(q).scalars()]


@router.post("/sample-forms", response_model=SampleFormResponse, status_code=201)
def create_sample_form(body: SampleFormCreate, db: Session = Depends(get_db),
                       current_user=Depends(get_current_user)):
    user_id = getattr(current_user, "id", None)
    sort_order = body.sort_order
    if sort_order is None:  # append after the current last form
        sort_order = (db.execute(select(func.max(LimsSampleForm.sort_order))).scalar() or 0) + 10
    form = LimsSampleForm(name=body.name, route=body.route, sort_order=sort_order,
                          is_default=False, active=True, updated_by_id=user_id)
    db.add(form)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise _conflict()
    log_create(db, form, _LOG_FIELDS, entity_type="sample_form", entity_pk=form.id, user_id=user_id)
    db.commit()
    return _out(db, form)


@router.patch("/sample-forms/{form_id}", response_model=SampleFormResponse)
def update_sample_form(form_id: int, body: SampleFormPatch, db: Session = Depends(get_db),
                       current_user=Depends(get_current_user)):
    form = db.get(LimsSampleForm, form_id)
    if form is None:
        raise HTTPException(404, f"Sample form {form_id} not found")
    user_id = getattr(current_user, "id", None)
    fields = body.model_dump(exclude_none=True)
    becomes_default = fields.get("is_default", False)
    stays_active = fields.get("active", form.active)
    if (form.is_default or becomes_default) and not stays_active:
        raise HTTPException(422, "The default form must stay active; make another form the default first")
    try:
        if becomes_default and not form.is_default:
            # Clear the old flag first and flush: the partial unique index allows one default.
            old = db.execute(select(LimsSampleForm).where(
                LimsSampleForm.is_default.is_(True), LimsSampleForm.id != form.id
            )).scalar_one_or_none()
            if old is not None:
                apply_and_log(db, old, {"is_default": False}, entity_type="sample_form",
                              entity_pk=old.id, user_id=user_id)
                db.flush()
        if apply_and_log(db, form, fields, entity_type="sample_form",
                         entity_pk=form.id, user_id=user_id):
            form.updated_by_id = user_id
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _conflict()
    return _out(db, form)


@router.patch("/lims-samples/{sample_id}/form")
def set_lims_sample_form(sample_id: str, body: SampleFormAssign, db: Session = Depends(get_db),
                         current_user=Depends(get_current_user)):
    sample = db.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one_or_none()
    if sample is None:
        raise HTTPException(404, f"Sample {sample_id} not found")
    try:
        service.set_sample_form(db, sample=sample, sample_form_id=body.sample_form_id,
                                user_id=getattr(current_user, "id", None))
    except service.SampleFormError as e:
        raise HTTPException(e.status, e.detail)
    db.commit()
    return service.form_payload(db, sample)
