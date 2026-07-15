"""Tests for lims_analyses.service.list_parent_analyses_senaite_shape
(read-flip Layer 4 / Task 1) -- parent-tier analyses in senaite shape, via
the shared serializer extracted from the vial-tier senaite-shape adapter
(list_analyses_in_senaite_shape).

Uses the in-memory `db_session` fixture (tests/conftest.py) so these tests
are self-contained -- no dependency on seeded live-DB rows. Mirrors the
`_mk_*` helper style in test_worksheet_analyst_stamp.py.
"""
from __future__ import annotations

from models import (
    AnalysisService,
    HplcMethod,
    Instrument,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    User,
)


def _mk_parent(db, sample_id="TEST-L4-PARENT"):
    p = LimsSample(sample_id=sample_id)
    db.add(p)
    db.flush()
    return p


def _mk_service(db, keyword, title="TEST svc"):
    svc = AnalysisService(keyword=keyword, title=title)
    db.add(svc)
    db.flush()
    return svc


def _mk_user(db, email, first_name=None, last_name=None):
    u = User(
        email=email, hashed_password="x",
        first_name=first_name, last_name=last_name,
    )
    db.add(u)
    db.flush()
    return u


def _mk_parent_analysis(
    db, parent, svc, *,
    provenance="canonical", review_state="verified",
    mirror_review_state=None, retested=False, retest_of_id=None,
    keyword=None, title=None, **kw,
):
    a = LimsAnalysis(
        lims_sample_pk=parent.id,
        lims_sub_sample_pk=None,
        analysis_service_id=svc.id,
        keyword=keyword or svc.keyword,
        title=title or svc.title,
        review_state=review_state,
        provenance=provenance,
        mirror_review_state=mirror_review_state,
        retested=retested,
        retest_of_id=retest_of_id,
        **kw,
    )
    db.add(a)
    db.flush()
    return a


# ── contract 1: both provenances serialized, shadow reports mirror state ────


def test_parent_tier_lists_both_canonical_and_shadow_rows(db_session):
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc_a = _mk_service(db_session, "ANALYTE-1-PUR", "Analyte 1 (Purity)")
    svc_b = _mk_service(db_session, "ANALYTE-2-QTY", "Analyte 2 (Quantity)")

    canonical = _mk_parent_analysis(
        db_session, parent, svc_a, provenance="canonical",
        review_state="verified", result_value="98.5",
    )
    shadow = _mk_parent_analysis(
        db_session, parent, svc_b, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="to_be_verified",
        result_value="12.3",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    by_uid = {r.uid: r for r in rows}

    assert f"mk1:{canonical.id}" in by_uid, f"got uids={list(by_uid)}"
    assert f"mk1:{shadow.id}" in by_uid, f"got uids={list(by_uid)}"
    # canonical row reports its own review_state
    assert by_uid[f"mk1:{canonical.id}"].review_state == "verified"
    # shadow row reports mirror_review_state (the true SENAITE state),
    # NOT its own sentinel review_state column ("senaite_mirror")
    assert by_uid[f"mk1:{shadow.id}"].review_state == "to_be_verified"


# ── contract 2: retested/superseded rows excluded, replacement included ────


def test_shadow_retest_excludes_old_includes_new(db_session):
    """Shadow-side retest supersession (parent_mirror.mirror_parent_analysis's
    is_retest branch): the old row is stamped retested=True and the new row
    carries retest_of_id -- resolve_shadow_target's "current" signal."""
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc = _mk_service(db_session, "ANALYTE-1-PUR", "Analyte 1 (Purity)")

    old = _mk_parent_analysis(
        db_session, parent, svc, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="verified",
        retested=True, result_value="98.0",
    )
    new = _mk_parent_analysis(
        db_session, parent, svc, provenance="shadow",
        review_state="senaite_mirror", mirror_review_state="to_be_verified",
        retest_of_id=old.id, result_value=None,
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    uids = {r.uid for r in rows}
    assert f"mk1:{new.id}" in uids
    assert f"mk1:{old.id}" not in uids


def test_canonical_retracted_supersession_excludes_old_includes_new(db_session):
    """Canonical-side analog: promote_to_parent's retest-source supersession
    (and cascade_parent_retest_to_sources's un-promote) retracts the old
    parent row (review_state='retracted') but NEVER sets retested=True --
    only vial-tier rows flip that flag (tier_allows for TIER_PARENT is
    {publish, retract, auto}; 'retest' is not among them, so a canonical
    parent-tier row's `retested` column is unreachable/always False).
    A retested==False-only filter would leave the retracted row visible;
    the listing must exclude review_state='retracted' explicitly for
    canonical rows."""
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc = _mk_service(db_session, "ANALYTE-1-PUR", "Analyte 1 (Purity)")

    old = _mk_parent_analysis(
        db_session, parent, svc, provenance="canonical",
        review_state="retracted", retested=False, result_value="98.0",
    )
    new = _mk_parent_analysis(
        db_session, parent, svc, provenance="canonical",
        review_state="verified", retested=False, result_value="99.0",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    uids = {r.uid for r in rows}
    assert f"mk1:{new.id}" in uids
    assert f"mk1:{old.id}" not in uids


# ── contract 3: M/I resolve via FK; NULL M/I is legitimate output ──────────


def test_method_instrument_resolve_via_fk_and_null_is_legitimate(db_session):
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = _mk_parent(db_session)
    svc_with_mi = _mk_service(db_session, "ANALYTE-1-PUR", "Analyte 1 (Purity)")
    svc_without_mi = _mk_service(db_session, "ANALYTE-2-PUR", "Analyte 2 (Purity)")
    method = HplcMethod(name="TEST Method A")
    instrument = Instrument(name="TEST Instrument A")
    db_session.add_all([method, instrument])
    db_session.flush()

    with_mi = _mk_parent_analysis(
        db_session, parent, svc_with_mi, provenance="canonical",
        review_state="verified", method_id=method.id, instrument_id=instrument.id,
    )
    without_mi = _mk_parent_analysis(
        db_session, parent, svc_without_mi, provenance="canonical",
        review_state="verified",
    )

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    by_uid = {r.uid: r for r in rows}

    r1 = by_uid[f"mk1:{with_mi.id}"]
    assert r1.method == "TEST Method A"
    assert r1.method_uid == str(method.id)
    assert r1.instrument == "TEST Instrument A"
    assert r1.instrument_uid == str(instrument.id)

    # NULL M/I is legitimate (not an error) -- SENAITE-retest blanking by design
    r2 = by_uid[f"mk1:{without_mi.id}"]
    assert r2.method is None
    assert r2.method_uid is None
    assert r2.instrument is None
    assert r2.instrument_uid is None


# ── contract 4: unknown sample -> [] ────────────────────────────────────────


def test_unknown_parent_sample_returns_empty_list(db_session):
    from lims_analyses.service import list_parent_analyses_senaite_shape
    assert list_parent_analyses_senaite_shape(db_session, "NO-SUCH-PARENT-XYZ") == []


# ── contract 5: extraction proof -- vial-tier senaite-shape unchanged ──────


def test_vial_tier_senaite_shape_unchanged_by_extraction(db_session):
    """Representative pre/post assertion for the extraction refactor: the
    vial-tier senaite-shape adapter (list_analyses_in_senaite_shape) now
    routes through the same shared serializer as the new parent-tier
    listing. Its own review_state (never mirror_review_state -- vial-tier
    rows are always provenance='canonical'), uid, M/I, analyst, and
    promoted_to_parent_id fields must be unaffected by the extraction."""
    from lims_analyses.service import list_analyses_in_senaite_shape

    parent = _mk_parent(db_session, "TEST-L4-VIAL-PARENT")
    sub = LimsSubSample(
        sample_id="TEST-L4-VIAL-PARENT-S01",
        parent_sample_pk=parent.id,
        vial_sequence=1,
        external_lims_uid="TEST-L4-UID-S01",
    )
    db_session.add(sub)
    db_session.flush()
    svc = _mk_service(db_session, "ID_TEST", "TEST: Identity")
    method = HplcMethod(name="TEST Method B")
    db_session.add(method)
    db_session.flush()
    tech = _mk_user(db_session, "tech@lab.test")

    row = LimsAnalysis(
        lims_sub_sample_pk=sub.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=svc.title,
        review_state="to_be_verified",
        method_id=method.id,
        analyst_user_id=tech.id,
        result_value="55.0",
    )
    db_session.add(row)
    db_session.flush()

    rows = list_analyses_in_senaite_shape(db_session, host_kind="sub_sample", host_pk=sub.id)
    matching = [r for r in rows if r.uid == f"mk1:{row.id}"]
    assert matching, f"expected uid=mk1:{row.id}; got uids={[r.uid for r in rows]}"
    r = matching[0]
    assert r.review_state == "to_be_verified"   # own review_state, not mirror_review_state
    assert r.method == "TEST Method B"
    assert r.method_uid == str(method.id)
    assert r.analyst == "tech@lab.test"
    assert r.promoted_to_parent_id is None
