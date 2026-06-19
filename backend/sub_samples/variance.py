"""Pure variance statistics — no DB, no I/O.

Input shape (per vial):
    {
        "sample_id": str,
        "in_variance_set": bool,
        "exclusion_reason": str | None,
        "results": {
            "<keyword>": {
                "value": float | str,
                "kind": "numeric" | "categorical",
                "spec": dict | None,
            },
            ...
        },
    }

Output shape (per keyword):
    Numeric — {kind, mean, sd, cv_pct, n, spec, pass}
    Categorical — {kind, conforms_count, total, n, spec, pass, mean=None}
"""
from __future__ import annotations

import math
from typing import Any, Optional


CONFORMS_VALUES = {"conforms", "pass", "passes", "passing", "ok"}

# Identity conformance tokens. Mirrors COABuilder conformance._identity_matches
# (the rule the COA itself applies) plus the select-form "Conforms"/"1".
_ID_PASS_TOKENS = {"conforms", "pass", "passes", "passing", "positive", "compliant", "ok", "1"}
_ID_FAIL_TOKENS = {
    "does_not_conform", "does not conform", "doesn't conform", "fail", "fails",
    "nonconforming", "non-conforming", "non conforming", "negative", "0",
}


def identity_conforms(
    value: Any,
    peptide_name: Optional[str] = None,
    result_options: Optional[list] = None,
) -> Optional[bool]:
    """Whether an identity result conforms, agreeing with the COA's own rule.

    Identity is never a literal "conforms" string for peptide-specific services —
    it's the peptide NAME (e.g. "BPC-157"), with an explicit "Does_Not_Conform"
    on failure. Select-form identity (HPLC-ID) stores the option value ("1"),
    whose label ("Conforms") is the signal. So:

      1. map a select value through *result_options* to its label;
      2. explicit fail token  -> False;
      3. explicit pass token  -> True;
      4. name-match (label starts with the declared peptide on a word boundary,
         mirroring COABuilder conformance._identity_matches) -> True;
      5. otherwise -> False.

    Returns None for a blank/missing result (not yet entered).
    """
    raw = str(value if value is not None else "").strip()
    if not raw:
        return None

    label = raw
    for opt in (result_options or []):
        if isinstance(opt, dict) and str(opt.get("value")) == raw:
            label = str(opt.get("label") or raw)
            break

    norm = label.strip().lower()
    if norm in _ID_FAIL_TOKENS:
        return False
    if norm in _ID_PASS_TOKENS:
        return True

    name = (peptide_name or "").strip()
    if name and label.startswith(name):
        suffix = label[len(name):]
        if not suffix or not suffix[0].isalnum():
            return True
    return False


def compute_variance_stats(vials: list[dict]) -> dict[str, dict[str, Any]]:
    """Compute per-keyword stats over vials with in_variance_set=True."""
    selected = [v for v in vials if v.get("in_variance_set")]
    keywords = _collect_keywords(vials)
    out: dict[str, dict[str, Any]] = {}
    for kw in keywords:
        kind = _detect_kind(vials, kw)
        if kind == "categorical":
            out[kw] = _categorical_stats(selected, kw)
        else:
            out[kw] = _numeric_stats(selected, kw)
    return out


def _collect_keywords(vials: list[dict]) -> list[str]:
    seen: list[str] = []
    for v in vials:
        for kw in (v.get("results") or {}).keys():
            if kw not in seen:
                seen.append(kw)
    return seen


def _detect_kind(vials: list[dict], kw: str) -> str:
    for v in vials:
        r = (v.get("results") or {}).get(kw)
        if r and r.get("kind"):
            return r["kind"]
    return "numeric"


def _numeric_stats(selected: list[dict], kw: str) -> dict[str, Any]:
    values: list[float] = []
    spec: Optional[dict] = None
    for v in selected:
        r = (v.get("results") or {}).get(kw)
        if not r:
            continue
        val = r.get("value")
        if val is None:
            continue
        try:
            values.append(float(val))
        except (TypeError, ValueError):
            continue
        if spec is None and r.get("spec"):
            spec = r["spec"]

    n = len(values)
    mean = sum(values) / n if n else None
    sd = _sample_stddev(values) if n >= 2 else None
    cv = (sd / mean * 100) if (sd is not None and mean) else None
    pass_ = _check_spec(mean, spec) if mean is not None else None
    return {
        "kind": "numeric",
        "mean": mean,
        "sd": sd,
        "cv_pct": cv,
        "n": n,
        "spec": spec,
        "pass": pass_,
    }


def _categorical_stats(selected: list[dict], kw: str) -> dict[str, Any]:
    total = 0
    conforms = 0
    spec: Optional[dict] = None
    for v in selected:
        r = (v.get("results") or {}).get(kw)
        if not r:
            continue
        # Prefer an explicit conformance verdict computed upstream where the
        # keyword/options/peptide context exists (identity, etc.) — the string
        # heuristic below can't tell "BPC-157" (a conforming identity) from a
        # fail, nor that sterility "1" means fail. Fall back to the heuristic
        # only when no verdict was supplied (e.g. SENAITE-sourced rows).
        verdict = r.get("conforms")
        if verdict is not None:
            total += 1
            if verdict:
                conforms += 1
        else:
            val = str(r.get("value", "")).strip().lower()
            if not val:
                continue
            total += 1
            if val in CONFORMS_VALUES:
                conforms += 1
        if spec is None and r.get("spec"):
            spec = r["spec"]
    return {
        "kind": "categorical",
        "mean": None,
        "sd": None,
        "cv_pct": None,
        "n": total,
        "conforms_count": conforms,
        "total": total,
        "spec": spec,
        "pass": (conforms == total) if total else None,
    }


def _sample_stddev(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    m = sum(values) / n
    return math.sqrt(sum((x - m) ** 2 for x in values) / (n - 1))


def _check_spec(mean: float, spec: Optional[dict]) -> Optional[bool]:
    if not spec or mean is None:
        return None
    if "min" in spec and mean < spec["min"]:
        return False
    if "max" in spec and mean > spec["max"]:
        return False
    if "target" in spec and "tolerance_pct" in spec:
        target = spec["target"]
        tol = spec["tolerance_pct"] / 100
        if not (target * (1 - tol) <= mean <= target * (1 + tol)):
            return False
    return True
