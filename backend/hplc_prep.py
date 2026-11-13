"""HPLC prep worksheet arithmetic (plan 3, Task 3): compute_row, the one working-out of a
worksheet row, ported from the lab tool's calc.js (tools-dennis, hplc-peptide-quant, commit
39a1afe8). Each function below is named after the calc.js function it ports, with its line.

Targets, leads, the diluent and the floor are NOT the tool's name tables: they come from plan
2's rules by peptide id (hplc_prep_rules). Everything else follows the tool exactly, including
what looks odd (a plain capsule row's component carries the per-capsule weight; a bac row's
component target is the rule's while its vial's is the bac target). Every number is unrounded;
a value that cannot be worked out is None, never 0. tests/fixtures/hplc_prep_cases.json, made
from the tool itself, pins this module and its TypeScript twin (src/lib/hplc-prep.ts).

Pure: standard library and hplc_prep_rules only."""
from typing import Optional

from hplc_prep_rules import component_target, match_rule, pick_lead, row_diluent, row_floor

MAX_VIALS = 7  # calc.js VIAL_LETTERS 'ABCDEFG'


def _div(a, b):
    # calc.js div (154): None when either side is missing or the divisor is 0
    return None if a is None or b is None or b == 0 else a / b


def _volume_ul(mass_mg, density):
    # calc.js massToVolumeUl (160)
    d = _div(mass_mg, density)
    return None if d is None else d * 1000


def _positive(v):
    return v if v is not None and v > 0 else None


def bac_volume_ml(mass_mg, params):
    # calc.js bacVolumeMl (282)
    rw, rba = params["diluent_density_mg_ml"], params["benzyl_alcohol_density_mg_ml"]
    if mass_mg is None or mass_mg <= 0 or rw is None or rw <= 0:
        return None
    c = params["bac_stock_ug_ml"] / 1000
    return (mass_mg / rw) / (1 - c / rba + c / rw)


def bac_declared_mg(inputs, params):
    # calc.js bacInput (295): a bac row's declared weight is worked out from its two weighings
    full, emptied = inputs.get("stock_vial_diluent_mg"), inputs.get("stock_vial_mg")
    vol = None if full is None or emptied is None else bac_volume_ml(full - emptied, params)
    return None if vol is None or vol <= 0 else vol * params["bac_stock_ug_ml"] / 1000


def declared_total_mg(form, declared, capsules):
    # calc.js declaredTotalMg (247): per capsule x capsules for a capsule row
    if form != "capsule":
        return declared
    return None if declared is None or capsules is None or capsules <= 0 else declared * capsules


def stock_prep(form, declared, inputs, params):
    # calc.js stockPrep (182): the stock's volume (mL), its concentration, and its problem
    density = params["diluent_density_mg_ml"]
    vial, vial_diluent = inputs.get("stock_vial_mg"), inputs.get("stock_vial_diluent_mg")
    liquid, bac = form == "liquid", form == "bac"
    if liquid:
        total_ml = _positive(inputs.get("declared_volume_ml"))
    elif vial is None or vial_diluent is None:
        total_ml = None
    elif bac and vial_diluent - vial > 0:
        total_ml = bac_volume_ml(vial_diluent - vial, params)
    else:
        total_ml = _div(vial_diluent - vial, density)
    problem = None
    if not bac and declared is not None and declared <= 0:
        problem = "declared"
    elif not liquid and total_ml is not None and total_ml <= 0:
        problem = "diluent"
    if bac:
        conc = None if problem else params["bac_stock_ug_ml"]
    else:
        conc = None if declared is None or problem else _div(declared * 1000, total_ml)
    return total_ml, conc, problem


def dilution_plan(target, volume, stock):
    # calc.js dilutionPlan (315): C1V1 = C2V2, each volume also in halves
    stock_vol = None if target is None or volume is None else _div(target * volume, stock)
    diluent_vol = None if stock_vol is None or volume is None else volume - stock_vol
    return {"stock_vol_ul": stock_vol, "diluent_vol_ul": diluent_vol,
            "stock_half_ul": None if stock_vol is None else stock_vol / 2,
            "diluent_half_ul": None if diluent_vol is None else diluent_vol / 2}


def dilution_actual(vial, vial_diluent, vial_all, stock, density):
    # calc.js dilutionActual (341): a weighing lower than the one before it is flagged, never
    # computed from (diluent < 0, stock <= 0)
    diluent_ul = None if vial is None or vial_diluent is None else _volume_ul(vial_diluent - vial, density)
    stock_ul = None if vial_diluent is None or vial_all is None else _volume_ul(vial_all - vial_diluent, density)
    problem = None
    if diluent_ul is not None and diluent_ul < 0:
        problem = "diluent"
    elif stock_ul is not None and stock_ul <= 0:
        problem = "stock"
    total = None if diluent_ul is None or stock_ul is None or problem else diluent_ul + stock_ul
    conc = None if stock is None or stock_ul is None or problem else _div(stock * stock_ul, total)
    return {"actual_diluent_ul": diluent_ul, "actual_stock_ul": stock_ul, "actual_total_ul": total,
            "actual_conc_ug_ml": conc, "dilution_factor": None if problem else _div(total, stock_ul),
            "problem": problem}


def volume_off(planned, actual, params):
    # calc.js volumeOff (880): past the tolerance, as a share of the plan
    if planned is None or actual is None or planned <= 0:
        return False
    return abs((actual - planned) / planned * 100) > params["volume_tolerance_pct"]


def _off(plan, actual, params):
    return {"diluent": volume_off(plan["diluent_vol_ul"], actual["actual_diluent_ul"], params),
            "stock": volume_off(plan["stock_vol_ul"], actual["actual_stock_ul"], params)}


def needs_two_step(two_step, lead_mg, params):
    # calc.js needsTwoStep (1020): the row's yes / no, else declared >= the threshold
    if two_step is True or two_step is False:
        return two_step
    return lead_mg is not None and lead_mg >= params["two_step_threshold_mg"]


def intermediate_target(stock, target, fixed):
    # calc.js intermediateTarget (1038)
    if stock is not None and (stock <= 0 or stock <= fixed):
        return None
    if target is not None and target >= fixed:
        return None
    return fixed


def intermediate_step(v, stock, target, params):
    # calc.js intermediateStep (1064): Step 3 dilutes from the actual once weighed, else the target
    typed_target, typed_volume = _positive(v.get("int_target_ug_ml")), _positive(v.get("int_volume_ul"))
    int_target = typed_target if typed_target is not None else intermediate_target(
        stock, target, params["intermediate_target_ug_ml"])
    volume = typed_volume if typed_volume is not None else params["intermediate_volume_ul"]
    plan = dilution_plan(int_target, volume, stock)
    actual = dilution_actual(v.get("int_vial_mg"), v.get("int_vial_diluent_mg"),
                             v.get("int_vial_all_mg"), stock, params["diluent_density_mg_ml"])
    weighed = actual["actual_conc_ug_ml"] is not None
    return {"target_ug_ml": int_target, "volume_ul": volume, "target_defaulted": typed_target is None,
            "plan": plan, "actual": actual, "weighed": weighed,
            "conc_for_final": actual["actual_conc_ug_ml"] if weighed else int_target,
            "off": _off(plan, actual, params)}


def sample_components(facts, inputs, declared, is_blend):
    # calc.js sampleComponents (763) and sampleVials (820): weights, vials, typed targets
    own = inputs.get("components") or {}
    out = []
    for c in facts["components"]:
        mine = own.get(str(c["peptide_id"])) or {}
        if is_blend:
            mg = _positive(mine["mg"] if mine.get("mg") is not None else c.get("declared_mg"))
            vial = mine["vial"] if mine.get("vial") is not None else (c.get("vial") or 1)
            vial = vial if isinstance(vial, int) and 1 <= vial <= MAX_VIALS else 1
        else:
            mg, vial = declared, 1
        out.append({"peptide_id": c["peptide_id"], "declared_mg": mg, "vial": vial,
                    "typed_target": _positive(mine.get("target"))})
    return out


def _split_mismatch(comps, declared):
    # calc.js sampleComponents (788): every share typed and their sum off the declared by 0.005
    weighed = [c["declared_mg"] for c in comps if c["declared_mg"] is not None]
    return (len(weighed) == len(comps) and declared is not None
            and abs(sum(weighed) - declared) > 0.005)


def _vial_target(v, lead, rule, is_blend, bac, params):
    # calc.js computeRun vial loop (1842): typed on the vial, else the lead's typed own target,
    # else the rule (a bac row with no rule: the bac target)
    typed = _positive(v.get("target_ug_ml"))
    if typed is not None:
        return {"value": typed, "source": "typed", "typed": True}
    if is_blend and lead["typed_target"] is not None:
        return {"value": lead["typed_target"], "source": "component", "typed": False}
    if bac and rule["source"] == "default":
        return {"value": params["bac_target_ug_ml"], "source": "bac", "typed": False}
    return {"value": rule["value"], "source": rule["source"], "typed": False}


def compute_row(facts: dict, inputs: Optional[dict], rules: list, params: dict) -> dict:
    """Everything the sheet shows for one row (the shape in the plan's "The shapes every task
    shares"): the stock, each autosampler vial's plan and actual, each component's finals, and
    the warnings. calc.js computeRun (1792), its per-sample block."""
    inputs = inputs or {}
    form = facts.get("form")
    density = params["diluent_density_mg_ml"]
    default_target = params["default_target_ug_ml"]
    if form is None:  # a Pen, a Nasal Spray: no HPLC prep maths
        return {"form": None, "declared_total_mg": None,
                "diluent": {"diluent": None, "rule_id": None, "typed": False},
                "stock": {"total_diluent_ml": None, "problem": None}, "capsule_diluent_ul": None,
                "floor_ug_ml": None, "components": [], "vials": [], "warnings": []}
    declared = inputs["declared_mg"] if inputs.get("declared_mg") is not None else facts.get("declared_mg")
    two_step = inputs.get("two_step")
    if form == "bac":  # calc.js bacInput (295)
        declared = bac_declared_mg(inputs, params)
        two_step = two_step is True
    total_mg = declared_total_mg(form, declared, inputs.get("capsules"))
    total_ml, row_stock, stock_problem = stock_prep(form, total_mg, inputs, params)
    bac, neat = form == "bac", form == "capsule"

    def stock_of(mg):  # computeRun stockOf (1813)
        if bac:
            return None if stock_problem else row_stock
        return None if mg is None or stock_problem else _div(mg * 1000, total_ml)

    is_blend = len(facts["components"]) > 1
    comps = sample_components(facts, inputs, declared, is_blend)
    row_rule = match_rule(rules, peptide_id=facts.get("peptide_id"), weight_mg=total_mg)
    lead_view = [{"peptide_id": c["peptide_id"], "declared_mg": c["declared_mg"]} for c in comps]
    typed_diluent = (inputs.get("diluent") or "").strip()
    if typed_diluent:
        diluent = {"diluent": typed_diluent, "rule_id": None, "typed": True}
    else:
        diluent = {**row_diluent(rules, row_rule=row_rule, components=lead_view), "typed": False}
    floor = row_floor(row_rule, default=params["floor_ug_ml"])
    targets = {c["peptide_id"]: component_target(rules, peptide_id=c["peptide_id"], weight_mg=c["declared_mg"],
                                                 in_blend=is_blend, default=default_target) for c in comps}
    vial_inputs = inputs.get("vials") or {}

    vials = []
    for n in sorted({c["vial"] for c in comps}):
        in_vial = [c for c in comps if c["vial"] == n]
        v = vial_inputs.get(str(n)) or {}
        lead = pick_lead(rules, [{"peptide_id": c["peptide_id"], "declared_mg": c["declared_mg"]} for c in in_vial],
                         row_rule=row_rule, chosen_id=v.get("lead_id"))
        lead_c = next(c for c in in_vial if c["peptide_id"] == lead["peptide_id"])
        lead_mg = lead_c["declared_mg"] if is_blend and lead_c["declared_mg"] is not None else total_mg
        stock = stock_of(lead_mg)
        steps2 = not neat and needs_two_step(two_step, lead_mg, params)
        target = _vial_target(v, lead_c, targets[lead_c["peptide_id"]], is_blend, bac, params)
        volume = v["target_volume_ul"] if v.get("target_volume_ul") is not None else params["target_volume_ul"]
        inter = intermediate_step(v, stock, target["value"], params) if steps2 else None
        for_final = inter["conc_for_final"] if steps2 else stock
        plan = dilution_plan(for_final if neat else target["value"], volume, for_final)
        vial_diluent = v.get("vial_diluent_mg")
        if neat and vial_diluent is None and v.get("vial_mg") is not None:
            vial_diluent = v["vial_mg"]  # a capsule is neat: a blank "+ diluent" is the empty vial
        actual = dilution_actual(v.get("vial_mg"), vial_diluent, v.get("vial_all_mg"), for_final, density)
        if steps2:
            a, b = inter["actual"]["dilution_factor"], actual["dilution_factor"]
            factor = a * b if a is not None and b is not None else None
        else:
            factor = actual["dilution_factor"]
        vials.append({"vial": n, "component_ids": [c["peptide_id"] for c in in_vial], "lead": lead,
                      "target": target, "target_volume_ul": volume, "stock_conc_ug_ml": stock,
                      "two_step": steps2, "neat": neat, "intermediate": inter, "stock_for_final": for_final,
                      "plan": plan, "actual": actual, "dilution_factor_total": factor,
                      "off": _off(plan, actual, params)})

    # computeRun component loop (1873): each at its vial lead's x (its stock / the lead's stock)
    by_vial = {v["vial"]: v for v in vials}
    components = []
    for c in comps:
        v = by_vial[c["vial"]]
        stock = stock_of(c["declared_mg"]) if is_blend else vials[0]["stock_conc_ug_ml"]
        lead_stock = v["stock_conc_ug_ml"]
        ratio = None if stock is None or lead_stock is None or lead_stock == 0 else stock / lead_stock
        planned = None if ratio is None else v["target"]["value"] * ratio
        conc = v["actual"]["actual_conc_ug_ml"]
        is_lead = v["lead"]["peptide_id"] == c["peptide_id"]
        rule = targets[c["peptide_id"]]
        target = ({"value": c["typed_target"], "source": "typed", "rule_id": None, "typed": True}
                  if c["typed_target"] is not None else {**rule, "typed": False})
        components.append({"peptide_id": c["peptide_id"], "declared_mg": c["declared_mg"], "vial": c["vial"],
                           "lead": is_lead, "target": target, "stock_conc_ug_ml": stock,
                           "planned_final_ug_ml": planned,
                           "actual_final_ug_ml": None if ratio is None or conc is None else conc * ratio,
                           "below_floor": not is_lead and planned is not None and planned < floor})

    capsule_diluent = None
    if neat:  # computeRun capsuleDiluentUl (1907): the water that takes the stock to the target
        t = vials[0]["target"]["value"]
        capsule_diluent = total_mg * 1e6 / t if total_mg is not None and t is not None and t > 0 else None

    return {"form": form, "declared_total_mg": total_mg, "diluent": diluent,
            "stock": {"total_diluent_ml": total_ml, "problem": stock_problem},
            "capsule_diluent_ul": capsule_diluent, "floor_ug_ml": floor,
            "components": components, "vials": vials,
            "warnings": _warnings(form, stock_problem, vials, components, inputs, comps, declared,
                                  is_blend, vials[0]["stock_conc_ug_ml"], floor, params)}


def _warnings(form, stock_problem, vials, components, inputs, comps, declared, is_blend,
              row_stock, floor, params):
    # calc.js weighingWarnings (2004), volumeWarnings (917), capsuleWarnings (4048) and the
    # summary's capsuleNoCount, belowFloor and the split. Order: the stock; per vial Step 3a then
    # Step 3; volume_off per vial (Step 3 stock, diluent, Step 3a stock, diluent); below_floor;
    # capsule_no_count; capsule_over_neat; split_mismatch.
    out = []

    def warn(code, text, vial=None, peptide_id=None):
        out.append({"code": code, "vial": vial, "peptide_id": peptide_id, "text": text})

    if stock_problem == "declared":
        warn("declared", "The declared peptide weight must be more than 0 mg. No stock is worked out.")
    if stock_problem == "diluent":
        warn("stock_backwards", "Step 2 weighings go backwards: the vial and septum + diluent is not "
             "more than the empty vial. Check the two weights; no stock is worked out until they do.")
    weighing = {"diluent": "the vial + diluent weight is less than the empty vial",
                "stock": "the last weight (vial, diluent + stock) is not more than the vial + diluent "
                         "weight, so no stock went in"}
    for v in vials:
        steps = ([("3a", "step3a", v["intermediate"]["actual"])] if v["two_step"] else []) + \
            [("3", "step3", v["actual"])]
        for label, code, actual in steps:
            if actual["problem"]:
                warn(f"{code}_{actual['problem']}", f"Vial {v['vial']}, Step {label}: "
                     f"{weighing[actual['problem']]}. Check the weights; no concentration is worked out.",
                     v["vial"])
    tol = params["volume_tolerance_pct"]
    for v in vials:
        checks = [("final vial", "stock", v["plan"], v["actual"]), ("final vial", "diluent", v["plan"], v["actual"])]
        if v["two_step"]:
            i = v["intermediate"]
            checks += [("intermediate", "stock", i["plan"], i["actual"]), ("intermediate", "diluent", i["plan"], i["actual"])]
        for where, what, plan, actual in checks:
            planned, got = plan[f"{what}_vol_ul"], actual[f"actual_{what}_ul"]
            if volume_off(planned, got, params):
                warn("volume_off", f"Vial {v['vial']}: the {what} added to the {where} is {got:.2f} uL "
                     f"against {planned:.2f} uL planned, more than {tol:g}% off. Remake the vial, or call it out.",
                     v["vial"])
    for c in components:
        if c["below_floor"]:
            warn("below_floor", f"This peptide lands at {c['planned_final_ug_ml']:.2f} ug/mL in vial {c['vial']}, "
                 f"under the {floor:g} ug/mL floor. Consider giving it its own vial.", c["vial"], c["peptide_id"])
    if form == "capsule" and not (inputs.get("capsules") is not None and inputs["capsules"] > 0):
        warn("capsule_no_count", "Type how many capsules went into the stock. Nothing is planned until then.")
    if form == "capsule" and row_stock is not None and row_stock > params["capsule_neat_max_ug_ml"]:
        warn("capsule_over_neat", f"The capsule stock is {row_stock:.2f} ug/mL. It is injected neat, so it must be "
             f"{params['capsule_neat_max_ug_ml']:g} ug/mL or lower: add water.")
    if is_blend and _split_mismatch(comps, declared):
        warn("split_mismatch", "The components' weights do not add up to the declared weight. Check the split.")
    return out
