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
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

from coa.native_sections import _eligible_parent_row
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
    sample row is still created; there is no automatic re-seed after registration;
    the admin Re-sync action (`lims_analyses.manage_native.resync_parent_from_order`)
    is the recovery path."""
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


# ── Task 5: harden the COA row selector ─────────────────────────────────────


def test_a_placeholder_can_never_be_certified(db, parent_sample, usp71_profile):
    """Belt-and-braces: even if a placeholder somehow reached 'verified',
    it must not be selectable as a certifiable result — its result_value is
    empty and it would abort or, worse, print blank."""
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    ph = db.query(LimsAnalysis).filter_by(provenance=PROVENANCE_ORDERED).one()
    ph.review_state = "verified"          # simulate the anomaly
    db.commit()
    assert _eligible_parent_row(db, parent_sample.id, ph.analysis_service_id) is None


# ── Task 6: regression gate + non-perturbation proof ────────────────────────
#
# The task-6 brief sketches three fixtures/helpers by inferred name —
# `to_be_verified_vial_row`, `verified_parent_row`, `_parent_line_states` —
# that do not exist anywhere in the codebase. All three below are built from
# scratch against real production code paths (create_analysis/apply_transition
# for the vial, the actual workflow/engine.py function name found by reading
# the file). See each fixture's docstring for how faithful it is to a real
# promote_to_parent / build_native_sections call, and the load-bearing test's
# docstring for exactly what it does NOT prove.


def _make_vial_in_to_be_verified(db, sub, svc, result="Not Detected"):
    """Walks a vial-tier analysis through the REAL state machine
    (create_analysis -> assign -> submit) to reach 'to_be_verified' — the
    same helper shape as test_lims_analyses_service.py's
    `_make_vial_in_to_be_verified` (that file drives promote_to_parent
    against the live Postgres dev DB; this one drives the identical service
    functions against the in-memory SQLite fixture). Deliberately NOT a
    hand-built LimsAnalysis(review_state="to_be_verified", ...) row: routing
    through create_analysis + apply_transition means the fixture is exactly
    the shape a real vial submission produces, not a guess at one."""
    from lims_analyses.service import apply_transition, create_analysis

    row = create_analysis(
        db, host_kind="sub_sample", host_pk=sub.id,
        analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
    )
    apply_transition(db, analysis_id=row.id, kind="assign",
                     reason="TEST: assign for promote")
    apply_transition(db, analysis_id=row.id, kind="submit",
                     result_value=result, reason="TEST: submit for promote")
    return row


@pytest.fixture
def to_be_verified_vial_row(db, parent_sample, usp71_profile):
    """A real vial (LimsSubSample) hung off parent_sample, carrying a
    vial-tier analysis for the sterility_usp71 member service, walked to
    'to_be_verified' via the production state machine — the exact shape
    promote_to_parent's source validation requires (service.py:697-738):
    review_state == 'to_be_verified', analysis_service_id matching the
    native identity, and a resolvable parent via lims_sub_sample_pk ->
    LimsSubSample.parent_sample_pk."""
    vial = LimsSubSample(
        parent_sample_pk=parent_sample.id,
        external_lims_uid="TEST-PLACEHOLDER-VIAL-UID-1",
        sample_id="TEST-PLACEHOLDER-PARENT-S01",
        vial_sequence=1,
    )
    db.add(vial)
    db.commit()
    db.refresh(vial)

    svc = usp71_profile.analysis_services[0]
    return _make_vial_in_to_be_verified(db, vial, svc)


def test_promote_still_succeeds_with_a_placeholder_present(db, parent_sample, usp71_profile,
                                                           to_be_verified_vial_row):
    """THE load-bearing invariant. If this ever fails, the placeholder has
    landed in the canonical slot and the whole design is wrong.

    WHAT THIS PROVES: promote_to_parent's Python code path runs cleanly —
    reads sources, validates, inserts a 'canonical' parent-tier row, writes
    promotions/audit — while an 'ordered' placeholder already occupies the
    same (parent_sample_pk, analysis_service_id) slot. That is a real,
    useful assertion: nothing in promote_to_parent raises, filters on, or is
    otherwise confused by a placeholder's presence.

    WHAT THIS DOES NOT PROVE (read before trusting this test further):
    the whole design's safety rests on Postgres's partial unique index
    `uq_lims_analyses_parent_service_root`, which is scoped
    `WHERE ... AND provenance = 'canonical'` (backend/database.py, the
    "Make the parent-tier root index provenance-aware" migration) so an
    'ordered' row structurally cannot occupy the same slot as a 'canonical'
    one. That index is created EXCLUSIVELY by raw SQL inside
    _run_migrations() against a live Postgres connection — it is not a
    SQLAlchemy Index() anywhere on the LimsAnalysis model (confirmed: `grep
    -n "uq_lims_analyses_parent_service" backend/models.py` returns nothing).
    This test's `db` fixture is `Base.metadata.create_all()` against
    sqlite:///:memory: — that call builds tables and columns from the ORM
    models only; it never runs _run_migrations() and so never creates any of
    the three partial unique indexes (root / shadow / ordered). A
    LimsAnalysisEvent comment elsewhere in models.py confirms this is
    deliberate: "the CHECK lives in database.py DDL only, not here... SQLite
    test fixtures stay unconstrained."
    So this test would still pass exactly as written even if a future change
    silently dropped the `provenance = 'canonical'` clause from the real
    index — it cannot detect that regression. Proving the index itself holds
    requires a real Postgres connection; that is explicitly deferred to a
    later task per the brief, not covered here.

    This IS the adversarial shape for that later Postgres check: the
    placeholder and the freshly-promoted row end up sharing BOTH partial
    indexes' keys at once — (lims_sample_pk, keyword) for
    uq_lims_analyses_parent_service_root (native promote derives the parent
    row's keyword from the service, same as the placeholder's), AND
    (lims_sample_pk, analysis_service_id) for
    uq_lims_analyses_parent_service_ordered. If the `provenance = 'canonical'`
    predicate were ever dropped from the root index, THIS exact pair of rows
    is what would collide.
    """
    from lims_analyses.service import promote_to_parent

    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    row, _ = promote_to_parent(
        # keyword="STERILITY_USP71" is inert here, not the row's real
        # identity: is_native (origin='mk1' source) makes promote_to_parent
        # re-derive eff_parent_keyword from the SOURCE SERVICE's own keyword
        # (service.py:750-754), so the inserted row actually carries
        # "STER-USP71" (usp71_profile's real keyword), not this string.
        db, keyword="STERILITY_USP71", result_value="Not Detected",
        result_unit=None, method_id=None, instrument_id=None,
        sources=[{"analysis_id": to_be_verified_vial_row.id, "contribution_kind": "chosen"}],
    )
    assert row.provenance == "canonical"
    assert row.review_state == "parent_to_verify"
    # Confirm the placeholder is still there, unaffected, for the SAME
    # (parent, service) as the row promote just inserted — this is the exact
    # pair of rows the Postgres partial index has to tolerate co-existing.
    placeholder = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).one()
    assert placeholder.analysis_service_id == row.analysis_service_id
    # Same keyword too, not just the same service id — this pair of rows
    # shares BOTH partial indexes' keys simultaneously (see docstring).
    assert placeholder.keyword == row.keyword == "STER-USP71"


@pytest.fixture
def verified_parent_row(db, parent_sample, usp71_profile):
    """A promoted AND reviewer-verified canonical parent-tier row
    (review_state='verified', which IS in coa.native_sections.ELIGIBLE_STATES
    — 'parent_to_verify', the state Task 4's `promoted_usp71_row` fixture
    uses, is NOT) for sterility_usp71, plus the active NULL-matrix 'equals'
    spec build_native_sections needs to resolve a verdict
    (coa/spec_rules.resolve_spec) — without a resolvable spec the section
    build aborts (rule 5) before a placeholder ever enters the picture,
    which would make the byte-identity test below vacuous. Modelled directly
    on test_native_sections.py::test_equals_spec_fills_and_verdicts, the
    existing test that already exercises an 'equals' spec end-to-end."""
    from models import AnalysisServiceSpec

    svc = usp71_profile.analysis_services[0]
    db.add(AnalysisServiceSpec(
        analysis_service_id=svc.id, matrix=None, rule_kind="equals",
        equals_value="Not Detected",
    ))
    row = LimsAnalysis(
        lims_sample_pk=parent_sample.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        result_value="Not Detected",
        provenance="canonical",
        review_state="verified",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_coa_sections_are_byte_identical_with_and_without_placeholders(
        db, parent_sample, usp71_profile, verified_parent_row, monkeypatch):
    """build_native_sections' row selector (_eligible_parent_row) already
    filters provenance='canonical' — pinning the assembled DOCUMENT
    byte-for-byte (rather than re-deriving that one filter clause) catches
    any future change anywhere in the build path — ordering, dedup,
    formatting — that could let a placeholder leak into a published COA.

    Deviates from the brief's sketch by adding `monkeypatch`: it is required,
    not optional. build_native_sections calls fetch_sample_services
    unconditionally, which is a live HTTP call to Integration Service
    (sub_samples/service.py:1057-1078); unmocked it raises RuntimeError
    (INTEGRATION_SERVICE_URL / API key unset in tests) before ever reaching
    the code this test exists to check. Pattern matches every test in
    test_native_sections.py, all of which monkeypatch this same call.

    The first assertion below is REDUNDANT by itself: _eligible_parent_row
    (coa/native_sections.py:83-113) filters on BOTH `provenance == 'canonical'`
    AND `review_state IN ELIGIBLE_STATES`, and the seeded placeholder fails
    both (provenance='ordered', review_state='unassigned') — so that
    assertion alone would stay green even if the `provenance == 'canonical'`
    clause (the one this whole plan depends on) were deleted from
    _eligible_parent_row; the review_state clause would still save it. The
    second block closes that gap: it flips the placeholder's review_state to
    'verified' (defeating the review_state gate) so provenance is the ONLY
    clause left standing between the placeholder and the document. With the
    clause present the document is still unchanged; if it were ever removed,
    _eligible_parent_row's `.order_by(id.desc())` would pick the
    higher-id placeholder over the real result, its empty result_value would
    fail rule 3, and this assertion would fail loudly.
    """
    from coa.native_sections import build_native_sections

    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"sterility_usp71": True}, "package": None},
    )
    before = build_native_sections(db, parent_sample)
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert build_native_sections(db, parent_sample) == before

    # Defeat the review_state gate too, so provenance='canonical' is the
    # ONLY thing left keeping the placeholder out of the document.
    ph = db.query(LimsAnalysis).filter_by(provenance=PROVENANCE_ORDERED).one()
    ph.review_state = "verified"
    db.commit()
    assert build_native_sections(db, parent_sample) == before


def test_workflow_engine_ignores_placeholders(db, parent_sample, usp71_profile,
                                              verified_parent_row):
    """workflow/engine.py branches if-canonical/elif-shadow with no else, so
    an 'ordered' row must contribute nothing to sample-scope state gates.

    The brief names this helper `_parent_line_states`; that name does not
    exist. The real function, found by reading workflow/engine.py:38 (the
    one containing the if-canonical/elif-shadow loop the brief describes),
    is `_live_parent_line_states`.

    `_EXCLUDED_LINE_STATES` (engine.py:28) is {'retracted', 'rejected',
    'cancelled'} — 'verified' is not in it — so `verified_parent_row` makes
    `before` a genuinely non-empty {'STER-USP71': 'verified'}, not `{} == {}`
    (which the placeholder-loop's missing else-branch would trivially pass
    regardless of whether provenance filtering worked at all). Both the
    canonical row and the placeholder share the SAME keyword
    ('STER-USP71') and `out` is keyed by keyword — so this additionally pins
    that seeding a same-keyword placeholder does not clobber the canonical
    row's entry in the dict, not just that an empty dict stays empty."""
    from workflow.engine import _live_parent_line_states

    before = _live_parent_line_states(db, parent_sample)
    assert before == {"STER-USP71": "verified"}
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert _live_parent_line_states(db, parent_sample) == before


# ── Manage-analyses slice: re-add after soft remove + audited reason ─────────


def test_rejected_placeholder_does_not_block_re_add(db, parent_sample, usp71_profile):
    """R1 soft-remove sets review_state='rejected'; the partial unique index
    excludes rejected rows, and so must the pre-check — otherwise a re-add
    reports `existing` and mints nothing."""
    first = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert first["created"] == 1
    row = db.get(LimsAnalysis, first["created_ids"][0])
    row.review_state = "rejected"
    db.commit()

    again = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert again["created"] == 1 and again["existing"] == 0
    live = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).all()
    assert sorted(r.review_state for r in live) == ["rejected", "unassigned"]


def test_reason_writes_an_auto_transition_with_empty_changed(db, parent_sample, usp71_profile):
    from models import LimsAnalysisTransition
    stats = seed_parent_placeholders(
        db, parent=parent_sample, services={"sterility_usp71": True},
        reason="manage_analyses:add profile=sterility_usp71", created_by_user_id=7,
    )
    db.commit()
    (aid,) = stats["created_ids"]
    trs = db.query(LimsAnalysisTransition).filter_by(analysis_id=aid).all()
    assert len(trs) == 1
    t = trs[0]
    assert t.transition_kind == "auto" and t.from_state is None and t.to_state == "unassigned"
    assert t.reason == "manage_analyses:add profile=sterility_usp71"
    assert t.user_id == 7
    assert t.details == {"changed": {}}


def test_no_reason_writes_no_transition(db, parent_sample, usp71_profile):
    """Registration-time seeding is unchanged: no transition row (today's behavior)."""
    from models import LimsAnalysisTransition
    stats = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.analysis_id.in_(stats["created_ids"])
    ).count() == 0


# ── mk1 read mode: provenance discriminator + live vial-state overlay ──────
# The FE card filters to provenance='ordered' in mk1 read mode (the main
# table owns canonical rows there — PR #135's dupe class), so the shaped
# rows must say which side they are; and a placeholder's static
# 'unassigned' should report the live bench state once vial work exists.


def _mk_vial(db, parent, seq):
    vial = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"VIAL-UID-{parent.id}-{seq}",
        sample_id=f"{parent.sample_id}-S{seq:02d}",
        vial_sequence=seq,
    )
    db.add(vial)
    db.commit()
    db.refresh(vial)
    return vial


def _mk_vial_row(db, vial, svc, review_state, retested=False):
    row = LimsAnalysis(
        lims_sample_pk=None,
        lims_sub_sample_pk=vial.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        provenance="canonical",
        review_state=review_state,
        retested=retested,
    )
    db.add(row)
    db.commit()
    return row


def test_shaped_rows_carry_provenance(db, parent_sample, usp71_profile):
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    svc = usp71_profile.analysis_services[0]
    db.add(LimsAnalysis(
        lims_sample_pk=parent_sample.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
        provenance="canonical", review_state="retracted",
    ))
    db.commit()
    rows = list_native_parent_analyses_senaite_shape(db, parent_sample.sample_id)
    # retracted canonical + surviving placeholder (existing lineage contract)
    assert sorted(r.provenance for r in rows) == ["canonical", "ordered"]


def test_placeholder_reports_most_advanced_live_vial_state(db, parent_sample, usp71_profile):
    """P-0160 shape: the anchor vial is mid-run while a sibling vial idles.
    The placeholder must report the furthest-along live state, not the
    newest row's (the idle sibling was seeded later and would win a
    newest-id rule)."""
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    svc = usp71_profile.analysis_services[0]
    anchor = _mk_vial(db, parent_sample, 2)
    idle = _mk_vial(db, parent_sample, 3)
    _mk_vial_row(db, anchor, svc, "to_be_verified")
    _mk_vial_row(db, idle, svc, "unassigned")  # newer id, less advanced
    db.commit()
    rows = list_native_parent_analyses_senaite_shape(db, parent_sample.sample_id)
    assert len(rows) == 1
    assert rows[0].provenance == "ordered"
    assert rows[0].review_state == "to_be_verified"


def test_placeholder_state_ignores_dead_vial_rows(db, parent_sample, usp71_profile):
    """Retested/rejected/retracted vial rows are not live work — a
    placeholder backed only by dead rows keeps its own 'unassigned' (the
    test is outstanding again)."""
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    svc = usp71_profile.analysis_services[0]
    vial = _mk_vial(db, parent_sample, 2)
    _mk_vial_row(db, vial, svc, "rejected")
    _mk_vial_row(db, vial, svc, "to_be_verified", retested=True)
    db.commit()
    rows = list_native_parent_analyses_senaite_shape(db, parent_sample.sample_id)
    assert len(rows) == 1
    assert rows[0].review_state == "unassigned"
