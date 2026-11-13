// Generator for hplc_calibration_cases.json (plan 4, Task 2). A dev tool, run by hand, never at test time:
//
//   node backend/tests/fixtures/make_hplc_calibration_cases.cjs <path to the lab tool's calc.js>
//
// Every case is written below in Mk1's own shape (the hplc_calibration_sheets.inputs of a sheet). The
// generator translates it ONCE (toSource) into the lab tool's calibration record, runs the tool's own
// calibration, netPeptide and calWarnings (and replicatePrep for a replicate case), and translates the
// result back (toExpect) into the shape work_out_sheet returns. backend/hplc_calibration.py and
// src/lib/hplc-calibration.ts are held to `expect`.
//
// Warnings: each code comes from the source FIELD that raised the line (calDuplicateWeighings' kind, a
// level's problem, calVolumeDeviations' what, the stock weight, the netPeptide fields, the findIndex
// that unshifts "cannot be made"), never from the text, and the count is checked against calWarnings.
// Warning text is not pinned (work_out_sheet writes its own).
//
// Two things have no source counterpart and are derived here:
//   net_partial: assay or water not typed, or a counterion chosen and not applied (Mk1's rule).
//   the override (net.override_factor): the source always multiplies the stock by netPeptide's factor.
//     An override case is run on a TWIN sheet whose net block is {assayPct: override * 100} alone, so
//     the twin's factor is the override exactly (asserted; 0.85 comes out of (85 / 100) * 1 * (1 - 0)).
//     The computed factor, `net`, parts_used and the net warnings come from the REAL net block; every
//     level, the stock and the fit come from the twin.
'use strict';
const fs = require('fs');
const path = require('path');

const SOURCE_COMMIT = '39a1afe8bff374abf8241d63f35682d32f4795d8';
const calcPath = process.argv[2];
if (!calcPath) throw new Error('usage: node make_hplc_calibration_cases.cjs <path to calc.js>');
const api = require(path.resolve(calcPath));
const shaFile = path.join(path.dirname(path.resolve(calcPath)), '..', '..', 'SNAPSHOT_SHA.txt');
if (!fs.existsSync(shaFile)) throw new Error(`no ${shaFile}: cannot prove calc.js is the pinned snapshot`);
if (fs.readFileSync(shaFile, 'utf8').trim() !== SOURCE_COMMIT)
  throw new Error(`calc.js is not the snapshot this fixture pins (${SOURCE_COMMIT})`);
const D = api.DEFAULTS;

/* The constants backend/hplc_calibration.py copies, each checked against the tool's own. The last three
   are HPLC_RUN_PARAM_DEFAULTS' (the Python module imports them). */
const CONSTANTS = {
  proton_da: 1.00728, cal_level_targets: [1000, 500, 250, 100, 10, 1], cal_stock_diluent_ul: 1000,
  cal_min_stock_mg: 20, cal_top_aliquot_ul: 150, cal_stock_as_top_pct: 5,
  diluent_density_mg_ml: 997.1, target_volume_ul: 1500, volume_tolerance_pct: 15,
};
const SOURCE_CONSTANTS = {
  proton_da: api.msNeutralMass(0, 'M-H'),   // PROTON_DA is not exported: 1 x 0 + 1 x PROTON_DA
  cal_level_targets: api.CAL_LEVEL_TARGETS, cal_stock_diluent_ul: D.calStockDiluentUl,
  cal_min_stock_mg: D.calMinStockMg, cal_top_aliquot_ul: D.calTopAliquotUl, cal_stock_as_top_pct: D.calStockAsTopPct,
  diluent_density_mg_ml: D.diluentDensityMgPerMl, target_volume_ul: D.targetVolumeUl, volume_tolerance_pct: D.volumeTolerancePct,
};
for (const k of Object.keys(CONSTANTS))
  if (JSON.stringify(CONSTANTS[k]) !== JSON.stringify(SOURCE_CONSTANTS[k])) throw new Error(`constant ${k}: fixture ${CONSTANTS[k]}, source ${SOURCE_CONSTANTS[k]}`);
const COUNTERIONS = { Acetate: 60.05, TFA: 114.02, HCl: 36.46, Iodide: 126.90, Sodium: 21.98 };
if (JSON.stringify(COUNTERIONS) !== JSON.stringify(D.counterions)) throw new Error('COUNTERIONS differ from DEFAULTS.counterions');
const MS_IONS = ['', 'M', 'M+H', 'M+2H', 'M+3H', 'M+4H', 'M-H', 'M-2H', 'M-3H', 'M-4H'];
if (JSON.stringify(MS_IONS) !== JSON.stringify(api.MS_IONS.map(x => x[0]))) throw new Error('MS_IONS differ from the source');

/* ─── The cases, in Mk1's shape ─── */
const NET_KEYS = ['counterion', 'counterion_mw', 'equivalents', 'free_mw', 'stated_fw', 'ms_mz', 'ms_ion',
  'assay_pct', 'water_pct', 'assumption', 'override_factor', 'override_reason'];
const net = (fields = {}) => Object.assign(Object.fromEntries(NET_KEYS.map(k => [k, null])), fields);
const META = { standard_id: 'P-0129', cas: '2381089-83-2', supplier: 'Cayman Chemical', lot: '39747', coa_weight_mg: 5,
  diluent_density_mg_ml: null, level_volume_ul: null, analyst: 'DN', date: '2026-02-05', notes: '' };
const STOCK = { vial_mg: 15727.09, vial_standard_mg: 15729.14, vial_diluent_mg: 16727.24 };
// calc.test.js sheet 1290A: (target, vial, vial + diluent, vial + diluent + std), areas, purity, RT
const WEIGHINGS = [[1000, 2794.62, 3546.08, 4268.25], [500, 2790.84, 3532.48, 4273.52], [250, 2766.75, 3508.98, 4252.60],
  [100, 2794.60, 3686.36, 4279.47], [10, 2802.83, 4149.12, 4297.18], [1, 2800.34, 4142.88, 4294.77]];
const AREAS_A = [8588.495, 4325.233, 2175.431, 869.562, 83.014, 7.363];
const AREAS_B = [8400.629, 4240.415, 2167.877, 865.139, null, null];
const PURITY_A = [99.832, 99.782, 99.815, 99.821, null, null];
const RT_A = [6.349, 6.387, 6.398, 6.403, 6.398, 6.414];
const workbookLevels = (areas = AREAS_A) => WEIGHINGS.map(([target, v, vd, vds], i) => ({
  target, vial_mg: v, vial_diluent_mg: vd, vial_diluent_std_mg: vds, peak_area: areas[i], purity: PURITY_A[i], rt: RT_A[i] }));
const sheet = (netFields, change = {}) => Object.assign({ ...META, net: net(netFields), stock: { ...STOCK },
  stock_as_top: false, top_aliquot_ul: null, levels: workbookLevels() }, change);
const editLevel = (levels, i, fields) => levels.map((L, j) => (j === i ? { ...L, ...fields } : L));

const ASSUMPTION = 'lean 2, undeclared on the CoA';
const CI_FREE = { counterion: 'Acetate', equivalents: 2, free_mw: 4731.3, stated_fw: 4731.3, assay_pct: 99.3, water_pct: 6.2, assumption: ASSUMPTION };
const MS_OK = { counterion: 'Sodium', equivalents: 2, free_mw: 4813.53, stated_fw: 4813.5, water_pct: 0, assumption: ASSUMPTION, ms_mz: 1603.1, ms_ion: 'M-3H' };
const SEMAX = () => {
  const lv = workbookLevels();
  lv[0] = { target: 1000, vial_mg: null, vial_diluent_mg: null, vial_diluent_std_mg: null, peak_area: 8520, purity: null, rt: null };
  return sheet({}, { standard_id: 'P-0200', stock: { vial_mg: 10000, vial_standard_mg: 10001.99, vial_diluent_mg: 11996.19 },
    stock_as_top: true, levels: lv });
};
const BLANK = {
  standard_id: null, cas: null, supplier: null, lot: null, coa_weight_mg: null, diluent_density_mg_ml: null,
  level_volume_ul: null, analyst: null, date: null, notes: null, net: net(),
  stock: { vial_mg: null, vial_standard_mg: null, vial_diluent_mg: null }, stock_as_top: null, top_aliquot_ul: null,
  levels: CONSTANTS.cal_level_targets.map(target => ({ target, vial_mg: null, vial_diluent_mg: null, vial_diluent_std_mg: null,
    peak_area: null, purity: null, rt: null })),
};
const CASE1 = sheet({});

const CASES = [
  ['no correction', CASE1],
  ['assay only', sheet({ assay_pct: 98.5 })],
  ['assay and water', sheet({ assay_pct: 99.3, water_pct: 6.2 })],
  ['counterion, stated FW is the free peptide', sheet(CI_FREE)],
  ['counterion, stated FW is the salt', sheet({ counterion: 'Acetate', free_mw: 1025.17, stated_fw: 1085.22, water_pct: 0, assumption: ASSUMPTION })],
  ['partial: sodium with no equivalents', sheet({ counterion: 'Sodium', free_mw: 4813.53, stated_fw: 4813.5, assay_pct: 98, water_pct: 5 })],
  ['manual override', sheet({ ...CI_FREE, override_factor: 0.85, override_reason: 'Re-assayed in house, 85 % net' })],
  ['override with no reason', sheet({ ...CI_FREE, override_factor: 0.85 })],
  ['counterion applied, no assumption', sheet({ counterion: 'Acetate', equivalents: 2, free_mw: 711.86, stated_fw: 711.85, water_pct: 0 })],
  // Ruling (task 2 report): no netPeptide line fires here, but no assay is typed, so Mk1's
  // net_partial DOES fire. Not a defect; do not "fix" it away.
  ['mass spec agrees', sheet(MS_OK)],
  ['mass spec wrong ion', sheet({ ...MS_OK, ms_ion: 'M+H' })],
  ['stated FW matches nothing', sheet({ counterion: 'Acetate', equivalents: 1, free_mw: 700, stated_fw: 790, water_pct: 0, assumption: ASSUMPTION })],
  ['four points, two blank areas', sheet({}, { levels: workbookLevels(AREAS_B) })],
  ['serial dilution, weighing backwards', sheet({}, { levels: editLevel(workbookLevels(), 3, { vial_diluent_mg: 2700 }) })],
  ['a volume more than 15% off', sheet({}, { levels: editLevel(workbookLevels(), 0, { vial_diluent_std_mg: 4626.25 }) })],
  ['weak stock', sheet({}, { stock: { ...STOCK, vial_diluent_mg: 19727.24 } })],
  ['stock is the top level', SEMAX()],
  ['stock top, typed aliquot', Object.assign(SEMAX(), { top_aliquot_ul: 200 })],
  ['same weight twice', sheet({}, { levels: editLevel(workbookLevels(), 1, { vial_diluent_std_mg: 3532.48 }) })],
  ['another injection', { notes: 'Inj2', levels: AREAS_A.map((a, i) => ({ peak_area: a * 1.02, purity: PURITY_A[i], rt: RT_A[i] })) }, CASE1],
  // Ruling (task 2 report): a blank sheet still returns the source's defaults (density 997.1, level
  // volume 1500, top aliquot 150, factor 1, f_counterion 1, counterion_mw 0); only the weighed values are null.
  ['blank sheet', BLANK],
  // Fix round 1: the reviewer's differential cases (C:/tmp/hplc-build/p4-t2-review/diff_cases.json),
  // inputs copied verbatim, made permanent so every warning code and branch is pinned.
  ["same_weight_next vial",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2794.62,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["stock_not_heavier zero",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15727.09,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["equivalents disagree (salt 1 eq, box 2)",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Acetate","counterion_mw":null,"equivalents":2,"free_mw":1025.17,"stated_fw":1085.22,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["fw mismatch no counterion",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":700,"stated_fw":790,"ms_mz":null,"ms_ion":null,"assay_pct":99,"water_pct":0,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["assumed FW with acetate",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Acetate","counterion_mw":null,"equivalents":2,"free_mw":null,"stated_fw":4731.3,"ms_mz":null,"ms_ion":null,"assay_pct":99,"water_pct":5,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["Other typed mass, salt",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Formate","counterion_mw":45.02,"equivalents":null,"free_mw":1000,"stated_fw":1090.04,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":3,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["ion M",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Sodium","counterion_mw":null,"equivalents":2,"free_mw":4813.53,"stated_fw":4813.5,"ms_mz":4813.2,"ms_ion":"M","assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["ion M+2H",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Sodium","counterion_mw":null,"equivalents":2,"free_mw":4813.53,"stated_fw":4813.5,"ms_mz":2407.77,"ms_ion":"M+2H","assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["ion M-H",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Sodium","counterion_mw":null,"equivalents":2,"free_mw":4813.53,"stated_fw":4813.5,"ms_mz":4812.5,"ms_ion":"M-H","assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["typed density and volume, stock top",{"standard_id":"P-0200","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":1034.72,"level_volume_ul":2000,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":10000,"vial_standard_mg":10001.99,"vial_diluent_mg":11996.19},"stock_as_top":true,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":null,"vial_diluent_mg":null,"vial_diluent_std_mg":null,"peak_area":8520,"purity":null,"rt":null},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["tol 1 Da inside (free 200, stated 201)",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":200,"stated_fw":201,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["tol 1 Da outside (free 200, stated 201.0001)",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":200,"stated_fw":201.0001,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["tol 0.2% inside, acetate (free 4000, stated 4008)",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Acetate","counterion_mw":null,"equivalents":2,"free_mw":4000,"stated_fw":4008,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["tol 0.2% outside, acetate (free 4000, stated 4008.01)",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Acetate","counterion_mw":null,"equivalents":2,"free_mw":4000,"stated_fw":4008.01,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["kr tie 2.5 rounds up",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"X","counterion_mw":2,"equivalents":2,"free_mw":1000,"stated_fw":1005,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["toFixed tie next-row",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.0078125,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2794.007813,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["only two points",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":null,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":null,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":null,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":null,"purity":null,"rt":6.414}]}],
  ["all areas equal",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":500,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":500,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":500,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":500,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":500,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":500,"purity":null,"rt":6.414}]}],
  ["workbook stock as top",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":true,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["workbook stock as top, aliquot 300",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":true,"top_aliquot_ul":300,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["level 2 target above level 1",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":600,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["three levels",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398}]}],
  ["nine levels",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414},{"target":0.5,"vial_mg":2800.1,"vial_diluent_mg":3500.2,"vial_diluent_std_mg":4250.3,"peak_area":3.9,"purity":null,"rt":6.41},{"target":0.25,"vial_mg":2801.1,"vial_diluent_mg":3501.7,"vial_diluent_std_mg":4251.9,"peak_area":2.1,"purity":null,"rt":6.42},{"target":0.1,"vial_mg":2802.4,"vial_diluent_mg":3800,"vial_diluent_std_mg":4400,"peak_area":0.9,"purity":null,"rt":6.4}]}],
  ["replicate, own areas differ",{"notes":"Inj2","levels":[{"peak_area":8700.1,"purity":null,"rt":6.359},{"peak_area":4300.2,"purity":null,"rt":6.396999999999999},{"peak_area":null,"purity":null,"rt":6.4079999999999995},{"peak_area":870.3,"purity":null,"rt":6.412999999999999},{"peak_area":80,"purity":null,"rt":6.4079999999999995},{"peak_area":7.5,"purity":null,"rt":6.4239999999999995}]},{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":null,"counterion_mw":null,"equivalents":null,"free_mw":null,"stated_fw":null,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":null,"assumption":null,"override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  ["free 0 and eq 0 (acetate)",{"standard_id":"P-0129","cas":"2381089-83-2","supplier":"Cayman Chemical","lot":"39747","coa_weight_mg":5,"diluent_density_mg_ml":null,"level_volume_ul":null,"analyst":"DN","date":"2026-02-05","notes":"","net":{"counterion":"Acetate","counterion_mw":null,"equivalents":0,"free_mw":0,"stated_fw":0,"ms_mz":null,"ms_ion":null,"assay_pct":null,"water_pct":0,"assumption":"lean 2, undeclared on the CoA","override_factor":null,"override_reason":null},"stock":{"vial_mg":15727.09,"vial_standard_mg":15729.14,"vial_diluent_mg":16727.24},"stock_as_top":false,"top_aliquot_ul":null,"levels":[{"target":1000,"vial_mg":2794.62,"vial_diluent_mg":3546.08,"vial_diluent_std_mg":4268.25,"peak_area":8588.495,"purity":99.832,"rt":6.349},{"target":500,"vial_mg":2790.84,"vial_diluent_mg":3532.48,"vial_diluent_std_mg":4273.52,"peak_area":4325.233,"purity":99.782,"rt":6.387},{"target":250,"vial_mg":2766.75,"vial_diluent_mg":3508.98,"vial_diluent_std_mg":4252.6,"peak_area":2175.431,"purity":99.815,"rt":6.398},{"target":100,"vial_mg":2794.6,"vial_diluent_mg":3686.36,"vial_diluent_std_mg":4279.47,"peak_area":869.562,"purity":99.821,"rt":6.403},{"target":10,"vial_mg":2802.83,"vial_diluent_mg":4149.12,"vial_diluent_std_mg":4297.18,"peak_area":83.014,"purity":null,"rt":6.398},{"target":1,"vial_mg":2800.34,"vial_diluent_mg":4142.88,"vial_diluent_std_mg":4294.77,"peak_area":7.363,"purity":null,"rt":6.414}]}],
  // Fix round 2: Math.round((1e12 - 4731.3) / 1e-300) is Infinity in the source (the port used to raise);
  // the sheet falls into the "mismatch" branch.
  ['Other with a vanishing mass', sheet({ counterion: 'Other', counterion_mw: 1e-300, equivalents: 2, free_mw: 4731.3,
    stated_fw: 1e12, water_pct: 0, assumption: ASSUMPTION })],
  // Fix round 2: three netPeptide lines at once, so their ORDER is pinned (fw mismatch with no counterion
  // mass, then KF missing, then the counterion not applied).
  ['two net warnings, in order', sheet({ counterion: 'Other', free_mw: 4731.3, stated_fw: 4800, assay_pct: 99.3 })],
];
// The one case whose source run divides by zero (calc.js 2793-2794: free 0 / (0 + 0 x 60.05) is NaN).
// Its NaN values are written as null (the port's None); every other case must be finite throughout.
const NON_FINITE_OK = new Set(['free 0 and eq 0 (acetate)']);

/* ─── Mk1 -> the tool's calibration record, written once ─── */
const or = (v, d = null) => (v === undefined || v === null ? d : v);
function toSource(inputs) {
  const n = inputs.net || {};
  const s = inputs.stock || {};
  return {
    notes: inputs.notes,   // as typed (undefined when absent), so a replicate round-trips
    diluentDensityMgPerMl: or(inputs.diluent_density_mg_ml), targetTotalUl: or(inputs.level_volume_ul),
    stockAsTop: or(inputs.stock_as_top, false), topAliquotUl: or(inputs.top_aliquot_ul),
    // the page forces the net basis (cal.js:87); the override is Mk1's and has no source field
    net: { basis: 'net', counterion: or(n.counterion, ''), counterionMw: or(n.counterion_mw), equivalents: or(n.equivalents),
      freeMw: or(n.free_mw), statedFw: or(n.stated_fw), assayPct: or(n.assay_pct), waterPct: or(n.water_pct),
      assumption: or(n.assumption, ''), msMz: or(n.ms_mz), msIon: or(n.ms_ion, '') },
    stock: { vialMg: or(s.vial_mg), vialPeptideMg: or(s.vial_standard_mg), vialDiluentMg: or(s.vial_diluent_mg) },
    levels: (inputs.levels || []).map(L => ({ target: or(L.target), vialMg: or(L.vial_mg), vialDiluentMg: or(L.vial_diluent_mg),
      vialDiluentStdMg: or(L.vial_diluent_std_mg), peakArea: or(L.peak_area), purity: or(L.purity), rt: or(L.rt) })),
  };
}
// A replicate's own fields (CAL_REP_OWN's notes, CAL_REP_LEVEL_OWN); a key the replicate lacks stays undefined.
function toSourceReplicate(rep) {
  const out = {};
  if (rep.notes !== undefined) out.notes = rep.notes;
  out.levels = (rep.levels || []).map(L => {
    const x = {};
    if (L.peak_area !== undefined) x.peakArea = L.peak_area;
    if (L.purity !== undefined) x.purity = L.purity;
    if (L.rt !== undefined) x.rt = L.rt;
    return x;
  });
  return out;
}

/* ─── The tool's answer -> work_out_sheet's shape ─── */
function netCodes(nt) {
  // netPeptide's warning lines, in its order, each from the field that raised it (calc.js 2741 to 2812)
  const codes = [];
  const hasCi = nt.counterion !== '';
  if (nt.fwBasis === 'salt' && nt.equivalents !== null) {
    const kr = Math.round((nt.statedFw - nt.freeMw) / nt.counterionMw);
    if (Math.abs(nt.equivalents - kr) > 0.05) codes.push('net_equivalents_disagree');
  }
  if (nt.fwBasis === 'mismatch') codes.push(hasCi && nt.counterionMw ? 'net_fw_mismatch' : 'net_fw_mismatch_no_counterion');
  if (nt.msM !== null && nt.freeMw !== null && !(Math.abs(nt.msM - nt.freeMw) <= Math.max(1.5, nt.freeMw * 0.001))) codes.push('net_ms_mismatch');
  if (nt.basis !== 'net') throw new Error('the page forces the net basis');
  if (nt.waterPct === null) codes.push('net_kf_missing');
  if (hasCi && !nt.counterionApplied) codes.push('net_counterion_partial');
  if (nt.blocking) codes.push('net_assumption_missing');
  if (codes.length !== nt.warnings.length) throw new Error(`net warnings: mapped ${codes}, source has ${nt.warnings.length}`);
  return codes;
}
function sheetCodes(src, c) {
  // calWarnings (calc.js 2996) without the net block's lines: [codes before the net lines, the "cannot be made" level]
  const codes = [];
  const w = (code, level = null) => codes.push({ code, level });
  for (const d of api.calDuplicateWeighings(src)) w(d.kind === 'same-row' ? 'same_weight_row' : 'same_weight_next', d.cells[0].level);
  c.levels.forEach((l, i) => { if (l.problem) w(`level_backwards_${l.problem}`, i); });
  for (const d of api.calVolumeDeviations(c)) w(`volume_off_${d.what}`, d.level);
  if (c.stockWeightMg !== null && c.stockWeightMg <= 0) w('stock_not_heavier');
  if (c.stockWeightMg !== null && c.stockWeightMg > 0 && c.stockWeightMg < D.calMinStockMg) w('stock_under_min');
  const i = c.levels.findIndex(l => !l.fromStock && l.target !== null && l.madeFromUgPerMl !== null && l.madeFromUgPerMl <= l.target);
  return { codes, cannot: i };
}
const partsUsed = nt => [nt.assayPct !== null ? 'assay' : null, nt.counterionApplied ? 'counterion' : null, nt.waterPct !== null ? 'water' : null].filter(Boolean);
const toNet = nt => ({
  counterion: nt.counterion, counterion_mw: nt.counterionMw, equivalents: nt.equivalents, free_mw: nt.freeMw, stated_fw: nt.statedFw,
  assay_pct: nt.assayPct, water_pct: nt.waterPct, fw_basis: nt.fwBasis, f_counterion: nt.fCounterion, factor: nt.factor,
  counterion_applied: nt.counterionApplied, assumed_fw: nt.assumedFw, ms_m: nt.msM, parts_used: partsUsed(nt),
});
const toLevel = l => ({
  target: l.target, problem: l.problem, from_stock: !!l.fromStock, made_from_ug_ml: l.madeFromUgPerMl,
  planned_std_ul: l.plannedStdUl, planned_diluent_ul: l.plannedDiluentUl, actual_diluent_ul: l.actualDiluentUl,
  std_to_add_ul: l.stdToAddUl, actual_std_ul: l.actualStdUl, total_ul: l.totalUl, actual_conc_ug_ml: l.actualConcUgPerMl,
  peak_area: l.peakArea, purity: l.purity, rt: l.rt, remaining_ul: l.remainingUl,
  back_calc_ug_ml: l.backCalcUgPerMl, back_calc_dev_pct: l.backCalcDevPct,
});

function workOut(inputs, name) {
  const fail = msg => { throw new Error(`${name}: ${msg}`); };
  const n = inputs.net || {};
  const src = toSource(inputs);
  const real = api.netPeptide(src);
  const override = api.num(n.override_factor);
  let calSrc = src;
  if (override !== null) {
    calSrc = toSource({ ...inputs, net: { assay_pct: override * 100 } });
    if (api.netPeptide(calSrc).factor !== override) fail(`the twin's factor ${api.netPeptide(calSrc).factor} is not the override ${override}`);
  }
  const c = api.calibration(calSrc);
  if (override === null && !Object.is(c.net.factor, real.factor)) fail('calibration\'s net is not netPeptide\'s');

  const { codes, cannot } = sheetCodes(calSrc, c);
  const twinNetCount = c.net.warnings.length;
  if (codes.length + twinNetCount + (cannot >= 0 ? 1 : 0) !== api.calWarnings(calSrc, c).length) fail('mapped warnings do not match calWarnings\' count');
  const warnings = [];
  if (cannot >= 0) warnings.push({ code: 'level_cannot_be_made', level: cannot });
  warnings.push(...codes);
  for (const code of netCodes(real)) warnings.push({ code, level: null });
  const hasCi = real.counterion !== '';
  if (real.assayPct === null || real.waterPct === null || (hasCi && !real.counterionApplied)) warnings.push({ code: 'net_partial', level: null });
  if (override !== null && !String(n.override_reason || '').trim()) warnings.push({ code: 'override_reason_missing', level: null });
  const blocking = warnings.map(x => x.code).filter(x => x === 'net_assumption_missing' || x === 'override_reason_missing');
  if ((real.blocking !== '') !== blocking.includes('net_assumption_missing')) fail('blocking disagrees with netPeptide');

  return {
    density: c.density, level_volume_ul: or(api.num(inputs.level_volume_ul), D.targetVolumeUl),
    stock_weight_mg: c.stockWeightMg, stock_diluent_to_add_ul: c.stockDiluentToAddUl, stock_actual_diluent_ul: c.stockActualDiluentUl,
    stock_conc_as_weighed_ug_ml: c.stockConcAsWeighedUgPerMl, net: toNet(real),
    factor_applied: override !== null ? override : real.factor, factor_source: override !== null ? 'override' : 'computed',
    stock_net_weight_mg: c.stockNetWeightMg, stock_conc_ug_ml: c.stockConcUgPerMl, stock_as_top: c.stockAsTop,
    top_aliquot_ul: c.topAliquotUl, stock_near_top: c.stockNearTop, stock_remaining_ul: c.stockRemainingUl,
    levels: c.levels.map(toLevel), fit: { slope: c.fit.slope, intercept: c.fit.intercept, r2: c.fit.r2, n: c.fit.n },
    rt_avg: c.rtAvg, rt_rsd_pct: c.rtRsdPct, range: c.range ? { low: c.range.low, high: c.range.high } : null,
    warnings, blocking,
  };
}

function assertFinite(x, where) {
  if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`${where}: ${x} is not finite`);
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) assertFinite(v, `${where}.${k}`);
}

// NaN or Infinity -> null in place (JSON.stringify would do the same silently); returns the paths
function nullNonFinite(x, where) {
  const out = [];
  for (const [k, v] of Object.entries(x)) {
    const p = where ? `${where}.${k}` : k;
    if (typeof v === 'number' && !Number.isFinite(v)) { x[k] = null; out.push(p); }
    else if (v && typeof v === 'object') out.push(...nullNonFinite(v, p));
  }
  return out;
}
const canon = x => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v));

const cases = CASES.map(([name, inputs, replicateOf]) => {
  let expect;
  if (replicateOf) {
    // the replicate's preparation is the original's, as the source merges it (replicatePrep, calc.js 2862)
    const merged = api.replicatePrep(toSource(replicateOf), toSourceReplicate(inputs));
    const mk1 = { ...replicateOf, notes: merged.notes,
      levels: replicateOf.levels.map((L, i) => ({ ...L, peak_area: merged.levels[i].peakArea, purity: merged.levels[i].purity, rt: merged.levels[i].rt })) };
    if (canon(toSource(mk1)) !== canon(merged)) throw new Error(`${name}: the replicate does not round-trip through replicatePrep`);
    expect = workOut(mk1, name);
  } else expect = workOut(inputs, name);
  if (NON_FINITE_OK.has(name)) {
    const nulled = nullNonFinite(expect, '');
    if (!nulled.length) throw new Error(`${name}: expected a non-finite source value`);
    // calc.js 1258 filters with `!== null`, so NaN levels count as fitted and the range is {NaN, NaN}:
    // no range at all, which is null in the port (no level has a concentration)
    if (expect.range && expect.range.low === null && expect.range.high === null) { expect.range = null; nulled.push('range (both ends NaN, written as range null)'); }
    console.log(`${name}: written as null: ${nulled.join(', ')}`);
  }
  assertFinite(expect, name);
  assertFinite(inputs, name);
  const out = { name, inputs };
  if (replicateOf) out.replicate_of = replicateOf;
  out.expect = expect;
  return out;
});
if (new Set(cases.map(c => c.name)).size !== cases.length) throw new Error('case names must be unique');

const fixture = {
  about: 'work_out_sheet fixture (plan 4 HPLC calibration curve worksheet, Task 2), generated by make_hplc_calibration_cases.cjs from the lab tool\'s own calc.js at source_commit. Each case is a sheet\'s stored inputs in Mk1\'s shape; a replicate case also carries replicate_of (the original\'s inputs) and its expect is work_out_sheet(replicate_prep(replicate_of, inputs)). expect is the whole work_out_sheet result the tool computes, except that a warning\'s text is not pinned. net_partial and the manual override have no source counterpart: see the generator\'s header. counterions, ms_ions and constants are the tool\'s, checked by the generator. backend/tests/test_hplc_calibration.py and the TypeScript mirror run every case. Regenerate, never edit by hand.',
  source_commit: SOURCE_COMMIT,
  counterions: COUNTERIONS,
  ms_ions: MS_IONS,
  constants: CONSTANTS,
  cases,
};
const out = path.join(__dirname, 'hplc_calibration_cases.json');
fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
console.log(`wrote ${cases.length} cases`);
