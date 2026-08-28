"""Shadow-backed SenaiteAnalysesReader (COA read-independence, spec §5).

Serves the resolver's Protocol from list_parent_analyses_senaite_shape —
zero SENAITE HTTP. Canonical-backed keywords never reach a reader
(_resolve_mk1_parent_tier shadows them), so this covers only the
SENAITE-only fall-through keywords, sourced from mirror shadow rows.
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
