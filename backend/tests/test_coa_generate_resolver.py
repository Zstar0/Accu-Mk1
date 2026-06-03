"""End-to-end happy-path test for COA generation with resolver pre-flight.

Marker: integration. Skipped by default; run with `-m integration`.

Phase 1 ships this as an xfail stub. The real wiring requires mocking both
COABuilder (httpx POST to {COA_BUILDER_URL}/process/{sample_id}) and the
SENAITE Analysis endpoint that SenaiteAnalysesHttpReader hits. The existing
test_e2e_peptide_request.py harness has a COABuilder mock surface that
should be adaptable here once Phase 2/3 UI work touches the same code path.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.xfail(
    reason=(
        "Phase 1 happy-path integration test stub. Fill in once the "
        "COABuilder + SENAITE Analysis mocks are wired. Tracked in "
        "docs/superpowers/plans/2026-06-02-coa-rollup-phase1.md Task 9."
    ),
    strict=False,
)
def test_single_vial_happy_path_writes_manifest():
    """
    Given a parent with one HPLC vial and a verified Identity result,
    generate-coa should:
      - call the resolver (auto-resolves to the parent AR)
      - call COABuilder (stubbed)
      - write one CoaGenerationSource row with resolution_mode='auto'
    """
    # Implementation deferred — see module docstring.
    assert False, "stub"
