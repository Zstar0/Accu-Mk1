"""Per-substance PUR_/QTY_ derivation — on-demand reconciler (Slice 6b).

Moves the four raw-SQL statements that used to live inline in
`database._run_migrations()` into a standalone, report-producing function
callable on demand via `POST /catalog/reconcile-per-substance`
(`require_admin`), in addition to running once at every boot.

Why this exists — incident P-1500: a peptide re-label left an ID_<X>
service's PUR_<X>/QTY_<X> twins stale, and because the derivation only ran
inside `_run_migrations()` at startup, the only way to re-heal it was
restarting the whole backend container. This module gives that healing
step a name, a report, and an endpoint, so it no longer requires a
restart.

The four statements below are VERBATIM copies of what `_run_migrations()`
ran — same NOT EXISTS guards, same idempotence. Two things about them are
deliberately NOT fixed here:

- The group-membership INSERT groups PUR_/QTY_ rows into a service group
  literally named 'Analytics'. Production's real HPLC bench group is
  named 'Core HPLC' (see catalog/departments.py), so on prod this
  statement is a no-op by design — it's a dying shim for dev/seed
  catalogs, not a bug.
- None of the four statements set `origin` on the rows they touch/create.
  `analysis_services.origin` defaults to `'senaite'` (models.py), so
  Mk1-derived PUR_/QTY_/ID_-link rows end up carrying `origin='senaite'`
  even though SENAITE never touched them. That's a known, deliberate
  oddity — documented, not corrected by this reconciler.

One behavioral delta from the old `_run_migrations()` site, worth knowing
rather than silently inheriting: there, each statement ran on its own raw
connection with its own commit/rollback, so one statement failing did not
skip the others. Here all four run inside the caller's Session transaction
and share one commit — a mid-run failure now rolls back everything run so
far in this call (and, because it aborts the transaction, the `missing`
query below never runs either). Low risk in practice (all four tables
already exist by the time this runs, post-`create_all`), and the boot call
already wraps this in a try/except that never blocks startup either way —
but it is a real change in failure isolation, not "equivalent behavior"
in the strictest sense.
"""
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

# Auto-link identity services (ID_<X>) to their peptide by exact name match
# so identity conformance resolves (variance overlay + COA). Idempotent —
# only fills NULLs where an exact (case/whitespace-folded) name matches.
# Must run before the PUR_/QTY_ mints below so those pick up fresh links.
_ID_LINK_SQL = """
UPDATE analysis_services svc SET peptide_id = p.id
FROM peptides p
WHERE left(svc.keyword, 3) = 'ID_' AND svc.peptide_id IS NULL
  AND svc.peptide_name IS NOT NULL AND svc.peptide_name <> ''
  AND lower(trim(p.name)) = lower(trim(svc.peptide_name))
"""

# Per-substance purity service, derived from the identity service (ID_<X>)
# so the keyword suffix + peptide_id are authoritative (the suffix is not
# derivable from the peptide name, e.g. ID_TB500BETA4). Idempotent via
# NOT EXISTS (analysis_services.keyword is not unique).
_PUR_MINT_SQL = """
INSERT INTO analysis_services (title, keyword, category, unit, peptide_id, active, created_at, updated_at)
SELECT p.name || ' - Purity', 'PUR_' || substring(idsvc.keyword from 4), 'HPLC', '%',
       idsvc.peptide_id, TRUE, NOW(), NOW()
FROM analysis_services idsvc
JOIN peptides p ON p.id = idsvc.peptide_id
WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM analysis_services x
    WHERE x.keyword = 'PUR_' || substring(idsvc.keyword from 4))
"""

# Per-substance quantity service — same shape as the purity mint above.
_QTY_MINT_SQL = """
INSERT INTO analysis_services (title, keyword, category, unit, peptide_id, active, created_at, updated_at)
SELECT p.name || ' - Quantity', 'QTY_' || substring(idsvc.keyword from 4), 'HPLC', 'mg',
       idsvc.peptide_id, TRUE, NOW(), NOW()
FROM analysis_services idsvc
JOIN peptides p ON p.id = idsvc.peptide_id
WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM analysis_services x
    WHERE x.keyword = 'QTY_' || substring(idsvc.keyword from 4))
"""

# Group all per-substance purity/quantity services into 'Analytics'
# (consistent with the ID_<X> identity services). Idempotent; a prod no-op
# by design — see module docstring.
_GROUP_MEMBERSHIP_SQL = """
INSERT INTO service_group_members (service_group_id, analysis_service_id)
SELECT g.id, s.id
FROM service_groups g
JOIN analysis_services s ON left(s.keyword, 4) IN ('PUR_', 'QTY_')
WHERE g.name = 'Analytics'
ON CONFLICT (service_group_id, analysis_service_id) DO NOTHING
"""

# Post-run check: any ID_ service with a linked peptide whose PUR_/QTY_
# twin is STILL absent after the mints above just ran. Uses the same
# keyword-match guard as the mint statements themselves (not a peptide_id
# match) so this is a direct check on "did the mint above actually work",
# not a looser drift signal.
_MISSING_SQL = """
SELECT idsvc.keyword,
       'PUR_' || substring(idsvc.keyword from 4) AS expected_pur,
       'QTY_' || substring(idsvc.keyword from 4) AS expected_qty
FROM analysis_services idsvc
WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
  AND (NOT EXISTS (SELECT 1 FROM analysis_services x
                    WHERE x.keyword = 'PUR_' || substring(idsvc.keyword from 4))
    OR NOT EXISTS (SELECT 1 FROM analysis_services x
                    WHERE x.keyword = 'QTY_' || substring(idsvc.keyword from 4)))
"""


def reconcile_per_substance_services(db: Session) -> dict:
    """Run the per-substance ID_/PUR_/QTY_ derivation and report what moved.

    Postgres-only (NOW(), substring(... from ...), left()) — matches the
    dialect the four statements always ran on. Does not commit; the caller
    owns the transaction (boot code and the admin route both commit after
    calling this, same as the rest of `init_db`'s seed/backfill steps).

    Safe to call repeatedly: every statement is idempotent, so a second
    call with nothing new to link/mint/group returns all-zero counts and
    an empty `missing` list.
    """
    id_links = db.execute(text(_ID_LINK_SQL)).rowcount or 0
    pur_minted = db.execute(text(_PUR_MINT_SQL)).rowcount or 0
    qty_minted = db.execute(text(_QTY_MINT_SQL)).rowcount or 0
    group_memberships = db.execute(text(_GROUP_MEMBERSHIP_SQL)).rowcount or 0

    missing = [
        {"id_keyword": kw, "expected_pur": pur, "expected_qty": qty}
        for kw, pur, qty in db.execute(text(_MISSING_SQL)).all()
    ]
    if missing:
        # Loud anomaly: the mint above just ran and this should be empty.
        log.error(
            "per_substance_reconcile_missing count=%s sample=%s",
            len(missing), missing[:5],
        )

    return {
        "id_links": id_links,
        "pur_minted": pur_minted,
        "qty_minted": qty_minted,
        "group_memberships": group_memberships,
        "missing": missing,
    }
