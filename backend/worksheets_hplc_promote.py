"""Promote an HPLC prep worksheet row (plan 2026-11-12-hplc-prep-worksheet, Task 6): a finished
row becomes one sample_preps row, the record Process HPLC reads its weighings from.

promote_reasons says, in words a bench tech can act on, everything that stops a row; it is pure.
promote_row writes the prep. The route takes the locks (main): the worksheet row, then the
row's vial analyses and item (endo_prep_rules.lock_items_for_update), and promote_row holds
them until the mk1_db insert has committed, so the routes that refuse a promoted row
(worksheets_hplc.promoted_hplc_item_ids) are ordered against it. The numbers come from
compute_row and nowhere else: this module copies them into columns, it works nothing out.

main imports this module inside its route, so this module imports main only inside functions."""
import logging
from typing import Optional

import mk1_db
import psycopg2
import psycopg2.errors
import worksheets_hplc
from calculations.hplc_processor import BAC_STOCK_UG_ML, BENZYL_ALCOHOL_DENSITY, MAX_CAPSULES
from endo_prep_rules import _iso_now
from hplc_prep import compute_row
from hplc_prep_rules import load_rules
from models import HplcMethod, LimsSubSample, Peptide, instrument_methods, peptide_methods
from sqlalchemy import select
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

REFUSED_MESSAGE = "This row cannot be promoted yet."
REASON_COMPLETED = "the worksheet is completed; a completed worksheet promotes nothing"
REASON_RIDER = "this vial rides the run with another sample; it has no prep of its own"
REASON_NO_FORM = "this form has no HPLC prep in Mk1"
REASON_NO_INSTRUMENT = ("pick the instrument first: a curve is checked against the run's instrument, "
                        "and a prep without one cannot be checked")
REASON_DECLARED = "type the declared weight: the stock concentration is worked out from it"
REASON_DECLARED_ZERO = "the declared weight must be more than 0 mg"
REASON_CAPSULE_COUNT = "type how many capsules went into the stock"
REASON_LIQUID_VOLUME = "type the declared volume: a liquid's stock volume is the volume the customer declared"
REASON_STOCK_PAIR = "weigh the stock vial: Step 2 needs both of its weighings"
REASON_STOCK_BACKWARDS = ("Step 2: the vial and septum + diluent is not more than the empty vial; "
                          "check the two weights")
REASON_BAC_FIGURES = ("this method's bac water figures (stock or benzyl alcohol density) are not the ones "
                      "Process HPLC uses; have the method checked before a bac row is promoted")
REASON_SOLO_BLEND = ("the sample names a catalog blend as one peptide; record the blend's components "
                     "on the sample so each one is quantified on its own curve")
_FORM_PROBLEM = "no HPLC prep for this sample form"  # sheet_rows' wording for a null form
# compute_row's words for a flagged weighing (hplc_prep._warnings)
_FLAGGED = {"diluent": "the vial + diluent weight is less than the empty vial",
            "stock": "the last weight (vial, diluent + stock) is not more than the vial + diluent "
                     "weight, so no stock went in"}
_FINAL = (("vial_mg", "the empty vial"), ("vial_diluent_mg", "the vial + diluent"),
          ("vial_all_mg", "the vial with diluent + stock"))
_INTERMEDIATE = (("int_vial_mg", "the empty intermediate vial"),
                 ("int_vial_diluent_mg", "the intermediate vial + diluent"),
                 ("int_vial_all_mg", "the intermediate vial with diluent + stock"))
# Warnings that never stop a promote; their words go into the prep's notes.
_NOTE_WARNINGS = ("below_floor", "volume_off", "capsule_over_neat", "split_mismatch")
# One blend vial_data entry: the wizard's keys (main.create_sample_prep_endpoint), the
# intermediate vial and analyte_data.
VIAL_DATA_KEYS = {
    "vial_number", "component_ids", "component_abbreviations", "declared_weight_mg",
    "target_conc_ug_ml", "target_total_vol_ul", "stock_vial_empty_mg", "stock_vial_loaded_mg",
    "stock_conc_ug_ml", "required_diluent_vol_ul", "required_stock_vol_ul", "dil_vial_empty_mg",
    "dil_vial_with_diluent_mg", "dil_vial_final_mg", "actual_conc_ug_ml", "actual_diluent_vol_ul",
    "actual_stock_vol_ul", "actual_total_vol_ul", "int_vial_empty_mg", "int_vial_with_diluent_mg",
    "int_vial_final_mg", "analyte_data",
}
_UNIQUE_ITEM = "uq_sample_preps_worksheet_item"


class Refused(Exception):
    """promote_row's refusal: the HTTP status, a message, and for a 409 every reason."""

    def __init__(self, status: int, message: str, reasons: Optional[list] = None):
        super().__init__(message)
        self.status, self.reasons = status, reasons


def _and(words: list) -> str:
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def _missing(weighed: dict, names, skip=()) -> list:
    return [label for key, label in names if key not in skip and weighed.get(key) is None]


def _facts(row: dict) -> dict:
    return {k: row[k] for k in ("declared_mg", "form", "peptide_id", "components")}


def promote_reasons(row: dict, computed: Optional[dict], blend_cap: int) -> list[str]:
    """Every reason the row cannot be promoted, all at once, in the order the sheet is worked
    (empty: it can be). `row` is sheet_rows' row facts (plus "peptide_is_blend" when the
    caller knows the row's one peptide is a catalog blend); `computed` is compute_row's
    answer for it, or None when the row cannot be computed (no form, no components). The
    floor and the other warnings in _NOTE_WARNINGS are never a reason."""
    if row["rider_only"]:
        return [REASON_RIDER]
    reasons = [REASON_NO_FORM] if row["form"] is None else []
    reasons += [p for p in row["problems"] if p != _FORM_PROBLEM]
    if row.get("peptide_is_blend") and not row["is_blend"]:
        reasons.append(REASON_SOLO_BLEND)
    n = len(row["components"])
    if n > blend_cap:
        reasons.append(f"this blend has {n} components and the cap is {blend_cap}; "
                       "a partial blend is never filed")
    if row["instrument_id"] is None:
        reasons.append(REASON_NO_INSTRUMENT)
    if computed is None:
        return reasons

    inputs, form = row["hplc_prep"] or {}, computed["form"]
    declared = inputs.get("declared_mg") if inputs.get("declared_mg") is not None else row["declared_mg"]
    if form != "bac" and declared is None:
        reasons.append(REASON_DECLARED)
    if form == "capsule":
        count = inputs.get("capsules")
        if count is None:
            reasons.append(REASON_CAPSULE_COUNT)
        elif count > MAX_CAPSULES:
            reasons.append(f"a stock of {count} capsules is more than Process HPLC takes "
                           f"({MAX_CAPSULES}); check the count")
    # calculate_dilution_factor works a bac stock volume out with its own constants (it passes
    # stock_volume_ml neither), so the sheet's must be the same or the certificate differs
    if form == "bac" and (row["params"]["bac_stock_ug_ml"] != BAC_STOCK_UG_ML
                          or row["params"]["benzyl_alcohol_density_mg_ml"] != BENZYL_ALCOHOL_DENSITY):
        reasons.append(REASON_BAC_FIGURES)
    if form == "liquid" and not (inputs.get("declared_volume_ml") or 0) > 0:
        reasons.append(REASON_LIQUID_VOLUME)
    if form != "liquid":
        if inputs.get("stock_vial_mg") is None or inputs.get("stock_vial_diluent_mg") is None:
            reasons.append(REASON_STOCK_PAIR)
        elif computed["stock"]["problem"] == "diluent":
            reasons.append(REASON_STOCK_BACKWARDS)
    if computed["stock"]["problem"] == "declared":
        reasons.append(REASON_DECLARED_ZERO)

    weighed_vials = inputs.get("vials") or {}
    for v in computed["vials"]:
        weighed = weighed_vials.get(str(v["vial"])) or {}
        steps = ([("3a", _INTERMEDIATE, (), v["intermediate"]["actual"])] if v["two_step"] else []) + \
            [("3", _FINAL, ("vial_diluent_mg",) if v["neat"] else (), v["actual"])]
        for label, names, skip, actual in steps:
            missing = _missing(weighed, names, skip)
            if missing:
                reasons.append(f"Vial {v['vial']}, Step {label}: weigh {_and(missing)}")
            elif actual["problem"]:
                reasons.append(f"Vial {v['vial']}, Step {label}: {_FLAGGED[actual['problem']]}; "
                               "check the weights")
    if row["is_blend"]:
        names = {c["peptide_id"]: c["abbreviation"] or c["name"] for c in row["components"]}
        reasons += [f"type the weight of {names[c['peptide_id']]} in the blend split (Step 2b)"
                    for c in computed["components"] if c["declared_mg"] is None]

    # The backstop: whatever the list above missed, a prep never leaves without the numbers
    # Process HPLC works from.
    if not reasons:
        if computed["stock"]["total_diluent_ml"] is None:
            reasons.append("the stock volume cannot be worked out from these numbers; check Step 2")
        for v in computed["vials"]:
            if v["dilution_factor_total"] is None or v["stock_conc_ug_ml"] is None:
                reasons.append(f"Vial {v['vial']} cannot be worked out from these numbers; check the row")
    return reasons


def _vial_columns(v: dict, weighed: dict, stock_pair: tuple) -> dict:
    """One vial's columns, as the flat row and a vial_data entry share them. The intermediate
    weighings only when the vial takes two steps (a stale one would make the engine dilute
    twice); a neat vial's blank "+ diluent" as its empty weighing (the engine reads that as
    no diluent added)."""
    with_diluent = weighed.get("vial_diluent_mg")
    if v["neat"] and with_diluent is None:
        with_diluent = weighed.get("vial_mg")
    two = v["two_step"]
    return {
        "target_conc_ug_ml": v["target"]["value"], "target_total_vol_ul": v["target_volume_ul"],
        "stock_vial_empty_mg": stock_pair[0], "stock_vial_loaded_mg": stock_pair[1],
        "stock_conc_ug_ml": v["stock_conc_ug_ml"],
        "required_stock_vol_ul": v["plan"]["stock_vol_ul"],
        "required_diluent_vol_ul": v["plan"]["diluent_vol_ul"],
        "dil_vial_empty_mg": weighed.get("vial_mg"), "dil_vial_with_diluent_mg": with_diluent,
        "dil_vial_final_mg": weighed.get("vial_all_mg"),
        "actual_conc_ug_ml": v["actual"]["actual_conc_ug_ml"],
        "actual_diluent_vol_ul": v["actual"]["actual_diluent_ul"],
        "actual_stock_vol_ul": v["actual"]["actual_stock_ul"],
        "actual_total_vol_ul": v["actual"]["actual_total_ul"],
        "int_vial_empty_mg": weighed.get("int_vial_mg") if two else None,
        "int_vial_with_diluent_mg": weighed.get("int_vial_diluent_mg") if two else None,
        "int_vial_final_mg": weighed.get("int_vial_all_mg") if two else None,
    }


def _prep_data(db: Session, current_user, worksheet, item, row: dict, computed: dict) -> dict:
    """The sample_preps row, every value from the row facts, its inputs or compute_row."""
    import json

    inputs = row["hplc_prep"] or {}
    form = computed["form"]
    # stock_volume_ml reads (with_diluent - empty), so the heavier weighing is "loaded": for
    # every form that is stock_vial_diluent_mg (a bac vial is weighed full first, then emptied)
    stock_pair = (None, None) if form == "liquid" else (inputs.get("stock_vial_mg"),
                                                        inputs.get("stock_vial_diluent_mg"))
    weighed_vials = inputs.get("vials") or {}
    columns = {v["vial"]: _vial_columns(v, weighed_vials.get(str(v["vial"])) or {}, stock_pair)
               for v in computed["vials"]}
    peptide = db.get(Peptide, row["peptide_id"])
    vial_pk = db.execute(select(LimsSubSample.id).where(
        LimsSubSample.sample_id == item.sample_id)).scalar_one_or_none()
    notes = [w["text"] for w in computed["warnings"] if w["code"] in _NOTE_WARNINGS]
    data = {
        "worksheet_item_id": item.id, "lims_sub_sample_pk": vial_pk,
        "senaite_sample_id": item.sample_id,
        "peptide_id": peptide.id, "peptide_name": peptide.name,
        "peptide_abbreviation": peptide.abbreviation,
        "instrument_id": row["instrument_id"], "instrument_name": row["instrument_name"],
        "status": "awaiting_hplc", "notes": "\n".join(notes) or None,
        "created_by_user_id": current_user.id, "created_by_email": current_user.email,
        "updated_by_user_id": current_user.id, "updated_by_email": current_user.email,
        "prep_form": form,
        # the declared total in the stock: per capsule x the count, the worked-out bac weight
        "declared_weight_mg": computed["declared_total_mg"],
        "declared_volume_ml": inputs.get("declared_volume_ml") if form == "liquid" else None,
        "capsules_used": inputs.get("capsules") if form == "capsule" else None,
        "diluent": computed["diluent"]["diluent"],
        "is_blend": bool(row["is_blend"]),
        # vial 1 is the lowest vial: every component may have moved to vial 2
        **columns[computed["vials"][0]["vial"]],
    }
    if row["is_blend"]:
        listed = {c["peptide_id"]: c for c in row["components"]}
        mine = {c["peptide_id"]: c for c in computed["components"]}
        aliases = dict(db.execute(select(Peptide.id, Peptide.hplc_aliases).where(
            Peptide.id.in_(list(listed)))).all())
        data["components_json"] = json.dumps([
            {"id": pid, "name": c["name"], "abbreviation": c["abbreviation"],
             "vial_number": mine[pid]["vial"], "hplc_aliases": aliases.get(pid)}
            for pid, c in listed.items()])
        entries = []
        for v in computed["vials"]:
            lead = mine[v["lead"]["peptide_id"]]
            entries.append({
                "vial_number": v["vial"], "component_ids": v["component_ids"],
                "component_abbreviations": [listed[p]["abbreviation"] for p in v["component_ids"]],
                "declared_weight_mg": lead["declared_mg"],
                **columns[v["vial"]],
                "analyte_data": [{
                    "component_id": p, "abbreviation": listed[p]["abbreviation"],
                    "declared_weight_mg": mine[p]["declared_mg"],
                    "target_conc_ug_ml": mine[p]["planned_final_ug_ml"],
                    "target_total_vol_ul": v["target_volume_ul"],
                    "stock_conc_ug_ml": mine[p]["stock_conc_ug_ml"],
                    "required_stock_vol_ul": v["plan"]["stock_vol_ul"],
                    "required_diluent_vol_ul": v["plan"]["diluent_vol_ul"],
                    "actual_conc_ug_ml": mine[p]["actual_final_ug_ml"],
                } for p in v["component_ids"]],
            })
        data["vial_data"] = json.dumps(entries)
    return data


def _promote_stamp(computed: dict, user_id) -> dict:
    """The rule the row was promoted under. locked_by carries the event, as an endo lock's
    does, so endo_prep_rules.release_on_clear (which frees a "result" lock) never frees it."""
    return {"event": "promote", "locked_at": _iso_now(), "locked_by": "promote", "user_id": user_id,
            "diluent": computed["diluent"]["diluent"], "floor_ug_ml": computed["floor_ug_ml"],
            "vials": [{"vial": v["vial"], "lead": v["lead"]["peptide_id"], "target": v["target"]["value"]}
                      for v in computed["vials"]]}


def _stamp_analyses(db: Session, item, row: dict, user_id) -> None:
    """The wizard's bench stamp (prep_bridge.stamp_prep_assignment), fill-only-NULL, on the
    vial's HPLC analyses: the row's instrument and the method the sheet's params came from
    (linked to both the row's peptide and its instrument, lowest id; none links, no method).
    Runs after the prep's commit in its own transaction; best effort, logged, never fatal."""
    from lims_analyses import prep_bridge

    try:
        vial_pk = db.execute(select(LimsSubSample.id).where(
            LimsSubSample.sample_id == item.sample_id)).scalar_one_or_none()
        if vial_pk is None:
            return
        method_id = db.execute(
            select(HplcMethod.id)
            .join(peptide_methods, peptide_methods.c.method_id == HplcMethod.id)
            .join(instrument_methods, instrument_methods.c.method_id == HplcMethod.id)
            .where(peptide_methods.c.peptide_id == row["peptide_id"],
                   instrument_methods.c.instrument_id == row["instrument_id"])
            .order_by(HplcMethod.id).limit(1)).scalar_one_or_none()
        prep_bridge.stamp_prep_assignment(db, lims_sub_sample_pk=vial_pk, instrument_id=row["instrument_id"],
                                          method_id=method_id, user_id=user_id)
        db.commit()
    except Exception:
        db.rollback()
        log.exception("hplc_promote_stamp_failed item=%s sample=%s", item.id, item.sample_id)


def _first_line(exc: Exception) -> str:
    return (str(exc).strip().splitlines() or [type(exc).__name__])[0]


def _computed_row(db: Session, worksheet, item, *, peptide_check: bool) -> tuple[dict, Optional[dict]]:
    row = worksheets_hplc.sheet_rows(db, worksheet, [item])[0]
    if peptide_check and row["peptide_id"] and not row["is_blend"]:
        pep = db.get(Peptide, row["peptide_id"])
        row = {**row, "peptide_is_blend": bool(pep is not None and pep.is_blend)}
    # never computed without components: a row with a form and none is a problem row
    computed = (compute_row(_facts(row), row["hplc_prep"], load_rules(db), row["params"])
                if row["form"] and row["components"] else None)
    return row, computed


def _already(db: Session, current_user, worksheet, item, prep: dict) -> dict:
    """A row promoted before: its prep, and the promote stamp written when a half commit lost
    it (the prep committed, the item's stamp did not)."""
    if (item.prep_rule or {}).get("event") != "promote":
        _row, computed = _computed_row(db, worksheet, item, peptide_check=False)
        if computed is not None and computed["vials"]:
            item.prep_rule = _promote_stamp(computed, current_user.id)
            db.commit()
            _stamp_analyses(db, item, _row, current_user.id)
    row = worksheets_hplc.sheet_rows(db, worksheet, [item])[0]
    return {"prep": prep, "already": True, "row": row}


def promote_row(db: Session, current_user, worksheet, item) -> dict:
    """POST /worksheets/{id}/items/{item_id}/hplc/promote. The caller holds the worksheet and
    item locks, re-read; this keeps them (no commit, no rollback) until the sample_preps
    insert has committed. Then the item's promote stamp and the commit, then the vial's bench
    stamp. Raises Refused: 404 not an HPLC row, 409 with every reason, 500 when mk1_db fails
    (nothing is written then on either side)."""
    if not worksheets_hplc.hplc_rows(db, [item]):
        raise Refused(404, "This item is not an HPLC row")
    if worksheet.status == "completed":
        raise Refused(409, REFUSED_MESSAGE, [REASON_COMPLETED])
    try:
        found = worksheets_hplc._preps_by_item([item.id])
        if item.id in found:
            return _already(db, current_user, worksheet, item, found[item.id])
        row, computed = _computed_row(db, worksheet, item, peptide_check=True)
        reasons = promote_reasons(row, computed, worksheets_hplc.blend_cap(db))
        if reasons:
            raise Refused(409, REFUSED_MESSAGE, reasons)
        data = _prep_data(db, current_user, worksheet, item, row, computed)
        try:
            mk1_db.create_sample_prep(data)
        except psycopg2.errors.UniqueViolation as exc:
            # the backstop index: another request promoted this row first; read the winner
            if getattr(exc.diag, "constraint_name", None) != _UNIQUE_ITEM:
                raise
            found = worksheets_hplc._preps_by_item([item.id])
            if item.id not in found:
                raise
            return _already(db, current_user, worksheet, item, found[item.id])
    except psycopg2.Error as exc:
        log.exception("hplc_promote_mk1_db_failed item=%s", item.id)
        raise Refused(500, f"The prep was not saved: {_first_line(exc)}")
    item.prep_rule = _promote_stamp(computed, current_user.id)
    db.commit()
    _stamp_analyses(db, item, row, current_user.id)
    out = worksheets_hplc.sheet_rows(db, worksheet, [item])[0]
    return {"prep": out["prep"], "already": False, "row": out}
