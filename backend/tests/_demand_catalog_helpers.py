"""Shared seed helpers for the S9 demand-catalog suite (test_demand_verify.py
and test_demand_precheck.py both build the same legacy-key-complete catalog).
Not a test module itself — leading underscore keeps it out of pytest's
`test_*.py` discovery, and its own functions stay underscore-prefixed to
signal "test fixture data, not public API"."""
from models import AnalysisProfile, VialRole, Department


def _mk_profile(db, key, *, vials=1, role="endo", dim="role", active=True):
    p = AnalysisProfile(
        key=key, name=f"T {key}", is_addon=True, vials_required=vials,
        fulfillment_dim=dim, fulfillment_role=role, active=active,
    )
    db.add(p)
    db.flush()
    return p


def _mk_role(db, code, *, dept=True):
    d = None
    if dept:
        d = Department(name=f"Dept {code}")
        db.add(d)
        db.flush()
    r = VialRole(code=code, label=code.upper(), department_id=(d.id if d else None))
    db.add(r)
    db.flush()
    return r


def _seed_legacy_ok(db):
    _mk_role(db, "hplc"); _mk_role(db, "endo"); _mk_role(db, "ster")
    _mk_profile(db, "hplcpurity_identity", role="hplc")
    _mk_profile(db, "bac_water_panel", role="hplc")
    _mk_profile(db, "endotoxin", role="endo")
    _mk_profile(db, "sterility_pcr", role="ster")
