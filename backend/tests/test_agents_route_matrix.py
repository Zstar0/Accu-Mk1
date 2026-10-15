"""Every authenticated route refuses an agent key unless the allow-list names it (spec 2026-10-12
section 9). Sends a REAL key to each route; 403 is raised in the auth dependency, so no handler
runs. A route that rejects earlier for another reason (401/422 before auth) must be listed in
EARLY_REJECT with a reason; it is still never a success."""
import re

import pytest

from tests.agents_support import app_client, make_agent  # noqa: F401

DENIED = {"detail": "agent keys cannot use this endpoint"}
EARLY_REJECT: dict[tuple[str, str], str] = {}


def _auth_deps():
    from auth import get_current_user, require_admin
    from documents import comment_routes, routes as doc_routes
    return {get_current_user, require_admin, doc_routes.require_document_writer,
            doc_routes.require_document_admin_writer, doc_routes.require_document_admin_user,
            doc_routes._space_reader, comment_routes.require_comment_actor}


def _uses_auth(dependant, deps) -> bool:
    return dependant.call in deps or any(_uses_auth(d, deps) for d in dependant.dependencies)


def _authed_routes():
    from fastapi.routing import APIRoute
    from main import app
    deps = _auth_deps()
    for r in app.routes:
        if isinstance(r, APIRoute) and _uses_auth(r.dependant, deps):
            for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
                yield m, r.path


def _url(template: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", template)


def _call(c, method, template, headers):
    kw = {"headers": headers}
    if method in ("POST", "PUT", "PATCH"):
        kw["json"] = {}
    return c.request(method, _url(template), **kw)


@pytest.mark.parametrize("lab,coa", [(True, True), (True, False), (False, False)])
def test_every_route_outside_the_scopes_refuses(app_client, lab, coa):
    from agents import access
    from types import SimpleNamespace
    c, db = app_client
    _, h = make_agent(db, f"m{int(lab)}{int(coa)}", lab_tools=lab, coa_publishing=coa)
    scopes = access.scopes_for(SimpleNamespace(lab_tools=lab, coa_publishing=coa))
    for method, template in _authed_routes():
        if access.allowed(scopes, method, template):
            continue
        r = _call(c, method, template, h)
        if (method, template) in EARLY_REJECT:
            assert r.status_code in (401, 403, 422), (method, template, r.status_code)
        else:
            assert (r.status_code, r.json()) == (403, DENIED), (method, template, r.status_code, r.text[:200])


# Every route the walk above does not reach, because no bearer dependency guards it. Pinned so a
# new route outside the walk fails here until someone classifies it.
NOT_BEARER = frozenset({
    ("GET", "/health"),  # public liveness probe
    ("POST", "/auth/login"),  # password login; issues the bearer
    ("POST", "/api/slack/interactions"),  # Slack signing secret, checked in the handler
    ("POST", "/webhooks/clickup"),  # ClickUp X-Signature, checked in the handler
    ("GET", "/api/bench/{token}"),  # bench-station path token
    ("POST", "/api/bench/{token}/scan"),  # bench-station path token
    ("GET", "/api/capture/{token}"),  # phone capture path token
    ("POST", "/api/capture/{token}/photos"),  # phone capture path token
    ("GET", "/admin/clickup-users/unmapped"),  # X-Service-Token (require_internal_service_token)
    ("POST", "/admin/clickup-users/{clickup_user_id}/map"),  # X-Service-Token
    ("GET", "/peptide-requests"),  # X-Service-Token
    ("POST", "/peptide-requests"),  # X-Service-Token
    ("GET", "/peptide-requests/{request_id}"),  # X-Service-Token
    ("GET", "/peptide-requests/{request_id}/history"),  # X-Service-Token
    ("POST", "/peptide-requests/{request_id}/retract"),  # X-Service-Token
    ("GET", "/s2s/catalog/service-keys"),  # X-Service-Token, IS bridge
    ("POST", "/s2s/lims-samples"),  # X-Service-Token, IS bridge
    ("POST", "/s2s/lims-samples/fields"),  # X-Service-Token, IS bridge
    ("POST", "/s2s/lims-samples/shipping"),  # X-Service-Token, IS bridge
    ("POST", "/s2s/lims-samples/{sample_id}/services"),  # X-Service-Token, IS bridge
    ("POST", "/s2s/orders/upsert"),  # X-Service-Token, IS bridge
    ("GET", "/s2s/peptides"),  # X-Service-Token, IS bridge
    ("GET", "/s2s/samples/{sample_id}/attachments/{attachment_id}"),  # X-Service-Token, IS bridge
    ("GET", "/samples/{sample_id}/coa-sections"),  # X-Service-Token, COA Builder
    ("GET", "/samples/{sample_id}/variance-payload"),  # X-Service-Token, COA Builder
})


def test_every_route_outside_the_walk_is_pinned_not_bearer():
    from fastapi.routing import APIRoute
    from main import app
    every = {(m, r.path) for r in app.routes if isinstance(r, APIRoute) for m in r.methods - {"HEAD", "OPTIONS"}}
    rest = every - set(_authed_routes())
    unclassified, stale = sorted(rest - NOT_BEARER), sorted(NOT_BEARER - rest)
    assert (unclassified, stale) == ([], []), f"unclassified={unclassified} stale={stale}"
