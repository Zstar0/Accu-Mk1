"""S3 native-identity convergence — behavior tests.

Task 3 covers the two retest-lineage readers, whose identity resolution is
deliberately NOT promote's `_ident_clause` ternary (service.py:850-857).
Promote holds the source ROW and can read its service FK before querying;
these two callers hold only a keyword off a keyword-boundary wire. The shape
they use instead is three-legged:

  1. explicit `analysis_service_id` — caller already holds the native key
  2. exact stored keyword — byte-identical to the pre-S3 lookup
  3. mk1 catalog rescue — ONLY on a miss from (2), and only for origin='mk1'

Leg 2-before-3 is the whole point: a caller sending a keyword that names a
LIVE row must always get that row, even when some other service's catalog
keyword happens to be the same string (test_exact_keyword_wins_over_rescue).

Fixture idiom follows tests/test_parent_retest_cascade.py (in-memory SQLite,
the established harness for these two functions) rather than the live-PG
builder: the cascade commits its own transactions, so a rollback fixture
would not contain it, and index enforcement is Task 2's subject, not this
file's.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from catalog.departments import ANALYTICAL_DEPARTMENT
from database import Base
from lims_analyses.seeder import seed_analyses_for_vial
from lims_analyses.service import (
    BadRequestError,
    NotFoundError,
    add_analysis_to_native_vial,
    cascade_parent_retest_to_sources,
    delete_pristine_analysis,
    parent_retest,
)
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsAnalysisPromotion,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def db_mem():
    """In-memory SQLite session (same harness as test_parent_retest_cascade)."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def host(db_mem):
    """A parent LimsSample with one sub-sample. Returns (db, parent, sub)."""
    parent = LimsSample(sample_id="P-S3-001", external_lims_uid="uid-s3-001")
    db_mem.add(parent)
    db_mem.flush()

    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-s3-001-S01",
        sample_id="P-S3-001-S01",
        vial_sequence=1,
    )
    db_mem.add(sub)
    db_mem.commit()
    return db_mem, parent, sub


def _service(db, *, keyword, origin):
    """Catalog service. `keyword` here is the CATALOG keyword — the row's
    stored keyword is passed separately so drift can be constructed."""
    svc = AnalysisService(title=f"TEST {keyword}", keyword=keyword, origin=origin)
    db.add(svc)
    db.flush()
    return svc


def _parent_row(db, parent, svc, *, stored_keyword, state="verified"):
    row = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=stored_keyword,
        title=f"TEST: parent {stored_keyword}",
        review_state=state,
        result_value="99.00",
        retest_of_id=None,
    )
    db.add(row)
    db.flush()
    return row


def _promoted_vial(db, sub, svc, *, stored_keyword):
    """A retest-eligible ('promoted') vial-tier source row."""
    row = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=stored_keyword,
        title=f"TEST: vial {stored_keyword}",
        review_state="promoted",
        result_value="99.00",
        retest_of_id=None,
    )
    db.add(row)
    db.flush()
    return row


def _vial_row(db, sub, svc, *, stored_keyword, state="unassigned"):
    """A vial-tier root row — the population the seeder's already-seeded skip
    set is built from. `state` lets a test construct a DEAD (rejected/
    retracted) row, which must NOT contribute to either set."""
    row = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=stored_keyword,
        title=f"TEST: vial {stored_keyword}",
        review_state=state,
        retest_of_id=None,
    )
    db.add(row)
    db.flush()
    return row


def _link(db, parent_row, vial_row):
    db.add(LimsAnalysisPromotion(
        parent_analysis_id=parent_row.id,
        source_analysis_id=vial_row.id,
        contribution_kind="chosen",
        promoted_by_user_id=None,
    ))
    db.flush()


def _drifted_native(db, parent, sub, *, catalog_kw="PUR_NEW", stored_kw="PUR_OLD"):
    """mk1-origin service whose live rows carry a keyword that has drifted away
    from the catalog's. Returns (svc, parent_row, vial_row)."""
    svc = _service(db, keyword=catalog_kw, origin="mk1")
    prow = _parent_row(db, parent, svc, stored_keyword=stored_kw)
    vial = _promoted_vial(db, sub, svc, stored_keyword=stored_kw)
    _link(db, prow, vial)
    db.commit()
    return svc, prow, vial


# ─── (a) explicit analysis_service_id — both sites ───────────────────────────


def test_cascade_finds_drifted_native_row_by_service_id(host):
    """Caller holds the native identity key: the lookup keys on the service FK
    alone, and the keyword it also passes is irrelevant to the match."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub)

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="TOTALLY-UNRELATED-KEYWORD",
        user_id=None,
        analysis_service_id=svc.id,
    )

    assert len(new_ids) == 1, f"service-id lookup must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id
    db.refresh(prow)
    assert prow.review_state == "retracted"


def test_parent_retest_finds_drifted_native_row_by_service_id(host):
    """Same, one level up: parent_retest's active-row lookup and the service id
    it threads down to the cascade."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub)

    new_ids, state = parent_retest(
        db,
        sample_id=parent.sample_id,
        keyword="TOTALLY-UNRELATED-KEYWORD",
        user_id=None,
        analysis_service_id=svc.id,
    )

    assert len(new_ids) == 1, f"service-id lookup must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id
    assert state == "retracted"


# ─── (b) catalog-keyword rescue after an exact miss — both sites ─────────────


def test_cascade_rescues_drifted_native_row_via_catalog_keyword(host):
    """Caller passes the CATALOG keyword for an mk1 service whose live rows
    still carry the pre-rename keyword. Exact match misses; the mk1-scoped
    catalog rescue resolves the service and finds the row by FK. Before S3
    this silently no-op'd."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub, catalog_kw="PUR_NEW", stored_kw="PUR_OLD")

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="PUR_NEW",          # catalog keyword; no live row carries it
        user_id=None,
    )

    assert len(new_ids) == 1, f"catalog rescue must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id


def test_parent_retest_rescues_drifted_native_row_via_catalog_keyword(host):
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub, catalog_kw="PUR_NEW", stored_kw="PUR_OLD")

    new_ids, state = parent_retest(
        db,
        sample_id=parent.sample_id,
        keyword="PUR_NEW",
        user_id=None,
    )

    assert len(new_ids) == 1, f"catalog rescue must find the drifted row; got {new_ids}"
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id
    assert state == "retracted"


# ─── (c) the hazard: exact keyword must win over the rescue ──────────────────


def test_exact_keyword_wins_over_catalog_rescue(host):
    """The reason leg 2 runs before leg 3.

    Both root indexes permit these two rows to be live on one parent at once:
      X — service 'PUR_NEW' (mk1), stored keyword 'PUR_OLD'   (drifted)
      Y — service 'OTHER'   (mk1), stored keyword 'PUR_NEW'   (also drifted)
    A caller sending 'PUR_NEW' means Y — that is the string Y's live row
    answers to, and it is what the FE sends (it echoes row.keyword). Resolving
    'PUR_NEW' through the catalog FIRST would route the retest to X and retract
    the wrong promoted sources."""
    db, parent, sub = host

    # X: the drifted row whose SERVICE owns the 'PUR_NEW' catalog keyword
    svc_x = _service(db, keyword="PUR_NEW", origin="mk1")
    row_x = _parent_row(db, parent, svc_x, stored_keyword="PUR_OLD")
    vial_x = _promoted_vial(db, sub, svc_x, stored_keyword="PUR_OLD")
    _link(db, row_x, vial_x)

    # Y: the row that actually answers to the string 'PUR_NEW'
    svc_y = _service(db, keyword="OTHER", origin="mk1")
    row_y = _parent_row(db, parent, svc_y, stored_keyword="PUR_NEW")
    vial_y = _promoted_vial(db, sub, svc_y, stored_keyword="PUR_NEW")
    _link(db, row_y, vial_y)
    db.commit()

    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="PUR_NEW",
        user_id=None,
    )

    assert len(new_ids) == 1
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial_y.id, (
        "exact stored-keyword match must win; the catalog rescue routed the "
        "retest to the wrong line"
    )
    db.refresh(row_x)
    assert row_x.review_state == "verified", "row X must be untouched"
    db.refresh(vial_x)
    assert vial_x.retested is False, "row X's source must not be retested"


# ─── (d) senaite-origin: keyword only, no rescue ─────────────────────────────


def test_senaite_origin_gets_no_catalog_rescue(host):
    """senaite services keep the keyword as their identity contract
    (grandfathered): a drifted senaite row is NOT reachable by its catalog
    keyword, because the rescue leg is scoped to origin='mk1'. The SENAITE
    webhook (main.py) sends SENAITE's own keyword, which is the stored one."""
    db, parent, sub = host
    svc = _service(db, keyword="SEN_NEW", origin="senaite")
    prow = _parent_row(db, parent, svc, stored_keyword="SEN_OLD")
    vial = _promoted_vial(db, sub, svc, stored_keyword="SEN_OLD")
    _link(db, prow, vial)
    db.commit()

    assert cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="SEN_NEW",          # catalog keyword — must NOT rescue
        user_id=None,
    ) == [], "senaite rows must not be reachable through the mk1 catalog rescue"

    with pytest.raises(NotFoundError):
        parent_retest(db, sample_id=parent.sample_id, keyword="SEN_NEW", user_id=None)

    # ...and the stored keyword still works, exactly as before S3.
    new_ids = cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="SEN_OLD",
        user_id=None,
    )
    assert len(new_ids) == 1
    assert db.get(LimsAnalysis, new_ids[0]).retest_of_id == vial.id


# ─── the SENAITE wire opts out of the rescue leg ────────────────────────────


def test_senaite_wire_does_not_rescue_into_a_colliding_native_line(host):
    """uq_analysis_services_mk1_keyword is PARTIAL on origin='mk1', so nothing
    stops an mk1 service and a senaite service from sharing a keyword string.
    A SENAITE retest for that string, finding no live row of its own, must NOT
    rescue into the native line that merely shares it — that would retract real
    vial results, silently (main.py's caller swallows exceptions).

    Both halves are asserted: with allow_native_rescue=False nothing is
    touched, and with the default the rescue DOES fire — so the guard is what
    prevents it here, not an accident of the fixture."""
    db, parent, sub = host

    # The native line, drifted: its catalog keyword is 'COLLIDE'.
    svc_mk1 = _service(db, keyword="COLLIDE", origin="mk1")
    native_row = _parent_row(db, parent, svc_mk1, stored_keyword="PUR_OLD")
    native_vial = _promoted_vial(db, sub, svc_mk1, stored_keyword="PUR_OLD")
    _link(db, native_row, native_vial)

    # A senaite service sharing the string, with no live row on this parent.
    _service(db, keyword="COLLIDE", origin="senaite")
    db.commit()

    assert cascade_parent_retest_to_sources(
        db,
        parent_sample_id=parent.sample_id,
        keyword="COLLIDE",
        user_id=None,
        allow_native_rescue=False,
    ) == [], "SENAITE wire must not rescue into the colliding native line"
    db.refresh(native_row)
    db.refresh(native_vial)
    assert native_row.review_state == "verified"
    assert native_vial.retested is False

    # Control: the native wire (default) does rescue — the guard is load-bearing.
    assert cascade_parent_retest_to_sources(
        db, parent_sample_id=parent.sample_id, keyword="COLLIDE", user_id=None,
    ), "default path should still rescue; the fixture is not proving the guard"


# ─── the audit event names the row that was retested ────────────────────────


def test_retest_event_records_resolved_identity_not_requested_keyword(host):
    """parent_retest's activity event used to echo the caller's keyword. Since
    the rescue leg can resolve a row whose stored keyword differs from the one
    asked for, the event must name the ROW's identity — otherwise the audit
    trail carries a keyword that doesn't identify what was retested. The
    requested string is kept alongside it, only when it differed."""
    db, parent, sub = host
    svc, prow, vial = _drifted_native(db, parent, sub, catalog_kw="PUR_NEW", stored_kw="PUR_OLD")

    parent_retest(db, sample_id=parent.sample_id, keyword="PUR_NEW", user_id=None)

    ev = db.execute(
        LimsSubSampleEvent.__table__.select().where(
            LimsSubSampleEvent.event == "parent_analysis_retested"
        )
    ).mappings().one()
    assert ev["details"]["keyword"] == "PUR_OLD", "must record the resolved row's keyword"
    assert ev["details"]["analysis_service_id"] == svc.id
    assert ev["details"]["requested_keyword"] == "PUR_NEW"
    assert ev["details"]["service_origin"] == "mk1"


def test_retest_event_omits_requested_keyword_when_it_matches(host):
    """The pre-S3 shape: caller named the row's own keyword, so there is no
    divergence to record."""
    db, parent, sub = host
    svc = _service(db, keyword="PUR_SAME", origin="mk1")
    prow = _parent_row(db, parent, svc, stored_keyword="PUR_SAME")
    vial = _promoted_vial(db, sub, svc, stored_keyword="PUR_SAME")
    _link(db, prow, vial)
    db.commit()

    parent_retest(db, sample_id=parent.sample_id, keyword="PUR_SAME", user_id=None)

    ev = db.execute(
        LimsSubSampleEvent.__table__.select().where(
            LimsSubSampleEvent.event == "parent_analysis_retested"
        )
    ).mappings().one()
    assert ev["details"]["keyword"] == "PUR_SAME"
    assert "requested_keyword" not in ev["details"]


# ─── regression: the provenance term survives the refactor ──────────────────


def test_all_legs_target_canonical_not_shadow(host):
    """`review_state NOT IN ('retracted','rejected')` does NOT exclude the
    shadow sentinel 'senaite_mirror', so a shadow row for the same (parent,
    service) matches every leg's filter. A shadow carries no promotion links,
    so resolving to one makes the cascade silently no-op instead of retesting
    the sources the canonical row promoted.

    Pins that for all three identity legs. The live-PG original
    (test_parent_mirror_fail_closed.py::test_retest_cascade_targets_canonical_
    not_shadow) covers the exact-keyword leg only; the service-id and rescue
    legs are new surface. Shadow is inserted FIRST (lower id) to bias an
    unordered scan toward it."""
    db, parent, sub = host
    svc = _service(db, keyword="PUR_NEW", origin="mk1")

    shadow = LimsAnalysis(
        lims_sample_pk=parent.id,
        analysis_service_id=svc.id,
        keyword="PUR_OLD",
        title="TEST: shadow",
        review_state="senaite_mirror",
        provenance="shadow",
        mirror_review_state="verified",
        result_value="88.8",
    )
    db.add(shadow)
    db.flush()          # shadow gets the lower id

    canonical = _parent_row(db, parent, svc, stored_keyword="PUR_OLD")
    vial = _promoted_vial(db, sub, svc, stored_keyword="PUR_OLD")
    _link(db, canonical, vial)
    db.commit()

    for leg, kwargs in (
        ("service id", {"keyword": "irrelevant", "analysis_service_id": svc.id}),
        ("exact keyword", {"keyword": "PUR_OLD"}),
        ("catalog rescue", {"keyword": "PUR_NEW"}),
    ):
        db.rollback()
        for row in (canonical, vial):
            db.refresh(row)
            row.review_state = "verified" if row is canonical else "promoted"
            row.result_value = "99.00"
            row.retested = False
        db.execute(
            LimsAnalysis.__table__.delete().where(
                LimsAnalysis.retest_of_id.is_not(None)
            )
        )
        db.commit()

        new_ids = cascade_parent_retest_to_sources(
            db, parent_sample_id=parent.sample_id, user_id=None, **kwargs
        )
        assert new_ids, f"{leg} leg resolved to the shadow row and no-opped"
        db.refresh(shadow)
        assert shadow.review_state == "senaite_mirror", f"{leg} leg touched the shadow"
        assert shadow.result_value == "88.8"
        assert shadow.retested is False


# ═══ Task 4: the seeder's already-seeded skip set ════════════════════════════
#
# The skip set exists to answer one question — WOULD THIS INSERT COLLIDE? — so
# it mirrors the vial-tier root indexes, and BOTH of them are live with
# byte-identical predicates (database.py:696 keyword-keyed, :1641 service-id-
# keyed). The check is therefore a UNION, not the origin ternary Task 3's
# identity RESOLUTION uses: a candidate is already-seeded if it collides on
# either key. The service-id index is deliberately origin-agnostic
# (database.py:1635), so the id set is not scoped to mk1 rows.
#
# Harness note: Base.metadata.create_all does NOT build the partial unique
# indexes (raw SQL in run_migrations), so a pre-change double-seed SUCCEEDS
# here rather than raising IntegrityError — these assert on what was seeded,
# not on the exception prod would get.


def _endo_svc(db, *, origin, keyword="ENDO-LAL"):
    """The endo role's whole whitelist is one keyword, so seed_analyses_for_vial
    (role='endo') is the narrowest end-to-end probe of the skip set."""
    return _service(db, keyword=keyword, origin=origin)


def _seed_endo(db, sub, commit=False):
    return seed_analyses_for_vial(
        db,
        sub_sample=sub,
        role="endo",
        wp_services={"endotoxin": True},
        commit=commit,
    )


def test_seeder_skips_drifted_native_row_by_service_id(host):
    """A native vial row whose stored keyword has drifted from the catalog must
    STILL count as already-seeded, keyed by service id.

    Before Task 4 the drifted keyword missed the keyword-only skip set and the
    seeder re-seeded the same service — which under the new
    uq_lims_analyses_sub_service_id_root is an IntegrityError, i.e. check-in
    breaks on exactly the rows S3 exists to converge."""
    db, parent, sub = host
    svc = _endo_svc(db, origin="mk1")
    _vial_row(db, sub, svc, stored_keyword="ENDO-LAL-OLD")   # drifted
    db.commit()

    created = _seed_endo(db, sub)

    assert created == [], (
        "drifted native row must skip by service id; the seeder re-seeded "
        f"{[r.keyword for r in created]}"
    )
    rows = db.execute(
        LimsAnalysis.__table__.select().where(
            LimsAnalysis.lims_sub_sample_pk == sub.id
        )
    ).all()
    assert len(rows) == 1, "the vial must still carry exactly one row for this service"


def test_seeder_senaite_row_still_skips_by_stored_keyword(host):
    """The unchanged twin: a senaite row keeps the keyword as its identity
    contract, and an undrifted one skips exactly as it did pre-S3."""
    db, parent, sub = host
    svc = _endo_svc(db, origin="senaite")
    _vial_row(db, sub, svc, stored_keyword="ENDO-LAL")
    db.commit()

    assert _seed_endo(db, sub) == [], "senaite keyword skip must be unchanged"


def test_seeder_dead_rows_block_nothing_in_either_set(host):
    """The comment contract at the skip-set query: rejected/retracted rows do
    NOT block, so a service rejected on the vial and later re-added resurrects
    as a fresh active row next to the dead one. This row is dead on BOTH keys
    (same service id AND same keyword) — if either set had picked it up, the
    resurrection would silently no-op."""
    db, parent, sub = host
    svc = _endo_svc(db, origin="mk1")
    _vial_row(db, sub, svc, stored_keyword="ENDO-LAL", state="rejected")
    db.commit()

    created = _seed_endo(db, sub)

    assert len(created) == 1, "a dead row must not block resurrection-seeding"
    assert created[0].analysis_service_id == svc.id


def test_seeder_mirror_skips_drifted_native_but_still_seeds_a_new_service(host, monkeypatch):
    """The second consumer — the HPLC parent mirror — converts coherently, and
    the skip does not over-reach: PUR_A is skipped because a drifted row for
    that SERVICE already exists, while PUR_B (a service with no row at all)
    still seeds. Before Task 4 both were seeded."""
    db, parent, sub = host
    dept = Department(name=ANALYTICAL_DEPARTMENT)
    db.add(dept)
    db.flush()

    svc_a = _service(db, keyword="PUR_A", origin="mk1")
    svc_b = _service(db, keyword="PUR_B", origin="mk1")
    svc_a.department_id = dept.id
    svc_b.department_id = dept.id
    _vial_row(db, sub, svc_a, stored_keyword="PUR_A_OLD")     # drifted
    db.commit()

    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda _sid: ["PUR_A", "PUR_B"],
    )
    created = seed_analyses_for_vial(
        db,
        sub_sample=sub,
        role="hplc",
        wp_services={"hplcpurity_identity": True},
        parent_sample_id=parent.sample_id,
        commit=False,
    )

    assert [r.keyword for r in created] == ["PUR_B"], (
        "mirror must skip the drifted native service and still seed the new one"
    )


# ═══ Task 5: native vial add / delete ════════════════════════════════════════
#
# Both functions took keyword-only identity off the Manage Analyses wire. The
# add path is the sharper one: it RESOLVED a service and then guarded on that
# service's keyword string — so a vial already carrying the service under a
# drifted stored keyword read as "not present" and a second row was minted.
# Under Task 2's uq_lims_analyses_sub_service_id_root that insert is now an
# IntegrityError, so the guard has to catch it first and raise the clean 409.
#
# Harness note (same as Task 4's): create_all does NOT build the partial unique
# indexes, so these assert on the guard, not on the index behind it.


def _native_vial_svc(db, *, keyword, origin="mk1", senaite_uid=None):
    svc = _service(db, keyword=keyword, origin=origin)
    svc.senaite_uid = senaite_uid
    db.flush()
    return svc


# ─── add: resolution order ───────────────────────────────────────────────────


def test_add_analysis_to_native_vial_by_service_id(host):
    """analysis_service_id alone resolves the service — no keyword, no uid."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_NEW")
    db.commit()

    row = add_analysis_to_native_vial(
        db,
        sub_sample_pk=sub.id,
        senaite_service_uid=None,
        keyword=None,
        analysis_service_id=svc.id,
        user_id=None,
    )

    assert row.analysis_service_id == svc.id
    assert row.keyword == "PUR_NEW", "the row is stamped with the catalog keyword"
    assert row.review_state == "unassigned"


def test_add_analysis_to_native_vial_keyword_alias_still_works(host):
    """The pre-S3 wire is untouched: keyword alone still resolves."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_KW")
    db.commit()

    row = add_analysis_to_native_vial(
        db,
        sub_sample_pk=sub.id,
        senaite_service_uid=None,
        keyword="PUR_KW",
        user_id=None,
    )

    assert row.analysis_service_id == svc.id


def test_add_analysis_to_native_vial_service_id_wins_over_the_aliases(host):
    """Resolution order is service_id → senaite_uid → keyword. When more than
    one is on the wire the service id decides, so a stale keyword/uid the FE
    happens to echo alongside it can never route the add to another service."""
    db, parent, sub = host
    wanted = _native_vial_svc(db, keyword="PUR_WANTED", senaite_uid="SN-WANTED")
    _native_vial_svc(db, keyword="PUR_OTHER", senaite_uid="SN-OTHER")
    db.commit()

    row = add_analysis_to_native_vial(
        db,
        sub_sample_pk=sub.id,
        senaite_service_uid="SN-OTHER",
        keyword="PUR_OTHER",
        analysis_service_id=wanted.id,
        user_id=None,
    )

    assert row.analysis_service_id == wanted.id


def test_add_analysis_to_native_vial_requires_an_identifier(host):
    """No identifier at all is still a BadRequest, exactly as before."""
    db, parent, sub = host
    db.commit()

    with pytest.raises(BadRequestError):
        add_analysis_to_native_vial(
            db, sub_sample_pk=sub.id, senaite_service_uid=None,
            keyword=None, user_id=None,
        )


def test_add_analysis_to_native_vial_unknown_service_id_404s(host):
    db, parent, sub = host
    db.commit()

    with pytest.raises(NotFoundError):
        add_analysis_to_native_vial(
            db, sub_sample_pk=sub.id, senaite_service_uid=None, keyword=None,
            analysis_service_id=999_999, user_id=None,
        )


# ─── add: the duplicate guard ────────────────────────────────────────────────


def test_add_analysis_to_native_vial_duplicate_guard_catches_drifted_keyword(host):
    """The defect this task retires.

    The vial already carries the service, stored under a drifted keyword. The
    pre-S3 guard resolved the service and then compared svc.keyword to the
    stored string — a miss — so it minted a SECOND row for the same service.
    The service-FK guard sees it."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_NEW")
    existing = _vial_row(db, sub, svc, stored_keyword="PUR_OLD")   # drifted
    db.commit()

    with pytest.raises(BadRequestError):
        add_analysis_to_native_vial(
            db, sub_sample_pk=sub.id, senaite_service_uid=None, keyword=None,
            analysis_service_id=svc.id, user_id=None,
        )

    rows = db.execute(
        LimsAnalysis.__table__.select().where(
            LimsAnalysis.lims_sub_sample_pk == sub.id
        )
    ).all()
    assert len(rows) == 1, "no duplicate may be minted"
    assert rows[0].id == existing.id


def test_add_analysis_to_native_vial_dead_row_does_not_block(host):
    """The guard's active-set contract survives the rekey: a rejected row for
    the same SERVICE must not block re-adding it."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_DEAD")
    _vial_row(db, sub, svc, stored_keyword="PUR_DEAD", state="rejected")
    db.commit()

    row = add_analysis_to_native_vial(
        db, sub_sample_pk=sub.id, senaite_service_uid=None, keyword=None,
        analysis_service_id=svc.id, user_id=None,
    )
    assert row.analysis_service_id == svc.id


def test_add_analysis_to_native_vial_senaite_origin_keeps_keyword_guard(host):
    """senaite services keep the keyword as their identity contract, so their
    guard leg is byte-identical to pre-S3: same keyword blocks."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="SEN_KW", origin="senaite")
    _vial_row(db, sub, svc, stored_keyword="SEN_KW")
    db.commit()

    with pytest.raises(BadRequestError):
        add_analysis_to_native_vial(
            db, sub_sample_pk=sub.id, senaite_service_uid=None,
            keyword="SEN_KW", user_id=None,
        )


# ─── delete: identity + the exactly-one rule ─────────────────────────────────


def test_delete_pristine_by_service_id(host):
    """A drifted native row is reachable by its service FK; the caller never
    has to know what string the row happens to store."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_NEW")
    row = _vial_row(db, sub, svc, stored_keyword="PUR_OLD")       # drifted
    db.commit()
    row_id = row.id

    delete_pristine_analysis(
        db, sub_sample_pk=sub.id, analysis_service_id=svc.id, user_id=7,
    )

    assert db.get(LimsAnalysis, row_id) is None


def test_delete_pristine_by_service_id_event_names_the_resolved_keyword(host):
    """The analysis_removed event is the only trace left after the hard-delete,
    so it must carry the ROW's keyword — on this path the caller passed none."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_NEW")
    _vial_row(db, sub, svc, stored_keyword="PUR_OLD")
    db.commit()

    delete_pristine_analysis(
        db, sub_sample_pk=sub.id, analysis_service_id=svc.id, user_id=7,
    )

    ev = db.execute(
        LimsSubSampleEvent.__table__.select().where(
            LimsSubSampleEvent.event == "analysis_removed"
        )
    ).mappings().one()
    assert ev["details"] == {"keyword": "PUR_OLD"}, (
        "the event must name the row that was removed, not the caller's input"
    )


def test_delete_pristine_keyword_alias_still_works(host):
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_KW")
    row = _vial_row(db, sub, svc, stored_keyword="PUR_KW")
    db.commit()
    row_id = row.id

    delete_pristine_analysis(db, sub_sample_pk=sub.id, keyword="PUR_KW", user_id=7)

    assert db.get(LimsAnalysis, row_id) is None


def test_delete_pristine_requires_exactly_one_identifier(host):
    """Neither → BadRequest. Both → BadRequest: two identifiers can disagree,
    and silently preferring one would delete a row the caller didn't name."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_BOTH")
    row = _vial_row(db, sub, svc, stored_keyword="PUR_BOTH")
    db.commit()
    row_id = row.id

    with pytest.raises(BadRequestError):
        delete_pristine_analysis(db, sub_sample_pk=sub.id, user_id=7)

    with pytest.raises(BadRequestError):
        delete_pristine_analysis(
            db, sub_sample_pk=sub.id, keyword="PUR_BOTH",
            analysis_service_id=svc.id, user_id=7,
        )

    assert db.get(LimsAnalysis, row_id) is not None, "neither call may delete"


def test_delete_pristine_by_service_id_still_guards_activity(host):
    """The pristine guards are identity-agnostic: reaching a worked row by its
    service id must still refuse and point at retract."""
    db, parent, sub = host
    svc = _native_vial_svc(db, keyword="PUR_WORKED")
    row = _vial_row(db, sub, svc, stored_keyword="PUR_OLD", state="to_be_verified")
    row.result_value = "99.00"
    db.commit()

    with pytest.raises(BadRequestError):
        delete_pristine_analysis(
            db, sub_sample_pk=sub.id, analysis_service_id=svc.id, user_id=7,
        )
    assert db.get(LimsAnalysis, row.id) is not None


# ─── HTTP layer: the new field reaches the service ───────────────────────────
#
# Route pins, because the service-layer tests above pass just as well when the
# route never forwards the field. Fixture follows test_native_manage_analyses'
# route_client (StaticPool so the ASGI thread shares the in-memory DB).


@pytest.fixture
def route_client():
    from unittest.mock import MagicMock

    from fastapi.testclient import TestClient
    from sqlalchemy.pool import StaticPool

    from auth import get_current_user
    from database import get_db
    from main import app

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()

    def _override_get_db():
        yield shared

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=42)

    tc = TestClient(app)
    tc._test_session = shared
    yield tc

    for dep, prev in ((get_db, prev_db), (get_current_user, prev_user)):
        if prev is None:
            app.dependency_overrides.pop(dep, None)
        else:
            app.dependency_overrides[dep] = prev
    shared.close()


def _native_host(db, *, sample_id="P-S3-R01"):
    """Parent + one mk1:// vial — the shape the explorer routes' native branch
    keys on (external_lims_uid LIKE 'mk1://%')."""
    parent = LimsSample(sample_id=sample_id, external_lims_system="mk1")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"mk1://{sample_id}-v1",
        sample_id=f"{sample_id}-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.flush()
    return parent, sub


def test_add_analysis_to_native_vial_route_threads_service_id(route_client):
    """POST body carries analysis_service_id and nothing else — no service_uid,
    which is the only identifier the route forwarded before."""
    db = route_client._test_session
    parent, sub = _native_host(db, sample_id="P-S3-R01")
    svc = _native_vial_svc(db, keyword="PUR_ROUTE")
    db.commit()

    resp = route_client.post(
        f"/explorer/samples/{sub.sample_id}/analyses",
        json={"analysis_service_id": svc.id},
    )

    assert resp.status_code == 200, resp.text
    row = db.execute(
        LimsAnalysis.__table__.select().where(
            LimsAnalysis.lims_sub_sample_pk == sub.id
        )
    ).mappings().one()
    assert row["analysis_service_id"] == svc.id


def test_add_analysis_to_native_vial_route_rejects_non_integer_service_id(route_client):
    """The body is an untyped dict, so a non-int must be refused at the edge
    rather than reaching a SQLAlchemy comparison."""
    db = route_client._test_session
    parent, sub = _native_host(db, sample_id="P-S3-R02")
    db.commit()

    resp = route_client.post(
        f"/explorer/samples/{sub.sample_id}/analyses",
        json={"analysis_service_id": "not-an-int"},
    )

    assert resp.status_code == 400, resp.text


def test_delete_pristine_route_threads_service_id_past_a_drifted_keyword(route_client):
    """The keyword stays in the path (it is the route's shape), but when
    ?analysis_service_id= is supplied the service id decides — here the path
    keyword names nothing at all and the drifted row is still removed."""
    db = route_client._test_session
    parent, sub = _native_host(db, sample_id="P-S3-R03")
    svc = _native_vial_svc(db, keyword="PUR_NEW")
    row = _vial_row(db, sub, svc, stored_keyword="PUR_OLD")     # drifted
    db.commit()
    row_id = row.id

    resp = route_client.delete(
        f"/explorer/samples/{sub.sample_id}/analyses/PUR_NEW"
        f"?analysis_service_id={svc.id}"
    )

    assert resp.status_code == 200, resp.text
    assert db.get(LimsAnalysis, row_id) is None


def test_delete_pristine_route_keyword_only_is_unchanged(route_client):
    """The pre-S3 wire — no query param — still resolves by the path keyword."""
    db = route_client._test_session
    parent, sub = _native_host(db, sample_id="P-S3-R04")
    svc = _native_vial_svc(db, keyword="PUR_KW", origin="senaite")
    row = _vial_row(db, sub, svc, stored_keyword="PUR_KW")
    db.commit()
    row_id = row.id

    resp = route_client.delete(f"/explorer/samples/{sub.sample_id}/analyses/PUR_KW")

    assert resp.status_code == 200, resp.text
    assert db.get(LimsAnalysis, row_id) is None


# ─── Task 6: COA pin staleness — native rows compare by service id ───────────
#
# `_apply_pin_override`'s mk1 branch guarded the pinned row with
# `row.keyword != analyte_keyword`. That disjunct reads the row's DENORMALIZED
# keyword echo, so a catalog rename after the row was stamped made a perfectly
# good pin look stale and blocked the COA. The guard now also accepts the row
# when the requested keyword resolves, through the mk1 catalog, to the row's
# own service — with the exact-keyword compare RETAINED as the pre-S3
# grandfather (Task 3's leg-2-before-leg-3, same reasoning).
#
# Pin STORAGE stays keyword-keyed (`CoaResultPin.analyte_keyword`) — ruled out
# of S3. Every test here therefore stores the pin under the keyword being
# resolved; only the ROW's echo drifts.


def _pin(db, *, parent_sample_id, analyte_keyword, row):
    from models import CoaResultPin

    db.add(CoaResultPin(
        parent_sample_id=parent_sample_id,
        analyte_keyword=analyte_keyword,
        mode="pin",
        source_sample_id=parent_sample_id,
        source_analysis_uid=f"mk1:{row.id}",
    ))
    db.flush()


def _base_decision(analyte_keyword):
    """A no-pin base decision, as the merge layer hands it to the override."""
    from coa.schemas import SourceDecision

    return SourceDecision(
        analyte_keyword=analyte_keyword,
        mode="auto",
        chosen=None,
        candidates=[],
        blocked=None,
    )


def test_pin_survives_native_keyword_rename(host):
    """Native row pinned; the catalog keyword was renamed after the row was
    stamped, so the row's stored echo has drifted. The staleness check must
    NOT flag stale_pin — the requested keyword resolves through the mk1
    catalog to this row's own service, which IS its identity."""
    from coa.source_resolver import _apply_pin_override

    db, parent, _sub = host
    svc = _service(db, keyword="PUR_NEW", origin="mk1")     # catalog: renamed
    row = _parent_row(db, parent, svc, stored_keyword="PUR_OLD")   # echo: stale
    _pin(db, parent_sample_id=parent.sample_id, analyte_keyword="PUR_NEW", row=row)
    db.commit()

    out = _apply_pin_override(db, parent.sample_id, "PUR_NEW", _base_decision("PUR_NEW"))

    assert out.blocked is None, out.blocked_detail
    assert out.mode == "pin"
    assert out.chosen is not None
    assert out.chosen.source_analysis_uid == f"mk1:{row.id}"
    assert out.chosen.value == "99.00"


def test_pin_exact_keyword_still_wins_over_the_catalog_resolve(host):
    """The pre-S3 leg is RETAINED, not replaced: a pinned row whose stored
    keyword IS the requested string stays fresh even when a DIFFERENT mk1
    service owns that catalog keyword (the drifted-squatter shape both root
    indexes permit — see _find_active_parent_row). A bare service comparison
    would newly block this COA."""
    from coa.source_resolver import _apply_pin_override

    db, parent, _sub = host
    # Service 1 drifted: its catalog keyword is now the string service 2's rows
    # are stored under.
    _service(db, keyword="PUR_KW", origin="mk1")
    other = _service(db, keyword="PUR_OTHER", origin="mk1")
    row = _parent_row(db, parent, other, stored_keyword="PUR_KW")
    _pin(db, parent_sample_id=parent.sample_id, analyte_keyword="PUR_KW", row=row)
    db.commit()

    out = _apply_pin_override(db, parent.sample_id, "PUR_KW", _base_decision("PUR_KW"))

    assert out.blocked is None, out.blocked_detail
    assert out.mode == "pin"
    assert out.chosen.source_analysis_uid == f"mk1:{row.id}"


def test_pin_senaite_origin_row_keeps_the_string_compare(host):
    """senaite-origin rows are byte-unchanged: their keyword IS their identity
    contract, grandfathered. The colliding mk1 service is here to mutation-
    check the resolve's `origin='mk1'` scoping — drop that term and the
    lowest-id match for 'PUR_NEW' becomes the SENAITE service itself, whose id
    is the row's, so this pin would wrongly resolve fresh."""
    from coa.source_resolver import _apply_pin_override

    db, parent, _sub = host
    sen = _service(db, keyword="PUR_NEW", origin="senaite")
    row = _parent_row(db, parent, sen, stored_keyword="PUR_OLD")   # drifted echo
    # Cross-origin keyword collision: uq_analysis_services_mk1_keyword is
    # PARTIAL on origin='mk1', so nothing stops this from existing.
    _service(db, keyword="PUR_NEW", origin="mk1")
    _pin(db, parent_sample_id=parent.sample_id, analyte_keyword="PUR_NEW", row=row)
    db.commit()

    out = _apply_pin_override(db, parent.sample_id, "PUR_NEW", _base_decision("PUR_NEW"))

    assert out.blocked == "stale_pin"
    assert out.chosen is None


def test_pin_falls_through_to_string_compare_with_no_native_resolution(host):
    """Requested keyword resolves to NO mk1 catalog service: the guard is the
    pre-S3 string compare, unchanged — a drifted native row is still stale."""
    from coa.source_resolver import _apply_pin_override

    db, parent, _sub = host
    svc = _service(db, keyword="PUR_CATALOG", origin="mk1")
    row = _parent_row(db, parent, svc, stored_keyword="PUR_OLD")
    # 'PUR_UNKNOWN' names no mk1 service at all.
    _pin(db, parent_sample_id=parent.sample_id, analyte_keyword="PUR_UNKNOWN", row=row)
    db.commit()

    out = _apply_pin_override(
        db, parent.sample_id, "PUR_UNKNOWN", _base_decision("PUR_UNKNOWN")
    )

    assert out.blocked == "stale_pin"
    assert out.chosen is None


def test_pin_service_match_does_not_bypass_the_liveness_guards(host):
    """The service leg only answers the IDENTITY question. A retracted row
    whose service matches the requested keyword is still stale — fail-closed
    on state/provenance/reportable is untouched."""
    from coa.source_resolver import _apply_pin_override

    db, parent, _sub = host
    svc = _service(db, keyword="PUR_NEW", origin="mk1")
    row = _parent_row(
        db, parent, svc, stored_keyword="PUR_OLD", state="retracted"
    )
    _pin(db, parent_sample_id=parent.sample_id, analyte_keyword="PUR_NEW", row=row)
    db.commit()

    out = _apply_pin_override(db, parent.sample_id, "PUR_NEW", _base_decision("PUR_NEW"))

    assert out.blocked == "stale_pin"
    assert out.chosen is None


# ─── (h) Task 7: the senaite-shape wire carries the native identity key ──────


def test_senaite_shape_wire_emits_the_rows_own_service_fk(host):
    """Both native and senaite-origin rows ship `analysis_service_id`.

    It is the ROW's FK, not the resolved catalog service's id: the two agree
    whenever the FK resolves, and only the row's own column is still truthful
    when it does not (services_by_id.get() returns None there).
    """
    from lims_analyses.service import _serialize_senaite_shape_rows

    db, parent, sub = host
    native_svc = _service(db, keyword="PUR_NEW", origin="mk1")
    native_row = _parent_row(db, parent, native_svc, stored_keyword="PUR_OLD")
    senaite_svc = _service(db, keyword="ENDO-LAL", origin="senaite")
    senaite_row = _vial_row(db, sub, senaite_svc, stored_keyword="ENDO-LAL")
    db.commit()

    out = _serialize_senaite_shape_rows(db, [native_row, senaite_row])

    by_uid = {o.uid: o for o in out}
    native = by_uid[f"mk1:{native_row.id}"]
    senaite = by_uid[f"mk1:{senaite_row.id}"]
    assert native.analysis_service_id == native_svc.id
    assert senaite.analysis_service_id == senaite_svc.id
    # The keyword the FE would join on is the DRIFTED one — which is exactly
    # why the service id has to ride alongside it.
    assert native.keyword == "PUR_OLD"
    assert native.service_origin == "mk1"


def test_senaite_shape_wire_service_id_survives_an_unresolvable_service(host):
    """FK pointing at no catalog row: service-derived fields go None, but the
    identity key itself still ships — it is read off the row, not off svc."""
    from lims_analyses.service import _serialize_senaite_shape_rows

    db, parent, _sub = host
    svc = _service(db, keyword="PUR_NEW", origin="mk1")
    row = _parent_row(db, parent, svc, stored_keyword="PUR_NEW")
    orphan_id = svc.id
    db.delete(svc)
    db.commit()

    out = _serialize_senaite_shape_rows(db, [row])

    assert out[0].analysis_service_id == orphan_id
    assert out[0].service_origin is None
