// Re-derives DENNIS_TWO_STEP and DENNIS_ONE_STEP_MASS_MG in
// backend/tests/test_hplc_processor_engine.py, the "Mk1 agrees with Dennis" check.
//
// NEEDS Dennis's private repo checked out at C:/tmp/tools-dennis/tools/hplc-peptide-quant/
// (override with DENNIS_CALC_JS=<path to calc.js>). It will not run without it: a missing
// calc.js is a missing dependency, not a failure of the engine. It reads calc.js ONLY. It
// never reads hplc-peptide-quant-data.json (real lab data), and calc.js itself does not.
//
// The inputs are numbers only, the weighings, areas and curve of the engine test's
// FORWARD_CASE (a golden-fixture row) plus its INT_WEIGHTS intermediate vial. No sample
// identity, client or lot. If that test's FORWARD_CASE or INT_WEIGHTS ever changes (a golden
// recapture), copy the new numbers here, run `node dennis_two_step_oracle.cjs`, and paste
// the printed values into the test.
//
// The mean of the areas is this script's (sum / n, the engine's convention): calc.js's
// sampleResult takes one peak area. Everything after it is calc.js's own code.
const path = process.env.DENNIS_CALC_JS || 'C:/tmp/tools-dennis/tools/hplc-peptide-quant/calc.js';
let calc;
try { calc = require(path); } catch (e) { console.error(`needs Dennis's calc.js at ${path}: ${e.message}`); process.exit(2); }

const D = 997.1;  // diluent density, mg/mL
const w = { stockEmpty: 5317.98, stockDiluent: 8277.73, dilEmpty: 2571.93, dilDiluent: 3806.59, dilAll: 4026.52 };
const iv = { empty: 2950.0, diluent: 4196.4, all: 4445.4 };
const areas = [23396.5746, 2476.4236, 225.9517, 19.8103, 6220.5662, 12400.5069];
const fit = { slope: 9.038015, intercept: 18.846082 };

const mean = areas.reduce((s, x) => s + x, 0) / areas.length;
const step1 = calc.stockPrep({ declaredMg: 5, vialMg: w.stockEmpty, vialDiluentMg: w.stockDiluent }, D);
const fin = calc.dilutionActual({ asVialMg: w.dilEmpty, asVialDiluentMg: w.dilDiluent, asVialAllMg: w.dilAll }, 1000, D);
const inter = calc.dilutionActual({ asVialMg: iv.empty, asVialDiluentMg: iv.diluent, asVialAllMg: iv.all }, 9000, D);
const total = inter.dilutionFactor * fin.dilutionFactor;  // calc.js:1832, unrounded
const one = calc.sampleResult({ peakArea: mean }, fit, step1, { dilutionFactor: fin.dilutionFactor }, null);
const two = calc.sampleResult({ peakArea: mean }, fit, step1, { dilutionFactor: total }, null);
console.log(JSON.stringify({
  DENNIS_TWO_STEP: { dilution_factor_total: total, peptide_mass_mg: two.peptideMassMg },
  DENNIS_ONE_STEP_MASS_MG: one.peptideMassMg,
}, null, 2));
