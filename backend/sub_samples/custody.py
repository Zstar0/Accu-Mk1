"""Vial<->profile custody edges (spec 4, ISO 17025 backbone). Append-only:
supersede + insert, never rewrite. No commits here — callers own the
transaction (sub_samples.service.set_assignment_role).

Binding decision (task-5, controller re-ruling — supersedes the earlier
"full skip when services are unavailable" instruction): a role change
ALWAYS supersedes every current custody row first, unconditionally — the
flip itself is a local fact that needs no services to be true. The earlier
"leave existing edges alone when wp_services is falsy" rule was proven
incoherent: in the very same transaction, `_drop_stale_role_rows` still
deletes the OLD role's analyses and the seeder runs with empty services, so
"preserved" edges would be actively FALSE (naming profiles whose work was
just removed), not stale-but-correct. So: supersede always; THEN, only if
wp_services is truthy, resolve fulfillment and write fresh host/rider
edges. If wp_services is falsy, nothing new is written and the vial
honestly shows zero current custody until the next assignment that does
have services. role None/'xtra' supersedes and writes nothing, same as
before.
"""
import logging
from datetime import datetime
from typing import Optional

from models import VialProfileAssignment
from sub_samples.catalog_demand import resolve_catalog_fulfillment

log = logging.getLogger(__name__)


def _supersede_current(db, sub_pk: int, now: datetime) -> None:
    current = (
        db.query(VialProfileAssignment)
        .filter_by(lims_sub_sample_pk=sub_pk, superseded_at=None)
        .all()
    )
    for row in current:
        row.superseded_at = now


def write_custody_edges(db, sub, role, wp_services, user_id, snapshot: Optional[dict] = None) -> int:
    """Supersede this vial's current custody rows, unconditionally, then —
    for a real role with a resolvable services dict — write fresh
    host/rider edges resolved from the catalog
    (sub_samples.catalog_demand.resolve_catalog_fulfillment).

    - role is None or 'xtra': supersede every current row, write nothing,
      return 0 — an unassigned/xtra vial has no custody to record.
    - role is real (not None/'xtra') but wp_services is falsy: supersede
      every current row (the flip happened; the old custody is no longer
      true), write nothing new, log 'custody_edge_skipped', return 0. The
      vial then has zero current custody until a later assignment resolves
      real services — honest, not stale-but-wrong. This gate fires the
      SAME way regardless of `snapshot` — a frozen resolution still needs a
      truthy wp_services to reach it, deliberately unchanged from before
      task 6 rather than newly reading purely off the snapshot.
    - role is real and wp_services is truthy: supersede current rows, then
      resolve fulfillment for `role` and write one row per host profile id
      (relation='host') and one per rider profile id (relation='rider'),
      all stamped assigned_at=now, assigned_by_id=user_id. Returns the
      number of rows written (0 if the role isn't in the resolved
      fulfillment map, e.g. no purchased service anchors it).

    snapshot (S4 rider, task 6): the sub-sample's PARENT catalog_snapshot
    (LimsSample.catalog_snapshot), threaded straight through to
    resolve_catalog_fulfillment. Non-NULL freezes which profiles resolve as
    host/rider to what was true at registration; NULL (the default) is the
    live path, unchanged.
    """
    now = datetime.utcnow()
    _supersede_current(db, sub.id, now)

    if not role or role == "xtra":
        return 0

    if not wp_services:
        log.warning("custody_edge_skipped sub=%s role=%s reason=no_services", sub.sample_id, role)
        return 0

    fulfillment = resolve_catalog_fulfillment(db, wp_services, snapshot=snapshot).get(role)
    if fulfillment is None:
        return 0

    written = 0
    for pid in fulfillment.host_profile_ids:
        db.add(VialProfileAssignment(
            lims_sub_sample_pk=sub.id, analysis_profile_id=pid,
            relation="host", assigned_at=now, assigned_by_id=user_id,
        ))
        written += 1
    for pid in fulfillment.rider_profile_ids:
        db.add(VialProfileAssignment(
            lims_sub_sample_pk=sub.id, analysis_profile_id=pid,
            relation="rider", assigned_at=now, assigned_by_id=user_id,
        ))
        written += 1
    return written


def current_custody(db, sub_pk: int) -> list:
    """Rows currently custodial for a sub-sample (superseded_at IS NULL)."""
    return (
        db.query(VialProfileAssignment)
        .filter_by(lims_sub_sample_pk=sub_pk, superseded_at=None)
        .all()
    )
