"""Quantity in IU (HGH): a display conversion, never a stored value.

lims_analyses keeps the mg the lab entered. From a peptide's `iu_from` cutoff
forward the COA prints quantity in IU (`iu_per_mg`), after the spec has judged
the raw mg, and the customer's declared amount on those samples is IU, so prep
divides it back to mg. Inert until both peptide fields are set. A blend anchors
on no single peptide, so it never converts.

ponytail: the gate is one date against the sample's order time. An order in
flight at the cutoff, or a sample transfer copying an mg-era declared amount,
lands on the wrong side of it. Upgrade path: capture the declared unit on the
order row.

ponytail: spec bounds stay in mg on the wire. Only an informational quantity
spec exists today; a numeric one on a converting peptide needs its bounds
converted here, or page 1 prints mg bounds beside the IU result.

Spec: docs/superpowers/specs/2026-11-04-hgh-iu-display-design.md
"""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy import select

from coa.spec_rules import sample_peptide_ids
from models import LimsSample, Peptide

# A removed row is no claim on the sample's identity, so it must not read as a
# second peptide and silently turn the conversion off.
_DEAD_STATES = ("retracted", "rejected", "cancelled")

# PEPT-Total's label is "mg/mL" but its value is the per-vial mass in mg (Handler
# ruling, reports_analyte_trends._MASS_UNITS), so it converts like any mg row.
# Leaving it would print page 1 in mg/mL beside NULL-unit vials in IU.
_MASS_UNITS = {"mg", "mg/ml"}


def naive_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _ordered_at(parent) -> Optional[datetime]:
    ordered = getattr(parent, "date_created", None) or getattr(parent, "created_at", None)
    return naive_utc(ordered) if ordered else None


def _original_order_times(db, retests: dict) -> dict:
    """{parent pk: the original sample's order time} from {parent pk: retested
    sample id}, one query per level of the chain. An original Mk1 does not hold
    is left out: it predates native intake."""
    out, pending = {}, dict(retests)
    for _ in range(8):
        if not pending:
            break
        rows = {r.sample_id: r for r in db.execute(
            select(LimsSample.sample_id, LimsSample.retest_of_sample_id,
                   LimsSample.date_created, LimsSample.created_at)
            .where(LimsSample.sample_id.in_(set(pending.values())))
        ).all()}
        found = {pk: rows[sid] for pk, sid in pending.items() if sid in rows}
        out.update({pk: _ordered_at(r) for pk, r in found.items() if not r.retest_of_sample_id})
        pending = {pk: r.retest_of_sample_id for pk, r in found.items() if r.retest_of_sample_id}
    return out


def iu_factors(db, parents) -> dict:
    """{parent pk: IU per mg} for the parents that convert. Two queries however
    many parents, so a list serializer can call it once per page, plus the
    original's lookup for a retest that would convert. A retest copies the
    original's declared amount, so it lands on the original's side of the
    cutoff, and an original with no known order time stays in mg."""
    if db is None:
        return {}
    gates = {
        pid: (factor, naive_utc(start))
        for pid, factor, start in db.execute(
            select(Peptide.id, Peptide.iu_per_mg, Peptide.iu_from).where(
                Peptide.iu_per_mg.is_not(None), Peptide.iu_from.is_not(None))
        ).all()
    }
    if not gates:
        return {}
    earliest = min(start for _, start in gates.values())
    due = {p.id: at for p in parents if (at := _ordered_at(p)) and at >= earliest}
    if not due:
        return {}
    out, starts = {}, {}
    for pk, peptide_id in sample_peptide_ids(db, sorted(due), _DEAD_STATES).items():
        gate = gates.get(peptide_id)
        if gate and due[pk] >= gate[1]:
            out[pk], starts[pk] = Decimal(str(gate[0])), gate[1]
    retests = {p.id: p.retest_of_sample_id for p in parents
               if p.id in out and getattr(p, "retest_of_sample_id", None)}
    if retests:
        originals = _original_order_times(db, retests)
        for pk in retests:
            at = originals.get(pk)
            if at is None or at < starts[pk]:
                del out[pk]
    return out


def iu_factor_for_sample(db, parent) -> Optional[Decimal]:
    return next(iter(iu_factors(db, [parent]).values()), None)


def to_iu(value, unit, factor: Optional[Decimal]) -> tuple:
    """(value, unit) for the wire. Only a mass in mg converts: a row already in
    IU stays as filed, and a value it cannot read keeps its unit, so a number is
    never relabeled without converting."""
    if factor is None or (unit or "mg").strip().lower() not in _MASS_UNITS:
        return value, unit
    text = "" if value is None else str(value).strip()
    if not text:
        return value, "IU"
    try:
        iu = Decimal(text) * factor
    except InvalidOperation:
        return value, unit
    return f"{iu:.3f}".rstrip("0").rstrip("."), "IU"


def declared_to_mg(declared: Optional[float], factor: Optional[Decimal]) -> Optional[float]:
    if declared is None or factor is None:
        return declared
    return round(float(declared) / float(factor), 3)


def declared_payload(db, row, shown: Optional[float] = None) -> dict:
    """Lookup fields for prep: the declared amount's unit and, when that is IU,
    the amount in mg. declared_weight_mg itself stays as stored because the
    sample details page edits it. `shown` is the figure the caller displays when
    it did not come from this row (the live SENAITE lookup), so the two agree."""
    factor = iu_factor_for_sample(db, row) if row is not None else None
    if factor is None:
        return {"declared_unit": None, "declared_prep_mg": None}
    declared = shown
    if declared is None:
        try:
            declared = float(row.declared_total_quantity)
        except (TypeError, ValueError):
            declared = None
    return {"declared_unit": "IU", "declared_prep_mg": declared_to_mg(declared, factor)}
