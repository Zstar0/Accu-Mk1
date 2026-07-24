"""Adapter-vs-source parity. Proves the Mk1 input adapter + vendored engine
reproduce COA Builder's verdict for the SAME sample. Run at devbox rollout:

    COABUILDER_SRC=/path/to/coabuilder \
    SENAITE_URL=... SENAITE_USER=... SENAITE_PASSWORD=... \
    PARITY_SAMPLES="PB-0010 BW-0001" \
    pytest backend/tests/test_conformance_coabuilder_parity.py -m parity -v

Skipped unless COABUILDER_SRC is set (no coabuilder checkout in Mk1 CI).
"""
import os
import sys
import pytest

pytestmark = pytest.mark.parity

COABUILDER_SRC = os.environ.get("COABUILDER_SRC")
# Space/comma-separated sample ids present in the target SENAITE, chosen to cover
# a populated peptide blend, a single peptide, and a BW/generic sample.
PARITY_SAMPLES = [s for s in os.environ.get("PARITY_SAMPLES", "").replace(",", " ").split() if s]


@pytest.mark.skipif(not COABUILDER_SRC, reason="COABUILDER_SRC not set")
@pytest.mark.skipif(not PARITY_SAMPLES, reason="PARITY_SAMPLES not set")
@pytest.mark.parametrize("sample_id", PARITY_SAMPLES)
def test_adapter_verdict_matches_coabuilder(sample_id):
    from conformance.service import run_conformance
    ours = run_conformance(sample_id)

    if COABUILDER_SRC not in sys.path:
        sys.path.insert(0, COABUILDER_SRC)
    from src.coabuilder_core.senaite_client import SenaiteClient  # noqa: E402

    theirs_input = SenaiteClient().fetch_sample_data(sample_id)
    matrix = theirs_input.get("SampleTypeTitle") or theirs_input.get("SampleType") or ""
    if matrix in {"Peptide", "Peptide Blend"} or not matrix:
        from src.coabuilder_core.conformance import ConformanceEngine as SrcEngine
        theirs = SrcEngine().process(theirs_input)
    else:
        from src.coabuilder_core.generic_assay_engine import GenericAssayEngine as SrcEngine
        theirs = SrcEngine().process(theirs_input)

    assert ours["overall_pass"] == theirs["canonical"]["overall_pass"], (
        f"{sample_id}: overall_pass mismatch")

    # Row-level verdicts: compare (test_name, status, conforms) sets.
    def _verdicts(rows):
        return sorted(
            (r.get("test_name"), r.get("status"), r.get("conforms"))
            for r in rows
        )
    assert _verdicts(ours["results_table"]) == _verdicts(theirs["results_table"]), (
        f"{sample_id}: row verdicts differ")
