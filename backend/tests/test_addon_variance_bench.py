"""Add-on test Variance, Tasks 9 to 11: the bench sign-off route of a replicate.

Contract pinned here: a replicate is signed off with the existing
`variance_verify` transition and is never promoted; the first (core) run is
the normal test and cannot be variance-verified.

Characterization only (no production change). Each world is built the real
way: a native-born parent, a catalog profile with the real test key, and
vials assigned through `set_assignment_role` with the order patched to carry
the variance map, so seeding runs through the production hook. In-memory
SQLite (the `lite` fixture), so nothing touches the shared dev Postgres.
The vial roles are created variance-eligible inside this file's own catalog
(a seeded dev database may still hold `hm` ineligible; seed code is untouched).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from lims_analyses.service import BadRequestError, apply_transition, promote_to_parent
from models import Department, LimsAnalysis, LimsSubSample, VialRole
from sub_samples import service as sub_service
from tests.test_addon_variance_override import _order
from tests.test_addon_variance_seeding import _profile
from tests.test_variance_demand import _lite_parent, lite  # noqa: F401 (fixture)

PCR_KEY = "rapid-sterility-pcr"
USP71_KEY = "sterility-usp71"
HM_KEY = "heavy_metals"
PCR_KW = ["STER-PCR"]
PCR_TWO_KW = ["STER-PCR-BACT", "STER-PCR-FUNGI"]


def _rows(db, vial):
    return sorted(db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=vial.id).all(),
                  key=lambda r: r.keyword)


def _replicate_world(db, role, key, keywords, *, monkeypatch, vials_required=1,
                     analytical_vials=None, n=2):
    """A native parent whose order bought `key` with Variance n, and one run's
    vials per kind: `vials_required` core vials, then the same number of
    variance vials, each assigned through `set_assignment_role`.

    Returns SimpleNamespace(parent, core, replicate, rows, core_rows, vials):
    `core` and `replicate` are the first vial of each kind (the anchor of a
    pooled run), `rows` the replicate's seeded rows and `core_rows` the core
    vial's, both by keyword; `vials` every vial in assignment order."""
    dep = Department(name=f"ZZ T9 {role}")
    db.add(dep)
    db.flush()
    db.add(VialRole(code=role, label=role, department_id=dep.id, variance_eligible=True,
                    sort_order=100, boxable=False, frozen=False, is_system=False))
    _profile(db, key, role, keywords, vials_required=vials_required,
             analytical_vials=analytical_vials)
    db.commit()
    sid = f"ZZT9-{role.upper()}"
    n_vials = 2 * vials_required
    parent = _lite_parent(db, sid, n_vials)
    services = {key: True, "variance": {key: n}}
    _order(monkeypatch, services)
    kinds = ["core"] * vials_required + ["variance"] * vials_required
    for seq, kind in enumerate(kinds, 1):
        sub_service.set_assignment_role(db, f"{sid}-S{seq:02d}", role, kind=kind,
                                        wp_services=services)
    vials = (db.query(LimsSubSample).filter_by(parent_sample_pk=parent.id)
             .order_by(LimsSubSample.vial_sequence).all())
    core, replicate = vials[0], vials[vials_required]
    return SimpleNamespace(parent=parent, core=core, replicate=replicate,
                           rows=_rows(db, replicate), core_rows=_rows(db, core), vials=vials)


def _submit(db, row, value):
    return apply_transition(db, analysis_id=row.id, kind="submit", result_value=value)


def _variance_verify(db, row):
    return apply_transition(db, analysis_id=row.id, kind="variance_verify")


def _parent_tier_rows(db, parent):
    return db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).count()


def _promote_chosen(db, row):
    return promote_to_parent(db, keyword=row.keyword, result_value=row.result_value,
                             result_unit=row.result_unit, method_id=None, instrument_id=None,
                             sources=[{"analysis_id": row.id, "contribution_kind": "chosen"}])


def _bench_kind(world):
    import json

    from main import _bench_kind_for_item
    analyses = json.dumps([{"keyword": r.keyword} for r in world.rows])
    return _bench_kind_for_item(world.replicate.assignment_role, analyses)


# ── Task 9: rapid PCR (pcr) ─────────────────────────────────────────────────

def test_pcr_replicate_submits_and_variance_verifies(lite, monkeypatch):
    w = _replicate_world(lite, "pcr", PCR_KEY, PCR_KW, monkeypatch=monkeypatch)
    assert w.replicate.assignment_kind == "variance"
    assert [r.keyword for r in w.rows] == ["STER-PCR"]
    row = w.rows[0]
    _submit(lite, row, "Not Detected")
    out = _variance_verify(lite, row)
    assert out.review_state == "variance_verified"
    assert out.verified_at is not None
    assert out.result_value == "Not Detected"
    assert _parent_tier_rows(lite, w.parent) == 0


def test_pcr_two_member_replicate_signs_off_each_row(lite, monkeypatch):
    w = _replicate_world(lite, "pcr", PCR_KEY, PCR_TWO_KW, monkeypatch=monkeypatch)
    bact, fungi = w.rows
    assert [bact.keyword, fungi.keyword] == PCR_TWO_KW
    _submit(lite, bact, "Not Detected")
    _submit(lite, fungi, "Not Detected")
    _variance_verify(lite, bact)
    lite.expire_all()
    assert [r.review_state for r in _rows(lite, w.replicate)] == [
        "variance_verified", "to_be_verified"]
    _variance_verify(lite, fungi)
    lite.expire_all()
    assert [r.review_state for r in _rows(lite, w.replicate)] == [
        "variance_verified", "variance_verified"]
    assert _parent_tier_rows(lite, w.parent) == 0


def test_pcr_replicate_promote_is_refused(lite, monkeypatch):
    w = _replicate_world(lite, "pcr", PCR_KEY, PCR_KW, monkeypatch=monkeypatch)
    row = w.rows[0]
    # promote checks the source state before the bucket, so submit first.
    _submit(lite, row, "Not Detected")
    with pytest.raises(BadRequestError, match="assigned to a variance bucket"):
        _promote_chosen(lite, row)
    lite.rollback()
    assert _parent_tier_rows(lite, w.parent) == 0


def test_pcr_core_vial_variance_verify_is_refused(lite, monkeypatch):
    w = _replicate_world(lite, "pcr", PCR_KEY, PCR_KW, monkeypatch=monkeypatch)
    assert w.core.assignment_kind == "core"
    row = w.core_rows[0]
    # the state machine runs before the bucket guard, so submit first.
    _submit(lite, row, "Not Detected")
    with pytest.raises(BadRequestError, match="variance bucket"):
        _variance_verify(lite, row)
    lite.rollback()
    lite.expire_all()
    assert _rows(lite, w.core)[0].review_state == "to_be_verified"


def test_pcr_replicate_lands_on_the_pcr_bench(lite, monkeypatch):
    w = _replicate_world(lite, "pcr", PCR_KEY, PCR_KW, monkeypatch=monkeypatch)
    from main import _ROLE_BENCH_KIND, _bench_kind_for_item
    assert _bench_kind(w) == "pcr"
    assert _ROLE_BENCH_KIND["pcr"] == "pcr"
    assert _bench_kind_for_item(w.core.assignment_role, None) == "pcr"


# ── Task 10: sterility plate, USP 71 (usp71) ────────────────────────────────

USP71_KW = ["BACTERIA", "FUNGI"]


def test_usp71_replicate_submits_and_variance_verifies(lite, monkeypatch):
    w = _replicate_world(lite, "usp71", USP71_KEY, USP71_KW, monkeypatch=monkeypatch)
    assert w.replicate.assignment_kind == "variance"
    assert [r.keyword for r in w.rows] == USP71_KW
    for row in w.rows:
        _submit(lite, row, "No Growth")
    _variance_verify(lite, w.rows[0])
    lite.expire_all()
    assert [r.review_state for r in _rows(lite, w.replicate)] == [
        "variance_verified", "to_be_verified"]
    _variance_verify(lite, w.rows[1])
    lite.expire_all()
    signed = _rows(lite, w.replicate)
    assert [r.review_state for r in signed] == ["variance_verified", "variance_verified"]
    assert all(r.verified_at is not None for r in signed)
    assert _parent_tier_rows(lite, w.parent) == 0


def test_usp71_replicate_promote_is_refused(lite, monkeypatch):
    w = _replicate_world(lite, "usp71", USP71_KEY, USP71_KW, monkeypatch=monkeypatch)
    for row in w.rows:
        _submit(lite, row, "No Growth")
        with pytest.raises(BadRequestError, match="assigned to a variance bucket"):
            _promote_chosen(lite, row)
        lite.rollback()
    assert _parent_tier_rows(lite, w.parent) == 0


def test_usp71_replicate_lands_on_the_sterility_bench(lite, monkeypatch):
    w = _replicate_world(lite, "usp71", USP71_KEY, USP71_KW, monkeypatch=monkeypatch)
    from main import _bench_kind_for_item
    assert _bench_kind(w) == "sterility"
    assert _bench_kind_for_item(w.core.assignment_role, None) == "sterility"


# ── Task 11: heavy metals (hm), one digest per run ──────────────────────────

HM_KW = ["HM-AS", "HM-CD", "HM-HG", "HM-PB"]


def _hm_world(db, monkeypatch):
    """n=2: two core vials (S01 anchor, S02 material), then two variance vials
    (S03 replicate digest anchor, S04 material), assigned in that order."""
    return _replicate_world(db, "hm", HM_KEY, HM_KW, monkeypatch=monkeypatch,
                            vials_required=2, analytical_vials=1)


def test_hm_replicate_digest_anchor_signs_off_every_metal(lite, monkeypatch):
    from sub_samples.variance_tests import replicate_anchor_vials
    w = _hm_world(lite, monkeypatch)
    s01, s02, s03, s04 = w.vials
    assert [v.assignment_kind for v in w.vials] == ["core", "core", "variance", "variance"]
    assert w.replicate is s03
    assert [r.keyword for r in w.core_rows] == HM_KW
    assert [r.keyword for r in w.rows] == HM_KW
    assert _rows(lite, s02) == []
    assert _rows(lite, s04) == []
    for row in w.rows:
        _submit(lite, row, "0.1")
        _variance_verify(lite, row)
    lite.expire_all()
    signed = _rows(lite, s03)
    assert [r.review_state for r in signed] == ["variance_verified"] * 4
    assert all(r.verified_at is not None for r in signed)
    assert _rows(lite, s04) == []
    assert _parent_tier_rows(lite, w.parent) == 0
    assert replicate_anchor_vials(lite, w.parent.id, "hm") == [s03]


def test_hm_material_vial_has_nothing_to_sign_off(lite, monkeypatch):
    w = _hm_world(lite, monkeypatch)
    material = w.vials[3]
    assert material.assignment_kind == "variance"
    assert material.in_variance_set is True
    assert lite.query(LimsAnalysis).filter_by(lims_sub_sample_pk=material.id).count() == 0
