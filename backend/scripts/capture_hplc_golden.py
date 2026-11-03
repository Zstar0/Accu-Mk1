"""Capture the golden master that pins the HPLC results engine (plan
docs/superpowers/plans/2026-10-31-hplc-results-engine.md, Task 1).

Reads hplc_analyses rows, re-runs TODAY's process_hplc_analysis on the inputs
each row stored in its calculation_trace, and writes the result as `expected`.
It deliberately does NOT replay the stored quantity_mg as the expected value:
that number came from whatever engine and calibration curve existed when the
row was written, so some rows would not reproduce, and the pin would then be
tempted into a tolerance. The stored value is used only to compute `drifted`
(the cases where it differs from what today's engine gives); it is not written
to the fixture.

The fixture is committed, so it carries numbers only, nothing attributable:
case ids are opaque (case-001, case-002, ...), assigned in row-id order, and
the sample label is never written. The opaque id -> "sample_id_label#row id"
map goes to STDERR (`case_ids` in the counts), which is the operator's record
and never goes in git.

Rows captured: the LIMIT most recent with a calculation_trace, plus EVERY row
whose weighings run backwards by the Task 2 rules (so the set of rows whose
reported quantity will change is complete, not sampled; `flagged` lists those),
plus EVERY row with more than one injection (individual_areas longer than 1).
The third criterion exists because the recent rows are almost all single
injection, so without it the engine's averaging path (and the purity average
over several injections) would be pinned by no real row at all.

It is NOT a test and the app never imports it. It takes no arguments and no
credentials: it uses the container's own engine (database.SessionLocal).

The prep form travels with the case. A liquid or bac row computes its stock volume
differently, so rebuilding it as a powder would pin a WRONG expected value and still
look like a clean capture. The query therefore selects prep_form, declared_volume_ml and
the intermediate vial's three weighings, and a case carries those keys ONLY when they
differ from the default (a powder row with no intermediate), so a capture of an
all-powder table is byte-identical to the one before. A NULL prep_form is a row saved
before the column existed, which is a one-step powder row: it is defaulted, and counted
(`prep_form_defaulted_to_powder`, `cases_by_prep_form`) so a recapture shows at a glance
whether any non-powder rows are in it.

Read-only, and careful about size: hplc_analyses carries two huge JSON columns
(the parsed injections and the chromatogram, ~7 GB of TOAST on a one-vCPU
instance). The query below names its columns one by one and never selects the
HPLCAnalysis entity or either of those two columns. Do not widen it. The
multi-injection predicate reads calculation_trace on every row, which is a
small JSON document per row, not those two columns.

Fixture JSON goes to stdout, counts to stderr. Prod (stdin form, per the
data-fix runbook), after lab hours:
    ssh root@100.120.92.93 'docker exec -w /app -i accu-mk1-backend python' \\
        < backend/scripts/capture_hplc_golden.py > /tmp/hplc_engine_golden.json
Local (from backend/, against the dev database):
    python scripts/capture_hplc_golden.py > /tmp/out.json
"""
import json
import math
import os
import sys
from collections import Counter
from datetime import datetime, timezone

# Piped over stdin (`python < script`, the prod data-fix form) there is no
# __file__; the container's working dir (/app) is already importable then.
if "__file__" in globals():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import case as sql_case
from sqlalchemy import func, or_, select, text

from calculations.hplc_processor import (
    AnalysisInput,
    CalibrationParams,
    IntermediateWeights,
    PeptideParams,
    WeightInputs,
    process_hplc_analysis,
)

LIMIT = 200
DEFAULT_DILUENT_DENSITY = 997.1  # mg/mL, water: CalibrationCurve.diluent_density's own default
# The five WeightInputs fields, which are also the hplc_analyses column names.
WEIGHT_FIELDS = (
    "stock_vial_empty",
    "stock_vial_with_diluent",
    "dil_vial_empty",
    "dil_vial_with_diluent",
    "dil_vial_with_diluent_and_sample",
)
# The intermediate vial of a two-step dilution; also hplc_analyses column names.
INTERMEDIATE_FIELDS = ("int_vial_empty", "int_vial_with_diluent", "int_vial_with_diluent_and_sample")
DEFAULT_PREP_FORM = "powder"  # what every row saved before the prep_form column is
EXPECTED_KEYS = ("quantity_mg", "dilution_factor", "stock_volume_ml", "purity_percent", "concentration_ug_ml")


def _number_list(value, length=None):
    """`value` if it is a non-empty list of numbers (of `length`, when given), else None."""
    if not isinstance(value, list) or not value:
        return None
    if length is not None and len(value) != length:
        return None
    return value if all(isinstance(v, (int, float)) for v in value) else None


def _section(trace, name):
    section = trace.get(name)
    return section if isinstance(section, dict) else {}


def build_case(row):
    """Turn one row into a fixture case. Returns (case, None), or (None, reason)
    when the row cannot become a case. Pure: no database, so it can be checked
    on made-up rows. `row` needs the attributes the query in fetch_rows selects."""
    trace = row.calculation_trace
    if not isinstance(trace, dict):
        return None, "no_calculation_trace"
    quantity = _section(trace, "quantity")

    areas = _number_list(quantity.get("individual_areas"))
    if areas is None:
        return None, "no_individual_areas"
    slope = quantity.get("calibration_slope")
    if not isinstance(slope, (int, float)):
        return None, "no_calibration_slope"
    intercept = quantity.get("calibration_intercept")
    if not isinstance(intercept, (int, float)):
        return None, "no_calibration_intercept"

    density = row.diluent_density if row.diluent_density is not None else DEFAULT_DILUENT_DENSITY
    weights = {name: getattr(row, name) for name in WEIGHT_FIELDS}  # a liquid row has None stock weighings
    # The trace's own per-injection purity and RT values, when it has one per
    # area. None when absent: the peak then simply omits the key, as the engine
    # tolerates. They ride in the case so the test rebuilds the SAME injections.
    area_percents = _number_list(_section(trace, "purity").get("individual_values"), len(areas))
    retention_times = _number_list(_section(trace, "identity").get("individual_rts"), len(areas))

    case = {
        "weights": weights,
        "areas": areas,
        "area_percents": area_percents,
        "retention_times": retention_times,
        "slope": slope,
        "intercept": intercept,
        "diluent_density": density,
        "expected": None,
    }
    # The form, the declared volume and the intermediate vial, only when they are not the
    # default, so the case shape (and a fixture of all-powder rows) is unchanged. getattr,
    # not row.prep_form: a row without the attribute is the old shape. capture_statement
    # selects all of them, and a test pins that, so this cannot hide a dropped column.
    prep_form = getattr(row, "prep_form", None) or DEFAULT_PREP_FORM
    declared_volume_ml = getattr(row, "declared_volume_ml", None)
    if prep_form != DEFAULT_PREP_FORM or declared_volume_ml is not None:
        case["prep_form"] = prep_form
        case["declared_volume_ml"] = declared_volume_ml
    intermediate = {name: getattr(row, name, None) for name in INTERMEDIATE_FIELDS}
    if any(v is not None for v in intermediate.values()):
        case["intermediate"] = intermediate
    try:
        result = process_hplc_analysis(input_from_case(case))
    except Exception as exc:  # a row the engine cannot process is a counted skip, never a silent drop
        return None, f"engine_raised_{type(exc).__name__}"
    case["expected"] = {key: result[key] for key in EXPECTED_KEYS}

    numbers = [slope, intercept, density, *areas, *(area_percents or []), *(retention_times or []),
               *(v for v in weights.values() if v is not None),
               *(v for v in intermediate.values() if v is not None),
               *([declared_volume_ml] if declared_volume_ml is not None else []),
               *(v for v in case["expected"].values() if v is not None)]
    if not all(math.isfinite(n) for n in numbers):
        return None, "non_finite_number"  # NaN never equals itself, so it could never pass the pin
    return case, None


def input_from_case(case):
    """The engine input a case describes. The single definition: the pin test
    imports this, because the pin only means something if the test feeds the
    engine exactly what this script fed it."""
    injections = []
    for i, area in enumerate(case["areas"]):
        peak = {"area": area}
        if case["area_percents"] is not None:
            peak["area_percent"] = case["area_percents"][i]
        if case["retention_times"] is not None:
            peak["retention_time"] = case["retention_times"][i]
        injections.append({"peaks": [peak], "main_peak_index": 0})
    intermediate = case.get("intermediate")
    return AnalysisInput(
        injections=injections,
        weights=WeightInputs(**case["weights"]),
        calibration=CalibrationParams(slope=case["slope"], intercept=case["intercept"]),
        # No reference RT, so identity is not computed or pinned here.
        peptide=PeptideParams(reference_rt=None, rt_tolerance=0.5, diluent_density=case["diluent_density"]),
        # Absent keys are the defaults, which is every case captured before the form existed.
        intermediate=None if intermediate is None else IntermediateWeights(**intermediate),
        # `or`, not a default: a case carrying "prep_form": None must read as the default
        # too, because stock_volume_ml raises ValueError on None. build_case does the same.
        form=case.get("prep_form") or DEFAULT_PREP_FORM,
        declared_volume_ml=case.get("declared_volume_ml"),
    )


def capture_statement():
    """The ONE read-only query. Columns are named one by one on purpose: never the
    HPLCAnalysis entity, never the two huge JSON columns (see module docstring).
    Split from fetch_rows so a test can read which columns it selects."""
    from models import CalibrationCurve, HPLCAnalysis

    # Task 2's rules, by role: stock leg <= 0, added diluent < 0, added stock <= 0.
    # The zero-diluent case is a legal neat injection, hence the asymmetry.
    weighs_backwards = or_(
        HPLCAnalysis.stock_vial_with_diluent - HPLCAnalysis.stock_vial_empty <= 0,
        HPLCAnalysis.dil_vial_with_diluent - HPLCAnalysis.dil_vial_empty < 0,
        HPLCAnalysis.dil_vial_with_diluent_and_sample - HPLCAnalysis.dil_vial_with_diluent <= 0,
    )
    # More than one injection: individual_areas is a JSON array longer than 1.
    # CASE guards json_array_length, which errors on a non-array (a missing key
    # is NULL and is fine; a scalar is not).
    areas = HPLCAnalysis.calculation_trace["quantity"]["individual_areas"]
    multi_injection = sql_case(
        (func.json_typeof(areas) == "array", func.json_array_length(areas)),
        else_=0,
    ) > 1
    # Ids rise with insertion and the primary key is indexed; created_at is not.
    recent = (
        select(HPLCAnalysis.id)
        .where(HPLCAnalysis.calculation_trace.is_not(None))
        .order_by(HPLCAnalysis.id.desc())
        .limit(LIMIT)
    )
    stmt = (
        select(
            HPLCAnalysis.id,
            HPLCAnalysis.sample_id_label,
            *(getattr(HPLCAnalysis, name) for name in WEIGHT_FIELDS),
            HPLCAnalysis.prep_form,
            HPLCAnalysis.declared_volume_ml,
            *(getattr(HPLCAnalysis, name) for name in INTERMEDIATE_FIELDS),
            HPLCAnalysis.quantity_mg,
            HPLCAnalysis.calibration_curve_id,
            HPLCAnalysis.calculation_trace,
            CalibrationCurve.diluent_density,  # a single column of the curve, never the entity
            weighs_backwards.label("weighs_backwards"),
        )
        .outerjoin(CalibrationCurve, CalibrationCurve.id == HPLCAnalysis.calibration_curve_id)
        .where(or_(HPLCAnalysis.id.in_(recent), weighs_backwards, multi_injection))
        .order_by(HPLCAnalysis.id)
    )
    return stmt


def fetch_rows(db):
    return db.execute(capture_statement()).all()


def capture(rows, source):
    """Build the fixture and the counts from fetched rows."""
    cases, flagged, drifted, case_ids = [], [], [], {}
    skipped, skipped_but_backwards, density_defaulted = Counter(), [], Counter()
    form_defaulted, cases_by_form, two_step_cases = 0, Counter(), 0
    purity_values_absent = multi_injection_cases = 0
    for row in rows:
        case, reason = build_case(row)
        if case is None:
            skipped[reason] += 1
            if row.weighs_backwards:
                skipped_but_backwards.append(f"{row.sample_id_label}#{row.id}")
            continue
        if row.diluent_density is None:
            density_defaulted["no_curve" if row.calibration_curve_id is None else "curve_density_null"] += 1
        # Opaque, sequential in row-id order (the query's order_by), so the same
        # capture always numbers its cases the same way.
        row_form = getattr(row, "prep_form", None)
        form_defaulted += row_form is None
        cases_by_form[row_form or DEFAULT_PREP_FORM] += 1
        two_step_cases += "intermediate" in case
        case = {"id": f"case-{len(cases) + 1:03d}", **case}
        case_ids[case["id"]] = f"{row.sample_id_label}#{row.id}"
        cases.append(case)
        if case["area_percents"] is None:
            purity_values_absent += 1
        if len(case["areas"]) > 1:
            multi_injection_cases += 1
        if row.weighs_backwards:
            flagged.append(case["id"])
        if row.quantity_mg != case["expected"]["quantity_mg"]:
            drifted.append(case["id"])
    fixture = {
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "drifted": drifted,
        "flagged": flagged,
        "cases": cases,
    }
    counts = {
        "limit": LIMIT,
        "rows_selected": len(rows),
        "cases": len(cases),
        "cases_with_multiple_injections": multi_injection_cases,  # the averaging path's real-row coverage
        "skipped": dict(skipped),
        "skipped_but_backwards": skipped_but_backwards,  # flagged rows NOT in the fixture: must be empty to call it complete
        "case_ids": case_ids,  # opaque id -> sample_id_label#row id. Operator's record: stderr only, never git
        "flagged": len(flagged),
        "drifted": len(drifted),
        "diluent_density_defaulted_to_997.1": dict(density_defaulted),
        "prep_form_defaulted_to_powder": form_defaulted,  # NULL prep_form: a row saved before the column existed
        "cases_by_prep_form": dict(cases_by_form),  # anything but powder here means the fixture is no longer all-powder
        "cases_with_intermediate": two_step_cases,
        "cases_without_trace_purity_values": purity_values_absent,  # their pinned purity_percent is the engine's 0 default
    }
    return fixture, counts


def main():
    from database import SessionLocal

    with SessionLocal() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))  # the server refuses any write from here on
        source = (
            f"hplc_analyses in {db.get_bind().url.database}: the {LIMIT} most recent rows with a "
            "calculation_trace, plus every row whose weighings run backwards, plus every row with more "
            "than one injection; inputs rebuilt from calculation_trace, expected recomputed by "
            "process_hplc_analysis at capture time"
        )
        rows = fetch_rows(db)
    fixture, counts = capture(rows, source)
    sys.stdout.write(json.dumps(fixture, indent=1, allow_nan=False) + "\n")
    print(json.dumps(counts, indent=1, sort_keys=True), file=sys.stderr)


if __name__ == "__main__":
    main()
