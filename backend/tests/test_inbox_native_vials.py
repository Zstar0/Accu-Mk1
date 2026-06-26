"""Unit tests for the native-vial inbox emission helper.

Container-mode parents are suppressed from /worksheets/inbox in favor of
their Mk1-native vials (spec 2026-06-11-vial-level-worksheets-inbox-design).
_build_native_vial_inbox_items mirrors the SENAITE loop's per-vial filters:
role, open-worksheet claims, prepped, no-analyses-left. Pure service-level
tests on in-memory sqlite — no SENAITE, no TestClient.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from main import INBOX_SUB_SAMPLE_COLUMNS, _build_native_vial_inbox_items
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    SamplePriority,
    ServiceGroup,
    service_group_members,
)


PARENT_ITEM = {
    "title": "BPC-157 10mg",
    "getClientTitle": "Acme Peptides",
    "getClientOrderNumber": "WP-555",
    "getDateReceived": "2026-06-10T15:00:00+00:00",
    "review_state": "sample_received",
}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def family(db):
    """Container parent + 3 native vials (2 hplc, 1 endo), each with one
    live analysis. Returns (parent, [sub1, sub2, sub3])."""
    grp = ServiceGroup(name="Analytics", color="sky")
    db.add(grp)
    svc = AnalysisService(title="Peptide Purity (HPLC)", keyword="HPLC-PUR")
    db.add(svc)
    db.flush()
    db.execute(service_group_members.insert().values(
        analysis_service_id=svc.id, service_group_id=grp.id,
    ))
    parent = LimsSample(
        sample_id="P-0300",
        external_lims_uid="senaite-uid-p0300",
        container_mode=True,
    )
    db.add(parent)
    db.flush()
    subs = []
    for seq, role in ((1, "hplc"), (2, "hplc"), (3, "endo")):
        sub = LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=f"mk1://nat-{seq:03d}",
            sample_id=f"P-0300-S{seq:02d}",
            vial_sequence=seq,
            assignment_role=role,
        )
        db.add(sub)
        db.flush()
        db.add(LimsAnalysis(
            lims_sub_sample_pk=sub.id,
            analysis_service_id=svc.id,
            keyword="HPLC-PUR",
            title="Peptide Purity (HPLC)",
            review_state="unassigned",
        ))
        subs.append(sub)
    db.commit()
    return parent, subs


def _as_inbox_rows(db, subs):
    """Re-select subs through the endpoint's column-limited tuple. Production
    hands _build_native_vial_inbox_items SQLAlchemy Rows (not ORM objects) —
    passing ORM objects here once masked a missing-column AttributeError."""
    ids = [s.id for s in subs]
    return db.execute(
        select(*INBOX_SUB_SAMPLE_COLUMNS)
        .where(LimsSubSample.id.in_(ids))
        .order_by(LimsSubSample.vial_sequence)
    ).all()


def _call(db, subs, **overrides):
    kwargs = dict(
        parent_item=PARENT_ITEM,
        parent_sample_id="P-0300",
        native_subs=_as_inbox_rows(db, subs),
        family_size=3,
        allowed_vial_roles={"hplc"},
        assigned_pairs=set(),
        assigned_uids_for_null_group=set(),
        hide_prepped=True,
        prepped_sub_pks=set(),
        prepped_senaite_ids=set(),
        priority_map={},
        order_priority=None,
        assignment_map={},
        keyword_to_peptide={},
    )
    kwargs.update(overrides)
    return _build_native_vial_inbox_items(db, **kwargs)


def test_emits_one_row_per_role_matching_native_vial(db, family):
    _parent, subs = family
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S01", "P-0300-S02"]
    first = items[0]
    assert first.uid == "mk1://nat-001"          # the vial's external_lims_uid
    assert first.is_parent is False
    assert first.parent_sample_id == "P-0300"
    assert first.container_mode is True
    assert first.vial_total == 3
    assert first.client_id == "Acme Peptides"
    assert first.analyses and first.analyses[0].keyword == "HPLC-PUR"


def test_non_container_parent_native_vials_carry_false_mode(db, family):
    """1.0.2 inbox fix: native vials under a NON-container (already-received)
    parent must emit with container_mode=False, not the old hardcoded True.
    The endpoint passes the parent's real mode through this param; this asserts
    the function honors it. The endpoint-level keep-the-parent-row behavior is
    covered by the integration test in test_worksheets_inbox.py."""
    _parent, subs = family
    items = _call(db, subs, container_mode=False)
    assert [i.sample_id for i in items] == ["P-0300-S01", "P-0300-S02"]
    assert all(i.container_mode is False for i in items)


def test_role_filter_micro(db, family):
    _parent, subs = family
    items = _call(db, subs, allowed_vial_roles={"ster", "endo"})
    assert [i.sample_id for i in items] == ["P-0300-S03"]


def test_claimed_vial_group_drops_analysis_and_row(db, family):
    """A vial whose only analysis-group is already on an open worksheet
    disappears (mirrors the SENAITE loop's assigned_pairs filter)."""
    _parent, subs = family
    grp_id = db.execute(select(ServiceGroup.id)).scalar_one()
    items = _call(db, subs, assigned_pairs={("mk1://nat-001", grp_id)})
    assert [i.sample_id for i in items] == ["P-0300-S02"]


def test_fully_claimed_uid_skipped(db, family):
    _parent, subs = family
    items = _call(db, subs, assigned_uids_for_null_group={"mk1://nat-002"})
    assert [i.sample_id for i in items] == ["P-0300-S01"]


def test_prepped_vial_hidden_by_pk_and_by_sample_id(db, family):
    _parent, subs = family
    items = _call(db, subs, prepped_sub_pks={subs[0].id})
    assert [i.sample_id for i in items] == ["P-0300-S02"]
    items = _call(db, subs, prepped_senaite_ids={"P-0300-S02"})
    assert [i.sample_id for i in items] == ["P-0300-S01"]
    # hide_prepped=False shows both
    items = _call(db, subs, prepped_sub_pks={subs[0].id}, hide_prepped=False)
    assert len(items) == 2


def test_vial_without_live_analyses_hidden(db, family):
    _parent, subs = family
    db.execute(
        LimsAnalysis.__table__.update()
        .where(LimsAnalysis.lims_sub_sample_pk == subs[0].id)
        .values(review_state="retracted")
    )
    db.commit()
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S02"]


def test_order_priority_inherited_and_persisted(db, family):
    """Order-level priority (WP payload) flows onto native vials exactly like
    step 4b does for parents: persisted to sample_priorities so it survives
    reloads and is read by the worksheet add endpoints."""
    _parent, subs = family
    items = _call(db, subs, order_priority="expedited")
    assert all(i.priority == "expedited" for i in items)
    persisted = db.execute(
        select(SamplePriority).where(SamplePriority.sample_uid == "mk1://nat-001")
    ).scalar_one()
    assert persisted.priority == "expedited"
    # Manual override wins over order priority
    items = _call(db, subs, order_priority="expedited",
                  priority_map={"mk1://nat-001": "normal"})
    assert items[0].priority == "normal"


def test_assignment_kind_passthrough(db, family):
    """Variance vials surface assignment_kind so the inbox can badge them
    (assignment_kind is the explicit per-vial variance marker, set at
    check-in — see project variance-bucket-assignment)."""
    _parent, subs = family
    db.execute(
        LimsSubSample.__table__.update()
        .where(LimsSubSample.id == subs[1].id)
        .values(assignment_kind="variance")
    )
    db.commit()
    items = _call(db, subs)
    by_id = {i.sample_id: i for i in items}
    assert by_id["P-0300-S01"].assignment_kind is None
    assert by_id["P-0300-S02"].assignment_kind == "variance"


def test_date_received_prefers_vial_own_timestamp(db, family):
    _parent, subs = family
    items = _call(db, subs)
    # received_at default=utcnow was set on insert — vial's own date wins
    assert items[0].date_received is not None
    assert items[0].date_received != PARENT_ITEM["getDateReceived"]


def test_promoted_vial_hidden(db, family):
    """A vial whose live analysis is `promoted` (rolled up to the parent = done)
    must NOT reappear in the inbox once its worksheet claim is gone.

    Regression for the 2026-06-25 incident: completing a Microbiology worksheet
    bounced fully-worked, promoted sterility vials back into the inbox because
    EXCLUDED_STATES dropped only rejected/retracted, not terminal done-states."""
    _parent, subs = family
    db.execute(
        LimsAnalysis.__table__.update()
        .where(LimsAnalysis.lims_sub_sample_pk == subs[0].id)
        .values(review_state="promoted")
    )
    db.commit()
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S02"]  # S01 (promoted) is done


def test_variance_verified_vial_hidden(db, family):
    """Variance vials finish at the vial-tier terminal state `variance_verified`
    (they are not `promoted`; the parent uses the mean model) and never get a
    sample_prep, so hide_prepped does not mask them. They must be excluded like
    `promoted` so they don't bounce back after worksheet completion."""
    _parent, subs = family
    db.execute(
        LimsAnalysis.__table__.update()
        .where(LimsAnalysis.lims_sub_sample_pk == subs[0].id)
        .values(review_state="variance_verified")
    )
    db.commit()
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S02"]


def test_retested_vial_reflects_live_row_not_superseded_original(db, family):
    """Visibility must follow the LIVE row (retested=False), not the superseded
    original (retest_of_id IS NULL). Here the original is non-terminal
    (to_be_verified) but the live retest is `promoted` (done) -> the vial is
    hidden. This is the P-0962-S03 shape from the incident, where reading the
    original masked the fact that the retest had already finished."""
    _parent, subs = family
    orig = db.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == subs[0].id)
    ).scalar_one()
    orig.review_state = "to_be_verified"
    orig.retested = True
    db.flush()
    db.add(LimsAnalysis(
        lims_sub_sample_pk=subs[0].id,
        analysis_service_id=orig.analysis_service_id,
        keyword="HPLC-PUR",
        title="Peptide Purity (HPLC)",
        review_state="promoted",
        retested=False,
        retest_of_id=orig.id,
    ))
    db.commit()
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S02"]  # S01 done via retest


def test_retested_vial_with_pending_live_row_still_shows(db, family):
    """Inverse guard: if the live retest row is non-terminal (needs rework),
    the vial MUST still appear — excluding done-states must not over-hide."""
    _parent, subs = family
    orig = db.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == subs[0].id)
    ).scalar_one()
    orig.review_state = "promoted"   # old, superseded
    orig.retested = True
    db.flush()
    db.add(LimsAnalysis(
        lims_sub_sample_pk=subs[0].id,
        analysis_service_id=orig.analysis_service_id,
        keyword="HPLC-PUR",
        title="Peptide Purity (HPLC)",
        review_state="unassigned",   # live, needs work
        retested=False,
        retest_of_id=orig.id,
    ))
    db.commit()
    items = _call(db, subs)
    assert [i.sample_id for i in items] == ["P-0300-S01", "P-0300-S02"]
