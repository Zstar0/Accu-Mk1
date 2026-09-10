"""Idempotent workflow-catalog seeds (spec §5.5). Handler curates via the
settings page afterward — seed descriptions are deliberately minimal."""
from sqlalchemy.orm import Session
from models import LimsWorkflowState, LimsWorkflowTransition

# (scope, slug, label, category, sort_order, description)
SEED_STATES = [
    ("sample", "sample_registered", "Registered", "active", 10, "Order created; not yet due at the lab."),
    ("sample", "sample_due", "Due", "active", 20, "Expected at the lab; not yet received."),
    ("sample", "sample_received", "Received", "active", 30, "Checked in at the lab."),
    ("sample", "ready_for_initial_review", "Ready for Initial Review", "active", 40, "Custom Accumark state."),
    ("sample", "waiting_for_addon_results", "Waiting for Add-on Results", "active", 50, "Custom Accumark state."),
    ("sample", "to_be_verified", "To Be Verified", "active", 60, "All results submitted; awaiting review."),
    ("sample", "verified", "Verified", "active", 70, "Results verified by the lab."),
    ("sample", "published", "Published", "terminal", 80, "COA published to the customer."),
    ("sample", "dispatched", "Dispatched", "terminal", 90, "Physically dispatched/stored out."),
    ("sample", "cancelled", "Cancelled", "exception", 100, "Cancelled before completion."),
    ("sample", "invalid", "Invalid", "exception", 110, "Invalidated after publish (retest issued)."),
    ("analysis", "registered", "Registered", "active", 5, "Line created, workflow not started."),
    ("analysis", "unassigned", "Unassigned", "active", 10, "Awaiting worksheet assignment."),
    ("analysis", "assigned", "Assigned", "active", 20, "On a worksheet."),
    ("analysis", "to_be_verified", "To Be Verified", "active", 30, "Result submitted."),
    ("analysis", "verified", "Verified", "active", 40, "Result verified."),
    ("analysis", "published", "Published", "terminal", 50, "On a published COA."),
    ("analysis", "promoted", "Promoted", "terminal", 55, "Sub-sample result promoted to parent."),
    ("analysis", "variance_verified", "Variance Verified", "active", 45, "Verified within the variance flow."),
    ("analysis", "rejected", "Rejected", "exception", 60, "Rejected by the lab."),
    ("analysis", "retracted", "Retracted", "exception", 70, "Retired; SENAITE spawns a replacement copy."),
    ("analysis", "cancelled", "Cancelled", "exception", 80, "Cancelled with its sample."),
    ("analysis", "senaite_mirror", "SENAITE Mirror (sentinel)", "exception", 999,
     "Internal sentinel — shadow mirror rows; never a real workflow position."),
]

# (scope, from_slug, to_slug, verb, auto_fire, requirements, description)
SEED_TRANSITIONS = [
    ("sample", "sample_registered", "sample_due", "to_due", False, [], "Order dispatched toward the lab."),
    ("sample", "sample_due", "sample_received", "receive", False, [], "Lab check-in."),
    ("sample", "sample_received", "to_be_verified", "submit", True,
     [{"kind": "all_analyses_in_state", "value": "to_be_verified,verified,published", "note": None}],
     "All analyses submitted."),
    # verify gates on verified-OR-published for the same reason the publish
    # edges below do (2026-09-09, the `no_edge:publish` residual class): a
    # legacy family's line that SENAITE already PUBLISHED surfaces in
    # `native_parent_line_states` as 'published' (Mk1 holds only a
    # senaite_mirror shadow row for it), so a strict 'verified' list refused
    # verify on 12 fully-finished samples, which then refused publish with
    # no_edge and stranded at to_be_verified. Verify was the only edge the
    # 2026-08-23 widening missed.
    ("sample", "to_be_verified", "verified", "verify", True,
     [{"kind": "all_analyses_in_state", "value": "verified,published",
       "note": None}],
     "Lab verification of all results."),
    # publish gates on verified-OR-published (not verified alone): the A6
    # publish hook flips shadow-mirrored analyses to 'published' before the
    # sample-publish evaluation runs, so shadow-only keywords legitimately
    # read 'published' at evaluation time — prod burn-in 2026-08-23 caught 7
    # real publishes refused on exactly this ordering (mk1_refused bucket).
    ("sample", "verified", "published", "publish", False,
     [{"kind": "all_analyses_in_state", "value": "verified,published", "note": "COA generated and published via Mk1"},
      {"kind": "coa_published", "value": None, "note": "attested by the publish touchpoint"}],
     "COA publish."),
    # waiting_for_addon_results was seeded as a state with NO out-edges, so
    # every real publish from it logged no_edge and stranded native_status
    # (7 samples in the 2026-08-23 burn-in census). Publishing once add-on
    # results complete is a legal lab flow; same gates as verified→published.
    ("sample", "waiting_for_addon_results", "published", "publish", False,
     [{"kind": "all_analyses_in_state", "value": "verified,published", "note": "COA publish once add-on results complete"},
      {"kind": "coa_published", "value": None, "note": "attested by the publish touchpoint"}],
     "COA publish once add-on results complete."),
    ("sample", "sample_received", "dispatched", "dispatch", False, [], "Physical dispatch."),
    ("sample", "sample_due", "cancelled", "cancel", False, [], "Cancel before receipt."),
    ("sample", "sample_received", "cancelled", "cancel", False, [], "Cancel after receipt."),
    ("sample", "published", "invalid", "invalidate", False, [], "Invalidate a published sample (spawns retest)."),
    ("analysis", "registered", "unassigned", "init", False, [], "Line enters the workflow."),
    ("analysis", "unassigned", "assigned", "assign", False, [], "Worksheet assignment."),
    ("analysis", "unassigned", "to_be_verified", "submit", False, [], "Result entry + submit."),
    ("analysis", "assigned", "to_be_verified", "submit", False, [], "Result entry + submit."),
    ("analysis", "to_be_verified", "verified", "verify", False, [], "Result verification."),
    ("analysis", "to_be_verified", "variance_verified", "variance_verify", False, [], "Variance-flow verification."),
    ("analysis", "to_be_verified", "rejected", "reject", False, [], "Reject a submitted result."),
    ("analysis", "unassigned", "rejected", "reject", False, [], "Reject an unstarted line."),
    ("analysis", "to_be_verified", "retracted", "retract", False, [],
     "Retire-and-replace: original retracted, SENAITE spawns an unassigned copy with the result carried."),
    ("analysis", "verified", "retracted", "retract", False, [],
     "Retire-and-replace from verified."),
    ("analysis", "verified", "verified", "retest", False, [],
     "Spawns a new unassigned retest line (retest_of link); the original stays verified, flagged retested."),
    ("analysis", "verified", "published", "publish", False, [], "Rides the sample COA publish."),
    ("analysis", "verified", "promoted", "promote", False, [], "Sub-sample tier: promote result to parent."),
]

# Native cancel (2026-09-09 spec §3.3): a customer can cancel at ANY point, so
# every sample state except `cancelled` gets an edge. Data, not code — the
# Settings -> Workflow pane owns these afterwards (seed is insert-if-missing).
_CANCEL_FROM = [slug for (scope, slug, *_r) in SEED_STATES if scope == "sample" and slug != "cancelled"]
SEED_TRANSITIONS += [
    ("sample", frm, "cancelled", "cancel", False, [],
     "Customer-requested cancellation; allowed at any point.")
    for frm in _CANCEL_FROM
    if frm not in ("sample_due", "sample_received")   # the two original edges stay as written
]
# Partial-publish pathway (spec §3.3): a primary COA published while add-on
# lines are still pending. Keyed by the `publish` verb because the engine's
# `coa_published` requirement is satisfied ONLY by the publish touchpoint's
# attestation (engine._eval_one: `met = bool((attested or {}).get("coa_published"))`)
# and _find_edge looks up (from_state, verb) — so the touchpoint's own verb
# must be the edge's verb. Not auto_fire (cascades never attest).
_SUBMIT_REQS = next((reqs for (scope, f, t, verb, _af, reqs, _d) in SEED_TRANSITIONS
                     if scope == "sample" and f == "sample_received" and verb == "submit"), None)
if _SUBMIT_REQS is None:  # fail loudly at import, not with a bare StopIteration
    raise RuntimeError("workflow.seeds: the seeded sample_received -> to_be_verified "
                       "'submit' edge is missing; the partial-publish pathway copies its requirements")
_SUBMIT_REQS = [dict(r) for r in _SUBMIT_REQS]   # own copy — never alias another edge's list
_COA_PUBLISHED_REQ = [{"kind": "coa_published", "value": None,
                       "note": "attested by the publish touchpoint"}]
SEED_TRANSITIONS += [
    ("sample", "sample_received", "waiting_for_addon_results", "publish", False,
     _COA_PUBLISHED_REQ, "Primary COA out while add-on lines are still pending (partial publish)."),
    ("sample", "waiting_for_addon_results", "to_be_verified", "submit", True, _SUBMIT_REQS,
     "Add-on results submitted; back onto the verify path."),
]


def seed_workflow_catalog(db: Session) -> dict:
    created_s = created_t = 0
    by_key: dict[tuple, LimsWorkflowState] = {}
    for scope, slug, label, category, sort_order, desc in SEED_STATES:
        row = (db.query(LimsWorkflowState)
               .filter_by(entity_scope=scope, slug=slug).one_or_none())
        if row is None:
            row = LimsWorkflowState(
                entity_scope=scope, slug=slug, label=label, category=category,
                sort_order=sort_order, description=desc, is_builtin=True,
                is_active=(slug != "senaite_mirror"))
            db.add(row)
            db.flush()
            created_s += 1
        by_key[(scope, slug)] = row
    for scope, f, t, verb, auto_fire, reqs, desc in SEED_TRANSITIONS:
        frm, to = by_key[(scope, f)], by_key[(scope, t)]
        exists = (db.query(LimsWorkflowTransition)
                  .filter_by(entity_scope=scope, from_state_id=frm.id, verb=verb)
                  .one_or_none())
        if exists is None:
            db.add(LimsWorkflowTransition(
                entity_scope=scope, from_state_id=frm.id, to_state_id=to.id,
                verb=verb, auto_fire=auto_fire, requirements=reqs, description=desc, is_builtin=True))
            db.flush()
            created_t += 1
    return {"states_created": created_s, "transitions_created": created_t}
