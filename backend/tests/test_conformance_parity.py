import json
from pathlib import Path

FIX = Path(__file__).parent / "fixtures" / "conformance"


def _load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def test_vendored_engine_imports_and_runs():
    from conformance_vendored import ConformanceEngine
    data = _load("senaite_dump_PB-0010.json")
    result = ConformanceEngine().process(data)
    assert set(result) >= {
        "meta", "canonical", "declared_peptides",
        "client_spec", "measured", "results_table", "addon_results",
    }
    assert isinstance(result["canonical"]["overall_pass"], bool)


def test_vendored_engine_matches_golden():
    from conformance_vendored import ConformanceEngine
    data = _load("senaite_dump_PB-0010.json")
    expected = _load("expected_PB-0010.json")
    result = json.loads(json.dumps(ConformanceEngine().process(data), default=str))
    assert result == expected, (
        "Vendored engine output drifted from the golden. If you intentionally "
        "refreshed the vendored engine, re-run scripts/regen_conformance_goldens.py "
        "AND re-run the adapter-vs-coabuilder parity check."
    )
