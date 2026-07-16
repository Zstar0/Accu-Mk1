"""Regenerate conformance golden fixtures from the vendored engine.

Run after intentionally refreshing the vendored engine (and after the
adapter-vs-coabuilder parity check confirms the refresh matches source).

Usage: python backend/scripts/regen_conformance_goldens.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path
from conformance_vendored import ConformanceEngine  # noqa: E402

FIX = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "conformance"
CASES = [("senaite_dump_PB-0010.json", "expected_PB-0010.json", "peptide")]


def main():
    for src, dst, engine_kind in CASES:
        data = json.loads((FIX / src).read_text(encoding="utf-8"))
        if engine_kind == "peptide":
            result = ConformanceEngine().process(data)
        else:
            from conformance_vendored import GenericAssayEngine
            result = GenericAssayEngine().process(data)
        (FIX / dst).write_text(
            json.dumps(result, indent=2, sort_keys=True, default=str) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {dst}: overall_pass={result['canonical']['overall_pass']} "
              f"rows={len(result['results_table'])}")


if __name__ == "__main__":
    main()
