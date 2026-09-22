"""Shadow-backed SenaiteAnalysesReader (COA read-independence, spec §5).

Serves the resolver's Protocol from list_parent_analyses_senaite_shape —
zero SENAITE HTTP. The payload this reader returns is FILTERED in one
respect: native-born HPLC rows (service_origin == 'mk1', keyword in the
HPLC trio/aggregates) are excluded by origin+keyword (M7 COA shim) —
_resolve_mk1_parent_tier already turns those rows into decisions keyed by
their per-slot wire keyword (e.g. 'ANALYTE-2-PUR'), never by the bare
stored keyword ('HPLC-PURITY') these rows carry here. Left unfiltered, a
native blend's N per-slot rows would all surface under the same bare
keyword as N candidates with no mk1_decisions entry to match (the mk1 tier
claimed a DIFFERENT key), forcing a spurious 'needs_decision' block on
every native blend COA. Every other row (both provenances — 'canonical'
senaite-origin promotions and 'shadow' mirror rows) rides through
unfiltered exactly as list_parent_analyses_senaite_shape produces it. What
decides THOSE keywords is resolve_sources' merge step — for any keyword
with an mk1 parent-tier verified row, _resolve_mk1_parent_tier already has
a decision and the merge never consults this reader's candidates for that
keyword (see resolve_sources: `if kw in mk1_decisions: base =
mk1_decisions[kw]`). So in practice this reader's (post-filter) candidates
only end up DECIDING the SENAITE-only fall-through keywords (sourced from
mirror shadow rows) — the rows themselves are not filtered here, only
out-voted downstream. This filter is a no-op wherever no native HPLC rows
exist (legacy/SENAITE-born parents): byte-identical to pre-M7 behavior.
retest_of_uid is synthesized as mk1:{retest_of_id} so the resolver's
superseded_uids logic works in the mk1 uid space; reportable comes from the
native column. review_state=None aborts (producer bug) — the resolver
pre-flight's existing fail-open catch handles it upstream.
"""
from typing import Dict, List

from coa.hplc_shim import is_native_hplc_row


def _shaped_rows(db, sample_id):
    from lims_analyses.service import list_parent_analyses_senaite_shape
    return list_parent_analyses_senaite_shape(db, sample_id)


class ShadowAnalysesReader:
    def __init__(self, db):
        self._db = db

    async def list_for_sample(self, sample_id: str) -> List[Dict]:
        out: List[Dict] = []
        for r in _shaped_rows(self._db, sample_id):
            # M7 COA shim: native HPLC rows are claimed by
            # _resolve_mk1_parent_tier under their wire keyword — never
            # surface them here under their bare stored keyword (see module
            # docstring). No-op for legacy/SENAITE-origin rows.
            if is_native_hplc_row(r):
                continue
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
