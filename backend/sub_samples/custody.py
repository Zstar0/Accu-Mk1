"""Vial<->profile custody edges (spec 4, ISO 17025 backbone). Append-only:
supersede + insert, never rewrite. No commits here — callers own the
transaction (sub_samples.service.set_assignment_role).

Binding decision (task-5, overrides the naive "supersede unconditionally,
then decide" ordering a first read of the plan's pseudocode suggests): when
wp_services is unavailable for a REAL (non-xtra) role, existing custody
rows are left completely alone — no supersede, no write. Superseding first
and then discovering there's nothing to replace it with would silently
erase custody on a transient Integration Service outage, which is worse
than a stale-but-correct record. role None/'xtra' has no fulfillment to
preserve, so it supersedes unconditionally regardless of wp_services.
"""
import logging
from datetime import datetime

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


def write_custody_edges(db, sub, role, wp_services, user_id) -> int:
    """Supersede this vial's current custody rows and, for a real role with
    a resolvable services dict, write fresh host/rider edges resolved from
    the catalog (sub_samples.catalog_demand.resolve_catalog_fulfillment).

    - role is None or 'xtra': supersede every current row, write nothing,
      return 0 — an unassigned/xtra vial has no custody to record.
    - role is real (not None/'xtra') but wp_services is falsy: do NOT
      supersede, do NOT write anything — skip entirely, log
      'custody_edge_skipped', return 0. Leaves whatever custody already
      existed in place (fail-soft, matching the seeding hook's own
      behavior when services can't be resolved).
    - role is real and wp_services is truthy: supersede current rows, then
      resolve fulfillment for `role` and write one row per host profile id
      (relation='host') and one per rider profile id (relation='rider'),
      all stamped assigned_at=now, assigned_by_id=user_id. Returns the
      number of rows written (0 if the role isn't in the resolved
      fulfillment map, e.g. no purchased service anchors it).
    """
    now = datetime.utcnow()

    if not role or role == "xtra":
        _supersede_current(db, sub.id, now)
        return 0

    if not wp_services:
        log.warning("custody_edge_skipped sub=%s role=%s reason=no_services", sub.sample_id, role)
        return 0

    _supersede_current(db, sub.id, now)

    fulfillment = resolve_catalog_fulfillment(db, wp_services).get(role)
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
