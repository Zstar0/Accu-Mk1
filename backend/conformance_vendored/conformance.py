import re
import logging
from typing import Dict, List, Any, Optional
from datetime import datetime

from .addon_parsing import parse_addon_results

logger = logging.getLogger(__name__)

class ConformanceEngine:
    """
    Accumark COA Engine — Data & Conformance Specification (v1)
    """

    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        # Default tolerances if not provided
        self.blend_total_tolerance_pct = self.config.get("blend_total_tolerance_pct", 5.0)
        self.analyte_qty_tolerance_pct = self.config.get("analyte_qty_tolerance_pct", 5.0)

    def process(
        self,
        senaite_json: Dict[str, Any],
        display_name_overrides: Optional[Dict[int, str]] = None,
    ) -> Dict[str, Any]:
        """
        Main entry point to process a Senaite JSON export.
        Returns a dictionary with structured COA data, conformance results, and usage reasoning.

        display_name_overrides: optional {slot_number: alias} map.  When provided,
        the COA renders the alias in place of the real peptide name for that slot.
        The real peptide name still drives identity-conforms matching so the
        conformance logic is unaffected.
        """
        analyses = self._index_analyses(senaite_json)

        # New Logic: Extract Specs from Custom Fields
        # This replaces both _extract_declared_peptides AND _parse_client_spec

        accumark_data = self._extract_accumark_fields(senaite_json, display_name_overrides)
        client_spec = accumark_data["client_spec"]
        declared_peptides = accumark_data["declared_peptides"]
        
        # Build Slot Map
        # slots = { p["order"]: p["name"] for p in declared_peptides if p["order"] <= 4 }
        slots = declared_peptides 
        
        # Determine Matrix Type early for usage in headers
        matrix_type_str = "Peptide"
        if len(declared_peptides) > 1:
            matrix_type_str = "Peptide Blend"

        # Override if explicitly provided in JSON (handled in meta, but we need it for rows now)
        # Using simple derivation for now as per previous logic logic at end of file 

        # 7. Measured Quantities
        measured = self._extract_measured_quantities(analyses)

        # 8/9. Comparison & Conformance
        conformances = []
        results_table = []
        overall_pass = True
        reasons = []

        # --- A. BLEND LEVEL TESTS ---
        
        # 1. Blend Identity (Composite Check)
        blend_id_status = "NOT EVALUATED"
        
        # Identity Logic moved to end of process() to prepend to results table.

        # 2. Blend Total Quantity (Always informational — no conformance check)
        blend_total_status = "MEASURED"
        blend_meas_val = measured["blend_total"]["value"]
        blend_meas_unit = measured["blend_total"]["unit"]
        blend_spec_val = None
        blend_spec_unit = None
        
        if client_spec and "blend_total" in client_spec:
            blend_spec_val = client_spec["blend_total"]["value"]
            blend_spec_unit = client_spec["blend_total"]["unit"]

        meas_str = f"{blend_meas_val} {blend_meas_unit}" if blend_meas_val is not None else "N/A"

        if len(declared_peptides) > 1:
            results_table.append({
                "analyte_name": matrix_type_str,
                "test_name": "Blend Total Quantity",
                "test_type": "QUANTITY",
                "specification": "MEASURE",
                "result": meas_str,
                "status": "MEASURED",
                "conforms": None,
                "status_color": "",
                "unit": blend_meas_unit or ""
            })

        # 3. Blend Purity (Calculated)
        # Spec: Mass-weighted average of component purities
        # Gather data from slots
        bp_components = []
        for slot in slots:
            slot_num = slot["order"]
            if slot_num > 4: continue
            
            # Get Quantity
            qty_val = 0.0
            if measured["slots"].get(slot_num):
                 qty_val = measured["slots"][slot_num].get("value", 0.0)
            
            # Get Purity
            pur_key = f"ANALYTE-{slot_num}-PUR"
            pur_val = 0.0
            pur_analysis = analyses.get(pur_key)
            if pur_analysis:
                val = self._get_numeric_result(pur_analysis)
                if val is not None: pur_val = val
            
            if qty_val and pur_val:
                bp_components.append({"qty_mg": qty_val, "purity_pct": pur_val})
        
        # Compute
        calc_blend_purity = self._calculate_blend_purity(bp_components)
        
        blend_pur_str = ""
        blend_pur_unit = "%"
        
        if calc_blend_purity is not None:
             blend_pur_str = f"{calc_blend_purity:.2f}%"
        else:
             # Fallback to SENAITE value if calculation fails (e.g. no quantities)
             
             # Fallback 1: BLEND-PUR (Explicit Blend Purity)
             blend_pur_vals = analyses.get("BLEND-PUR")
             if blend_pur_vals:
                  res = self._get_numeric_result(blend_pur_vals)
                  if res: blend_pur_str = f"{res}%"
             
             # Fallback 2: Single Peptide Purity (HPLC-PUR) if Single Peptide
             if not blend_pur_str and len(declared_peptides) == 1:
                 hplc_pur = analyses.get("HPLC-PUR")
                 if hplc_pur:
                     res = self._get_numeric_result(hplc_pur)
                     if res: blend_pur_str = f"{res}%"

        if len(declared_peptides) > 1:
            bp_status = "NOT EVALUATED"
            bp_spec = 98.0
            bp_spec_str = f"> {bp_spec}%"
            bp_color = ""
            bp_conforms = None
            
            # Extract float from string if needed, or better, use the source values.
            # Re-evaluating float source since logic above was messy with strings.
            bp_float = calc_blend_purity
            if bp_float is None and analyses.get("BLEND-PUR"):
                bp_float = self._get_numeric_result(analyses.get("BLEND-PUR"))
            
            if bp_float is not None:
                if bp_float >= bp_spec:
                    bp_status = "CONFORMS"
                    bp_conforms = True
                else:
                    # Calculate variance similar to QTY
                    d_pct = ((bp_float - bp_spec) / bp_spec) * 100
                    bp_status = f"{d_pct:+.2f}%"
                    bp_conforms = False
                    bp_color = "#444F5B"
            else:
                if not blend_pur_str:
                     bp_status = "NOT TESTED"

            results_table.append({
                "analyte_name": matrix_type_str, # User Req: Use Matrix Type
                "test_name": "Blend Purity",
                "test_type": "PURITY",
                "specification": bp_spec_str,
                "result": blend_pur_str,
                "status": bp_status,
                "conforms": bp_conforms,
                "status_color": bp_color,
                "unit": blend_pur_unit
            })

        # --- B. PER-ANALYTE TESTS (Identity, Quantity, Purity) ---
        for slot in slots:
            slot_num = slot["order"]
            if slot_num > 4: continue
            
            # We now rely on 'mapped_name' which is the raw Service Title ("BPC-157 - Identity (HPLC)")
            # And 'name', which is the parsed Peptide Name ("BPC-157")
            peptide_name = slot["name"]
            # display_name: the customer-facing rendered name.  Defaults to
            # peptide_name unless an alias override was supplied for this slot.
            display_name = slot.get("display_name") or peptide_name
            
            # B.1 Identity
            # We need to find the ID analysis.
            # New Logic: We might not have "ID_" keywords anymore if the service is named "BPC-157 - Identity"
            # We need to match analysis Keyword OR Title to the slot's peptide service
            
            # Try to find corresponding ID analysis
            id_analysis = None
            
            mapped_service = slot.get("mapped_name", "")
            
            # Find analysis that matches this service
            # Refined Logic: Match Title EXACTLY to the AnalyteXPeptide custom field string
            
            # Use raw list to ensure we don't miss analyses without keywords
            full_analysis_list = senaite_json.get("_Analyses_Detailed") or senaite_json.get("Analyses", [])
            
            for a in full_analysis_list:
                # print(f"DEBUG: Checking {a.get('Title')} vs {mapped_service}")
                t = a.get("Title") or a.get("title")
                st = a.get("ServiceTitle") or a.get("service_title")
                
                if t == mapped_service or st == mapped_service:
                    id_analysis = a
                    break
            
            # Fallback 1: ID_ keyword logic for backward compat
            if not id_analysis:
                 for k, a in analyses.items():
                      if k == f"ID_{peptide_name}" or k == f"ID_{peptide_name.replace(' ', '_')}":
                           id_analysis = a
                           break
            
            # Fallback 2: Slot-based ID keys (ANALYTE-1-ID)
            if not id_analysis:
                id_analysis = analyses.get(f"ANALYTE-{slot_num}-ID")

            
            # Logic Update: Clean Result Matching
            # We want to match the RESULT (e.g. "AOD-9604") against the CLEAN NAME (e.g. "AOD-9604")
            # But the 'mapped_service' (e.g. "AOD-9604 - Identity (HPLC)") might be what we find.
            
            id_res = id_analysis.get("Result") or "" if id_analysis else "NOT TESTED"
            
            is_match = False
            clean_res = id_res.strip() # maintain Case for now? Or lower?
            clean_name = peptide_name.strip()
            
            # 1. Check for explicit PASS/FAIL keywords
            if clean_res.lower() in ["pass", "conforms", "positive", "compliant"]:
                is_match = True
            
            # 2. Check for Name Match (Relaxed)
            # Match if Result STARTS WITH the name, followed by a non-word char or end of string.
            # This allows "B7-33 - Identity" to match "B7-33", but "DihexaNN" to fail "Dihexa"
            elif clean_res.startswith(clean_name):
                # Verify boundary: Next char must be non-alphanumeric or end of string
                suffix = clean_res[len(clean_name):]
                if not suffix or not suffix[0].isalnum():
                     is_match = True
                
            # If not tested, it fails
                
            # If not tested, it fails
            if id_analysis is None:
                is_match = False
                id_res = "Not Tested"

            # Displayed result: use the alias (display_name) when conforms;
            # matching above still keys on the real peptide_name.
            id_val = display_name if is_match else "Out of Spec"

            status_color = ""
            if not is_match:
                 # ID Failure -> "DOES NOT CONFORM" in #444F5B
                 id_status = "DOES NOT CONFORM"
                 status_color = "#444F5B"
            else:
                 id_status = "CONFORMS"

            results_table.append({
                "test_name": f"{display_name} - Identity",
                "analyte_name": display_name,
                "peptide_name": peptide_name,  # canonical — used by blend-identity lookups below
                "test_type": "IDENTITY",
                "specification": display_name,
                "result": id_val,
                "status": id_status,
                "conforms": is_match,
                "status_color": status_color,
                "unit": ""
            })

            # B.2 Quantity (Always informational — no conformance check)
            meas_qty_data = measured["slots"].get(slot_num)
            
            # Fallback for Single Peptide Quantity (PEPT-Total)
            if (not meas_qty_data or meas_qty_data.get("value") is None) and len(slots) == 1:
                 # Construct valid meas_qty_data from PEPT-Total analysis
                 pt = analyses.get("PEPT-Total")
                 if pt:
                     v_val = self._get_numeric_result(pt)
                     u_val = pt.get("Unit", "mg")
                     if v_val is not None:
                         meas_qty_data = {"value": v_val, "unit": u_val}
            
            qty_res_str = ""
            if meas_qty_data and meas_qty_data["value"]:
                qty_res_str = f"{meas_qty_data['value']} {meas_qty_data['unit']}"

            results_table.append({
                "test_name": f"{display_name} - Quantity",
                "analyte_name": display_name,
                "peptide_name": peptide_name,
                "test_type": "QUANTITY",
                "specification": "MEASURE",
                "result": qty_res_str,
                "status": "MEASURED",
                "conforms": None,
                "status_color": "",
                "unit": meas_qty_data["unit"] if meas_qty_data else "",
                "delta_pct": ""
            })

            # B.3 Purity
            # Look for ANALYTE-X-PUR
            pur_key = f"ANALYTE-{slot_num}-PUR"
            pur_analysis = analyses.get(pur_key)
            
            # Fallback for Single Peptide if missing
            if not pur_analysis and len(slots) == 1:
                 pur_analysis = analyses.get("HPLC-PUR")

            if pur_analysis:
                p_val = self._get_numeric_result(pur_analysis)
                
                # Logic: Purity must be >= 98.0%
                spec_limit = 98.0
                p_status = "NOT EVALUATED"
                p_spec_str = f"> {spec_limit}%"
                p_status_color = ""  # Default: use template color (green for CONFORMS)
                p_conforms = None
                
                if p_val is not None:
                    if p_val >= spec_limit:
                        p_status = "CONFORMS"
                        p_conforms = True
                    else:
                        # Calculate variance similar to QTY
                        # ((Actual - Spec) / Spec) * 100
                        d_pct = ((p_val - spec_limit) / spec_limit) * 100
                        p_status = f"{d_pct:+.2f}%"
                        p_status_color = "#444F5B"  # Dark slate for non-conforming
                        p_conforms = False
                else:
                     p_status = "NOT TESTED"

                results_table.append({
                    "test_name": f"{display_name} - Purity",
                    "analyte_name": display_name,
                    "peptide_name": peptide_name,
                    "test_type": "PURITY",
                    "specification": p_spec_str,
                    "result": f"{p_val}%" if p_val is not None else "",
                    "status": p_status,
                    "conforms": p_conforms,
                    "status_color": p_status_color,
                    "unit": "%"
                })

        # --- B.4 ADDON SERVICES (Endotoxin, Sterility) ---
        # Shared parser keeps peptide and BW paths in sync on Pass/Fail mappings.
        # Peptide matrices have no per-matrix endotoxin spec, so this resolves to
        # the 5.0 default; BW (handled by GenericAssayEngine) gets 0.25.
        addon_results_table = parse_addon_results(analyses, matrix_type_str)

        # --- C. FINAL BLEND IDENTITY EVALUATION ---
        
        explicit_id_analysis = analyses.get("BLEND_IDENTITY") or analyses.get("PEPT-ID")
        
        final_id_result = ""
        final_id_status = ""
        
        if explicit_id_analysis and len(declared_peptides) == 1:
            # Case 1: Single Peptide with Explicit Identity Service
            final_id_result = explicit_id_analysis.get("Result", "")
            lower_res = final_id_result.lower()
            if lower_res in ["pass", "conforms", "positive", "compliant"]:
                final_id_status = "CONFORMS" 
            elif lower_res in ["fail", "does not conform", "negative", "non-compliant"]:
                final_id_status = "DOES NOT CONFORM"
            else:
                final_id_status = final_id_result # Just show the text
        else:
            # Case 2: Blend (Force Composite) OR Single Peptide missing explicit service
            # Composite Calculation / Fallback
            # Internal lookups key on canonical peptide_name (alias-insensitive);
            # rendered strings below use display_name.
            comp_names = [p["name"] for p in declared_peptides]
            if not comp_names:
                 final_id_status = "NOT APPLICABLE"
            else:
                 all_conform = True
                 for name in comp_names:
                     found = False
                     for r in results_table:
                         # Match on canonical peptide_name (newer rows) with
                         # fallbacks to analyte_name / test_name for robustness.
                         if r.get("test_type") == "IDENTITY" and \
                            (r.get("peptide_name") == name or r.get("analyte_name") == name or r.get("test_name", "").startswith(name)):
                             found = True
                             if r.get("status") != "CONFORMS":
                                 all_conform = False
                             break
                     if not found:
                         all_conform = False

                 final_id_status = "CONFORMS" if all_conform else "DOES NOT CONFORM"

                 # Construct list of found identities — uses the rendered
                 # Result cell which is already the alias (display_name) when
                 # the slot conformed.
                 found_ids = []
                 for name in comp_names:
                     f_res = "N/A"
                     for r in results_table:
                         if r.get("test_type") == "IDENTITY" and r.get("peptide_name") == name:
                             raw = r.get("result", "")
                             # User Request: Strip " - Identity (HPLC)"
                             # Also helpful to strip general whitespace
                             f_res = raw.replace(" - Identity (HPLC)", "").strip()
                             break
                     found_ids.append(f_res)

                 final_id_result = ", ".join(found_ids)

        if final_id_status != "CONFORMS":
             if overall_pass: 
                 overall_pass = False
                 reasons.append("Blend Identity Condition not met")

        blend_id_status = final_id_status

        # Insert as FIRST row IF BLEND
        if len(declared_peptides) > 1:
            # Spec renders aliases so "what we claim" matches "what we display".
            spec_identity = ", ".join([(p.get("display_name") or p["name"]) for p in declared_peptides])
            results_table.insert(0, {
                "test_name": "Peptide ID (HPLC)",
                "analyte_name": matrix_type_str, # User Req: Use Matrix Type
                "test_type": "IDENTITY",
                "specification": spec_identity,
                "result": final_id_result,
                "status": final_id_status,
                "status_color": "#444F5B" if final_id_status == "DOES NOT CONFORM" else "",
                "unit": ""
            })

        # Determine fallback matrix type based on declared components
        fallback_matrix = "Peptide"
        if len(declared_peptides) > 1:
            fallback_matrix = "Peptide Blend"
            
        # Determine ClientLot
        # Prefer new field but fallback to BatchID
        client_lot = accumark_data.get("client_lot") or senaite_json.get("getBatchID") or senaite_json.get("BatchID") or ""

        # Date Processing
        raw_rec = senaite_json.get("DateReceived")
        formatted_rec = ""
        if raw_rec:
            try:
                # Handle ISO 8601: "2026-01-12T17:42:34+00:00"
                # Simple split/parse or datetime.fromisoformat
                # Removing TZ info for simple formatting
                # Using simple string manipulation if format is consistent or dateutil if available
                # sticking to stdlib
                if "T" in raw_rec:
                     dt = datetime.fromisoformat(raw_rec)
                     formatted_rec = dt.strftime("%m/%d/%Y")
                else:
                     formatted_rec = raw_rec # Fallback
            except Exception as e:
                logger.warning(f"Failed to parse DateReceived: {raw_rec} - {e}")
                formatted_rec = raw_rec

        # Published Date = NOW (Generation Time)
        formatted_pub = datetime.now().strftime("%m/%d/%Y")

        return {
            "meta": {
                 "sample_id": senaite_json.get("SampleID") or senaite_json.get("id"),
                 "client_sample_id": senaite_json.get("getClientSampleID") or senaite_json.get("ClientSampleID") or "",
                 "client": senaite_json.get("getClientTitle"),
                 "matrix": senaite_json.get("SampleTypeTitle") or senaite_json.get("SampleType") or fallback_matrix,
                 "date_received": formatted_rec,
                 "date_published": formatted_pub,
                 "lot_code": client_lot,
            },
            "canonical": {
                # Drives the big peptide title(s) on the COA — use aliases when set.
                "declared_components": [(p.get("display_name") or p["name"]) for p in declared_peptides],
                "declared_blend_total_qty": f"{blend_spec_val} {blend_spec_unit}" if blend_spec_val else "",
                "measured_blend_total_qty": f"{blend_meas_val} {blend_meas_unit}" if blend_meas_val else "",
                "measured_blend_total_purity": blend_pur_str,
                "blend_identity_status": blend_id_status,
                "overall_status_badge": "PASSED" if overall_pass else "FAILED",
                "overall_pass": overall_pass,
                "nonconformance_reasons": reasons,
                "results_interpretation": ""
            },
            "declared_peptides": declared_peptides,
            "client_spec": client_spec,
            "measured": measured,
            "results_table": results_table,
            "addon_results": addon_results_table
        }
    
    # --- Helpers ---
    
    def _extract_accumark_fields(
        self,
        data: Dict,
        display_name_overrides: Optional[Dict[int, str]] = None,
    ) -> Dict:
        """
        Parses strictly typed Accumark Custom Fields from Senaite JSON.
        Fields: ClientLot, DeclaredTotalQuantity, AnalyteXPeptide, AnalyteXDeclaredQuantity

        display_name_overrides ({slot: alias}) sets an alias as the rendered
        "display_name" on each declared_peptide.  When no override is supplied
        for a slot, display_name falls back to the real peptide name.  The
        real "name" is untouched and continues to drive identity matching.
        """
        # Normalize override keys to int since JSON bodies may send string keys
        norm_overrides: Dict[int, str] = {}
        if display_name_overrides:
            for k, v in display_name_overrides.items():
                try:
                    slot_int = int(k)
                    if v and str(v).strip():
                        norm_overrides[slot_int] = str(v).strip()
                except (TypeError, ValueError):
                    logger.warning(f"Ignoring invalid display_name_override key: {k!r}")
        
        # 1. Spec Spec
        spec = {"analytes": []}
        
        # Blend Total
        # Usually stored as string "10.50". We assume mg unless units field added later?
        # User spec says "DeclaredTotalQuantity"
        dtq = data.get("DeclaredTotalQuantity")
        if dtq:
            try:
                # Remove surrounding whitespace
                dtq_clean = str(dtq).strip() if dtq is not None else ""
                if dtq_clean:
                    val = float(dtq_clean)
                    spec["blend_total"] = {"value": val, "unit": "mg"}
            except ValueError:
                logger.warning(f"Invalid DeclaredTotalQuantity: {dtq}")

        # 2. Analytes / Declared Peptides
        declared_peptides = []
        
        # Loop slots 1-4
        for i in range(1, 4 + 1):
            pep_field = f"Analyte{i}Peptide"
            qty_field = f"Analyte{i}DeclaredQuantity"
            
            raw_pep = data.get(pep_field, "")
            raw_qty = data.get(qty_field, "")
            
            if not raw_pep: continue
            
            # Parse Name from "BPC-157 - Identity (HPLC)"
            # Parse Name from "BPC-157 - Identity (HPLC)"
            name = raw_pep
            if " - Identity" in raw_pep:
                 name = raw_pep.split(" - Identity")[0].strip()
            
            # Create Declared Peptide Entry
            # display_name defaults to real name; overridden per-slot when an
            # alias was selected in Accu-Mk1 sample-details.
            declared_peptides.append({
                "order": i,
                "keyword": f"accumark_analyte_{i}", # Dummy keyword, we use slot logic now
                "name": name,
                "display_name": norm_overrides.get(i, name),
                "mapped_name": raw_pep, # Full service title for matching
                "sort": i
            })
            
            # Add Spec
            if raw_qty:
                try:
                    q_clean = str(raw_qty).strip()
                    if q_clean:
                        q_val = float(q_clean)
                        spec["analytes"].append({
                            "slot": i,
                            "name": name,
                            "value": q_val,
                            "unit": "mg" # Default to mg per spec
                        })
                except ValueError:
                    logger.warning(f"Invalid Qty for Slot {i}: {raw_qty}")
        
        return {
            "client_spec": spec,
            "declared_peptides": declared_peptides,
            "client_lot": data.get("ClientLot", "")
        }

    _SKIP_STATES = {"retracted", "rejected", "cancelled"}

    def _index_analyses(self, senaite_json: Dict) -> Dict[str, Dict]:
        """Spec 3.1: Index analyses by keyword.

        When duplicate keywords exist (e.g., retests), keeps the most recent
        based on ResultCaptureDate.  Skips retracted/rejected/cancelled analyses.
        """
        analyses = {}
        source_list = senaite_json.get("_Analyses_Detailed") or senaite_json.get("Analyses", [])

        for a in source_list:
            state = a.get("review_state", "")
            if state in self._SKIP_STATES:
                continue
            kw = a.get("Keyword") or a.get("getKeyword")
            if kw:
                # Check if we already have this keyword (retest scenario)
                if kw in analyses:
                    existing = analyses[kw]
                    existing_date = existing.get("ResultCaptureDate") or existing.get("getResultCaptureDate") or ""
                    new_date = a.get("ResultCaptureDate") or a.get("getResultCaptureDate") or ""

                    # Keep the more recent result
                    if new_date > existing_date:
                        logger.debug(f"Retest detected for {kw}: replacing {existing_date} with {new_date}")
                        analyses[kw] = a
                else:
                    analyses[kw] = a
        return analyses

    def _get_numeric_result(self, a: Dict) -> Optional[float]:
        """Spec 3.2: Numeric helper"""
        if not a: return None
        r = a.get("Result")
        try:
            return float(r) if r not in (None, "") else None
        except ValueError:
            return None

    def _calculate_blend_purity(self, analytes: List[Dict[str, float]]) -> Optional[float]:
        """
        Calculate mass-weighted average of component purities.
        """
        total_mass = 0.0
        weighted_sum = 0.0

        for a in analytes:
            qty = a.get("qty_mg")
            purity = a.get("purity_pct")

            if qty is None or purity is None:
                continue
            if qty <= 0:
                continue
            
            if purity <= 1.0 and purity > 0:
                purity = purity * 100

            total_mass += qty
            weighted_sum += qty * purity

        if total_mass == 0:
            return None

        return weighted_sum / total_mass

    def _parse_val_unit(self, text: str):
        """Helper to split '10 mg' -> (10.0, 'mg')"""
        m = re.match(r'([\d\.]+)\s*(.*)', text)
        if m:
            try:
                val = float(m.group(1))
                unit = m.group(2).replace("\\r", "").replace("\r", "").strip()
                return val, unit
            except:
                pass
        return None, None

    def _extract_measured_quantities(self, analyses: Dict) -> Dict:
        """Spec 7: Measured Quantities"""
        # Blend Total
        blend = analyses.get("PEPT-Total")
        out = {
            "blend_total": {
                "value": self._get_numeric_result(blend),
                "unit": blend.get("Unit") if blend else None
            },
            "slots": {}
        }
        
        for s in [1,2,3,4]:
            key = f"ANALYTE-{s}-QTY"
            a = analyses.get(key)
            out["slots"][s] = {
                "value": self._get_numeric_result(a),
                "unit": a.get("Unit") if a else None
            }
        return out

    def _within_tolerance(self, declared: float, measured: float, tol_pct: float) -> bool:
        """Spec 8: Tolerance"""
        if declared is None or measured is None:
            return False
        if declared == 0:
            return measured == 0
        diff = abs(measured - declared)
        pct_diff = (diff / declared) * 100.0
        return pct_diff <= tol_pct

    def _units_compatible(self, u1: str, u2: str) -> bool:
        """
        Check if units are compatible for comparison.
        Refined logic: "mg" and "mg/mL" are compatible for liquids/blends.
        """
        if not u1 or not u2: return False
        n1 = u1.lower().replace(" ", "")
        n2 = u2.lower().replace(" ", "")
        
        if n1 == n2: return True
        
        compat_sets = [
            {"mg", "mg/ml", "mg/l"},
            {"ug", "ug/ml", "ug/l"},
        ]
        
        for s in compat_sets:
            if n1 in s and n2 in s:
                return True
                
        return False
