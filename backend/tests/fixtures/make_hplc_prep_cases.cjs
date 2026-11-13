// Generator for hplc_prep_cases.json (plan 3, Task 3). A dev tool, run by hand, never at test time:
//
//   node backend/tests/fixtures/make_hplc_prep_cases.cjs <path to the lab tool's calc.js>
//
// Every case is written below in Mk1's own shape (row facts + hplc_prep inputs). The generator
// translates it ONCE (toSource, the brief's translation table) into the lab tool's sample shape,
// runs the tool's own computeRun, and translates the result back (toExpect) into the shape
// compute_row returns. backend/hplc_prep.py and src/lib/hplc-prep.ts are held to `expect`.
//
// Targets, leads and the diluent come in Mk1 from plan 2's rules, by peptide id; in the tool from
// its built-in name tables. The fixture's `rules` are the tool's DEFAULTS tables re-keyed to the
// ids in PEPTIDES; equivalence() proves, before anything is written, that for every peptide here
// and for every case the two give the same target, lead and diluent. A difference stops the run.
// Warning `text` is not pinned (compute_row writes its own); code, vial and peptide_id are.
'use strict';
const fs = require('fs');
const path = require('path');

const SOURCE_COMMIT = '39a1afe8bff374abf8241d63f35682d32f4795d8';
const calcPath = process.argv[2];
if (!calcPath) throw new Error('usage: node make_hplc_prep_cases.cjs <path to calc.js>');
const api = require(path.resolve(calcPath));
const shaFile = path.join(path.dirname(path.resolve(calcPath)), '..', '..', 'SNAPSHOT_SHA.txt');
if (fs.existsSync(shaFile) && fs.readFileSync(shaFile, 'utf8').trim() !== SOURCE_COMMIT)
  throw new Error(`calc.js is not the snapshot this fixture pins (${SOURCE_COMMIT})`);
const D = api.DEFAULTS;

/* The thirteen method constants: a copy of HPLC_RUN_PARAM_DEFAULTS (the Python test pins the
   copy), each checked against the tool's own constant. */
const PARAMS = {
  default_target_ug_ml: 200, intermediate_target_ug_ml: 5000, intermediate_volume_ul: 1500,
  two_step_threshold_mg: 500, bac_stock_ug_ml: 9000.0, bac_target_ug_ml: 500,
  capsule_neat_max_ug_ml: 350, diluent_density_mg_ml: 997.1, benzyl_alcohol_density_mg_ml: 1034.72,
  floor_ug_ml: 60, target_volume_ul: 1500, sample_diluent_ul: 3000, volume_tolerance_pct: 15,
};
const SOURCE_PARAMS = {
  default_target_ug_ml: D.targetConcUgPerMl, intermediate_target_ug_ml: api.runIntermediateDefault({}),
  intermediate_volume_ul: D.intermediateVolumeUl, two_step_threshold_mg: D.twoStepFromMg,
  bac_stock_ug_ml: D.bacWaterStockUgPerMl, bac_target_ug_ml: D.bacWaterTargetUgPerMl,
  capsule_neat_max_ug_ml: D.capsuleNeatMaxUgPerMl, diluent_density_mg_ml: D.diluentDensityMgPerMl,
  benzyl_alcohol_density_mg_ml: api.benzylAlcoholDensity(), floor_ug_ml: D.blendFloorUgPerMl,
  target_volume_ul: D.targetVolumeUl, sample_diluent_ul: D.sampleDiluentUl, volume_tolerance_pct: D.volumeTolerancePct,
};
for (const k of Object.keys(PARAMS))
  if (PARAMS[k] !== SOURCE_PARAMS[k]) throw new Error(`param ${k}: fixture ${PARAMS[k]}, source ${SOURCE_PARAMS[k]}`);

/* Peptide ids to names. A blend's name is its components joined with " + ". */
const PEPTIDES = {
  2: 'NAD+', 3: 'GHK-Cu', 4: 'Ipamorelin', 10: 'BPC-157', 11: 'Tesamorelin', 12: 'Diluent Vial',
  20: 'BPC-157 + GHK-Cu', 21: 'Tesamorelin + Ipamorelin', 22: 'BPC-157 + Tesamorelin',
  23: 'NAD+ + Tesamorelin', 24: 'BPC-157 + Ipamorelin', 25: 'Tesamorelin + BPC-157',
};
const SOLO_IDS = [2, 3, 4, 10, 11, 12];
const idOfName = name => {
  const hit = Object.entries(PEPTIDES).find(([, n]) => n === name);
  if (!hit) throw new Error(`no peptide id for "${name}"`);
  return Number(hit[0]);
};

/* The lab's own lines (calc.js DEFAULTS) in plan 2's snapshot shape, every band open. */
const rule = (id, peptide_id, target, blend, priority, diluent, note) => ({
  id, peptide_id, min_mg: null, max_mg: null, target_conc_ug_ml: target, blend_target_conc_ug_ml: blend,
  lead_component_id: null, lead_priority: priority, floor_ug_ml: null, diluent, default_instrument_id: null,
  status: 'validated', note, sort_order: id, active: true,
});
const RULES = [
  rule(1, 2, 150, null, null, null, 'NAD+ target 150'),
  rule(2, 3, 125, 350, 2, 'Water + 0.1% TFA', 'GHK-Cu 125 alone, 350 in a blend, on TFA, leads after Ipamorelin'),
  rule(3, 4, 150, 175, 1, null, 'Ipamorelin 150 alone, 175 in a blend, leads first'),
];

/* What the fixture's rules give, as plan 2's functions do. Every band is open (asserted), so
   match_rule is "this peptide's line". The Python test runs the real functions over the same
   rules, so a slip here fails there too. */
for (const r of RULES) if (r.min_mg !== null || r.max_mg !== null || !r.active) throw new Error(`rule ${r.id} must be open and active`);
const lineOf = id => RULES.find(r => r.peptide_id === id) || null;
function ruleTarget(id, inBlend) {
  const line = lineOf(id);
  if (line && inBlend && line.blend_target_conc_ug_ml !== null) return { value: line.blend_target_conc_ug_ml, source: 'blend_rule', rule_id: line.id };
  if (line && line.target_conc_ug_ml !== null) return { value: line.target_conc_ug_ml, source: 'rule', rule_id: line.id };
  return { value: PARAMS.default_target_ug_ml, source: 'default', rule_id: null };
}
function ruleLead(comps, chosenId) {
  const ids = comps.map(c => c.peptide_id);
  if (chosenId != null && ids.includes(chosenId)) return { peptide_id: chosenId, why: 'chosen' };
  if (comps.length > 1) {
    const ranked = comps.map((c, i) => [lineOf(c.peptide_id), i]).filter(([l]) => l && l.lead_priority !== null)
      .sort((a, b) => a[0].lead_priority - b[0].lead_priority || a[1] - b[1]);
    if (ranked.length) return { peptide_id: ids[ranked[0][1]], why: 'preferred' };
  }
  const weighed = comps.map((c, i) => [c.declared_mg, i]).filter(([m]) => m !== null).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  if (weighed.length) return { peptide_id: ids[weighed[0][1]], why: 'heaviest' };
  return { peptide_id: ids[0], why: 'first' };
}
function ruleDiluent(rowId, compIds) {
  const line = [rowId].concat(compIds).map(lineOf).find(l => l && l.diluent !== null);
  return line ? { diluent: line.diluent, rule_id: line.id } : { diluent: 'Water', rule_id: null };
}

/* Table-level equivalence: every peptide here gets the same answer from both. */
for (const id of SOLO_IDS) {
  const name = PEPTIDES[id];
  const alone = api.targetConcFor(name), inBlend = api.blendTargetConcFor(name);
  if (alone.value !== ruleTarget(id, false).value) throw new Error(`${name}: source target ${alone.value}, rules ${ruleTarget(id, false).value}`);
  if (inBlend.value !== ruleTarget(id, true).value) throw new Error(`${name}: source blend target ${inBlend.value}, rules ${ruleTarget(id, true).value}`);
  const dil = api.sampleDiluent({ identity: name });
  if (dil.diluent !== ruleDiluent(id, [id]).diluent) throw new Error(`${name}: source diluent ${dil.diluent}, rules ${ruleDiluent(id, [id]).diluent}`);
}
{
  const fromSource = D.preferredLeads.map(n => SOLO_IDS.find(id => api.lookupByPeptide({ [n]: true }, PEPTIDES[id])));
  const fromRules = RULES.filter(r => r.lead_priority !== null).sort((a, b) => a.lead_priority - b.lead_priority).map(r => r.peptide_id);
  if (JSON.stringify(fromSource) !== JSON.stringify(fromRules)) throw new Error(`lead order: source ${fromSource}, rules ${fromRules}`);
}

/* ─── The cases, in Mk1's shape ─── */
const comp = (id, mg, vial = 1) => ({ peptide_id: id, name: PEPTIDES[id], abbreviation: PEPTIDES[id], declared_mg: mg, vial });
const solo = (id, declared, form = 'powder') => ({ declared_mg: declared, form, peptide_id: id, components: [comp(id, declared)] });
const blend = (id, comps, declared, form = 'powder') => ({ declared_mg: declared, form, peptide_id: id, components: comps });
// Weighings that make about 3 mL of stock, and a final vial weighed close to a 90 uL / 1410 uL plan.
const STOCK_3ML = { stock_vial_mg: 5012.31, stock_vial_diluent_mg: 8003.6 };
const FINAL_90 = { vial_mg: 2500.1, vial_diluent_mg: 3906.8, vial_all_mg: 3996.5 };

const CASES = [
  ['powder, nothing weighed', solo(10, 10), {}],
  ['powder, fully weighed, one step', solo(10, 10), { ...STOCK_3ML, vials: { 1: FINAL_90 } }],
  ['powder, typed target and volume', solo(10, 10), { ...STOCK_3ML, vials: { 1: { target_ug_ml: 250, target_volume_ul: 1000, vial_mg: 2480.0, vial_diluent_mg: 3404.8, vial_all_mg: 3479.6 } } }],
  ['powder, typed component target on a plain row (the vial ignores it)', solo(10, 10), { ...STOCK_3ML, components: { 10: { target: 250 } } }],
  ['powder, a peptide with a rule target (NAD+)', solo(2, 20), { ...STOCK_3ML, vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 3929.3, vial_all_mg: 3963.0 } } }],
  ['powder, declared 0', solo(10, 10), { declared_mg: 0, ...STOCK_3ML }],
  ['powder, stock weighings backwards', solo(10, 10), { stock_vial_mg: 8003.6, stock_vial_diluent_mg: 5012.31 }],
  ['powder, stock weighings equal', solo(10, 10), { stock_vial_mg: 5012.31, stock_vial_diluent_mg: 5012.31 }],
  ['powder, final vial + diluent lighter than empty', solo(10, 10), { ...STOCK_3ML, vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 2400.0, vial_all_mg: 2490.0 } } }],
  ['powder, final vial + diluent equal to empty (no diluent is legal)', solo(10, 10), { ...STOCK_3ML, vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 2500.1, vial_all_mg: 2590.0 } } }],
  ['powder, last weighing not above + diluent', solo(10, 10), { ...STOCK_3ML, vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 3906.8, vial_all_mg: 3906.8 } } }],
  ['powder, declared 500 mg, unweighed', solo(10, 500), {}],
  ['powder, declared 500 mg, intermediate and final weighed', solo(10, 500), { ...STOCK_3ML, vials: { 1: {
    int_vial_mg: 2400.0, int_vial_diluent_mg: 3836.2, int_vial_all_mg: 3881.0, vial_mg: 2500.1, vial_diluent_mg: 3933.2, vial_all_mg: 3992.8 } } }],
  ['powder, intermediate stock not above + diluent', solo(10, 500), { ...STOCK_3ML, vials: { 1: {
    int_vial_mg: 2400.0, int_vial_diluent_mg: 3836.2, int_vial_all_mg: 3836.2 } } }],
  ['powder, declared 750 mg, two_step false', solo(10, 750), { two_step: false, ...STOCK_3ML }],
  ['powder, declared 100 mg, two_step true', solo(10, 100), { two_step: true, ...STOCK_3ML }],
  ['powder, pipetted volume 20 % off plan', solo(10, 10), { ...STOCK_3ML, vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 3888.1, vial_all_mg: 3995.8 } } }],
  ['liquid, declared 3 mL', solo(10, 10, 'liquid'), { declared_volume_ml: 3, stock_vial_mg: 100.0, stock_vial_diluent_mg: 50.0, vials: { 1: FINAL_90 } }],
  ['liquid, no declared volume', solo(10, 10, 'liquid'), {}],
  ['bac, weighed full then emptied', solo(12, null, 'bac'), { stock_vial_diluent_mg: 35000.0, stock_vial_mg: 5000.0,
    vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 3913.0, vial_all_mg: 3996.2 } } }],
  ['capsule, 4 x 10 mg, weighed, neat', solo(10, 10, 'capsule'), { capsules: 4, stock_vial_mg: 20000.0, stock_vial_diluent_mg: 219420.0,
    vials: { 1: { vial_mg: 2500.1, vial_all_mg: 3995.0 } } }],
  ['capsule, no count', solo(10, 10, 'capsule'), {}],
  ['capsule, stock above 350', solo(10, 10, 'capsule'), { capsules: 4, stock_vial_mg: 20000.0, stock_vial_diluent_mg: 119710.0 }],
  ['blend of two, unsplit', blend(20, [comp(10, null), comp(3, null)], 20), { ...STOCK_3ML }],
  ['blend Tesamorelin + Ipamorelin, split', blend(21, [comp(11, 10), comp(4, 5)], 15), { ...STOCK_3ML,
    vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 3838.7, vial_all_mg: 3995.7 } } }],
  ['blend with a component under 60', blend(22, [comp(10, null), comp(11, null)], 22), { ...STOCK_3ML, components: { 10: { mg: 20 }, 11: { mg: 2 } } }],
  ['blend with a component exactly at 60', blend(22, [comp(10, 10), comp(11, 3)], 13), { ...STOCK_3ML }],
  ['blend, one component moved to vial 2', blend(23, [comp(2, 100), comp(11, 10)], 110), { ...STOCK_3ML, components: { 11: { vial: 2 } },
    vials: { 1: { vial_mg: 2500.1, vial_diluent_mg: 3988.6, vial_all_mg: 3995.4 }, 2: { vial_mg: 2490.0, vial_diluent_mg: 3902.0, vial_all_mg: 3991.0 } } }],
  ['blend, typed lead', blend(24, [comp(10, 10), comp(4, 5)], 15), { ...STOCK_3ML, vials: { 1: { lead_id: 10 } } }],
  ['blend, typed component target', blend(25, [comp(11, 10), comp(10, 5)], 15), { ...STOCK_3ML, components: { 11: { target: 250 } } }],
  ['blend, weights that do not add up', blend(22, [comp(10, 5), comp(11, 5)], 10), { ...STOCK_3ML, components: { 10: { mg: 4 } } }],
];

/* ─── Mk1 -> the tool's sample: the brief's translation table, written once ─── */
const LETTERS = api.VIAL_LETTERS;
const letterOf = n => LETTERS[n - 1];
const numberOf = letter => LETTERS.indexOf(letter) + 1;
const or = (v, d) => (v === undefined || v === null ? d : v);
// inputs.vials[n].* <-> the row's own fields (vial 1) or extraVials[letter] (vial 2 on)
function vialFields(v) {
  return {
    targetConcUgPerMl: or(v.target_ug_ml, null), targetVolumeUl: or(v.target_volume_ul, null),
    asVialMg: or(v.vial_mg, null), asVialDiluentMg: or(v.vial_diluent_mg, null), asVialAllMg: or(v.vial_all_mg, null),
    intTargetUgPerMl: or(v.int_target_ug_ml, null), intVolumeUl: or(v.int_volume_ul, null),
    intVialMg: or(v.int_vial_mg, null), intVialDiluentMg: or(v.int_vial_diluent_mg, null), intVialAllMg: or(v.int_vial_all_mg, null),
  };
}
function toSource(facts, inputs, id) {
  const comps = facts.components;
  const identity = comps.map(c => c.name).join(' + ');
  if (identity !== PEPTIDES[facts.peptide_id]) throw new Error(`${id}: identity "${identity}" is not peptide ${facts.peptide_id}`);
  const own = c => (inputs.components || {})[c.peptide_id] || {};
  const key = c => api.normalizeIdentity(c.name);
  const componentMg = {}, componentVial = {}, componentTarget = {}, vialLead = {}, extraVials = {};
  for (const c of comps) {
    // a component's weight and vial: the tech's (inputs.components) over the sample's (facts)
    const mg = or(own(c).mg, c.declared_mg);
    if (mg !== null) componentMg[key(c)] = mg;
    componentVial[key(c)] = letterOf(or(own(c).vial, or(c.vial, 1)));
    if (own(c).target != null) componentTarget[key(c)] = own(c).target;
  }
  const vials = inputs.vials || {};
  let leadPeptide = '';
  for (const [n, v] of Object.entries(vials)) {
    const lead = v.lead_id != null ? api.normalizeIdentity(PEPTIDES[v.lead_id]) : '';
    if (Number(n) === 1) leadPeptide = lead;
    else { extraVials[letterOf(Number(n))] = vialFields(v); if (lead) vialLead[letterOf(Number(n))] = lead; }
  }
  const s = {
    id, identity, form: facts.form,
    declaredMg: or(inputs.declared_mg, facts.declared_mg), declaredVolumeMl: or(inputs.declared_volume_ml, null),
    capsules: or(inputs.capsules, null), diluent: or(inputs.diluent, ''), twoStep: or(inputs.two_step, null),
    vialMg: or(inputs.stock_vial_mg, null), vialDiluentMg: or(inputs.stock_vial_diluent_mg, null),
    componentMg, componentVial, componentTarget, leadPeptide, vialLead, extraVials,
    ...vialFields(vials[1] || {}),
  };
  if (inputs.diluent_ul != null) s.diluentUl = inputs.diluent_ul;
  return api.blankSample(s);
}

/* ─── The tool's answer -> compute_row's shape ─── */
const plan = p => ({ stock_vol_ul: p.stockVolUl, diluent_vol_ul: p.diluentVolUl, stock_half_ul: p.stockHalfUl, diluent_half_ul: p.diluentHalfUl });
const actual = a => ({ actual_diluent_ul: a.actualDiluentUl, actual_stock_ul: a.actualStockUl, actual_total_ul: a.actualTotalUl,
  actual_conc_ug_ml: a.actualConcUgPerMl, dilution_factor: a.dilutionFactor, problem: a.problem });
const off = (p, a) => ({ diluent: api.volumeOff(p.diluentVolUl, a.actualDiluentUl).over, stock: api.volumeOff(p.stockVolUl, a.actualStockUl).over });

function toExpect(c, computed, facts, inputs, name) {
  const fail = msg => { throw new Error(`${name}: ${msg}`); };
  const isBlend = c.blend.blend;
  const rowRuleId = facts.peptide_id;
  const compIds = facts.components.map(x => x.peptide_id);

  // the diluent: typed, else the rules' (proven equal to the tool's)
  const dil = c.diluent;
  const rd = ruleDiluent(rowRuleId, compIds);
  if (!dil.typed && dil.diluent !== rd.diluent) fail(`diluent: source ${dil.diluent}, rules ${rd.diluent}`);

  const components = c.blend.components.map(x => {
    const id = idOfName(x.peptide);
    let target;
    if (x.target.typed) target = { value: x.target.value, source: 'typed', rule_id: null, typed: true };
    else {
      const r = ruleTarget(id, isBlend);
      const src = x.target.inBlend ? 'blend_rule' : x.target.peptide ? 'rule' : 'default';
      if (r.value !== x.target.value || r.source !== src) fail(`component ${x.peptide} target: source ${x.target.value} (${src}), rules ${r.value} (${r.source})`);
      target = { value: x.target.value, source: src, rule_id: r.rule_id, typed: false };
    }
    return { peptide_id: id, declared_mg: x.declaredMg, vial: numberOf(x.vial), lead: x.lead, target,
      stock_conc_ug_ml: x.stockConcUgPerMl, planned_final_ug_ml: x.plannedFinalUgPerMl,
      actual_final_ug_ml: x.actualFinalUgPerMl, below_floor: x.belowFloor };
  });

  const vials = c.vials.map((v, i) => {
    const n = numberOf(v.letter);
    const fields = c.blend.vials[i].fields;
    const inVial = components.filter(x => x.vial === n).map(x => ({ peptide_id: x.peptide_id, declared_mg: x.declared_mg }));
    // a plain row's only component names no reason in the tool (sampleComponents skips sampleVials); ask sampleVials itself
    const why = isBlend ? v.leadRule : api.sampleVials(Object.assign({}, c.input, { componentVial: {} }), [Object.assign({}, v.lead)])[0].leadRule;
    const lead = { peptide_id: idOfName(v.lead.peptide), why };
    const chosen = ((inputs.vials || {})[n] || {}).lead_id;
    const rl = ruleLead(inVial, chosen);
    if (rl.peptide_id !== lead.peptide_id || rl.why !== lead.why) fail(`vial ${n} lead: source ${lead.peptide_id} (${lead.why}), rules ${rl.peptide_id} (${rl.why})`);
    let source;
    if (v.target.typed) source = 'typed';
    else if (v.target.fromComponent) source = 'component';
    else {
      const r = ruleTarget(lead.peptide_id, isBlend);
      const bacFallback = c.bac && api.targetConcFor(v.lead.peptide).peptide === null;
      source = bacFallback ? 'bac' : v.target.inBlend ? 'blend_rule' : v.target.peptide ? 'rule' : 'default';
      const want = bacFallback ? { value: PARAMS.bac_target_ug_ml, source: 'bac' } : r;
      if ((bacFallback && r.source !== 'default') || want.value !== v.target.value || want.source !== source)
        fail(`vial ${n} target: source ${v.target.value} (${source}), rules ${want.value} (${want.source})`);
    }
    const I = v.intermediate;
    return {
      vial: n, component_ids: v.componentKeys.map(k => components[c.blend.components.findIndex(x => x.key === k)].peptide_id),
      lead, target: { value: v.target.value, source, typed: !!v.target.typed },
      target_volume_ul: or(api.num(fields.targetVolumeUl), D.targetVolumeUl),
      stock_conc_ug_ml: v.step1.stockConcUgPerMl, two_step: v.twoStep, neat: v.neat,
      intermediate: I ? { target_ug_ml: I.targetUgPerMl, volume_ul: I.volumeUl, target_defaulted: I.targetDefaulted,
        plan: plan(I.plan), actual: actual(I.actual), weighed: I.weighed, conc_for_final: I.concForFinal, off: off(I.plan, I.actual) } : null,
      stock_for_final: v.stockForFinal, plan: plan(v.plan), actual: actual(v.actual),
      dilution_factor_total: v.dilutionFactorTotal, off: off(v.plan, v.actual),
    };
  });

  // Warnings, in this order: the stock (declared, stock_backwards); per vial its Step 3a then Step 3
  // weighing problem; volume_off per deviation in volumeDeviations' order (per vial: step 3 stock,
  // step 3 diluent, step 3a stock, step 3a diluent); below_floor per component; capsule_no_count;
  // capsule_over_neat; split_mismatch. Each from the fields the tool's own warning reads.
  const warnings = [];
  const w = (code, vial = null, peptide_id = null) => warnings.push({ code, vial, peptide_id });
  if (c.step1.problem === 'declared') w('declared');
  if (c.step1.problem === 'diluent') w('stock_backwards');
  for (const v of c.vials) {
    if (v.twoStep && v.intermediate && v.intermediate.actual.problem) w(`step3a_${v.intermediate.actual.problem}`, numberOf(v.letter));
    if (v.actual.problem) w(`step3_${v.actual.problem}`, numberOf(v.letter));
  }
  if (warnings.length !== api.weighingWarnings(computed).length) fail('weighing warnings do not match the tool\'s count');
  const devs = api.volumeDeviations(computed);
  for (const d of devs) w('volume_off', numberOf(d.letter));
  for (const x of components) if (x.below_floor) w('below_floor', x.vial, x.peptide_id);
  const noCount = c.capsule && !(api.num(c.input.capsules) > 0);
  if (noCount !== computed.summary.capsuleNoCount.includes(c.input.id)) fail('capsule count disagrees with the summary');
  if (noCount) w('capsule_no_count');
  const overNeat = api.capsuleWarnings(computed).length;
  if (overNeat > 1) fail('more than one capsule warning');
  if (overNeat) w('capsule_over_neat');
  if (isBlend && c.blend.split === 'mismatch') w('split_mismatch');
  if ((computed.summary.belowFloor > 0) !== components.some(x => x.below_floor)) fail('below_floor disagrees with the summary');

  return {
    form: facts.form, declared_total_mg: c.declaredMg,
    diluent: { diluent: dil.diluent, rule_id: dil.typed ? null : rd.rule_id, typed: dil.typed },
    stock: { total_diluent_ml: c.step1.totalDiluentMl, problem: c.step1.problem },
    capsule_diluent_ul: c.capsuleDiluentUl,
    floor_ug_ml: D.blendFloorUgPerMl,
    components, vials, warnings,
  };
}

function assertFinite(x, where) {
  if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`${where}: ${x} is not finite`);
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) assertFinite(v, `${where}.${k}`);
}

const cases = CASES.map(([name, facts, inputs], i) => {
  const id = `CASE-${i + 1}`;
  const run = api.blankRun({ diluentDensityMgPerMl: PARAMS.diluent_density_mg_ml, samples: [toSource(facts, inputs, id)] });
  const computed = api.computeRun(run);
  const expect = toExpect(computed.samples[0], computed, facts, inputs, name);
  assertFinite(expect, name);
  assertFinite(inputs, name);
  return { name, facts, inputs, expect };
});
if (new Set(cases.map(c => c.name)).size !== cases.length) throw new Error('case names must be unique');

const fixture = {
  about: 'compute_row fixture (plan 3 HPLC prep worksheet, Task 3), generated by make_hplc_prep_cases.cjs from the lab tool\'s own calc.js at source_commit. Each case is a row in Mk1\'s shape (facts, inputs); expect is the whole compute_row result the tool computes for it, except that a warning\'s text is not pinned. rules are the tool\'s DEFAULTS tables re-keyed to the ids in peptides, proven equal by the generator; params is HPLC_RUN_PARAM_DEFAULTS. backend/tests/test_hplc_prep.py and the TypeScript mirror run every case. Regenerate, never edit by hand.',
  source_commit: SOURCE_COMMIT,
  params: PARAMS,
  rules: RULES,
  peptides: Object.fromEntries(Object.entries(PEPTIDES).map(([k, v]) => [String(k), v])),
  cases,
};
const out = path.join(__dirname, 'hplc_prep_cases.json');
fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
console.log(`wrote ${cases.length} cases to ${out}`);
