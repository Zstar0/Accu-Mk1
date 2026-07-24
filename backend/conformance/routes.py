from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from .schemas import ConformanceResponse
from .service import run_conformance

router = APIRouter(prefix="/api/conformance", tags=["conformance"])


@router.get("/{sample_id}", response_model=ConformanceResponse)
def get_conformance(sample_id: str, current_user=Depends(get_current_user)):
    """Per-analyte conformance verdict from the vendored COA engine.
    Read-only: fetches the SENAITE AR + analyses and runs the engine in-process.
    """
    try:
        return run_conformance(sample_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
