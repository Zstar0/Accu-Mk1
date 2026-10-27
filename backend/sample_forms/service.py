"""Sample Forms (dosage forms): default on create, retest copy, per-sample PATCH.

A form applies to Peptide-matrix samples only (Peptide / Peptide Blend);
Bacteriostatic Water and the like carry none. Callers own the commit.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.spec_rules import normalize_matrix
from models import LimsSample, LimsSampleForm, LimsSubSampleEvent


class SampleFormError(Exception):
    """A refused form change; routes map it to HTTPException(status, detail)."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def is_form_eligible(sample_type_title: Optional[str]) -> bool:
    return normalize_matrix(sample_type_title) == "Peptide"


def default_form_id(db: Session) -> Optional[int]:
    """None on a brand-new DB whose forms table is not seeded yet."""
    return db.execute(
        select(LimsSampleForm.id).where(LimsSampleForm.is_default.is_(True))
    ).scalar_one_or_none()


def apply_default_form(db: Session, row: LimsSample) -> None:
    """Birth-time default. A no-op for ineligible rows, rows that already
    carry a form, and an unseeded table. Never call from a refresh path."""
    if row.sample_form_id is None and is_form_eligible(row.sample_type_title):
        row.sample_form_id = default_form_id(db)


def copy_form_from_original(db: Session, row: LimsSample) -> None:
    """A retest inherits its original's form; a missing or form-less original
    leaves whatever apply_default_form gave the retest."""
    if not row.retest_of_sample_id:
        return
    original_form_id = db.execute(
        select(LimsSample.sample_form_id).where(LimsSample.sample_id == row.retest_of_sample_id)
    ).scalar_one_or_none()
    if original_form_id is not None:
        row.sample_form_id = original_form_id


def set_sample_form(db: Session, *, sample: LimsSample, sample_form_id: int,
                    user_id: Optional[int]) -> bool:
    """Returns True when the value changed (and an activity event was written).
    The caller commits."""
    form = db.get(LimsSampleForm, sample_form_id)
    if form is None:
        raise SampleFormError(404, f"Sample form {sample_form_id} not found")
    if not is_form_eligible(sample.sample_type_title):
        raise SampleFormError(422, "This sample type does not take a form")
    if sample.sample_form_id == form.id:
        return False  # also lets a since-retired form stay on its samples
    if not form.active:
        raise SampleFormError(422, f"Sample form '{form.name}' is inactive")
    previous = db.get(LimsSampleForm, sample.sample_form_id) if sample.sample_form_id else None
    sample.sample_form_id = form.id
    db.add(LimsSubSampleEvent(
        lims_sample_pk=sample.id,
        event="sample_form_changed",
        details={
            "from_id": previous.id if previous else None,
            "from_name": previous.name if previous else None,
            "to_id": form.id,
            "to_name": form.name,
        },
        user_id=user_id,
    ))
    db.flush()
    return True


def form_payload(db: Session, row: Optional[LimsSample]) -> dict:
    """The three lookup/PATCH fields for a sample row (None row = no registry row)."""
    if row is None:
        return {"sample_form_id": None, "sample_form_name": None, "sample_form_eligible": False}
    form = db.get(LimsSampleForm, row.sample_form_id) if row.sample_form_id else None
    return {
        "sample_form_id": row.sample_form_id,
        "sample_form_name": form.name if form else None,
        "sample_form_eligible": is_form_eligible(row.sample_type_title),
    }
