"""The HPLC prep worksheet's rows on the server (plan 2026-11-12-hplc-prep-worksheet, Task 5).

A row stores what a tech typed in ONE JSON column, worksheet_items.hplc_prep, changed by a
recursive merge patch. This module validates and merges those patches and serves the sheet's
row facts: what the server knows about each HPLC row before anything is typed. The browser
does the arithmetic (src/lib/hplc-prep.ts computeRow, the twin of hplc_prep.compute_row);
nothing here subtracts weighings or divides volumes. compute_row assumes every stored number
is a real number and every components / vials key a whole number written as a string, so the
validator refuses anything else rather than coercing it.

main imports this module inside its routes, so this module imports main only inside functions."""
import copy
import json
import math
import re
from typing import Optional

import mk1_db
from catalog.method_run_params import hplc_run_params
from hplc_prep import MAX_VIALS
from hplc_prep_rules import HPLC_DILUENTS
from models import (
    HplcMethod,
    Instrument,
    LimsSampleForm,
    LimsSubSample,
    Peptide,
    Settings,
    WorksheetItem,
    blend_components,
    instrument_methods,
    peptide_methods,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from worksheets_endo import _number

HPLC_FORMS = ("powder", "liquid", "bac", "capsule")
PREP_FINAL = "the row is promoted; its prep is final"  # endo's wording, the same string
BLEND_CAP_KEY = "hplc_blend_component_cap"
_BLEND_CAP_MAX = 4  # the physical ceiling until the 4-slot program lands

# The hplc_prep shape (the plan's "The shapes every task shares"). Every number is a weight,
# volume or target: finite and at least 0. capsules, lead_id and a component's vial are whole
# numbers (ints, never a float or a bool) with these bounds.
_ROW_NUMBERS = ("declared_mg", "declared_volume_ml", "diluent_ul", "stock_vial_mg",
                "stock_vial_diluent_mg")
_COMPONENT_NUMBERS = ("mg", "target")
_VIAL_NUMBERS = ("target_ug_ml", "target_volume_ul", "vial_mg", "vial_diluent_mg", "vial_all_mg",
                 "int_target_ug_ml", "int_volume_ul", "int_vial_mg", "int_vial_diluent_mg",
                 "int_vial_all_mg")
_MAP_KEY = re.compile(r"[1-9][0-9]*")  # "1", "36"; never "01", "+1", "1.0"
# Ceilings that keep the Python and TypeScript sides reading the same value (fix round 2, D1):
# above 2**53 - 1 JavaScript rounds a whole number; no balance or pipette reads 1e12.
_MAX_WHOLE = 2**53 - 1
_MAX_NUMBER = 1e12
# B4: a weighing (mg) and a volume in mL stop where POST /hplc/analyze stops (main.MAX_WEIGHING_MG,
# main.MAX_DECLARED_VOLUME_ML; main imports this module, so they are restated here and a test
# holds them equal), so no final prep carries a number the engine will refuse.
MAX_WEIGHING_MG = 1e9
MAX_DECLARED_VOLUME_ML = 1e6
_CEILINGS = {key: MAX_WEIGHING_MG for key in (
    "stock_vial_mg", "stock_vial_diluent_mg", "vial_mg", "vial_diluent_mg", "vial_all_mg",
    "int_vial_mg", "int_vial_diluent_mg", "int_vial_all_mg")} | {"declared_volume_ml": MAX_DECLARED_VOLUME_ML}
# B1: calc.js MAX_COMPONENTS; no more keys than this in one patch's components map
MAX_COMPONENTS = 7
# A declared quantity as stored ("10 mg", "10", "0.5mg"): its leading number.
_LEADING_NUMBER = re.compile(r"\s*([0-9]*\.?[0-9]+)")


class Refused(Exception):
    """apply_patch's refusal: the HTTP status and the reason."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status


def _check_object(value, path: str, numbers=(), wholes=None, others=None) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object or null")
    for key in sorted(value, key=str):
        v, where = value[key], f"{path}.{key}"
        if v is None:
            continue
        if key in numbers:
            top = _CEILINGS.get(key, _MAX_NUMBER)
            if not (_number(v) and 0 <= v <= top):
                raise ValueError(f"{where} must be a number from 0 to {top:.0f}")
        elif key in (wholes or {}):
            lo, hi = wholes[key]
            if not (_number(v) and isinstance(v, int) and lo <= v <= hi):
                raise ValueError(f"{where} must be a whole number from {lo} to {hi}")
        elif key in (others or {}):
            others[key](v, where)
        else:
            raise ValueError(f"{path} has an unknown key {ascii(key)}")


def _check_map(entry_check, max_key=None, max_count=None):
    def check(value, path: str) -> None:
        if not isinstance(value, dict):
            raise ValueError(f"{path} must be an object or null")
        if max_count is not None and len(value) > max_count:
            raise ValueError(f"{path} has {len(value)} keys; at most {max_count} are allowed")
        for key in sorted(value, key=str):
            if not (isinstance(key, str) and _MAP_KEY.fullmatch(key)):
                raise ValueError(f"{path} key {ascii(key)} is not a positive whole number")
            if max_key is not None and int(key) > max_key:
                raise ValueError(f"{path} key {ascii(key)} is not from 1 to {max_key}")
            if value[key] is not None:
                entry_check(value[key], f"{path}.{key}")
    return check


def _check_component(value, path: str) -> None:
    _check_object(value, path, _COMPONENT_NUMBERS, {"vial": (1, MAX_VIALS)})


def _check_vial(value, path: str) -> None:
    _check_object(value, path, _VIAL_NUMBERS, {"lead_id": (1, _MAX_WHOLE)})


def _check_diluent(value, path: str) -> None:
    if value not in HPLC_DILUENTS:
        raise ValueError(f"{path} must be one of: {', '.join(HPLC_DILUENTS)}")


def _check_bool(value, path: str) -> None:
    if not isinstance(value, bool):
        raise ValueError(f"{path} must be true, false or null")


def validate_hplc_prep_patch(patch) -> dict:
    """A merge patch in the hplc_prep shape, returned as is. Raises ValueError naming the key
    for an unknown key at any level, a number that is not finite (or a string, or a bool), a
    weight, volume or target below zero or above 1e12 (a weighing above 1e9 mg, a volume in mL
    above 1e6: the analyze route's ceilings), a capsules or lead_id that is not a
    whole number from 1 to 2**53 - 1, a vial outside 1 to 7, a components key that is not a
    positive whole number, more than 7 components keys, a vials key outside 1 to 7, a two_step
    that is not a boolean, or a diluent outside HPLC_DILUENTS. null is always allowed, and
    removes the key; the patch itself must be an object. Whether a components key is one of
    the row's own is apply_patch's check, which has the row."""
    if not isinstance(patch, dict):
        raise ValueError("hplc_prep must be an object")
    _check_object(patch, "hplc_prep", _ROW_NUMBERS, {"capsules": (1, _MAX_WHOLE)}, {
        "diluent": _check_diluent, "two_step": _check_bool,
        "components": _check_map(_check_component, max_count=MAX_COMPONENTS),
        "vials": _check_map(_check_vial, max_key=MAX_VIALS)})
    return patch


def _merge(stored: dict, patch: dict) -> dict:
    # src/lib/hplc-prep.ts mergeObject, line for line
    out = {}
    for key in {**stored, **patch}:
        sent = key in patch
        value = patch[key] if sent else stored[key]
        if value is None:
            continue
        if sent and isinstance(value, dict):
            base = stored.get(key)
            merged = _merge(base if isinstance(base, dict) else {}, value)
            if merged:
                out[key] = merged
        else:
            out[key] = copy.deepcopy(value)
    return out


def merge_hplc_prep(stored: Optional[dict], patch: dict) -> Optional[dict]:
    """A key sent replaces, a key sent as null is removed, a key not sent is untouched; an
    object is merged key by key, and one emptied is removed. None when nothing is left.
    Never mutates its arguments, and the result shares nothing with them."""
    return _merge(stored if isinstance(stored, dict) else {}, patch) or None


def blend_cap(db: Session) -> int:
    """The settings row hplc_blend_component_cap as a whole number, clamped to 1 to 4; 4 when
    the row is absent or not a whole number. One query."""
    raw = db.execute(select(Settings.value).where(Settings.key == BLEND_CAP_KEY)).scalar_one_or_none()
    try:
        cap = int(raw)
    except (TypeError, ValueError):
        return _BLEND_CAP_MAX
    return min(max(cap, 1), _BLEND_CAP_MAX)


def _hplc_items(db: Session, items) -> tuple[list, dict]:
    """(the HPLC-bench items, in the order given; sample_id -> vial row). One query."""
    from main import _bench_kind_for_item  # lazy: main imports this module

    sample_ids = {it.sample_id for it in items if it.sample_id}
    vials = {r.sample_id: r for r in db.execute(
        select(LimsSubSample.sample_id, LimsSubSample.parent_sample_pk, LimsSubSample.assignment_role,
               LimsSubSample.id)
        .where(LimsSubSample.sample_id.in_(sample_ids))).all()} if sample_ids else {}
    hplc = [it for it in items if _bench_kind_for_item(
        vials[it.sample_id].assignment_role if it.sample_id in vials else None,
        it.analyses_json) == "hplc"]
    return hplc, vials


def _preps_by_item(item_ids) -> dict[int, dict]:
    """item id -> {"id", "sample_id", "status"} of the sample_preps row promoted from it. The
    table lives behind mk1_db's own connection; ensure_sample_preps_table first, as every
    other reader does, so a deploy that has not run it yet still has worksheet_item_id."""
    if not item_ids:
        return {}
    _ensure_preps_table()
    return {p["worksheet_item_id"]: _slim(p)
            for p in mk1_db.list_sample_preps_for_worksheet_items(sorted(item_ids))}


def _slim(prep: dict) -> dict:
    return {"id": prep["id"], "sample_id": prep["sample_id"], "status": prep["status"]}


def _ensure_preps_table() -> None:
    global _preps_table_ready
    if not _preps_table_ready:
        # once per process: its ALTERs take a strong lock even when there is nothing to add,
        # and the columns are never dropped
        mk1_db.ensure_sample_preps_table()
        _preps_table_ready = True


_preps_table_ready = False


def _sheet_preps(items, vials: dict) -> tuple[dict, dict]:
    """(item id -> its promoted prep, item id -> other_preps), in ONE mk1_db query for every
    row (B8). other_preps: the sample_preps rows of the item's vial (lims_sub_sample_pk) NOT made
    from this item (a wizard prep, or one promoted from another worksheet's row), each
    {"id", "sample_id", "status"}, newest first. Information only: never a promote reason."""
    ids = {it.id for it in items}
    vial_pk = {it.id: vials[it.sample_id].id for it in items if it.sample_id in vials}
    if not ids:
        return {}, {}
    _ensure_preps_table()
    found = mk1_db.list_sample_preps_for_worksheet_items_or_vials(sorted(ids), sorted(set(vial_pk.values())))
    mine = {p["worksheet_item_id"]: _slim(p) for p in found if p["worksheet_item_id"] in ids}
    others = {i: [_slim(p) for p in found
                  if i in vial_pk and p["lims_sub_sample_pk"] == vial_pk[i] and p["worksheet_item_id"] != i]
              for i in ids}
    return mine, others


def _is_rider(vials: dict, item) -> bool:
    """A rider rides the run (assignment_role "fentanyl"): it has no prep of its own."""
    return item.sample_id in vials and vials[item.sample_id].assignment_role == "fentanyl"


def hplc_rows(db: Session, items) -> list:
    """The HPLC-bench items among `items`, in the order given. One query."""
    return _hplc_items(db, list(items))[0]


def promoted_hplc_item_ids(db: Session, items) -> set[int]:
    """The ids of the HPLC rows among `items` that have a sample_preps row: their form, prep and
    instrument are final. One query, plus one mk1_db query only when any item is an HPLC row.
    The one rule every writer of an item's instrument follows (fix round 2, A2); callers
    judge it under the worksheet then item locks (main._promoted_hplc_rows_locked)."""
    return set(_preps_by_item({it.id for it in hplc_rows(db, items)}))


def _declared(quantity) -> Optional[float]:
    if isinstance(quantity, bool):
        return None
    if isinstance(quantity, (int, float)):
        return float(quantity) if math.isfinite(quantity) else None
    m = _LEADING_NUMBER.match(quantity) if isinstance(quantity, str) else None
    return float(m.group(1)) if m else None


def _analytes(parent) -> tuple[list[tuple[int, Optional[float]]], bool]:
    """([(peptide_id, declared mg)] of the sample's analyte slots that carry a catalog peptide,
    first slot first, each peptide once; whether a named slot carries none)."""
    try:
        slots = json.loads(parent.analytes) if parent is not None and parent.analytes else []
    except (TypeError, ValueError):
        slots = []
    out, seen, unresolved = [], set(), False
    for slot in slots if isinstance(slots, list) else []:
        if not isinstance(slot, dict):
            continue
        pid = slot.get("peptide_id")
        if isinstance(pid, int) and not isinstance(pid, bool):
            if pid not in seen:
                seen.add(pid)
                out.append((pid, _declared(slot.get("declared_quantity"))))
        elif slot.get("name"):
            unresolved = True
    return out, unresolved


def _analysis_peptides(db: Session, parent_pks) -> dict[int, set[int]]:
    """parent pk -> the set of catalog peptides its live analyses (its own and its vials') name:
    the set-valued twin of coa.spec_rules.sample_peptide_ids, same anchor and joins, with
    coa.iu_display's wider dead states (a rejected or cancelled row is no second peptide).
    One query, none without pks."""
    from coa.iu_display import _DEAD_STATES
    from models import AnalysisService, LimsAnalysis

    pks = set(parent_pks)
    out: dict[int, set[int]] = {pk: set() for pk in pks}
    if not pks:
        return out
    anchor = func.coalesce(LimsAnalysis.peptide_id, AnalysisService.peptide_id)
    for host_pk, vial_parent_pk, peptide_id in db.execute(
            select(LimsAnalysis.lims_sample_pk, LimsSubSample.parent_sample_pk, anchor)
            .select_from(AnalysisService)
            .join(LimsAnalysis, LimsAnalysis.analysis_service_id == AnalysisService.id)
            .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
            .where(anchor.is_not(None), LimsAnalysis.review_state.not_in(_DEAD_STATES),
                   LimsAnalysis.lims_sample_pk.in_(pks) | LimsSubSample.parent_sample_pk.in_(pks))
            .distinct()).all():
        for pk in (host_pk, vial_parent_pk):
            if pk in out:
                out[pk].add(peptide_id)
    return out


def sheet_rows(db: Session, worksheet, items=None) -> list[dict]:
    """The row facts of every HPLC-bench item (the plan's "Row facts"), in the worksheet's item
    order, one row per item. `items` defaults to the worksheet's own. A fixed number of queries
    whatever the row count (the report lists them), plus the sample_preps lookup on mk1_db's
    connection."""
    # lazy: main imports this module
    from coa.iu_display import iu_factors
    from main import _worksheet_item_parent_facts, _worksheet_item_parents
    from worksheets_endo_promote import _sample_is_bac, _served_peptide_names

    if items is None:
        items = db.execute(select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet.id)
                           .order_by(WorksheetItem.sort_order, WorksheetItem.id)).scalars().all()
    items, vials = _hplc_items(db, list(items))
    if not items:
        return []
    parents = _worksheet_item_parents(db, {it.sample_id for it in items},
                                      {sid: v.parent_sample_pk for sid, v in vials.items()})
    iu_by_parent = iu_factors(db, list(parents.values()))
    names = _served_peptide_names(db, items)
    analytes = {it.id: _analytes(parents.get(it.sample_id)) for it in items}
    form_ids = {p.sample_form_id for p in parents.values() if p.sample_form_id}
    forms = {f.id: f for f in db.execute(
        select(LimsSampleForm).where(LimsSampleForm.id.in_(form_ids))).scalars()} if form_ids else {}

    # The sample's own analytes when a slot carries a catalog peptide; else (a sample born in
    # the older LIMS has none) the peptide set of its live analyses, in one query.
    fallback = {parents[it.sample_id].id for it in items
                if not analytes[it.id][0] and it.sample_id in parents}
    by_analyses = _analysis_peptides(db, fallback) if fallback else {}
    source, row_ids = {}, {}
    for it in items:
        parent = parents.get(it.sample_id)
        if analytes[it.id][0]:
            source[it.id], row_ids[it.id] = "analytes", [p for p, _ in analytes[it.id][0]]
        else:
            found = sorted(by_analyses.get(parent.id, ())) if parent is not None else []
            source[it.id], row_ids[it.id] = ("analyses" if found else None), found

    # A blend: the catalog blend whose components are exactly those peptides; an active one
    # before a retired one, then the lowest id. A retired blend that is the only match is
    # still the match: the sample is what it is (fix round 2, B). Every blend holding any of
    # those peptides, in one query.
    wanted = {frozenset(ids) for ids in row_ids.values() if len(ids) > 1}
    blends: dict[int, dict[int, int]] = {}
    blend_order: dict[int, list[int]] = {}
    retired: set[int] = set()
    if wanted:
        holding = select(blend_components.c.blend_id).where(
            blend_components.c.component_id.in_(set().union(*wanted)))
        for bid, active, cid, vial in db.execute(
                select(blend_components.c.blend_id, Peptide.active, blend_components.c.component_id,
                       blend_components.c.vial_number)
                .join(Peptide, Peptide.id == blend_components.c.blend_id)
                .where(Peptide.is_blend.is_(True), blend_components.c.blend_id.in_(holding))
                .order_by(blend_components.c.blend_id, blend_components.c.display_order,
                          blend_components.c.component_id)).all():
            blends.setdefault(bid, {})[cid] = vial
            blend_order.setdefault(bid, []).append(cid)
            if active is False:  # NULL counts as active, as the column's default has it
                retired.add(bid)
    blend_for = {s: min((b for b, comps in blends.items() if set(comps) == s), default=None,
                        key=lambda b: (b in retired, b))
                 for s in wanted}
    peptide_ids = {p for ids in row_ids.values() for p in ids} | (set(blend_for.values()) - {None})
    peptides = {p.id: p for p in db.execute(
        select(Peptide).where(Peptide.id.in_(peptide_ids))).scalars()} if peptide_ids else {}

    # Each row's catalog peptide, components and problems with it.
    resolved = {}
    for it in items:
        unresolved = source[it.id] == "analytes" and analytes[it.id][1]
        ids = row_ids[it.id]
        peptide_id, blend, problem = None, None, None
        if unresolved or any(p not in peptides for p in ids):
            problem = ("the sample has no catalog peptide" if not ids else
                       "an analyte of the sample has no catalog peptide" if source[it.id] == "analytes"
                       else "a test ordered on the sample has no catalog peptide")
        elif not ids:
            problem = "the sample has no catalog peptide"
        elif len(ids) == 1:
            peptide_id = ids[0]
        else:
            peptide_id = blend_for[frozenset(ids)]
            blend = blends.get(peptide_id)
            problem = None if peptide_id else "this blend is not in the catalog"
        resolved[it.id] = (peptide_id, blend, problem, len(ids) > 1)

    instrument_ids = {it.instrument_id for it in items if it.instrument_id}
    instruments = dict(db.execute(select(Instrument.id, Instrument.name).where(
        Instrument.id.in_(instrument_ids))).all()) if instrument_ids else {}
    # main._serialize_worksheets' method rule: the method linked to both the peptide and the
    # instrument, the lowest id when several are.
    pairs = {(resolved[it.id][0], it.instrument_id) for it in items
             if resolved[it.id][0] and it.instrument_id}
    run_params: dict = {}
    if pairs:
        for pid, iid, rp in db.execute(
                select(peptide_methods.c.peptide_id, instrument_methods.c.instrument_id,
                       HplcMethod.run_parameters)
                .select_from(HplcMethod)
                .join(peptide_methods, peptide_methods.c.method_id == HplcMethod.id)
                .join(instrument_methods, instrument_methods.c.method_id == HplcMethod.id)
                .where(peptide_methods.c.peptide_id.in_({p for p, _ in pairs}),
                       instrument_methods.c.instrument_id.in_({i for _, i in pairs}))
                .order_by(HplcMethod.id)).all():
            run_params.setdefault((pid, iid), rp)
    preps, other_preps = _sheet_preps(items, vials)

    rows = []
    for it in items:
        parent = parents.get(it.sample_id)
        facts = _worksheet_item_parent_facts(
            parent, iu_factor=iu_by_parent.get(parent.id) if parent is not None else None)
        peptide_id, blend, problem, is_blend = resolved[it.id]
        components = []
        if peptide_id:
            # From the analytes: their order and parsed quantities. From the analyses: a
            # blend in its own display order, the split unknown (typed in Step 2b).
            listed = (analytes[it.id][0] if source[it.id] == "analytes" else
                      [(pid, None) for pid in (blend_order[peptide_id] if blend else row_ids[it.id])])
            for pid, mg in listed:
                pep = peptides[pid]
                components.append({
                    "peptide_id": pid, "name": pep.name, "abbreviation": pep.abbreviation,
                    # a solo's weight is the row's: converted from IU where the sample
                    # was ordered in IU, which the analyte's raw quantity is not
                    "declared_mg": mg if blend else facts["declared_weight_mg"],
                    "vial": (blend.get(pid) or 1) if blend else 1})
        form_row = forms.get(parent.sample_form_id) if parent is not None else None
        sample_form = ({"id": form_row.id, "name": form_row.name, "hplc_prep": form_row.hplc_prep}
                       if form_row is not None else None)
        sample_bac = _sample_is_bac(it, parent, names.get(it.id, []))
        rider_only = _is_rider(vials, it)
        if rider_only:  # a rider rides the run: it has no prep of its own
            form = None
        elif it.prep_form in HPLC_FORMS:
            form = it.prep_form
        else:
            form = "bac" if sample_bac else (sample_form or {}).get("hplc_prep")
        hplc_prep = it.hplc_prep or {}
        # A missing declared weight is no problem: the sheet has a box for it (ruling, fix 1).
        problems = []
        if not rider_only:
            problems += [problem] if problem else []
            if form is None:
                problems.append("no HPLC prep for this sample form")
        rows.append({
            "item_id": it.id, "sample_id": it.sample_id,
            "parent_sample_id": parent.sample_id if parent is not None else None,
            # the customer's declaration, as _sample_is_bac reads it: the parent's identity,
            # else the served peptide names; never the catalog's name (fix round 2, C)
            "order_number": facts["client_order_number"],
            "identity": facts["sample_identity"] or ", ".join(names.get(it.id, [])) or None,
            "peptide_id": peptide_id,
            "peptide_name": peptides[peptide_id].name if peptide_id else None,
            "is_blend": is_blend, "components": components,
            "components_source": source[it.id],
            "declared_mg": facts["declared_weight_mg"],
            "sample_form": sample_form, "sample_bac": sample_bac, "form": form,
            "rider_only": rider_only,
            "instrument_id": it.instrument_id, "instrument_name": instruments.get(it.instrument_id),
            "params": hplc_run_params(run_params.get((peptide_id, it.instrument_id))),
            "prep_form": it.prep_form, "hplc_prep": hplc_prep,
            "promoted": it.id in preps, "prep": preps.get(it.id),
            "problems": problems,
            "other_preps": other_preps[it.id],
        })
    return rows


_UNSET = object()


def apply_patch(db: Session, worksheet, item, *, prep_form=_UNSET, hplc_prep=_UNSET) -> dict:
    """Validate, refuse, store; return the row's facts. A keyword left out is untouched.
    Raises Refused: 404 for an item that is not an HPLC row, 409 on a completed worksheet,
    400 with the reason for a bad patch or form, 409 PREP_FINAL when the row is promoted and
    this would change anything. Callers lock the rows first and commit after."""
    hplc, vials = _hplc_items(db, [item])
    if not hplc:
        raise Refused(404, "This item is not an HPLC row")
    if worksheet.status == "completed":
        raise Refused(409, "Worksheet is completed")
    form_after, prep_after = item.prep_form, item.hplc_prep or None
    if prep_form is not _UNSET:
        if prep_form is not None and prep_form not in HPLC_FORMS:
            raise Refused(400, f"prep_form must be one of {', '.join(HPLC_FORMS)}, or null")
        form_after = prep_form
    if hplc_prep is not _UNSET:
        if _is_rider(vials, item):
            raise Refused(400, "this row has no prep")
        try:
            validate_hplc_prep_patch(hplc_prep)
        except ValueError as exc:
            raise Refused(400, str(exc))
        # B1: a components key is one of the row's own components, so the stored map never
        # outgrows the sample; a null for any key only removes, so it is let through
        sent = {k for k, v in (hplc_prep.get("components") or {}).items() if v is not None}
        if sent:
            own = {str(c["peptide_id"]) for c in sheet_rows(db, worksheet, [item])[0]["components"]}
            stray = sorted(sent - own)
            if stray:
                raise Refused(400, f"hplc_prep.components key {ascii(stray[0])} is not a component of this row")
        prep_after = merge_hplc_prep(item.hplc_prep, hplc_prep)
    if (form_after, prep_after) != (item.prep_form, item.hplc_prep or None):
        if _preps_by_item([item.id]):
            raise Refused(409, PREP_FINAL)
        # a new dict every time: a plain JSON column misses an in-place edit
        item.prep_form, item.hplc_prep = form_after, prep_after
        db.flush()
    return sheet_rows(db, worksheet, [item])[0]
