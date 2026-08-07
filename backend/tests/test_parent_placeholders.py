"""Tests for lims_analyses/parent_placeholders.py.

Task 2 fixtures are self-contained in-memory SQLite, modelled on
test_catalog_demand.py's `db_session` idiom (models.py registers
AnalysisProfile/AnalysisService on Base.metadata before create_all(), so this
file needs no live DB and no other test's seeded catalog state). That
isolation is deliberate here specifically because the idempotency + origin-
filter assertions need `origin` pinned exactly — 'mk1' for the native
profile, genuinely 'senaite' for the legacy one — rather than whatever the
shared dev catalog happens to contain today.

`seed_parent_placeholders` delegates "what was ordered" entirely to
coa.native_sections._ordered_native_profiles, which excludes a profile
WHOLESALE the moment any one of its member services has origin != 'mk1'
(coa/native_sections.py:66). So the legacy-service test below only needs a
profile with a single genuinely-'senaite' member for the whole profile
(and therefore every service on it) to never reach the minting loop at all.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers AnalysisProfile/AnalysisService before create_all()
from database import Base
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample

from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from lims_analyses.service import list_native_parent_analyses_senaite_shape


def test_provenance_ordered_is_a_third_distinct_value():
    """Must not collide with the two existing provenances — every safety
    property (promote untouched, COA blind, workflow gates unperturbed)
    depends on it being neither."""
    assert PROVENANCE_ORDERED == "ordered"
    assert PROVENANCE_ORDERED not in ("canonical", "shadow")


# ── Task 2: seed_parent_placeholders ────────────────────────────────────────


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent_sample(db):
    parent = LimsSample(sample_id="TEST-PLACEHOLDER-PARENT", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent


def _mk_service(db, *, keyword, title, origin):
    svc = AnalysisService(title=title, keyword=keyword, origin=origin)
    db.add(svc)
    db.commit()
    db.refresh(svc)
    return svc


def _mk_profile(db, *, key, name, members, coa_archetype="limit_table"):
    prof = AnalysisProfile(
        key=key, name=name, is_addon=True, coa_archetype=coa_archetype,
    )
    for svc in members:
        prof.analysis_services.append(svc)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


@pytest.fixture
def usp71_profile(db):
    """A native (origin='mk1') sterility profile, reportable on the COA
    (coa_archetype set) — the shape _ordered_native_profiles requires to
    return it at all."""
    svc = _mk_service(db, keyword="STER-USP71", title="Sterility (USP<71>)", origin="mk1")
    return _mk_profile(db, key="sterility_usp71", name="Sterility USP<71>", members=[svc])


def test_mints_one_row_per_ordered_native_service(db, parent_sample, usp71_profile):
    stats = seed_parent_placeholders(
        db, parent=parent_sample, services={"sterility_usp71": True}
    )
    db.commit()
    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).all()
    assert stats["created"] == 1
    assert len(rows) == 1
    r = rows[0]
    assert r.lims_sub_sample_pk is None
    assert r.review_state == "unassigned"
    assert r.result_value is None
    assert r.retest_of_id is None


def test_is_idempotent(db, parent_sample, usp71_profile):
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    stats = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert stats["created"] == 0 and stats["existing"] == 1
    assert db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).count() == 1


def test_unordered_service_mints_nothing(db, parent_sample, usp71_profile):
    stats = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": False})
    db.commit()
    assert stats["created"] == 0
    assert db.query(LimsAnalysis).filter_by(provenance=PROVENANCE_ORDERED).count() == 0


def test_legacy_senaite_service_is_not_placeheld(db, parent_sample):
    """endotoxin/sterility_pcr are SENAITE-sourced — they already get a
    'shadow' row from the registration mirror. Double-placeholding them
    would put two pending rows on the same parent line.

    The 'endotoxin' member service is built with origin='senaite' for real
    (not origin='mk1' with the intent hand-waved) so this proves the actual
    origin gate in _ordered_native_profiles, not a fixture that begs the
    question.
    """
    svc = _mk_service(db, keyword="ENDO-LAL", title="Endotoxin (LAL)", origin="senaite")
    _mk_profile(db, key="endotoxin", name="Endotoxin", members=[svc])

    stats = seed_parent_placeholders(db, parent=parent_sample, services={"endotoxin": True})
    db.commit()
    assert stats["created"] == 0


def test_ordered_profile_without_archetype_still_gets_a_placeholder(db, parent_sample):
    """coa_archetype governs COA RENDERING, not whether the bench must run the
    test. A paid native profile with no archetype configured yet must still
    appear on the parent — that invisibility is the bug this feature fixes."""
    svc = _mk_service(db, keyword="HM-PB", title="Lead", origin="mk1")
    _mk_profile(db, key="heavy_metals", name="Heavy Metals",
                members=[svc], coa_archetype=None)

    stats = seed_parent_placeholders(
        db, parent=parent_sample, services={"heavy_metals": True}
    )
    db.commit()
    assert stats["created"] == 1
    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).one()
    assert row.keyword == "HM-PB"


def test_coa_path_still_requires_an_archetype(db, parent_sample):
    """The COA caller's behaviour must be untouched: default require_archetype=True."""
    from coa.native_sections import _ordered_native_profiles
    svc = _mk_service(db, keyword="HM-PB2", title="Lead", origin="mk1")
    _mk_profile(db, key="heavy_metals_2", name="HM2", members=[svc], coa_archetype=None)

    assert _ordered_native_profiles(db, {"heavy_metals_2": True}, None) == []
    assert len(_ordered_native_profiles(
        db, {"heavy_metals_2": True}, None, require_archetype=False)) == 1


# ── Task 3: registration hook ───────────────────────────────────────────────


def test_registration_hook_never_raises_when_is_unreachable(monkeypatch, parent_sample):
    """A catalog/IS failure must leave registration itself untouched — the
    sample row is still created and the next check-in heals the placeholders."""
    import main
    calls = []
    def boom(_sample_id):
        calls.append(_sample_id)
        raise RuntimeError("IS down")
    monkeypatch.setattr("sub_samples.service.fetch_sample_services", boom)
    main._native_placeholders_at_registration_bg(parent_sample.sample_id)  # must not raise
    # Proves the patch was the thing that actually raised — not that the
    # exception swallower is masking a different, unpatched failure path
    # (e.g. the real fetch_sample_services blowing up on missing env vars).
    assert calls == [parent_sample.sample_id]


# ── Task 4: placeholders on the native parent card ─────────────────────────


@pytest.fixture
def promoted_usp71_row(db, parent_sample, usp71_profile):
    """A promoted (provenance='canonical') parent-tier row for the SAME
    analysis_service_id as the sterility_usp71 placeholder — built directly
    rather than via promote_to_parent (which needs vial-tier source rows in
    to_be_verified state and would drag in unrelated machinery for no
    benefit here). review_state='parent_to_verify' is what promote actually
    produces and is a legal value under the DB CHECK."""
    svc = usp71_profile.analysis_services[0]
    row = LimsAnalysis(
        lims_sample_pk=parent_sample.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        provenance="canonical",
        review_state="parent_to_verify",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_placeholder_appears_on_native_parent_card(db, parent_sample, usp71_profile):
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    rows = list_native_parent_analyses_senaite_shape(db, parent_sample.sample_id)
    # SenaiteShapeAnalysisResponse is a plain pydantic BaseModel (no
    # __getitem__), so rows are read via attribute access — matching every
    # other consumer of this shape (e.g. test_senaite_shape_result_type.py).
    assert [r.keyword for r in rows] == ["STER-USP71"]
    assert rows[0].review_state == "unassigned"


def test_canonical_wins_over_placeholder_after_promote(db, parent_sample, usp71_profile,
                                                       promoted_usp71_row):
    """Post-promotion the card shows ONE row, the canonical one — the
    placeholder is left in the table (like a SENAITE shadow row) and
    deduped here."""
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    rows = list_native_parent_analyses_senaite_shape(db, parent_sample.sample_id)
    assert len(rows) == 1
    assert rows[0].review_state != "unassigned"


def test_placeholder_survives_a_retracted_canonical_row(db, parent_sample, usp71_profile):
    """A retracted (dead) canonical row does NOT discharge the placeholder:
    the result was thrown away, so the paid-for test is outstanding again
    and the bench must still see it. Suppression is scoped to LIVE
    canonical rows only — a dead one must not silently hide the
    placeholder, and (full-lineage contract) the dead row itself must still
    surface too."""
    svc = usp71_profile.analysis_services[0]
    dead = LimsAnalysis(
        lims_sample_pk=parent_sample.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        provenance="canonical",
        review_state="retracted",
    )
    db.add(dead)
    db.commit()

    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()

    rows = list_native_parent_analyses_senaite_shape(db, parent_sample.sample_id)
    assert [r.review_state for r in rows] == ["retracted", "unassigned"]


# ── Task 4b: keep placeholders OUT of the registry inbox ───────────────────


def test_registry_inbox_ignores_placeholders(db, parent_sample, usp71_profile):
    """The inbox has no canonical-wins dedupe, so a placeholder would show as
    an extra 'unassigned' analysis — and would DOUBLE UP with the canonical row
    after promotion. Placeholders are a parent-card concern; the inbox keeps
    today's behaviour until it gets a dedupe rule of its own."""
    from sub_samples.registry_inbox import inbox_candidates_from_registry

    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    # inbox_candidates_from_registry only considers status='sample_received'
    # parents; the shared parent_sample fixture is 'received', so flip it
    # here rather than touching the fixture other tests in this file rely on.
    parent_sample.status = "sample_received"
    db.commit()

    _, analyses_by_sample = inbox_candidates_from_registry(db)
    rows = analyses_by_sample.get(parent_sample.sample_id, [])
    assert not any(r["keyword"] == "STER-USP71" for r in rows)
