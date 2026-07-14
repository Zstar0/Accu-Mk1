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

# (scope, from_slug, to_slug, verb, requirements, description)
SEED_TRANSITIONS = [
    ("sample", "sample_registered", "sample_due", "to_due", [], "Order dispatched toward the lab."),
    ("sample", "sample_due", "sample_received", "receive", [], "Lab check-in."),
    ("sample", "sample_received", "to_be_verified", "submit", [], "All analyses submitted."),
    ("sample", "to_be_verified", "verified", "verify",
     [{"kind": "all_analyses_in_state", "value": "verified", "note": None}],
     "Lab verification of all results."),
    ("sample", "verified", "published", "publish",
     [{"kind": "all_analyses_in_state", "value": "verified", "note": "COA generated and published via Mk1"}],
     "COA publish."),
    ("sample", "sample_received", "dispatched", "dispatch", [], "Physical dispatch."),
    ("sample", "sample_due", "cancelled", "cancel", [], "Cancel before receipt."),
    ("sample", "sample_received", "cancelled", "cancel", [], "Cancel after receipt."),
    ("sample", "published", "invalid", "invalidate", [], "Invalidate a published sample (spawns retest)."),
    ("analysis", "registered", "unassigned", "init", [], "Line enters the workflow."),
    ("analysis", "unassigned", "assigned", "assign", [], "Worksheet assignment."),
    ("analysis", "unassigned", "to_be_verified", "submit", [], "Result entry + submit."),
    ("analysis", "assigned", "to_be_verified", "submit", [], "Result entry + submit."),
    ("analysis", "to_be_verified", "verified", "verify", [], "Result verification."),
    ("analysis", "to_be_verified", "variance_verified", "variance_verify", [], "Variance-flow verification."),
    ("analysis", "to_be_verified", "rejected", "reject", [], "Reject a submitted result."),
    ("analysis", "unassigned", "rejected", "reject", [], "Reject an unstarted line."),
    ("analysis", "to_be_verified", "retracted", "retract", [],
     "Retire-and-replace: original retracted, SENAITE spawns an unassigned copy with the result carried."),
    ("analysis", "verified", "retracted", "retract", [],
     "Retire-and-replace from verified."),
    ("analysis", "verified", "verified", "retest", [],
     "Spawns a new unassigned retest line (retest_of link); the original stays verified, flagged retested."),
    ("analysis", "verified", "published", "publish", [], "Rides the sample COA publish."),
    ("analysis", "verified", "promoted", "promote", [], "Sub-sample tier: promote result to parent."),
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
    for scope, f, t, verb, reqs, desc in SEED_TRANSITIONS:
        frm, to = by_key[(scope, f)], by_key[(scope, t)]
        exists = (db.query(LimsWorkflowTransition)
                  .filter_by(entity_scope=scope, from_state_id=frm.id, verb=verb)
                  .one_or_none())
        if exists is None:
            db.add(LimsWorkflowTransition(
                entity_scope=scope, from_state_id=frm.id, to_state_id=to.id,
                verb=verb, requirements=reqs, description=desc, is_builtin=True))
            db.flush()
            created_t += 1
    return {"states_created": created_s, "transitions_created": created_t}
