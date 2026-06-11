"""Tests for the COA unresolved-source block summary.

The summary turns raw resolver decisions into a tech-friendly block payload:
  - micro-group analytes (ENDO/STER/KF) NEVER block — the lab finishes them
    after the analytical COA and re-generates, so they're excluded.
  - each remaining blocked analyte gets a real display name + a plain-English
    reason for WHAT "unresolved" means.
"""
from __future__ import annotations

from coa.block_summary import (
    build_name_resolver,
    has_blocking_unresolved,
    summarize_unresolved,
)
from coa.schemas import CandidateInfo, ResolverResult, SourceDecision


def _cand(state, value=None):
    return CandidateInfo(
        source_sample_id="PB-0077",
        source_analysis_uid="uid-x",
        value=value,
        state=state,
    )


def _decision(kw, blocked=None, detail=None, n_candidates=0, candidates=None):
    return SourceDecision(
        analyte_keyword=kw,
        mode="auto",
        chosen=None,
        candidates=candidates if candidates is not None else [],
        blocked=blocked,
        blocked_detail=detail,
    )


MICRO = {"ENDO-LAL", "STER-PCR", "KF"}


# ─── micro exclusion ─────────────────────────────────────────────────────────


def test_micro_analytes_never_block():
    result = ResolverResult(parent_sample_id="PB-0077", decisions=[
        _decision("ENDO-LAL", blocked="missing"),
        _decision("STER-PCR", blocked="missing"),
    ])
    assert has_blocking_unresolved(result, micro_keywords=MICRO) is False
    assert summarize_unresolved(result, micro_keywords=MICRO, name_for=lambda k: k) == []


def test_analytical_analytes_still_block_alongside_micro():
    result = ResolverResult(parent_sample_id="PB-0077", decisions=[
        _decision("ANALYTE-4-PUR", blocked="missing"),
        _decision("ENDO-LAL", blocked="missing"),   # excluded
        _decision("STER-PCR", blocked="missing"),    # excluded
    ])
    assert has_blocking_unresolved(result, micro_keywords=MICRO) is True
    summary = summarize_unresolved(result, micro_keywords=MICRO, name_for=lambda k: k)
    assert [s["analyte_keyword"] for s in summary] == ["ANALYTE-4-PUR"]


def test_non_blocked_decisions_are_skipped():
    result = ResolverResult(parent_sample_id="PB-0077", decisions=[
        _decision("HPLC-PUR", blocked=None),  # resolved
        _decision("ANALYTE-4-QTY", blocked="needs_decision"),
    ])
    summary = summarize_unresolved(result, micro_keywords=MICRO, name_for=lambda k: k)
    assert [s["analyte_keyword"] for s in summary] == ["ANALYTE-4-QTY"]


# ─── dead-analyte exclusion (rejected/retracted/cancelled/invalid) ───────────


def test_all_dead_candidates_never_block():
    """An analyte whose candidates are ALL rejected/retracted/cancelled was
    taken off the offering — it must not gate the COA."""
    result = ResolverResult(parent_sample_id="PB-0077", decisions=[
        _decision("ANALYTE-4-PUR", blocked="missing",
                  candidates=[_cand("rejected")]),
        _decision("ANALYTE-4-QTY", blocked="missing",
                  candidates=[_cand("rejected")]),
    ])
    assert has_blocking_unresolved(result, micro_keywords=MICRO) is False
    assert summarize_unresolved(result, micro_keywords=MICRO, name_for=lambda k: k) == []


def test_genuinely_missing_analyte_with_no_candidates_still_blocks():
    """blocked='missing' with ZERO candidates is an expected-but-not-started
    analyte — it must still gate (don't silently drop real work)."""
    result = ResolverResult(parent_sample_id="P", decisions=[
        _decision("HPLC-PUR", blocked="missing", candidates=[]),
    ])
    assert has_blocking_unresolved(result, micro_keywords=MICRO) is True


def test_pending_candidate_still_blocks():
    """An unassigned/no-value candidate is pending, not dead — still gates."""
    result = ResolverResult(parent_sample_id="P", decisions=[
        _decision("HPLC-PUR", blocked="missing", candidates=[_cand("unassigned")]),
    ])
    assert has_blocking_unresolved(result, micro_keywords=MICRO) is True


def test_mixed_dead_and_pending_still_blocks():
    """A rejected sibling alongside a pending candidate means the analyte is
    still expected (e.g. rejected-then-re-added) — still gates."""
    result = ResolverResult(parent_sample_id="P", decisions=[
        _decision("HPLC-PUR", blocked="missing",
                  candidates=[_cand("rejected"), _cand("unassigned")]),
    ])
    assert has_blocking_unresolved(result, micro_keywords=MICRO) is True


# ─── friendly reason text ────────────────────────────────────────────────────


def test_each_blocking_reason_gets_plain_english():
    result = ResolverResult(parent_sample_id="P", decisions=[
        _decision("A-MISS", blocked="missing"),
        _decision("A-PICK", blocked="needs_decision", n_candidates=2),
        _decision("A-STALE", blocked="stale_pin"),
    ])
    summary = summarize_unresolved(result, micro_keywords=MICRO, name_for=lambda k: k)
    by_kw = {s["analyte_keyword"]: s for s in summary}
    assert "no" in by_kw["A-MISS"]["reason"].lower() and "result" in by_kw["A-MISS"]["reason"].lower()
    assert "COA Sources" in by_kw["A-PICK"]["reason"]
    assert "COA Sources" in by_kw["A-STALE"]["reason"]
    # raw detail is still carried for power users
    assert "detail" in by_kw["A-MISS"]


def test_unknown_reason_falls_back_to_generic():
    result = ResolverResult(parent_sample_id="P", decisions=[_decision("A", blocked="missing")])
    # Force an unexpected reason value through the dict path.
    result.decisions[0].blocked = "weird_future_reason"  # type: ignore[assignment]
    summary = summarize_unresolved(result, micro_keywords=MICRO, name_for=lambda k: k)
    assert summary[0]["reason"]  # non-empty fallback, no KeyError


# ─── name resolver ───────────────────────────────────────────────────────────


def test_name_resolver_prefers_alias_then_slot_then_catalog():
    name_for = build_name_resolver(
        catalog_titles={"ANALYTE-1-PUR": "Analyte 1 Purity", "ID_BPC157": "BPC-157 - Identity (HPLC)"},
        slot_names={1: "GHK-Cu", 2: "BPC-157"},
        aliases={2: "Customer BPC label"},
    )
    # slot 1 has no alias → slot peptide name + category
    assert name_for("ANALYTE-1-PUR") == "GHK-Cu (Purity)"
    # slot 2 has an alias → alias wins
    assert name_for("ANALYTE-2-QTY") == "Customer BPC label (Quantity)"
    # non-analyte keyword → catalog title
    assert name_for("ID_BPC157") == "BPC-157 - Identity (HPLC)"


def test_name_resolver_generic_fallback_when_slot_unknown():
    name_for = build_name_resolver(catalog_titles={}, slot_names={}, aliases={})
    # No alias, no slot, no catalog → readable generic, not the raw keyword
    assert name_for("ANALYTE-4-PUR") == "Analyte 4 (Purity)"
    # Unknown non-analyte keyword → raw keyword as last resort
    assert name_for("MYSTERY-KW") == "MYSTERY-KW"


def test_summarize_uses_name_for():
    result = ResolverResult(parent_sample_id="P", decisions=[_decision("ANALYTE-4-PUR", blocked="missing")])
    name_for = build_name_resolver(catalog_titles={}, slot_names={4: "GHK-Cu"}, aliases={})
    summary = summarize_unresolved(result, micro_keywords=MICRO, name_for=name_for)
    assert summary[0]["analyte_name"] == "GHK-Cu (Purity)"
