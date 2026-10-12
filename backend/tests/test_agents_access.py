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
    assert access.scopes_for(cred(False, False)) == {"documents"}
    assert access.scopes_for(cred(True, False)) == {"documents", "lab"}
    assert access.scopes_for(cred(True, True)) == {"documents", "lab", "coa"}
    assert access.scopes_for(cred(False, True)) == {"documents"}  # COA alone is never honoured


def test_allowed_is_exact_and_deny_by_default():
    from agents import access
    docs = frozenset({"documents"})
    assert access.allowed(docs, "get", "/api/documents/{doc_id}")
    assert not access.allowed(docs, "DELETE", "/api/documents/{doc_id}")
    assert not access.allowed(docs, "GET", "/api/flags")
    assert not access.allowed(docs | {"lab"}, "POST", "/wizard/senaite/samples/{sample_id}/publish-coa")
    assert access.allowed(docs | {"lab", "coa"}, "POST", "/wizard/senaite/samples/{sample_id}/publish-coa")
    assert not access.allowed(docs | {"lab", "coa"}, "GET", "/auth/users")


def test_admin_and_destructive_document_routes_are_never_listed():
    from agents import access
    for pair in [("DELETE", "/api/documents/{doc_id}"), ("PUT", "/api/documents/{doc_id}/content"),
                 ("POST", "/api/document-categories"), ("POST", "/api/document-spaces"),
                 ("PUT", "/api/document-spaces/{space_id}/grants"), ("POST", "/api/flags/types"),
                 ("PATCH", "/api/sub-samples/{sample_id}")]:
        assert pair not in access.all_routes(), pair
