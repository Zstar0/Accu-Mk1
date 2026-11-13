"""Analyte Trends report: one record per published PRIMARY COA.

Reads `published_coa_results` (IS read model, one row per analyte per COA) joined
to `coa_generations` so that rows the read model should no longer hold -- Additional
COA copies and superseded generations (the "orphans" on #reports/sync-debug) --
can never be counted, whatever state the table is in.

The list and the drill-down both derive from these records, so they always
describe the same population (the old dashboard counted overall_status by
product_name while the drill-down plotted purity by analyte_name).

Endotoxin / sterility / heavy metals are classified from the COA JSON itself,
not the table's has_* flags: native-born certificates carry them in
`native_sections`, which the table writer never reads, and heavy metals has no
column at all.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

ANALYTE_TRENDS_SQL = """
    SELECT
        r.verification_code, r.sample_id, r.published_at, r.product_name,
        r.is_blend, r.sample_type, r.lot_code,
        r.analyte_name, r.is_blend_overall,
        r.purity_percent, r.purity_conforms, r.purity_spec, r.identity_conforms,
        r.quantity_value, r.quantity_unit, r.overall_status,
        cg.coa_data->'product'->>'declared_quantity',
        cg.coa_data->'results',
        cg.coa_data->'native_sections'
    FROM published_coa_results r
    JOIN coa_generations cg ON cg.id = r.coa_generation_id
    WHERE cg.status = 'published'
      AND cg.parent_generation_id IS NULL
      AND r.product_name IS NOT NULL
    ORDER BY r.published_at, r.verification_code, r.id
"""

# The PEPT-Total quantity row is labelled "mg/mL" but holds the per-vial mass in
# mg (Handler ruling, v1.5.6 variance unit fix: NAD+ P-1463 "832.42 mg/mL" per
# vial == "834.86 mg" on the front page). Anything else is not comparable to a
# declared mass and gets no discrepancy.
_MASS_UNITS = {"mg", "mg/ml"}

# Section titles are authored per catalog profile, so match the common names
# (USP <232> calls heavy metals "Elemental Impurities") and fall back to the
# profile key (e.g. "hm", "endotoxin", "sterility_pcr").
_ADDON_KINDS = (
    ("endotoxin", "endo"),
    ("sterility", "sterility"),
    ("heavy metal", "hm"),
    ("elemental impurit", "hm"),
)
_HM_KEY = re.compile(r"(^|[_\-\s])hm([_\-\s]|$)", re.IGNORECASE)


def _kind(name: str) -> Optional[str]:
    n = (name or "").lower()
    return next((k for needle, k in _ADDON_KINDS if needle in n), None)


def _section_kind(sec: dict) -> Optional[str]:
    key = str(sec.get("profile_key") or "")
    return (
        _kind(sec.get("title", ""))
        or _kind(key.replace("_", " "))
        or ("hm" if _HM_KEY.search(key) else None)
    )


def _and(a: Optional[bool], b: Optional[bool]) -> Optional[bool]:
    """Combine two verdicts: any False fails, None means 'not tested'."""
    if a is None:
        return b
    if b is None:
        return a
    return a and b


def _addon_ok(status: Any) -> Optional[bool]:
    """CONFORMS passes; DOES NOT CONFORM / NON-CONFORMING / FAIL* fails; anything
    else (PENDING, N/A, blank) is not a verdict yet. The IS table writer counts
    PENDING as a failure, one more reason this report reads the COA JSON."""
    s = str(status or "").strip().upper()
    if s == "CONFORMS":
        return True
    if "NOT CONFORM" in s or "NON-CONFORM" in s or s.startswith("FAIL"):
        return False
    return None


def _section_ok(rows: list) -> Optional[bool]:
    verdicts = [r.get("conforms") for r in rows if isinstance(r, dict)]
    verdicts = [v for v in verdicts if v is not None]
    if not verdicts:
        return None
    return all(bool(v) for v in verdicts)


def _json(val: Any) -> Any:
    if isinstance(val, (str, bytes)):
        try:
            return json.loads(val)
        except ValueError:
            return None
    return val


def addon_verdicts(addons: Any, native_sections: Any) -> dict[str, Optional[bool]]:
    out: dict[str, Optional[bool]] = {"endo": None, "sterility": None, "hm": None}
    for a in _json(addons) or []:
        if isinstance(a, dict) and (k := _kind(a.get("test_name", ""))):
            out[k] = _and(out[k], _addon_ok(a.get("status")))
    for sec in _json(native_sections) or []:
        if isinstance(sec, dict) and (k := _section_kind(sec)):
            out[k] = _and(out[k], _section_ok(sec.get("rows") or []))
    return out


def parse_mass_mg(text: Any) -> Optional[float]:
    """'10.0 mg' -> 10.0; anything not a plain mg mass -> None."""
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*(mg)?\s*", str(text or ""), re.IGNORECASE)
    return float(m.group(1)) if m else None


def _verdict(test: Any) -> Optional[bool]:
    """A COA test dict's verdict. Older COAs carry only `status` (no `conforms`),
    which the IS table writer stores as NULL, so fall back to the status text."""
    if not isinstance(test, dict):
        return None
    if test.get("conforms") is not None:
        return bool(test["conforms"])
    return _addon_ok(test.get("status"))


def json_verdicts(results: Any) -> dict[Optional[str], tuple[Optional[bool], Optional[bool]]]:
    """(purity_ok, identity_ok) per analyte name from coa_data.results; key None
    holds a single-peptide COA's flat purity/identity."""
    results = _json(results) or {}
    if not isinstance(results, dict):
        return {}
    out: dict[Optional[str], tuple[Optional[bool], Optional[bool]]] = {
        None: (_verdict(results.get("purity")), _verdict(results.get("identity")))
    }
    for a in results.get("analytes") or []:
        if isinstance(a, dict):
            out[a.get("name")] = (_verdict(a.get("purity")), _verdict(a.get("identity")))
    return out


def _identity(rows: list[dict]) -> Optional[bool]:
    vals = [r["identity_conforms"] for r in rows if r["identity_conforms"] is not None]
    return all(vals) if vals else None


def build_coa_records(rows: list[tuple]) -> list[dict]:
    """Collapse ANALYTE_TRENDS_SQL rows (one per analyte) into one record per COA."""
    by_code: dict[str, list[dict]] = {}
    for row in rows:
        (code, sample_id, published_at, product, is_blend, sample_type, lot,
         analyte, is_overall, purity, purity_ok, purity_spec, identity_ok,
         qty, qty_unit, overall, declared, results, native) = row
        results = _json(results) if results is not None else None
        results = results if isinstance(results, dict) else {}
        jp, ji = json_verdicts(results).get(
            analyte if results.get("analytes") else None, (None, None))
        by_code.setdefault(code, []).append({
            "sample_id": sample_id, "published_at": published_at, "product": product,
            "is_blend": bool(is_blend), "sample_type": sample_type, "lot": lot,
            "analyte": analyte, "is_overall": bool(is_overall),
            "purity": purity,
            "purity_ok": purity_ok if purity_ok is not None else jp,
            "purity_spec": purity_spec,
            "identity_conforms": identity_ok if identity_ok is not None else ji,
            "qty": qty, "qty_unit": qty_unit,
            "overall": overall, "declared": declared, "addons": results.get("addons"),
            "native": native, "is_generic": "tests" in results,
        })

    records = []
    for code, rs in by_code.items():
        first = rs[0]
        rec: dict[str, Any] = {
            "code": code,
            "sample_id": first["sample_id"],
            "published_at": first["published_at"].isoformat() if first["published_at"] else None,
            "product": first["product"],
            "is_blend": first["is_blend"],
            "matrix": first["sample_type"],
            "lot": first["lot"],
            "overall": (first["overall"] or "").upper(),
            "purity": None, "purity_ok": None, "purity_spec": None,
            "identity_ok": None, "qty": None, "qty_declared": None,
            "tests": [],
            **addon_verdicts(first["addons"], first["native"]),
        }
        if first["is_generic"]:
            # Non-peptide matrix (bac water): one row per assay. The IS writer
            # overloads purity_* for percent results and quantity_* for the rest.
            rec["tests"] = [{
                "name": r["analyte"],
                "value": r["purity"] if r["purity"] is not None else r["qty"],
                "unit": "%" if r["purity"] is not None else (r["qty_unit"] or ""),
                "ok": r["purity_ok"],
                "spec": r["purity_spec"],
            } for r in rs]
        else:
            # Product level: the blend rollup row for blends, the single row otherwise.
            main = next((r for r in rs if r["is_overall"]), None) if first["is_blend"] else rs[0]
            components = [r for r in rs if not r["is_overall"]]
            if main:
                rec["purity"] = main["purity"]
                rec["purity_ok"] = main["purity_ok"]
                rec["purity_spec"] = main["purity_spec"]
                if (main["qty_unit"] or "").strip().lower() in _MASS_UNITS:
                    rec["qty"] = main["qty"]
            rec["identity_ok"] = _identity(components or rs)
            declared = parse_mass_mg(first["declared"])
            # coabuilder falls back to the MEASURED total when no declared total
            # was entered, so declared == measured means "unknown", not "0% off".
            # ponytail: an exact true match also lands here; rare at 2 dp.
            if declared and rec["qty"] is not None and round(declared, 2) != round(rec["qty"], 2):
                rec["qty_declared"] = declared
        records.append(rec)
    return records
