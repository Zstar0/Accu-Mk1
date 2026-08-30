"""Shadow-backed SenaiteAnalysesReader (COA read-independence, spec §5).

Serves the resolver's Protocol from list_parent_analyses_senaite_shape —
zero SENAITE HTTP. The payload this reader returns is UNFILTERED: it
includes both provenances (canonical + shadow) exactly as
list_parent_analyses_senaite_shape produces them, canonical-backed
keywords included. What actually decides those keywords is resolve_sources'
merge step — for any keyword with an mk1 parent-tier verified row,
_resolve_mk1_parent_tier already has a decision and the merge never
consults this reader's candidates for that keyword (see resolve_sources:
`if kw in mk1_decisions: base = mk1_decisions[kw]`). So in practice this
reader's candidates only end up DECIDING the SENAITE-only fall-through
keywords (sourced from mirror shadow rows) — the rows themselves are not
filtered here, only out-voted downstream.
retest_of_uid is synthesized as mk1:{retest_of_id} so the resolver's
superseded_uids logic works in the mk1 uid space; reportable comes from the
native column. review_state=None aborts (producer bug) — the resolver
pre-flight's existing fail-open catch handles it upstream.
"""
from typing import Dict, List


def _shaped_rows(db, sample_id):
    from lims_analyses.service import list_parent_analyses_senaite_shape
    return list_parent_analyses_senaite_shape(db, sample_id)


class ShadowAnalysesReader:
    def __init__(self, db):
        self._db = db

    async def list_for_sample(self, sample_id: str) -> List[Dict]:
        out: List[Dict] = []
        for r in _shaped_rows(self._db, sample_id):
            if r.review_state is None:
                raise ValueError(
                    f"shadow reader: {r.uid} on {sample_id} has "
                    f"review_state=None — refusing (producer bug)")
            retest_of = getattr(r, "retest_of_id", None)
            out.append({
                "uid": r.uid,
                "keyword": r.keyword,
                "result": r.result,
                "unit": r.unit,
                "review_state": r.review_state,
                "retest_of_uid": f"mk1:{retest_of}" if retest_of else None,
                "reportable": getattr(r, "reportable", True),
            })
        return out
