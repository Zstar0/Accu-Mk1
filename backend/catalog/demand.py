"""Catalog-driven base vial demand (Catalog 1D, shadow resolver).

Σ(vials_required) over the ordered assignable catalog units, bucketed by each
unit's home Department. This is the additive, catalog-sourced counterpart to
sub_samples.service.derive_base_demand's hardcoded ster:2. DEAD-UNTIL-WIRED:
no order-flow code calls it in 1D — it exists to be shadow-diffed against the
legacy demand (§247 parity gate) ahead of the Phase-3 order-flow inversion.

Bucketing keys on Department (spec invariant: "Department — not group — drives
routing"). Phase-1 caveat: sterility is the only catalog-migrated family, so
Microbiology maps cleanly to the "ster" bucket. When Endotoxin is migrated
onto the catalog (Phase 2) it becomes a second assignable Microbiology family
and this map needs a finer key (endo vs ster) — until then endo is NOT
catalog-assignable and never reaches this resolver.
"""
from __future__ import annotations

import logging
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import AnalysisService, Department, ServiceGroup

log = logging.getLogger(__name__)

# Home Department -> legacy demand bucket (== vial assignment_role). Phase-1
# scope: only sterility (Microbiology) is catalog-driven. See module docstring.
_DEPARTMENT_TO_BUCKET = {"Analytical": "hplc", "Microbiology": "ster"}


def _empty_demand() -> dict[str, int]:
    return {"hplc": 0, "endo": 0, "ster": 0}


def _bucket_for_department_id(db: Session, department_id: int | None) -> str | None:
    if department_id is None:
        return None
    name = db.execute(
        select(Department.name).where(Department.id == department_id)
    ).scalar_one_or_none()
    return _DEPARTMENT_TO_BUCKET.get(name) if name else None


def catalog_base_demand(db: Session, ordered_units: Iterable[str]) -> dict[str, int]:
    """Base (pre-variance) vial demand per bucket, summed from the catalog.

    ordered_units: names of the ordered ASSIGNABLE units. v1 sterility units are
    service groups ("Sterility PCR", "Sterility USP<71>"); a standalone
    assignable service is matched by keyword as a fallback (none in v1). Each
    unit contributes (vials_required or 0) to the bucket of its home Department.
    Unknown / non-assignable / department-less names contribute 0 (logged),
    never raise. Variance is NOT included here (see derive_variance_demand).
    """
    demand = _empty_demand()
    for name in ordered_units:
        group = db.execute(
            select(ServiceGroup).where(ServiceGroup.name == name)
        ).scalar_one_or_none()

        if group is not None:
            bucket = _bucket_for_department_id(db, group.department_id)
            vials = group.vials_required or 0
        else:
            # Fallback: a standalone assignable service, matched by keyword.
            svc = db.execute(
                select(AnalysisService).where(
                    AnalysisService.keyword == name,
                    AnalysisService.is_assignable.is_(True),
                )
            ).scalar_one_or_none()
            if svc is None:
                log.debug("catalog_base_demand.unknown_unit name=%s", name)
                continue
            bucket = _bucket_for_department_id(db, svc.department_id)
            vials = svc.vials_required or 0

        if bucket is None:
            log.debug("catalog_base_demand.no_bucket name=%s", name)
            continue
        demand[bucket] += vials
    return demand
