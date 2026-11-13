"""HPLC calibration curve worksheet arithmetic (plan 4, Task 2): work_out_sheet, the one working-out
of a calibration sheet, ported from the lab tool's calc.js (tools-dennis, hplc-peptide-quant, commit
39a1afe8). Each function below names the calc.js function it ports, with its line.

The sheet's stored inputs are in Mk1's shape (hplc_calibration_sheets.inputs: snake_case,
vial_standard_mg for the source's vialPeptideMg, level_volume_ul for targetTotalUl). The net block
is always on the net basis (the page forces it, cal.js:87). Two things are Mk1's own: a manual
override of the net factor (net.override_factor, applied to the stock in place of the computed
factor) and the net_partial / override_reason_missing warnings. Everything else follows the tool
exactly. Every number is unrounded; a value that cannot be worked out is None, never NaN, never 0.
Sums run left to right in explicit loops, as JavaScript adds (never sum(): compensated from 3.12).
tests/fixtures/hplc_calibration_cases.json, made from the tool itself, pins this module and its
TypeScript twin (src/lib/hplc-calibration.ts).

Pure: standard library and catalog.method_run_params only."""
import copy
import math
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from catalog.method_run_params import HPLC_RUN_PARAM_DEFAULTS

# calc.js DEFAULTS.counterions (120): g/mol per equivalent; sodium is net of the proton it replaces
COUNTERIONS: dict[str, float] = {"Acetate": 60.05, "TFA": 114.02, "HCl": 36.46, "Iodide": 126.90, "Sodium": 21.98}
# calc.js MS_IONS (2714), the ion forms only
MS_IONS: tuple[str, ...] = ("", "M", "M+H", "M+2H", "M+3H", "M+4H", "M-H", "M-2H", "M-3H", "M-4H")
PROTON_DA = 1.00728  # calc.js 2715
CAL_LEVEL_TARGETS = (1000, 500, 250, 100, 10, 1)  # calc.js 2710
CAL_STOCK_DILUENT_UL = 1000  # calc.js DEFAULTS.calStockDiluentUl (116)
CAL_MIN_STOCK_MG = 20  # calc.js DEFAULTS.calMinStockMg (121)
CAL_TOP_ALIQUOT_UL = 150  # calc.js DEFAULTS.calTopAliquotUl (124)
CAL_STOCK_AS_TOP_PCT = 5  # calc.js DEFAULTS.calStockAsTopPct (125)
_DENSITY = HPLC_RUN_PARAM_DEFAULTS["diluent_density_mg_ml"]
_TARGET_VOLUME_UL = HPLC_RUN_PARAM_DEFAULTS["target_volume_ul"]
_VOLUME_TOLERANCE_PCT = HPLC_RUN_PARAM_DEFAULTS["volume_tolerance_pct"]

_NET_KEYS = ("counterion", "counterion_mw", "equivalents", "free_mw", "stated_fw", "ms_mz", "ms_ion",
             "assay_pct", "water_pct", "assumption", "override_factor", "override_reason")
_LEVEL_KEYS = ("target", "vial_mg", "vial_diluent_mg", "vial_diluent_std_mg", "peak_area", "purity", "rt")
_REP_LEVEL_OWN = ("peak_area", "purity", "rt")  # calc.js CAL_REP_LEVEL_OWN (2860)
_BLOCKING = ("net_assumption_missing", "override_reason_missing")


def _num(v):
    # calc.js num (147): a finite number, else None (a bool is not a number here)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return v


def _div(a, b):
    # calc.js div (154): None when either side is missing or the divisor is 0
    return None if a is None or b is None or b == 0 else a / b


def _volume_ul(mass_mg, density):
    # calc.js massToVolumeUl (160)
    d = _div(mass_mg, density)
    return None if d is None else d * 1000


def _js_round(x):
    # JavaScript Math.round: the nearest integer, a half going up (never Python's half-even round)
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def _to_fixed6(v):
    # JavaScript toFixed(6): the exact binary value rounded, a tie away from zero; -0 reads "0.000000"
    if v == 0:
        v = 0
    return str(Decimal(v).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def _fmt(v, dp=2):
    # calc.js fmt (5562), for warning text only
    if v is None:
        return ""
    t = f"{v:.{dp}f}"
    return t[1:] if re.fullmatch(r"-0(\.0*)?", t) else t


def _text(v):
    return str(v or "").strip()


def _volume_off(planned, actual):
    # calc.js volumeOff (880): (pct, over), signed, as a share of the plan
    if planned is None or actual is None or planned <= 0:
        return None, False
    pct = (actual - planned) / planned * 100
    return pct, abs(pct) > _VOLUME_TOLERANCE_PCT


def _average(values):
    # calc.js average (1115)
    v = [x for x in values if x is not None]
    if not v:
        return None
    s = 0
    for x in v:
        s += x
    return s / len(v)


def _stdev(values):
    # calc.js stdev (1108): the sample standard deviation
    v = [x for x in values if x is not None]
    if len(v) < 2:
        return None
    m = _average(v)
    s = 0
    for x in v:
        s += (x - m) * (x - m)
    return math.sqrt(s / (len(v) - 1))


def blank_inputs() -> dict:
    # calc.js blankCalSheet (2816), in Mk1's shape: six levels at CAL_LEVEL_TARGETS, every value null
    return {
        "standard_id": None, "cas": None, "supplier": None, "lot": None, "coa_weight_mg": None,
        "diluent_density_mg_ml": None, "level_volume_ul": None, "analyst": None, "date": None, "notes": None,
        "net": {k: None for k in _NET_KEYS},
        "stock": {"vial_mg": None, "vial_standard_mg": None, "vial_diluent_mg": None},
        "stock_as_top": None, "top_aliquot_ul": None,
        "levels": [{k: (t if k == "target" else None) for k in _LEVEL_KEYS} for t in CAL_LEVEL_TARGETS],
    }


def blank_replicate_inputs(n_levels: int) -> dict:
    # calc.js duplicateCalSheet (2894): a replicate's own fields, run results blank
    return {"notes": None, "levels": [{k: None for k in _REP_LEVEL_OWN} for _ in range(n_levels)]}


def ms_neutral_mass(mz, ion) -> Optional[float]:
    # calc.js msNeutralMass (2717): z x m/z minus (or plus) z protons
    v = _num(mz)
    if v is None or not ion:
        return None
    if ion == "M":
        return v
    m = re.fullmatch(r"M([+-])([0-9]*)H", str(ion))
    if not m:
        return None
    z = int(m.group(2)) if m.group(2) else 1
    return z * v - (1 if m.group(1) == "+" else -1) * z * PROTON_DA


def linear_fit(points: list[tuple[Optional[float], Optional[float]]]) -> dict:
    # calc.js linearFit (1087): centred least squares, a pair with a blank is ignored
    pts = [(_num(x), _num(y)) for x, y in points]
    pts = [(x, y) for x, y in pts if x is not None and y is not None]
    n = len(pts)
    if n < 2:
        return {"slope": None, "intercept": None, "r2": None, "n": n}
    sx = sy = 0
    for x, y in pts:
        sx += x
    for x, y in pts:
        sy += y
    mx, my = sx / n, sy / n
    sxy = sxx = syy = 0
    for x, y in pts:
        sxy += (x - mx) * (y - my)
        sxx += (x - mx) * (x - mx)
        syy += (y - my) * (y - my)
    if sxx == 0:
        return {"slope": None, "intercept": None, "r2": None, "n": n}
    slope = sxy / sxx
    return {"slope": slope, "intercept": my - slope * mx,
            "r2": None if syy == 0 else (sxy * sxy) / (sxx * syy), "n": n}


def _net_worked(net: Optional[dict]):
    # calc.js netPeptide (2741), basis always net: (result, [(code, text)]) in the source's order
    n0 = net or {}
    name = _text(n0.get("counterion"))
    has_ci = bool(name) and not re.fullmatch(r"none", name, re.IGNORECASE)
    known = next((k for k in COUNTERIONS if k.lower() == name.lower()), None)
    ci_mw = 0 if not has_ci else COUNTERIONS[known] if known else _num(n0.get("counterion_mw"))
    n, stated = _num(n0.get("equivalents")), _num(n0.get("stated_fw"))
    free_typed = _num(n0.get("free_mw"))
    assumed_fw = free_typed is None and stated is not None
    free = free_typed if free_typed is not None else stated
    assay, water = _num(n0.get("assay_pct")), _num(n0.get("water_pct"))
    warnings = []
    fw_basis = None

    def tol(x):
        return max(1, x * 0.002)

    if not assumed_fw and free is not None and stated is not None:
        if abs(stated - free) <= tol(free):
            fw_basis = "free"
        elif has_ci and ci_mw:
            kr = _js_round((stated - free) / ci_mw)
            if kr >= 1 and abs(stated - (free + kr * ci_mw)) <= tol(stated):
                fw_basis = "salt"
                if n is not None and abs(n - kr) > 0.05:
                    warnings.append(("net_equivalents_disagree",
                                     f"net peptide: the stated FW says {kr} {name} equivalent{'' if kr == 1 else 's'}, "
                                     f"the Equivalents box says {_fmt(n, 2)}: the stated FW is used; check which is right."))
            else:
                fw_basis = "mismatch"
                warnings.append(("net_fw_mismatch",
                                 "net peptide: the stated FW matches neither the free peptide nor a whole number of "
                                 "counterions: check the molecular formula and FW on the CoA (Step 1 of the net peptide check)."))
        else:
            fw_basis = "mismatch"
            warnings.append(("net_fw_mismatch_no_counterion",
                             "net peptide: the stated FW differs from the free-peptide MW and no counterion is chosen: check the CoA."))
    ms_m = ms_neutral_mass(n0.get("ms_mz"), n0.get("ms_ion"))
    if ms_m is not None and free is not None and not abs(ms_m - free) <= max(1.5, free * 0.001):
        warnings.append(("net_ms_mismatch",
                         "net peptide: the mass spec on the CoA does not match the free-peptide MW: check the formula "
                         "sum and the ion form (MS reports the free peptide, never the salt)."))
    # A divisor of 0 (nonsense MWs) gives None where calc.js 2793-2794 divide without div() and get
    # NaN or -Infinity. work_out_sheet then has no stock and no fit, as the source does. With -Infinity
    # the source also counts the counterion as applied (so parts_used, net_assumption_missing, and
    # level_cannot_be_made at level 0 from a -Infinity stock); those are Infinity arithmetic, not copied:
    # with no fit nothing can be filed.
    if not has_ci:
        f_ci = 1
    elif fw_basis == "salt":
        f_ci = _div(free, stated)
    elif free is not None and n is not None and ci_mw:
        f_ci = _div(free, free + n * ci_mw)
    else:
        f_ci = 1
    applied = has_ci and f_ci is not None and abs(f_ci - 1) > 1e-12
    if water is None:
        warnings.append(("net_kf_missing",
                         "net peptide: Karl Fischer water not entered: the rule is KF on every reference standard "
                         "lot; 0 % is used until it is typed."))
    if has_ci and not applied:
        missing = ", ".join(x for x in (
            "free-peptide MW (or the stated FW)" if free is None else "",
            "equivalents" if n is None and fw_basis != "salt" else "",
            "counterion mass" if not ci_mw else "") if x)
        warnings.append(("net_counterion_partial",
                         f"net peptide: no {name} correction yet (missing {missing or 'its mass'}): the assay and "
                         "water still apply; the stock is a little high until the counterion is in."))
    if applied and not _text(n0.get("assumption")):
        warnings.append(("net_assumption_missing",
                         "net peptide: write the counterion assumption and its basis in words (e.g. \"1H NMR, 2.1 eq\" "
                         "or \"lean 2, undeclared on the CoA\") before the curve is filed."))
    factor = None if f_ci is None else \
        (1 if assay is None else assay / 100) * f_ci * (1 - (0 if water is None else water / 100))
    parts = [p for p, on in (("assay", assay is not None), ("counterion", applied), ("water", water is not None)) if on]
    result = {"counterion": name if has_ci else "", "counterion_mw": ci_mw if has_ci else 0, "equivalents": n,
              "free_mw": free, "stated_fw": stated, "assay_pct": assay, "water_pct": water, "fw_basis": fw_basis,
              "f_counterion": f_ci, "factor": factor, "counterion_applied": applied, "assumed_fw": assumed_fw,
              "ms_m": ms_m, "parts_used": parts}
    return result, warnings


def net_peptide(net: Optional[dict]) -> dict:
    # calc.js netPeptide (2741), basis always net; parts_used is Mk1's (decision 16)
    return _net_worked(net)[0]


def replicate_prep(original: dict, replicate: dict) -> dict:
    # calc.js replicatePrep (2862) over CAL_REP_LEVEL_OWN: the original's preparation, the replicate's run results
    out = copy.deepcopy(original or {})
    rep = replicate or {}
    out.pop("notes", None)
    if "notes" in rep:
        out["notes"] = copy.deepcopy(rep["notes"])
    rep_levels = rep.get("levels") or []
    levels = []
    for i, level in enumerate(out.get("levels") or []):
        own = rep_levels[i] if i < len(rep_levels) and rep_levels[i] else {}
        x = dict(level)
        for f in _REP_LEVEL_OWN:
            x[f] = own.get(f)
        levels.append(x)
    out["levels"] = levels
    return out


def _duplicate_weighings(raw_levels):
    # calc.js calDuplicateWeighings (2958): [(kind, level)], same-row per level, then next-row
    out = []  # [kind, level, value]
    fields = ("vial_mg", "vial_diluent_mg", "vial_diluent_std_mg")
    for i, level in enumerate(raw_levels):
        seen = set()
        for f in fields:
            v = _num(level.get(f))
            if v is None:
                continue
            k = _to_fixed6(v)
            if k in seen:
                if not any(o[0] == "same-row" and o[1] == i and o[2] == v for o in out):
                    out.append(["same-row", i, v])
            else:
                seen.add(k)
    for i in range(len(raw_levels) - 1):
        for f in fields:
            a, b = _num(raw_levels[i].get(f)), _num(raw_levels[i + 1].get(f))
            if a is not None and b is not None and a != 0 and _to_fixed6(a) == _to_fixed6(b):
                out.append(["next-row", i, a])
    return out


def _level_word(target):
    return f"the {_fmt(target, 0)} ug/mL level"


def work_out_sheet(inputs: dict) -> dict:
    # calc.js calibration (1132) and calWarnings (2996); the stock takes factor_applied (Mk1's override)
    inputs = inputs or {}
    net_in = inputs.get("net") or {}
    stock = inputs.get("stock") or {}
    density = _num(inputs.get("diluent_density_mg_ml"))
    density = _DENSITY if density is None else density
    vial, vial_std, vial_diluent = (_num(stock.get(k)) for k in ("vial_mg", "vial_standard_mg", "vial_diluent_mg"))

    stock_weight = None if vial is None or vial_std is None else vial_std - vial
    net, net_warnings = _net_worked(net_in)
    override = _num(net_in.get("override_factor"))
    factor_applied = override if override is not None else net["factor"]
    # a factor that cannot be worked out leaves no net stock (calc.js 1144 on the net basis: NaN)
    stock_net_weight = None if stock_weight is None or factor_applied is None else stock_weight * factor_applied
    stock_diluent_to_add = None if stock_weight is None else CAL_STOCK_DILUENT_UL
    stock_actual_diluent = None if vial_std is None or vial_diluent is None else \
        _volume_ul(vial_diluent - vial_std, density)
    per_ml = None if stock_actual_diluent is None else stock_actual_diluent / 1000
    stock_conc_as_weighed = None if stock_weight is None else _div(stock_weight * 1000, per_ml)
    stock_conc = None if stock_net_weight is None else _div(stock_net_weight * 1000, per_ml)

    raw = inputs.get("levels") or []
    stock_as_top = bool(inputs.get("stock_as_top"))
    top_aliquot = _num(inputs.get("top_aliquot_ul"))
    top_aliquot = CAL_TOP_ALIQUOT_UL if top_aliquot is None else top_aliquot
    target_total = _num(inputs.get("level_volume_ul"))
    target_total = _TARGET_VOLUME_UL if target_total is None else target_total
    levels = []
    prev = stock_conc
    for i, L in enumerate(raw):
        target = _num(L.get("target"))
        own = {"peak_area": _num(L.get("peak_area")), "purity": _num(L.get("purity")), "rt": _num(L.get("rt"))}
        if i == 0 and stock_as_top:
            levels.append({"target": target, "problem": None, "from_stock": True, "made_from_ug_ml": stock_conc,
                           "planned_std_ul": None, "planned_diluent_ul": None, "actual_diluent_ul": None,
                           "std_to_add_ul": None, "actual_std_ul": None, "total_ul": None,
                           "actual_conc_ug_ml": stock_conc, **own, "remaining_ul": None,
                           "back_calc_ug_ml": None, "back_calc_dev_pct": None})
            prev = stock_conc
            continue
        lv_vial, lv_dil, lv_all = (_num(L.get(k)) for k in ("vial_mg", "vial_diluent_mg", "vial_diluent_std_mg"))
        planned_std = None if target is None or prev is None or prev <= 0 or target >= prev else \
            target * target_total / prev
        planned_dil = None if planned_std is None else target_total - planned_std
        actual_dil = None if lv_vial is None or lv_dil is None else _volume_ul(lv_dil - lv_vial, density)
        std_to_add = None if actual_dil is None or actual_dil < 0 or target is None or prev is None or prev <= target \
            else _div(actual_dil * target, prev - target)
        actual_std = None if lv_dil is None or lv_all is None else _volume_ul(lv_all - lv_dil, density)
        problem = "diluent" if actual_dil is not None and actual_dil < 0 else \
            "standard" if actual_std is not None and actual_std <= 0 else None
        total = None if actual_dil is None or actual_std is None or problem else actual_dil + actual_std
        actual_conc = None if actual_std is None or prev is None or problem else _div(actual_std * prev, total)
        levels.append({"target": target, "problem": problem, "from_stock": False, "made_from_ug_ml": prev,
                       "planned_std_ul": planned_std, "planned_diluent_ul": planned_dil, "actual_diluent_ul": actual_dil,
                       "std_to_add_ul": std_to_add, "actual_std_ul": actual_std, "total_ul": total,
                       "actual_conc_ug_ml": actual_conc, **own, "remaining_ul": None,
                       "back_calc_ug_ml": None, "back_calc_dev_pct": None})
        prev = actual_conc

    # remaining: what is left of a level after the next one is drawn from it (calc.js 1224)
    if stock_as_top:
        drawn = top_aliquot + (levels[1]["actual_std_ul"] if len(levels) > 1 and levels[1]["actual_std_ul"] is not None else 0)
    else:
        drawn = levels[0]["actual_std_ul"] if levels and levels[0]["actual_std_ul"] is not None else 0
    stock_remaining = None if stock_actual_diluent is None else stock_actual_diluent - drawn
    for i, level in enumerate(levels):
        if level["from_stock"]:
            level["remaining_ul"] = stock_remaining
            continue
        nxt = levels[i + 1] if i + 1 < len(levels) else None
        level["remaining_ul"] = None if level["total_ul"] is None else \
            level["total_ul"] - (nxt["actual_std_ul"] if nxt and nxt["actual_std_ul"] is not None else 0)
    top = _num(raw[0].get("target")) if raw else None
    stock_near_top = (abs(stock_conc - top) / top * 100 <= CAL_STOCK_AS_TOP_PCT) \
        if not stock_as_top and stock_conc is not None and top else False

    fit = linear_fit([(L["actual_conc_ug_ml"], L["peak_area"]) for L in levels])
    for L in levels:
        if fit["slope"] and L["peak_area"] is not None:
            L["back_calc_ug_ml"] = (L["peak_area"] - fit["intercept"]) / fit["slope"]
            L["back_calc_dev_pct"] = (L["back_calc_ug_ml"] - L["actual_conc_ug_ml"]) / L["actual_conc_ug_ml"] * 100 \
                if L["actual_conc_ug_ml"] else None
    rts = [L["rt"] for L in levels]
    rt_avg, rt_sd = _average(rts), _stdev(rts)
    rt_rsd = (None if rt_sd is None else rt_sd / rt_avg * 100) if rt_avg else None
    fitted = [L["actual_conc_ug_ml"] for L in levels if L["actual_conc_ug_ml"] is not None and L["peak_area"] is not None]
    rng = {"low": min(fitted), "high": max(fitted)} if fitted else None

    # calWarnings (2996), then Mk1's two
    warnings = []

    def warn(code, level, text):
        warnings.append({"code": code, "level": level, "text": text})

    for kind, i, value in _duplicate_weighings(raw):
        if kind == "same-row":
            warn("same_weight_row", i, f"{_level_word(_num(raw[i].get('target')))}: the same weight {_fmt(value, 2)} mg "
                 "in two of its weighings: \"add result\" pressed twice? Weigh again.")
        else:
            warn("same_weight_next", i, f"{_level_word(_num(raw[i].get('target')))} and "
                 f"{_level_word(_num(raw[i + 1].get('target')))}: the same weight {_fmt(value, 2)} mg one above the "
                 "other: \"add result\" pressed twice? Check which is right.")
    for i, L in enumerate(levels):
        if L["problem"] == "diluent":
            warn("level_backwards_diluent", i, f"{_level_word(L['target'])}: Step 3 weighings go backwards: \"Vial, cap "
                 "and Diluent\" is less than the empty vial. Check the weights; nothing is worked out for this level "
                 "or the ones below until they do.")
        elif L["problem"] == "standard":
            warn("level_backwards_standard", i, f"{_level_word(L['target'])}: Step 3 weighings go backwards: the last "
                 "weight (vial, diluent + standard) is not more than the vial + diluent weight, so no standard went "
                 "in. Check the weights; nothing is worked out for this level or the ones below until they do.")
    # calc.js calVolumeDeviations (2983)
    for i, L in enumerate(levels):
        if L["problem"]:
            continue
        for what, planned, actual in (("diluent", L["planned_diluent_ul"], L["actual_diluent_ul"]),
                                      ("standard", L["std_to_add_ul"], L["actual_std_ul"])):
            pct, over = _volume_off(planned, actual)
            if over:
                warn(f"volume_off_{what}", i, f"{_level_word(L['target'])}: {what} added is {_fmt(actual, 2)} uL "
                     f"against {_fmt(planned, 2)} planned ({'+' if pct > 0 else ''}{_fmt(pct, 1)}%, more than "
                     f"{_VOLUME_TOLERANCE_PCT}% off): remake the level, or call it out.")
    if stock_weight is not None and stock_weight <= 0:
        warn("stock_not_heavier", None, "the stock: the vial with the standard weighs no more than the empty vial: "
             "check the two stock weighings.")
    if stock_weight is not None and 0 < stock_weight < CAL_MIN_STOCK_MG:
        warn("stock_under_min", None, f"the stock: {_fmt(stock_weight, 2)} mg of standard is under the "
             f"{CAL_MIN_STOCK_MG} mg minimum: weigh 25 to 50 mg and dilute (USP <41>; a weighing this small puts "
             "1 to 2 % into every level).")
    for code, text in net_warnings:
        warn(code, None, text)
    cannot = next((i for i, L in enumerate(levels) if not L["from_stock"] and L["target"] is not None
                   and L["made_from_ug_ml"] is not None and L["made_from_ug_ml"] <= L["target"]), None)
    if cannot is not None:
        L = levels[cannot]
        text = (f"the stock: {_fmt(L['made_from_ug_ml'], 2)} ug/mL is not stronger than {_level_word(L['target'])}, "
                "so that level cannot be made from it: the stock needs more standard or less diluent."
                if cannot == 0 else
                f"{_level_word(L['target'])} cannot be made from the level above it "
                f"({_fmt(L['made_from_ug_ml'], 2)} ug/mL): check that level's weighings.")
        warnings.insert(0, {"code": "level_cannot_be_made", "level": cannot, "text": text})
    if net["assay_pct"] is None or net["water_pct"] is None or (net["counterion"] and not net["counterion_applied"]):
        warn("net_partial", None, "net peptide: the factor is partial: "
             + ", ".join(x for x in ("assay not typed" if net["assay_pct"] is None else "",
                                     "water not typed" if net["water_pct"] is None else "",
                                     f"{net['counterion']} not applied" if net["counterion"] and not net["counterion_applied"] else "") if x)
             + "; only the parts typed are in it.")
    if override is not None and not _text(net_in.get("override_reason")):
        warn("override_reason_missing", None, "net peptide: the factor is entered by hand: write why before the "
             "curve is filed.")

    return {
        "density": density, "level_volume_ul": target_total, "stock_weight_mg": stock_weight,
        "stock_diluent_to_add_ul": stock_diluent_to_add, "stock_actual_diluent_ul": stock_actual_diluent,
        "stock_conc_as_weighed_ug_ml": stock_conc_as_weighed, "net": net, "factor_applied": factor_applied,
        "factor_source": "override" if override is not None else "computed",
        "stock_net_weight_mg": stock_net_weight, "stock_conc_ug_ml": stock_conc, "stock_as_top": stock_as_top,
        "top_aliquot_ul": top_aliquot, "stock_near_top": stock_near_top, "stock_remaining_ul": stock_remaining,
        "levels": levels, "fit": fit, "rt_avg": rt_avg, "rt_rsd_pct": rt_rsd, "range": rng,
        "warnings": warnings, "blocking": [w["code"] for w in warnings if w["code"] in _BLOCKING],
    }


def default_curve_name(abbreviation: str, instrument_name: str, date: Optional[str]) -> str:
    # calc.js defaultCurveId (3183): instrument-date-peptide, every character outside [A-Za-z0-9-] removed
    name = "-".join([instrument_name or "1290", date or "undated", abbreviation or "std"])
    return re.sub(r"[^A-Za-z0-9-]+", "", name)


def standard_data_for(worked: dict) -> dict:
    # Mk1's calibration_curves.standard_data from a worked sheet: the fitted points (calc.js 1258), in level order
    points = [L for L in worked["levels"] if L["actual_conc_ug_ml"] is not None and L["peak_area"] is not None]
    data = {"concentrations": [L["actual_conc_ug_ml"] for L in points], "areas": [L["peak_area"] for L in points]}
    if points and all(L["rt"] is not None for L in points):
        data["rts"] = [L["rt"] for L in points]
    return data
