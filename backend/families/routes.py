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


def _get_senaite_reader_dep(
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Build a reader bound to the caller's auth: ShadowAnalysesReader
    (native rows, zero SENAITE HTTP) in mk1 mode, else the SENAITE HTTP
    reader.

    Re-uses the same adapters the COA resolver uses (coa/source_resolver.py,
    coa/shadow_reader.py) so caller-auth propagation and the read-source
    switch stay consistent across both consumers of the reader Protocol.
    """
    from coa.source_setting import coa_generation_source
    if coa_generation_source(db) == "mk1":
        from coa.shadow_reader import ShadowAnalysesReader
        return ShadowAnalysesReader(db)

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
