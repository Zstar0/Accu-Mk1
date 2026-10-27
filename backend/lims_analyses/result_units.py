"""Result units (sample forms, spec 2026-10-26, task 8).

A test's catalog unit is not always the unit a sample is reported in: heavy
metals are "ppm" in the catalog, a nasal spray may be reported in "µg/mL".
The allowed units come only from the spec rows (plus the catalog unit): no
separate unit configuration. The default comes from the unit on the sample's
dosage-form spec row, and the analyst can pick another allowed unit.

The route validates a submitted unit against `canonical_unit`; the analyses
listing ships `unit_choices` per row. `apply_transition` stays unvalidated on
purpose: the endotoxin worksheet calls it with its own units.
"""
from __future__ import annotations

from typing import NamedTuple, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.spec_rules import normalize_unit
from models import AnalysisService, AnalysisServiceSpec


class UnitChoices(NamedTuple):
    allowed: list[str]
    default: Optional[str]


def _spec_units(db: Session, service: AnalysisService,
                cache: Optional[dict] = None) -> list[tuple[Optional[int], Optional[str]]]:
    """(sample_form_id, unit) of the service's active spec rows in any tier,
    ordered by spec id. One read per service; `cache` is keyed by service.id."""
    if cache is not None and service.id in cache:
        return cache[service.id]
    rows = [tuple(r) for r in db.execute(
        select(AnalysisServiceSpec.sample_form_id, AnalysisServiceSpec.unit)
        .where(AnalysisServiceSpec.analysis_service_id == service.id,
               AnalysisServiceSpec.active.is_(True))
        .order_by(AnalysisServiceSpec.id)
    ).all()]
    if cache is not None:
        cache[service.id] = rows
    return rows


def _spellings(service: AnalysisService, spec_units) -> dict[str, str]:
    """normalized unit -> first spelling: the catalog unit, then the spec rows
    in id order. Blanks dropped. Dict order is the allowed-list order."""
    out: dict[str, str] = {}
    for unit in [service.unit, *(u for _, u in spec_units)]:
        key = normalize_unit(unit)
        if key and key not in out:
            out[key] = unit
    return out


def allowed_units(db: Session, service: AnalysisService) -> list[str]:
    """The catalog unit first, then the units of the service's active spec rows
    in any tier, ordered by spec id. Deduplicated by normalize_unit (first
    spelling kept), blanks dropped."""
    return list(_spellings(service, _spec_units(db, service)).values())


def unit_choices(db: Session, service: AnalysisService, sample_form_id: Optional[int],
                 cache: Optional[dict] = None) -> UnitChoices:
    """The allowed units and the default for a sample of `sample_form_id`.

    Default: the one unit among the active form-tier rows for (service, form);
    with several, the catalog unit if it is one of them, else None; with none
    (or no form), the catalog unit. A form row with a blank unit names no unit
    and does not count. The default is always the allowed-list spelling, so a
    dropdown can match it exactly."""
    spec_units = _spec_units(db, service, cache)
    spelling = _spellings(service, spec_units)
    catalog = normalize_unit(service.unit)
    form_units = {normalize_unit(u) for fid, u in spec_units
                  if sample_form_id is not None and fid == sample_form_id} - {""}
    if len(form_units) == 1:
        default = spelling[next(iter(form_units))]
    elif form_units:
        default = spelling[catalog] if catalog in form_units else None
    else:
        default = spelling.get(catalog)
    return UnitChoices(list(spelling.values()), default)


def canonical_unit(db: Session, service: AnalysisService, unit: str) -> Optional[str]:
    """The allowed-list spelling that matches `unit` (trim, case-insensitive),
    else None."""
    return _spellings(service, _spec_units(db, service)).get(normalize_unit(unit))
