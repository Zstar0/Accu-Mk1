"""Promote to Parent from the 2 mL endotoxin worksheet (endo slice 3, spec
docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md, sections
5.2 and 5.3).

The browser sends the values the analyst sees: the value, its unit, its LOQ,
its LOD and the LOD's unit (spec D6). The server re-checks every eligibility
rule from what the worksheet stored, fills the vial's endotoxin result,
promotes it through the sample page's own promote function
(lims_analyses.promote_flow.run_promote) and records where each value came
from. It never recomputes the endotoxin maths; it only confirms the sent
value and LOQ match the stored reading (final review I-3).

Rows are independent: a row's fill and promote commit together or not at
all, and a refused or failed row never blocks the others."""
import json
import logging
import math
import re
from decimal import Decimal
from types import SimpleNamespace
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from coa.spec_rules import normalize_matrix, normalize_unit, resolve_spec, sample_peptide_id
from endo_prep_rules import effective_values, load_rules, row_facts, row_rule
from models import (
    AnalysisService, AuditLog, LimsAnalysis, LimsSubSample, WorksheetItem,
    service_group_members,
)
from worksheets_endo import (
    _DEAD_STATES, cartridge_sensitivities, endo_run_params, form_is_bac, parse_reading,
    reader_shows, reader_validity, resolve_endo_method,
)

log = logging.getLogger(__name__)

# The Mk1-native endotoxin service (spec 5.2 rule 1, the browser's
# NATIVE_ENDO_KEYWORD); SENAITE-born ENDO-LAL keeps manual entry.
NATIVE_ENDO_KEYWORD = "ENDOTOXIN-USP85LAL"
UNIT_PEPTIDE = "EU/vial"
UNIT_BAC = "EU/mL"
LOD_UNIT = "EU/mL"
# Bac water goes into the cartridge 20x, so a clean run reads < sensitivity
# x 20 (src/lib/endo-prep-2ml.ts BW_DILUTION and prep2Check's floorShown).
BW_DILUTION = 20
# The words of the browser's isBacWater (src/lib/endo-prep.ts).
_BAC_WORDS = re.compile(r"bacteriostatic|bac\.?\s*water", re.IGNORECASE)
# The vial states a worksheet may fill (spec 5.2 rule 2).
_FILLABLE_STATES = ("unassigned", "assigned", "to_be_verified")

# Spec 5.3's reasons; the dialog shows them as they are.
REASON_STOCK = "promote is for 2 mL worksheets"
REASON_NOT_ON_WORKSHEET = "not on this worksheet"
REASON_NOT_NATIVE = "manual entry: SENAITE-born endotoxin"
REASON_NO_ENDO = "the vial has no endotoxin analysis"
REASON_MANY_ENDO = "the vial has more than one endotoxin analysis"
REASON_PROMOTED = "already promoted"
REASON_PARENT_HOLDS = "the parent already holds a result; retest the vial to replace it"
REASON_NO_READING = "no reading"
REASON_NO_CARTRIDGE = "the row has no cartridge"
REASON_PEPTIDE_UNIT = "peptides promote in EU/vial"
REASON_BAC_UNIT = "bac water promotes in EU/mL"
REASON_BAD_NUMBERS = "the value, LOQ or LOD does not match the worksheet row"
REASON_GT = ("a '>' reading reports only when the floor itself already fails, so "
             "re-run the vial at a higher dilution for a number")
REASON_UNEXPECTED = "not promoted: an unexpected error, see the server log"
TYPED = "typed, no reader record"


class EndoPromoteRowIn(BaseModel):
    """One ticked Box 3 row: the values its confirm dialog showed."""
    item_id: int
    value: float
    unit: str
    loq: float
    lod: float
    lod_unit: str
    # The endo ">" certificate slice: the browser asserts that this value is a
    # floor, and the server checks the assertion against the stored reading
    # (the same trust model as value and LOQ, final review I-3).
    result_floor: bool = False


class EndoPromoteRequest(BaseModel):
    # The reader import's bound; the route also caps it at the item count.
    rows: list[EndoPromoteRowIn] = Field(max_length=500)


class EndoPromoteRowResult(BaseModel):
    item_id: int
    promoted: bool
    parent_analysis_id: Optional[int] = None
    state: Optional[str] = None
    reason: Optional[str] = None


class EndoPromoteResponse(BaseModel):
    results: list[EndoPromoteRowResult]


class _Refused(Exception):
    """A row that cannot be promoted; the message is the reason shown."""


def vial_endo_analyses(db: Session, sample_ids) -> dict[str, list[tuple[LimsAnalysis, AnalysisService]]]:
    """Each vial's live endotoxin analyses with their services (spec 5.2
    rule 1), keyed by the vial's sample id: the current row of each retest
    chain (retested is false), not rejected or retracted, on a service whose
    keyword names the endotoxin bench (main._bench_kind_for_keyword; the
    service FK, never the row's label). ONE query for any number of vials,
    never one per item (the 2026-09-15 pool outage class). A sample id with
    no vial (a legacy bare parent id) maps to an empty list."""
    out: dict = {sid: [] for sid in sample_ids}
    if not out:
        return out
    from main import _bench_kind_for_keyword  # lazy: main imports this module

    for sample_id, analysis, svc in db.execute(
        select(LimsSubSample.sample_id, LimsAnalysis, AnalysisService)
        .join(LimsAnalysis, LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id)
        .join(AnalysisService, AnalysisService.id == LimsAnalysis.analysis_service_id)
        .where(LimsSubSample.sample_id.in_(list(out)),
               LimsAnalysis.retested.is_(False),
               LimsAnalysis.review_state.notin_(_DEAD_STATES))
        .order_by(LimsAnalysis.id)
    ).all():
        if _bench_kind_for_keyword(svc.keyword) == "endo":
            out[sample_id].append((analysis, svc))
    return out


def endo_analysis_by_sample(db: Session, sample_ids) -> dict[str, Optional[dict]]:
    """The endo_analysis key of endotoxin worksheet items (spec 5.1): the
    vial's one live endotoxin analysis as {id, state, keyword, native}, else
    None (no vial, no live endotoxin analysis, or more than one; the
    promote's refusal tells those apart). One query for a whole page."""
    out: dict[str, Optional[dict]] = {}
    for sample_id, pairs in vial_endo_analyses(db, sample_ids).items():
        if len(pairs) != 1:
            out[sample_id] = None
            continue
        analysis, svc = pairs[0]
        out[sample_id] = {"id": analysis.id, "state": analysis.review_state,
                          "keyword": svc.keyword, "native": svc.origin == "mk1"}
    return out


def _same(a: float, b: float) -> bool:
    """Equal within the spec's relative tolerance (1e-9)."""
    return math.isclose(a, b, rel_tol=1e-9)


def _near(sent: float, expected: float) -> bool:
    """Equal as Box 3 shows it: 3 decimals (0.0005), plus 1e-6 relative for
    the browser's float steps (final review I-3)."""
    return abs(sent - expected) <= 0.0005 + 1e-6 * abs(expected)


def _num_text(v: float) -> str:
    """A result as stored text, never in exponent form (main._dec_to_str's
    idiom): 25.0 -> "25", 350.0 -> "350", 0.2 -> "0.2"."""
    return format(Decimal(repr(v)).normalize(), "f")


def _fmt(v: float) -> str:
    """The browser's fmt (src/lib/endo-prep.ts): JS Math.round to 3 decimals,
    printed without a trailing .0, so both sides' reason texts are identical."""
    r = math.floor(v * 1000 + 0.5) / 1000
    s = repr(r)
    return s[:-2] if s.endswith(".0") else s


def _positive(v) -> Optional[float]:
    """A catalog sensitivity as a usable number (consumable specs are free
    JSON), else None."""
    ok = (isinstance(v, (int, float)) and not isinstance(v, bool)
          and math.isfinite(v) and v > 0)
    return float(v) if ok else None


def _served_peptide_names(db: Session, items) -> dict[int, list[str]]:
    """Each item's distinct analysis peptide names, in order, from what the
    worksheet item serializer serves as `analyses` (main._serialize_worksheets):
    the item's own analyses_json, else its service group's members. One
    query at most, for the group-only items."""
    group_ids = {it.service_group_id for it in items
                 if not it.analyses_json and it.service_group_id}
    by_group: dict[int, list] = {}
    if group_ids:
        for gid, name in db.execute(
            select(service_group_members.c.service_group_id, AnalysisService.peptide_name)
            .join(AnalysisService,
                  AnalysisService.id == service_group_members.c.analysis_service_id)
            .where(service_group_members.c.service_group_id.in_(group_ids))
            .order_by(service_group_members.c.service_group_id, AnalysisService.id)
        ).all():
            by_group.setdefault(gid, []).append({"peptide_name": name})
    out = {}
    for it in items:
        if it.analyses_json:
            try:
                analyses = json.loads(it.analyses_json)
            except ValueError:
                analyses = []
        else:
            analyses = by_group.get(it.service_group_id, [])
        names = [a.get("peptide_name") for a in analyses if isinstance(a, dict)] \
            if isinstance(analyses, list) else []
        out[it.id] = list(dict.fromkeys(n for n in names if isinstance(n, str) and n))
    return out


def _sample_is_bac(item, parent, peptide_names: list[str]) -> bool:
    """The browser's isBacWaterSample (src/lib/endo-prep-2ml.ts): a BW-
    sample id, or a sample type or identity that mentions bacteriostatic
    water, from the same parent facts the worksheet item serves. The identity
    is endoIdentityFor's (src/lib/endo-worksheet.ts): the parent's, else the
    item's analysis peptide names joined with ", ". The row's form plays no
    part."""
    from main import _worksheet_item_parent_facts  # lazy: main imports this module

    facts = _worksheet_item_parent_facts(parent)
    identity = facts["sample_identity"] or ", ".join(peptide_names)
    return ((item.sample_id or "").upper().startswith("BW-")
            or bool(_BAC_WORDS.search(facts["sample_type"] or ""))
            or bool(_BAC_WORDS.search(identity)))


def _parent_holds(db: Session, parent_pk: int, service_id: int) -> bool:
    """The parent already holds a live result for this service: the row
    uq_lims_analyses_parent_service_id_root keeps unique (database.py)."""
    return db.execute(select(LimsAnalysis.id).where(
        LimsAnalysis.lims_sample_pk == parent_pk,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.analysis_service_id == service_id,
        LimsAnalysis.provenance == "canonical",
        LimsAnalysis.retest_of_id.is_(None),
        LimsAnalysis.review_state.notin_(_DEAD_STATES),
    ).limit(1)).first() is not None


def _refusal(item_id: int, reason: str) -> EndoPromoteRowResult:
    return EndoPromoteRowResult(item_id=item_id, promoted=False, reason=reason)


def _plan(db: Session, worksheet, item, row: EndoPromoteRowIn, ctx) -> dict:
    """Spec 5.2's rules re-checked from stored data, in the order of spec
    5.3's reason table where one rule needs another's answer, then the spec
    the result will be judged by. Writes nothing. Returns what the fill, the
    promote and the audit row need, or raises _Refused with the reason."""
    if item is None:
        raise _Refused(REASON_NOT_ON_WORKSHEET)
    pairs = ctx.live.get(item.sample_id) or []
    if not pairs:
        raise _Refused(REASON_NO_ENDO)
    if len(pairs) > 1:
        raise _Refused(REASON_MANY_ENDO)
    analysis, svc = pairs[0]
    # Re-read the vial under a row lock (final review I-1): a request that
    # loaded it before another promote committed waits here for that commit
    # and judges the row as committed, so it never retracts the other's fresh
    # parent. Both worksheet requests lock the vial first: no new deadlock.
    # SQLite ignores FOR UPDATE.
    db.refresh(analysis, with_for_update=True)
    # The item too, read after that lock (Task 4 locking follow-up): the item
    # PATCH and Re-apply take the analysis lock before they write the item,
    # so this reads the row as committed, never as the batch loaded it.
    db.refresh(item)
    if svc.origin != "mk1" or svc.keyword != NATIVE_ENDO_KEYWORD:
        raise _Refused(REASON_NOT_NATIVE)
    if analysis.review_state == "promoted":
        raise _Refused(REASON_PROMOTED)
    # Dead states are not fillable; a row retested meanwhile is no longer the live one.
    if analysis.retested or analysis.review_state not in _FILLABLE_STATES:
        state = "retested" if analysis.retested else analysis.review_state
        raise _Refused(f"the vial's endotoxin analysis is {state}")
    parent = ctx.parent_by_sample[item.sample_id]
    # Only a retest row's promote may supersede the parent's live result
    # (promote_to_parent); any other row would collide with it.
    if analysis.retest_of_id is None and _parent_holds(db, parent.id, svc.id):
        raise _Refused(REASON_PARENT_HOLDS)
    if item.result_reading is None:
        raise _Refused(REASON_NO_READING)
    parsed = parse_reading(item.result_reading)
    # A ">" says the vial holds AT LEAST this much, so the number is a floor,
    # not the result. It promotes ONLY when the floor already reaches the
    # limit, which is a definitive failure whatever the true value is; the
    # row carries result_floor so the spec engine judges it as a floor
    # (coa.spec_rules.evaluate) and the certificate prints "> 2500". A floor
    # under the limit is refused below, once the spec says what the limit is.
    lt, gt, reading = parsed.lt, parsed.gt, parsed.value
    record = item.result_reader
    if record:
        valid, why = reader_validity(record, ctx.run_params)
        if not valid:
            raise _Refused("Invalid: " + "; ".join(why))
    # The browser's unit rule: the row's form (formOf) must agree with the
    # sample (isBacWaterSample), and the unit follows the form.
    sample_bac = _sample_is_bac(item, parent, ctx.peptide_names.get(item.id, []))
    bac = form_is_bac(item.prep_form, sample_bac)
    if bac != sample_bac:
        raise _Refused(REASON_PEPTIDE_UNIT if bac else REASON_BAC_UNIT)
    unit = UNIT_BAC if bac else UNIT_PEPTIDE
    if normalize_unit(row.unit) != normalize_unit(unit):
        raise _Refused(REASON_BAC_UNIT if bac else REASON_PEPTIDE_UNIT)
    # A saved reading always stores its row's cartridge (check_item_endo_fields);
    # the run's and the method default are the spec's fallbacks.
    cartridge_id = (item.cartridge_type_id or worksheet.cartridge_type_id
                    or ctx.default_cartridge_id)
    sensitivity = _positive(ctx.sensitivities.get(cartridge_id))
    if sensitivity is None:
        raise _Refused(REASON_NO_CARTRIDGE)
    # The number a clean run shows: the sensitivity, x 20 for bac water.
    floor = round(sensitivity * BW_DILUTION, 6) if bac else sensitivity
    if lt and not _same(reading, floor):
        what = "floor for bac water" if bac else "sensitivity"
        raise _Refused(f"the reading <{_fmt(reading)} is not this cartridge's {what} "
                       f"({_fmt(floor)})")
    if (not all(math.isfinite(x) for x in (row.value, row.loq, row.lod))
            or row.value < 0 or row.loq <= 0 or row.lod <= 0
            or normalize_unit(row.lod_unit) != normalize_unit(LOD_UNIT)
            or not _same(row.lod, sensitivity)
            or bool(row.result_floor) != gt
            or (lt and not _same(row.value, row.loq))):
        raise _Refused(REASON_BAD_NUMBERS)
    # The browser's totalOf and waterOf (src/lib/endo-prep-2ml.ts). The total
    # is the row's effective one (slice 5, spec 5): its own, else its rule's,
    # else the method's standard. A result locks the row, so the rule is the
    # line the row locked, never one edited since.
    params = endo_run_params(ctx.run_params)
    if bac:
        total, water = BW_DILUTION, None
    else:
        facts = ctx.facts.get(item.id)
        rule = (row_rule(item, rules=ctx.rules, endo_prep=worksheet.endo_prep, **facts)
                if facts else None)
        # Water resolves through the same chain as the total now that a rule
        # line can prescribe it: typed beats rule beats the method's standard,
        # and a liquid row keeps only what the analyst typed (powder only).
        effective = effective_values(item, rule, std_total=params["std_total_dilution"],
                                     std_water=params["recon_water_ml"])
        total, water = effective["total_dilution"], effective["recon_water_ml"]
    # Final review I-3 (Handler, 2026-10-13): the sent value and LOQ must be
    # what this row's stored reading gives, within Box 3's 3-decimal display.
    # It confirms the browser's arithmetic and recomputes no verdict. Bac
    # water reads in EU/mL already; its LOQ is the sensitivity x 20. A liquid
    # with no water has no value (the browser's waterOf is null), so it is
    # refused as the browser refuses it.
    if not bac and water is None:
        raise _Refused(REASON_BAD_NUMBERS)
    scale = 1 if bac else total * water
    if not (_near(row.value, reading * scale)
            and _near(row.loq, sensitivity * (BW_DILUTION if bac else scale))):
        raise _Refused(REASON_BAD_NUMBERS)
    # The spec the certificate will judge the result by (coa.native_sections).
    matrix = normalize_matrix(parent.sample_type_title)
    spec = resolve_spec(db, svc.id, matrix, peptide_id=sample_peptide_id(db, parent.id),
                        unit=unit)
    if spec is None:
        raise _Refused(f"No active {svc.title} spec in {unit} for {matrix or 'any sample type'}")
    limit = (float(spec.max_value)
             if spec.rule_kind == "range" and spec.max_value is not None else None)
    if lt and limit is not None and row.loq > limit:
        raise _Refused(f"inconclusive: LOQ {_fmt(row.loq)} {unit} is above the {_fmt(limit)} limit")
    # The only verdict a floor supports: it fails once the floor itself
    # reaches the limit (inclusive, so exactly the limit fails). Under the
    # limit, or with no limit to clear, the true value is unknown and nothing
    # may be reported. Mirrors coa.spec_rules.evaluate(floor=True), which
    # would abort the certificate on such a row.
    if gt and (limit is None or row.value < limit):
        why = ("the spec has no upper limit for a floor to reach" if limit is None
               else f"a floor of {_fmt(row.value)} {unit} does not reach the "
                    f"{_fmt(limit)} limit")
        raise _Refused(f"inconclusive: {why}; {REASON_GT}")
    # A "<" result is stored as the number equal to its LOQ (spec section 4),
    # the same float, so the certificate's value <= LOQ always prints "< <LOQ>".
    loq = row.value if lt else row.loq
    return {
        "analysis": analysis,
        "unit": unit,
        "loq": loq,
        "result_floor": gt,
        "details": {
            "user_id": ctx.user_id, "worksheet_id": worksheet.id, "item_id": item.id,
            "sample_id": item.sample_id, "reading": item.result_reading,
            "reader_test_id": (record.get("test_id")
                               if record and reader_shows(record, parsed) else TYPED),
            "cartridge_type_id": cartridge_id, "cartridge_sensitivity": sensitivity,
            "total_dilution": total, "water_ml": water,
            "value": row.value, "unit": unit, "loq": loq, "lod": row.lod, "lod_unit": LOD_UNIT,
            "result_floor": gt,
        },
    }


def _promote_one(db: Session, current_user, worksheet, item, row: EndoPromoteRowIn, plan: dict,
                 background_tasks) -> EndoPromoteRowResult:
    """Fill the vial's result and promote it (spec 5.3 steps 2 to 4). The
    fill is flushed into the transaction run_promote commits, so the two land
    together or not at all. The provenance row needs the parent's id, so it
    follows in its own commit, before the next row's promote can roll the
    session back; a failure there is logged and the promotion stands, as the
    sample page's promote treats its own bookkeeping."""
    from lims_analyses import promote_flow  # lazy, so a test can patch run_promote
    from lims_analyses.schemas import PromoteRequest, PromoteSourceRef
    from lims_analyses.service import apply_transition

    analysis = plan["analysis"]
    value = _num_text(row.value)
    reason = f"promoted from worksheet WS-{worksheet.id} row {item.sample_id}"
    # The worksheet's pinned endotoxin method (v2 pins it at the first reading
    # or print); unpinned, the vial keeps the method it has.
    method_id = worksheet.endo_method_id or analysis.method_id
    apply_transition(
        db, analysis_id=analysis.id, kind="submit", result_value=value,
        result_unit=plan["unit"], loq=plan["loq"], lod=row.lod, lod_unit=LOD_UNIT,
        result_floor=plan["result_floor"] or None,
        method_id=method_id, user_id=plan["details"]["user_id"], reason=reason, commit=False,
    )
    resp = promote_flow.run_promote(db, current_user, PromoteRequest(
        keyword=analysis.keyword, result_value=value, result_unit=plan["unit"],
        method_id=method_id,
        # The instrument the reader import stamped stays as it is.
        instrument_id=analysis.instrument_id,
        sources=[PromoteSourceRef(analysis_id=analysis.id, contribution_kind="chosen")],
        reason=reason, loq=plan["loq"], lod=row.lod, lod_unit=LOD_UNIT,
        # Sent explicitly, never left to promote_to_parent's copy-from-source
        # branch: that fires only when every limit is None, and this promote
        # always sends the LOQ, so a floor would be dropped on the parent.
        result_floor=plan["result_floor"] or None,
    ), background_tasks=background_tasks, audit_reason=reason)
    parent_id = resp.parent.id
    try:
        db.add(AuditLog(operation="endo_worksheet_promoted", entity_type="lims_analysis",
                        entity_id=str(parent_id), details=plan["details"]))
        db.commit()
    except Exception:
        db.rollback()
        log.exception("endo_worksheet_promote_audit_failed worksheet=%s item=%s parent_analysis=%s",
                      plan["details"]["worksheet_id"], plan["details"]["item_id"], parent_id)
    return EndoPromoteRowResult(item_id=row.item_id, promoted=True,
                                parent_analysis_id=parent_id, state=resp.parent.review_state)


def promote_rows(db: Session, current_user, worksheet, rows: list[EndoPromoteRowIn], *,
                 background_tasks=None) -> list[EndoPromoteRowResult]:
    """POST /worksheets/{id}/promote's rows, each answered on its own and in
    the order sent (spec 5.3). The route has already refused a malformed
    body. A stock worksheet refuses every row. The worksheet's stored data is
    read in a fixed number of queries; each eligible row then costs its own
    checks, writes and commit."""
    if worksheet.endo_prep != "2ml":
        return [_refusal(r.item_id, REASON_STOCK) for r in rows]
    from lims_analyses.promote_flow import PromoteError
    from lims_analyses.state_machine import InvalidTransitionError

    ws_id = worksheet.id
    items = {it.id: it for it in db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == ws_id)).scalars()}
    sample_ids = {it.sample_id for it in items.values() if it.sample_id}
    parent_pk_by_sample = dict(db.execute(
        select(LimsSubSample.sample_id, LimsSubSample.parent_sample_pk)
        .where(LimsSubSample.sample_id.in_(sample_ids))).all()) if sample_ids else {}
    # The serializer's own parent resolver (review I2): one query.
    from main import _worksheet_item_parents  # lazy: main imports this module
    parent_by_sample = _worksheet_item_parents(db, sample_ids, parent_pk_by_sample)
    method = resolve_endo_method(db, worksheet)
    default_cartridge_id = next(
        (c["id"] for c in (method["cartridges"] if method else []) if c["is_default"]), None)
    cartridge_ids = ({it.cartridge_type_id for it in items.values()}
                     | {worksheet.cartridge_type_id, default_cartridge_id}) - {None}
    ctx = SimpleNamespace(
        user_id=getattr(current_user, "id", None),
        live=vial_endo_analyses(db, sample_ids),
        peptide_names=_served_peptide_names(db, items.values()),
        parent_by_sample=parent_by_sample,
        run_params=method["run_parameters"] if method else None,
        default_cartridge_id=default_cartridge_id,
        sensitivities=cartridge_sensitivities(db, cartridge_ids),
        # Slice 5: the rows' match inputs and today's lines, once per request.
        facts=row_facts(db, worksheet, items.values()),
        rules=load_rules(db),
    )
    results = []
    for row in rows:
        try:
            item = items.get(row.item_id)
            plan = _plan(db, worksheet, item, row, ctx)
            results.append(_promote_one(db, current_user, worksheet, item, row, plan,
                                        background_tasks))
        except _Refused as refused:
            db.rollback()
            results.append(_refusal(row.item_id, str(refused)))
        except PromoteError as e:
            # The parent's unique index on Postgres: two requests raced past the checks.
            db.rollback()
            results.append(_refusal(row.item_id, REASON_PARENT_HOLDS
                                    if e.code == "parent_row_already_exists" else str(e.detail)))
        except InvalidTransitionError as e:
            # The vial moved between the check and the fill (another tab promoted it).
            db.rollback()
            results.append(_refusal(row.item_id, REASON_PROMOTED
                                    if e.from_state == "promoted" else str(e)))
        except Exception:
            db.rollback()
            log.exception("endo_worksheet_promote_failed worksheet=%s item=%s", ws_id, row.item_id)
            results.append(_refusal(row.item_id, REASON_UNEXPECTED))
    return results
