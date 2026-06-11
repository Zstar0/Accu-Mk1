"""
Tech-friendly summary of why a COA is blocked on unresolved sources.

Two jobs, both pure (no DB / no I/O — caller gathers the inputs):

  1. Micro-group analytes (ENDO-LAL / STER-PCR / KF) NEVER block COA
     generation. The lab finishes micro after the analytical COA goes out,
     then re-generates and re-publishes — so a missing micro result is
     expected, not an error.

  2. Each remaining blocked analyte is rendered with a REAL display name
     (not the raw keyword) plus a plain-English reason explaining what the
     tech actually needs to do.

See: docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
"""

from __future__ import annotations

import re
from typing import Callable, Dict, List, Set

from coa.schemas import ResolverResult

# Generic per-analyte keyword on a blend parent (ANALYTE-{slot}-PUR/QTY).
# Mirrors lims_analyses/seeder.py:_PARENT_ANALYTE — kept in sync by hand.
_ANALYTE_GENERIC = re.compile(r"^ANALYTE-([1-4])-(PUR|QTY)$")

_CATEGORY_LABEL = {"PUR": "Purity", "QTY": "Quantity"}

# SENAITE states for an analysis that is no longer part of the offering. An
# analyte whose candidates are ALL in one of these was rejected/invalidated
# on the parent — it must not gate the COA (mirrors the reject cascade). An
# analyte with NO candidates is "expected but not started" and still gates.
_DEAD_CANDIDATE_STATES = frozenset({"rejected", "retracted", "cancelled", "invalid"})

# Plain-English explanation per blocking reason — written for a bench tech,
# pointing at the concrete next action.
_REASON_TEXT: Dict[str, str] = {
    "missing": (
        "No verified result yet. Enter the result on a vial and promote it, "
        "then re-generate."
    ),
    "needs_decision": (
        "More than one vial has a result. Pick which one to report in the "
        "COA Sources panel."
    ),
    "stale_pin": (
        "The chosen vial no longer has a valid result. Re-pick the source in "
        "the COA Sources panel."
    ),
}
_REASON_FALLBACK = "Source not resolved. Check the COA Sources panel."


def build_name_resolver(
    *,
    catalog_titles: Dict[str, str],
    slot_names: Dict[int, str],
    aliases: Dict[int, str],
) -> Callable[[str], str]:
    """Return a `keyword -> display name` function.

    Resolution order for a generic ANALYTE-{slot}-{cat} keyword:
      1. per-sample alias for that slot (the customer-facing name a tech picked)
      2. the parent's analyte-slot peptide name (e.g. "GHK-Cu")
      3. the Mk1 catalog title for the keyword (generic "Analyte N Purity")
      4. a readable generic ("Analyte N (Purity)") — never the raw keyword

    Non-analyte keywords resolve to the catalog title, falling back to the
    raw keyword only when the catalog has nothing.
    """
    def name_for(keyword: str) -> str:
        m = _ANALYTE_GENERIC.match(keyword)
        if m:
            slot = int(m.group(1))
            cat = _CATEGORY_LABEL.get(m.group(2), m.group(2))
            base = aliases.get(slot) or slot_names.get(slot)
            if base:
                return f"{base} ({cat})"
            return catalog_titles.get(keyword) or f"Analyte {slot} ({cat})"
        return catalog_titles.get(keyword) or keyword

    return name_for


def _is_dead_analyte(d) -> bool:
    """True iff the analyte has candidates and EVERY one is terminally
    inactive (rejected/retracted/cancelled/invalid) — the analyte was taken
    off the offering, so it must not gate the COA. Zero candidates means
    'expected but not started' and still gates; any non-dead candidate (a
    pending or re-added sibling) keeps it gating too."""
    return bool(d.candidates) and all(
        c.state in _DEAD_CANDIDATE_STATES for c in d.candidates
    )


def _blocking_decisions(result: ResolverResult, micro_keywords: Set[str]):
    """Decisions that should actually hold up COA generation: blocked, not a
    micro-group analyte, and not a dead (rejected/invalidated) analyte."""
    return [
        d for d in result.decisions
        if d.blocked is not None
        and d.analyte_keyword not in micro_keywords
        and not _is_dead_analyte(d)
    ]


def has_blocking_unresolved(
    result: ResolverResult, *, micro_keywords: Set[str]
) -> bool:
    """True iff at least one NON-micro analyte is unresolved."""
    return bool(_blocking_decisions(result, micro_keywords))


def summarize_unresolved(
    result: ResolverResult,
    *,
    micro_keywords: Set[str],
    name_for: Callable[[str], str],
) -> List[dict]:
    """One friendly entry per blocking (non-micro) decision."""
    out: List[dict] = []
    for d in _blocking_decisions(result, micro_keywords):
        out.append({
            "analyte_keyword": d.analyte_keyword,
            "analyte_name": name_for(d.analyte_keyword),
            "blocked": d.blocked,
            "reason": _REASON_TEXT.get(d.blocked or "", _REASON_FALLBACK),
            "detail": d.blocked_detail,
            "candidates_count": len(d.candidates),
        })
    return out
