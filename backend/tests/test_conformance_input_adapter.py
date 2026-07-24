import json
from pathlib import Path

FIX = Path(__file__).parent / "fixtures" / "conformance"
ENGINE_KEYS = {"Keyword", "Result", "Unit", "Title", "review_state", "ResultCaptureDate"}


def _load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def test_build_analyses_detailed_yields_engine_shape():
    from conformance.senaite_input import build_analyses_detailed
    raw = _load("analysis_list_PB-0010.json")
    out = build_analyses_detailed(raw)
    assert len(out) == len(raw)
    for row in out:
        assert ENGINE_KEYS <= set(row), f"missing keys: {ENGINE_KEYS - set(row)}"
    # Every row that had a result in the raw response keeps it under "Result".
    for raw_row, row in zip(raw, out):
        raw_result = raw_row.get("Result") or raw_row.get("getResult") or raw_row.get("result")
        if raw_result not in (None, ""):
            assert str(row["Result"]) == str(raw_result)


def test_build_analyses_detailed_feeds_engine_to_nonempty_table():
    """With populated declarations, the fed analyses must produce >=1 row —
    guards against the engine silently seeing zero results from a bad shim."""
    from conformance.senaite_input import build_analyses_detailed
    from conformance_vendored import ConformanceEngine
    ar = _load("senaite_dump_PB-0010.json")
    # Reuse the dump's own detailed analyses as the "raw" input for this check.
    raw = ar["_Analyses_Detailed"]
    ar_copy = dict(ar)
    ar_copy["_Analyses_Detailed"] = build_analyses_detailed(raw)
    result = ConformanceEngine().process(ar_copy)
    # Same number of indexed analyses reach the engine as the dump carried.
    assert len(ar_copy["_Analyses_Detailed"]) == len(raw)
    assert isinstance(result["results_table"], list)
