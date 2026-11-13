"""The agent route allow-list (spec 2026-10-12 section 3.4)."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_every_listed_template_exists_in_the_app_with_that_method():
    from fastapi.routing import APIRoute
    from main import app
    from agents import access
    present = {(m, r.path) for r in app.routes if isinstance(r, APIRoute) for m in r.methods}
    missing = sorted(access.all_routes() - present)
    assert missing == [], f"allow-list names routes the app does not have: {missing}"


def test_scopes_follow_the_switches_and_coa_needs_lab():
    from agents import access
    cred = lambda lab, coa: SimpleNamespace(lab_tools=lab, coa_publishing=coa)  # noqa: E731
    base = {"documents", "reads"}  # every agent reads (Handler 2026-10-12)
    assert access.scopes_for(cred(False, False)) == base
    assert access.scopes_for(cred(True, False)) == base | {"lab"}
    assert access.scopes_for(cred(True, True)) == base | {"lab", "coa"}
    assert access.scopes_for(cred(False, True)) == base  # COA alone is never honoured


def test_allowed_is_exact_and_deny_by_default():
    from agents import access
    base = access.scopes_for(SimpleNamespace(lab_tools=False, coa_publishing=False))
    assert access.allowed(base, "get", "/api/documents/{doc_id}")
    assert access.allowed(base, "GET", "/api/flags")  # lab reads need no switch
    assert not access.allowed(base, "DELETE", "/api/documents/{doc_id}")
    assert not access.allowed(base, "POST", "/api/flags")  # flag writes need Lab tools
    assert access.allowed(base | {"lab"}, "POST", "/api/flags")
    assert not access.allowed(base | {"lab"}, "POST", "/wizard/senaite/samples/{sample_id}/publish-coa")
    assert access.allowed(base | {"lab", "coa"}, "POST", "/wizard/senaite/samples/{sample_id}/publish-coa")
    assert not access.allowed(base | {"lab", "coa"}, "GET", "/auth/users")


def test_switches_gate_only_writes():
    """Reads are open to every agent; each switch adds writes only."""
    from agents import access
    assert all(method == "GET" for method, _ in access.READS)
    assert all(method != "GET" for method, _ in access.LAB | access.COA)


# Every Mk1 route labmanager-mcp's lab tools call (C:/tmp/lmcp-agent-keys/src/labmanager_mcp/tools/
# reads.py, media.py, flags.py, flagging.py, reports.py, coa.py), as backend templates. MCP paths
# are already backend paths: its base ends in /api and the edge strips exactly one /api.
MCP_LAB = [
    ("GET", "/senaite/samples"), ("GET", "/wizard/senaite/lookup"),  # reads
    ("GET", "/api/sub-samples"), ("GET", "/api/lims-analyses"), ("GET", "/api/lims-analyses/promotions"),
    ("GET", "/api/lims-analyses/parent/{sample_id}/native-analyses"),
    ("GET", "/hplc/analyses/{analysis_id}"), ("GET", "/hplc/analyses/by-sample-prep/{sample_prep_id}"),
    ("GET", "/api/sub-samples/{parent_sample_id}/variance-set"),
    ("GET", "/api/sub-samples/{sample_id}/chromatograms"),
    ("GET", "/explorer/orders/{order_id}"), ("GET", "/explorer/customers/{customer_id}"),
    ("GET", "/api/conformance/{sample_id}"), ("GET", "/api/flags"),
    ("GET", "/api/sub-samples/{sample_id}/photo"), ("GET", "/api/sub-samples/{sample_id}/attachments"),  # media
    ("GET", "/api/sub-samples/{sample_id}/attachments/{attachment_id}"),
    ("POST", "/api/flags"), ("POST", "/api/flags/{flag_id}/comments"), ("GET", "/api/flags/types"),  # flags
    ("GET", "/reports/dashboard"), ("GET", "/reports/turnaround"), ("GET", "/reports/throughput"),  # reports
    ("GET", "/reports/sla-performance"), ("GET", "/reports/ready-to-publish"),
    ("GET", "/reports/ready-to-publish/summary"), ("GET", "/reports/checkin-times"),
    ("GET", "/reports/sync-status"), ("GET", "/reports/analyte-trends"),
    ("GET", "/reports/customers/summary"), ("GET", "/reports/customers/cohorts"),
    ("GET", "/reports/customers/at-risk"), ("GET", "/reports/customers/list"),
    ("GET", "/reports/customers/orders"), ("GET", "/reports/customers/churn-signals"),
    ("GET", "/reports/customers/changes"), ("GET", "/reports/purity-trend/{analyte_name}"),
    ("GET", "/reports/customers/{customer_key}"),
    ("GET", "/explorer/coa-generations"),  # coa, read half
]
MCP_COA = [
    ("POST", "/wizard/senaite/samples/{sample_id}/generate-coa"),
    ("POST", "/wizard/senaite/samples/{sample_id}/generate-vial-coas"),
    ("POST", "/wizard/senaite/samples/{sample_id}/publish-coa"),
]


def test_every_mcp_lab_route_is_in_lab():
    from agents import access
    assert sorted(set(MCP_LAB) - (access.READS | access.LAB)) == []
    assert sorted(set(MCP_COA) - access.COA) == []


def _dep_calls(dependant):
    for d in dependant.dependencies:
        yield d.call
        yield from _dep_calls(d)


def test_no_allow_listed_route_depends_on_an_admin_gate():
    """An agent never passes require_admin: a listed route behind it is a list that drifted onto
    admin surface."""
    from fastapi.routing import APIRoute
    from auth import require_admin
    from main import app
    from agents import access
    gated = {(m, r.path) for r in app.routes if isinstance(r, APIRoute)
             for m in r.methods if require_admin in set(_dep_calls(r.dependant))}
    assert ("GET", "/admin/agents") in gated  # the walk does see the gate where it is
    assert sorted(access.all_routes() & gated) == []


def test_admin_and_destructive_document_routes_are_never_listed():
    from agents import access
    for pair in [("DELETE", "/api/documents/{doc_id}"), ("PUT", "/api/documents/{doc_id}/content"),
                 ("POST", "/api/document-categories"), ("POST", "/api/document-spaces"),
                 ("PUT", "/api/document-spaces/{space_id}/grants"), ("POST", "/api/flags/types"),
                 ("PATCH", "/api/sub-samples/{sample_id}")]:
        assert pair not in access.all_routes(), pair
