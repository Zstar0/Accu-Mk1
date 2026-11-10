"""Add-on test Variance: the four test keys, the run labels and the one
resolver that turns `services["variance"]` into replicate runs and vials
per vial role.

Every consumer (vial demand, the lab override, the seeder's anchor rule,
the lock, the certificate rows) asks `resolve_variance_plan`; none
re-derives the role or the vial count. The role and the counts come from
the catalog (`AnalysisProfile.key`), snapshot first, never from a table
here.

HPLC and the legacy keys (`endotoxin`, `sterility_pcr`) are skipped: they
stay on today's path (`derive_variance_demand`). Fail closed: an entry Mk1
cannot fulfil is an error sentence, never dropped silently. The resolver
never raises for a bad entry.

Module top imports only stdlib, sqlalchemy and models on purpose:
`coa.a_la_carte` imports `coa.native_sections`, which will import this
module, so the a la carte helpers are imported inside the functions.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from models import AnalysisProfile, LimsAnalysis, LimsSubSample, VialRole

VARIANCE_TEST_KEYS: frozenset[str] = frozenset({
    "endotoxin-usp85-lal", "rapid-sterility-pcr", "sterility-usp71", "heavy_metals"})
VARIANCE_N_MIN: int = 2
VARIANCE_N_MAX: int = 10            # Handler confirms (design open question 4)
RUN_LABEL_VIAL: str = "Vial"        # Handler confirms copy (C12)
RUN_LABEL_DIGEST: str = "Digest"    # Handler confirms copy (C12)
LEGACY_BUCKETS: frozenset[str] = frozenset({"hplc", "endo", "ster"})
# Row states that are no longer a result: the anchors here and the
# certificate builder's replicate rows (coa.native_sections) share it.
DEAD_ROW_STATES: tuple[str, ...] = ("rejected", "retracted")


@dataclass(frozen=True)
class RoleVariance:
    key: str                 # one of VARIANCE_TEST_KEYS
    role: str                # the profile's fulfillment_role
    n: int                   # total runs bought
    vials_per_run: int       # vials_required
    analytical_per_run: int  # analytical_vials, or vials_required when NULL

    @property
    def replicate_runs(self) -> int:
        return self.n - 1

    @property
    def replicate_vials(self) -> int:
        return (self.n - 1) * self.vials_per_run

    @property
    def pooled(self) -> bool:
        return self.analytical_per_run < self.vials_per_run

    @property
    def run_label(self) -> str:
        return RUN_LABEL_DIGEST if self.pooled else RUN_LABEL_VIAL


@dataclass(frozen=True)
class VariancePlan:
    by_role: dict[str, RoleVariance]   # fulfillable entries only
    errors: tuple[str, ...]            # one sentence per refused entry, in key order
    notes: tuple[str, ...]             # entries deliberately not demanded (retest)

    def for_key(self, key: str) -> RoleVariance | None:
        return next((rv for rv in self.by_role.values() if rv.key == key), None)

    def error_for(self, key: str) -> str | None:
        """The first error naming that key."""
        prefix = f"Variance for {key}: "
        return next((e for e in self.errors if e.startswith(prefix)), None)


def is_retest_sample(parent) -> bool:
    """Same rule as the a la carte decision (R8: reused, not copied)."""
    from coa.a_la_carte import _is_retest
    return _is_retest(parent)


def is_bac_water_sample(parent) -> bool:
    """The sample's matrix is Bacteriostatic Water (the a la carte c6 rule)."""
    from coa.a_la_carte import BW_MATRIX
    from coa.spec_rules import normalize_matrix
    return normalize_matrix(parent.sample_type_title) == BW_MATRIX


def _profile_facts(db, key: str, snapshot: dict | None):
    """(fulfillment_role, vials_required, analytical_vials) or an error tail.

    Snapshot first, like the seeder: the registration-frozen entry wins. A
    snapshot only freezes role-dim profiles, so an entry implies role dim.
    An old entry without `analytical_vials` reads that one field live.
    """
    entry = next((e for e in ((snapshot or {}).get("profiles") or [])
                  if isinstance(e, dict) and e.get("key") == key), None)
    live = None
    if entry is None or "analytical_vials" not in entry:
        # An inactive live profile still resolves: paid order.
        live = db.execute(select(AnalysisProfile).where(AnalysisProfile.key == key)
                          ).scalars().one_or_none()
    if entry is None:
        if live is None:
            return None, "the test is not in the catalog"
        if live.fulfillment_dim != "role":
            return None, "the test is not fulfilled by a vial role"
        role, vials, analytical = live.fulfillment_role, live.vials_required, live.analytical_vials
    else:
        role, vials = entry.get("fulfillment_role"), entry.get("vials_required")
        analytical = (entry.get("analytical_vials") if "analytical_vials" in entry
                      else (live.analytical_vials if live is not None else None))
    if not role:
        return None, "the test has no vial role"
    if not isinstance(vials, int) or vials < 1:
        return None, "the test ships no vials of its own"
    return (role, vials, vials if analytical is None else analytical), None


def resolve_variance_plan(db, services: dict | None, *, snapshot: dict | None = None,
                          is_retest: bool = False, native_born: bool,
                          bac_water: bool) -> VariancePlan:
    """Map the RAW `services["variance"]` (not the normalized entitlement,
    so a bad n is reported, not dropped) to runs and vials per role.

    `native_born` and `bac_water` are required, no default (R2, R6): a
    caller that forgot either must not fail open. Callers pass
    `is_native_born(parent)` and `is_bac_water_sample(parent)`.
    """
    services = services if isinstance(services, dict) else {}
    raw = services.get("variance")
    if not isinstance(raw, dict):
        return VariancePlan({}, (), ())

    errors: list[tuple[str, str]] = []
    notes: list[str] = []
    found: list[RoleVariance] = []
    for key in sorted(raw, key=str):
        if key not in VARIANCE_TEST_KEYS:
            continue  # rule 1: HPLC and legacy keys stay on today's path
        n = raw[key]

        def refuse(why: str) -> None:
            errors.append((key, f"Variance for {key}: {why}"))

        if is_retest:
            notes.append(f"Variance for {key} is not carried to a retest in this version")
            continue
        if not native_born:
            refuse("only a Mk1-native sample can run it in this version")
            continue
        if bac_water:
            refuse("it is not offered on a Bacteriostatic Water sample")
            continue
        if (not isinstance(n, int) or isinstance(n, bool)
                or not VARIANCE_N_MIN <= n <= VARIANCE_N_MAX):
            refuse(f"the number of runs must be a whole number from "
                   f"{VARIANCE_N_MIN} to {VARIANCE_N_MAX}, got {n!r}")
            continue
        if not services.get(key):
            refuse("the test is not on this sample")
            continue
        facts, why = _profile_facts(db, key, snapshot)
        if facts is None:
            refuse(why)
            continue
        role, vials, analytical = facts
        if role in LEGACY_BUCKETS:
            refuse(f"its vial role {role} is a legacy bucket")
            continue
        vr = db.execute(select(VialRole).where(VialRole.code == role)).scalars().one_or_none()
        if vr is None:
            refuse(f"its vial role {role} does not exist")
            continue
        if not vr.variance_eligible:
            refuse(f"its vial role {role} is not variance-eligible")
            continue
        if analytical != 1:
            refuse(f"Mk1 supports one analytical vial per run, the catalog says {analytical}")
            continue
        found.append(RoleVariance(key, role, n, vials, analytical))

    by_role: dict[str, RoleVariance] = {}
    clashing = {rv.role for rv in found if sum(o.role == rv.role for o in found) > 1}
    for rv in found:
        if rv.role in clashing:
            others = ", ".join(o.key for o in found if o.role == rv.role and o is not rv)
            errors.append((rv.key, f"Variance for {rv.key}: its vial role {rv.role} "
                                   f"is shared with {others}"))
        else:
            by_role[rv.role] = rv
    errors.sort(key=lambda e: e[0])
    return VariancePlan(by_role, tuple(msg for _, msg in errors), tuple(notes))


def variance_test_roles(db, parent=None) -> frozenset[str]:
    """Vial roles of the four tests, from the live catalog, plus (with
    `parent`) the roles frozen in that sample's catalog snapshot, so a role
    renamed or cleared after registration still fences the sample's
    existing vials. The HPLC variance builders skip these roles so a micro
    replicate never switches on the HPLC series. A legacy bucket is never
    fenced (the resolver refuses it anyway), so HPLC and Bac Water stay
    exactly as today."""
    roles = set(db.execute(select(AnalysisProfile.fulfillment_role).where(
        AnalysisProfile.key.in_(VARIANCE_TEST_KEYS),
        AnalysisProfile.fulfillment_role.isnot(None))).scalars())
    snapshot = getattr(parent, "catalog_snapshot", None)
    entries = (snapshot.get("profiles") if isinstance(snapshot, dict) else None) or []
    roles.update(e.get("fulfillment_role") for e in entries
                 if isinstance(e, dict) and e.get("key") in VARIANCE_TEST_KEYS)
    return frozenset(r for r in roles if isinstance(r, str) and r and r not in LEGACY_BUCKETS)


def _live_row_exists():
    return (select(LimsAnalysis.id)
            .where(LimsAnalysis.lims_sub_sample_pk == LimsSubSample.id,
                   LimsAnalysis.retested.is_(False),
                   LimsAnalysis.review_state.notin_(DEAD_ROW_STATES))
            .exists())


def replicate_anchor_vials(db, parent_pk: int, role: str) -> list:
    """In-set variance vials of `role` that carry at least one live row,
    by vial_sequence. Material vials (no rows) are never anchors."""
    live = _live_row_exists()
    return list(db.execute(
        select(LimsSubSample)
        .where(LimsSubSample.parent_sample_pk == parent_pk,
               LimsSubSample.assignment_role == role,
               LimsSubSample.assignment_kind == "variance",
               LimsSubSample.in_variance_set.is_(True),
               live)
        .order_by(LimsSubSample.vial_sequence)
    ).scalars())


def _has_core_anchor(db, parent_pk: int, role: str) -> bool:
    """A vial of `role` whose kind is not variance (core or NULL) carries a
    live row. Set membership is not asked: a core vial past sequence 1 is
    outside the variance set by design and still anchors the core run."""
    return db.execute(
        select(LimsSubSample.id)
        .where(LimsSubSample.parent_sample_pk == parent_pk,
               LimsSubSample.assignment_role == role,
               (LimsSubSample.assignment_kind.is_(None)
                | (LimsSubSample.assignment_kind != "variance")),
               _live_row_exists())
        .limit(1)
    ).first() is not None


def variance_run_problems(db, parent, plan: VariancePlan | None) -> list[str]:
    """Every purchased run of the four tests that has no anchor, one
    sentence each (empty: complete). The lock refuses on a non-empty list;
    the certificate builder (Task 14) reuses the same sentences.

    Anchors are counted per kind: the in-set variance anchors of a role
    must equal its replicate runs, and the role must have a core anchor,
    so a kind flip inside one role can never pass as a complete set."""
    if plan is None:
        return []
    problems: list[str] = []
    for rv in plan.by_role.values():
        k = len(replicate_anchor_vials(db, parent.id, rv.role))
        if k != rv.replicate_runs:
            problems.append(f"variance series incomplete: {rv.key} bought {rv.n} runs, "
                            f"{k} replicate runs carry results")
        if not _has_core_anchor(db, parent.id, rv.role):
            word = "digest" if rv.pooled else "run"
            problems.append(f"variance series incomplete: {rv.key} is missing the core "
                            f"{word}: no core vial of role {rv.role} carries results")
    return problems


def four_test_replicate_parent(db, sample_id: str):
    """The parent LimsSample when it has a variance vial whose role is a
    four-test role (`variance_test_roles(db, parent)`), else None. The
    publish guard's scope test: a sample with no variance vial costs exactly
    one SELECT here and nothing else. Out-of-set vials count on purpose:
    taking the only replicate out of the set must still reach the count
    check, or the draft's stale run row would ship."""
    from models import LimsSample
    rows = db.execute(
        select(LimsSubSample.assignment_role, LimsSample)
        .join(LimsSample, LimsSample.id == LimsSubSample.parent_sample_pk)
        .where(LimsSample.sample_id == sample_id,
               LimsSubSample.assignment_kind == "variance")
    ).all()
    if not rows:
        return None
    parent = rows[0][1]
    fenced = variance_test_roles(db, parent)
    return parent if any(role in fenced for role, _ in rows) else None
