"""Which routes an agent key may call (spec 2026-10-12 section 3.4). The ONLY place that answers
it. Deny by default: a route not listed here refuses every agent, including routes added later.
Templates are FastAPI route templates exactly as `app.routes` holds them (tests pin each one)."""
from __future__ import annotations

_G, _P, _PATCH, _D = "GET", "POST", "PATCH", "DELETE"

DOCUMENTS = frozenset({
    (_G, "/api/document-categories"), (_G, "/api/document-spaces"),
    (_G, "/api/documents"), (_G, "/api/documents/{doc_id}"), (_G, "/api/documents/{doc_id}/content"),
    (_P, "/api/documents"), (_PATCH, "/api/documents/{doc_id}"),
    (_P, "/api/documents/{doc_id}/activate"), (_P, "/api/documents/{doc_id}/retire"),
    (_G, "/api/documents/comment-labels"), (_G, "/api/documents/comments"),
    (_G, "/api/documents/comments/{comment_id}"), (_PATCH, "/api/documents/comments/{comment_id}"),
    (_D, "/api/documents/comments/{comment_id}"),
    (_P, "/api/documents/comments/{comment_id}/resolve"), (_P, "/api/documents/comments/{comment_id}/reopen"),
    (_G, "/api/documents/{doc_id}/comments"), (_P, "/api/documents/{doc_id}/comments"),
    (_G, "/api/documents/{doc_id}/comments/export"),
    (_P, "/api/documents/{doc_id}/comment-attachments"),
    (_G, "/api/documents/comment-attachments/{attachment_id}"),
})

# Exactly what labmanager-mcp's lab tools READ (tools/reads.py, media.py, flags.py, flagging.py,
# reports.py and the read half of coa.py). Every agent gets these: read-only Mk1 data is fine for
# agents (Handler 2026-10-12); the switches below gate writes only.
READS = frozenset({
    (_G, "/senaite/samples"), (_G, "/wizard/senaite/lookup"),
    (_G, "/api/lims-analyses"), (_G, "/api/lims-analyses/promotions"),
    (_G, "/api/lims-analyses/parent/{sample_id}/native-analyses"), (_G, "/api/conformance/{sample_id}"),
    (_G, "/api/sub-samples"), (_G, "/api/sub-samples/{sample_id}/chromatograms"),
    (_G, "/api/sub-samples/{parent_sample_id}/variance-set"),
    (_G, "/api/sub-samples/{sample_id}/attachments"),
    (_G, "/api/sub-samples/{sample_id}/attachments/{attachment_id}"),
    (_G, "/api/sub-samples/{sample_id}/photo"),
    (_G, "/hplc/analyses/{analysis_id}"), (_G, "/hplc/analyses/by-sample-prep/{sample_prep_id}"),
    (_G, "/explorer/orders/{order_id}"), (_G, "/explorer/customers/{customer_id}"),
    (_G, "/api/flags"), (_G, "/api/flags/types"),
    (_G, "/explorer/coa-generations"),
    (_G, "/reports/dashboard"), (_G, "/reports/throughput"), (_G, "/reports/turnaround"),
    (_G, "/reports/sla-performance"), (_G, "/reports/checkin-times"), (_G, "/reports/analyte-trends"),
    (_G, "/reports/purity-trend/{analyte_name}"), (_G, "/reports/ready-to-publish"),
    (_G, "/reports/ready-to-publish/summary"), (_G, "/reports/sync-status"),
    (_G, "/reports/customers/summary"), (_G, "/reports/customers/list"), (_G, "/reports/customers/orders"),
    (_G, "/reports/customers/cohorts"), (_G, "/reports/customers/at-risk"),
    (_G, "/reports/customers/churn-signals"), (_G, "/reports/customers/changes"),
    (_G, "/reports/customers/{customer_key}"),
})

# Switch "Lab tools": the lab writes the MCP makes, raising and commenting on flags.
LAB = frozenset({
    (_P, "/api/flags"), (_P, "/api/flags/{flag_id}/comments"),
})

# Changes what customers receive: its own switch, honoured only with Lab tools.
COA = frozenset({
    (_P, "/wizard/senaite/samples/{sample_id}/generate-coa"),
    (_P, "/wizard/senaite/samples/{sample_id}/generate-vial-coas"),
    (_P, "/wizard/senaite/samples/{sample_id}/publish-coa"),
})

_BY_SCOPE = {"documents": DOCUMENTS, "reads": READS, "lab": LAB, "coa": COA}


def scopes_for(cred) -> frozenset:
    scopes = {"documents", "reads"}
    if cred.lab_tools:
        scopes.add("lab")
        if cred.coa_publishing:
            scopes.add("coa")
    return frozenset(scopes)


def allowed(scopes, method: str, template: str) -> bool:
    pair = (method.upper(), template)
    return any(pair in _BY_SCOPE[s] for s in scopes)


def all_routes() -> frozenset:
    return DOCUMENTS | READS | LAB | COA
