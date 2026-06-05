"""senaite-shape response carries result_type + result_options from the service."""
from __future__ import annotations

from models import AnalysisService, LimsSample, LimsSubSample, LimsAnalysis
from lims_analyses.service import list_analyses_in_senaite_shape


def _setup(db_session):
    svc = AnalysisService(
        title="Rapid Sterility Screening (PCR)", keyword="STER-PCR",
        result_type="select",
        result_options=[{"value": "1", "label": "Conforms"},
                        {"value": "0", "label": "Does Not Conform"}],
    )
    db_session.add(svc)
    db_session.flush()
    parent = LimsSample(sample_id="RT-0001", external_lims_uid="uid-RT-0001")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://x",
                        sample_id="RT-0001-S01", vial_sequence=1)
    db_session.add(sub)
    db_session.flush()
    a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                     keyword="STER-PCR", title="Rapid Sterility Screening (PCR)",
                     review_state="to_be_verified", result_value=None)
    db_session.add(a)
    db_session.commit()
    return sub


def test_shape_carries_result_type_and_options(db_session):
    sub = _setup(db_session)
    rows = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id, include_retests=False,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r.result_type == "select"
    assert [o.model_dump() for o in r.result_options] == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_shape_defaults_when_no_result_type(db_session):
    """A service with no configured result type yields result_type=None and
    result_options=[] — the FE text-input fallback path (no dropdown)."""
    svc = AnalysisService(
        title="Plain Numeric", keyword="PLAIN",
        result_type=None, result_options=None,
    )
    db_session.add(svc)
    db_session.flush()
    parent = LimsSample(sample_id="PL-0001", external_lims_uid="uid-PL-0001")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://pl",
                        sample_id="PL-0001-S01", vial_sequence=1)
    db_session.add(sub)
    db_session.flush()
    a = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                     keyword="PLAIN", title="Plain Numeric",
                     review_state="to_be_verified", result_value=None)
    db_session.add(a)
    db_session.commit()

    rows = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id, include_retests=False,
    )
    assert len(rows) == 1
    assert rows[0].result_type is None
    assert rows[0].result_options == []


def test_shape_retest_chain_with_include_retests(db_session):
    """include_retests=True returns both the original and retest rows, ordered
    oldest-first (by id), with retested=True on the original.

    This is the FE grouping contract: groupAnalysesByTitle takes
    rows[rows.length-1] as 'current' and rows.slice(0,-1) as 'history'.
    Oldest-first ordering means the newest row lands last (current), and
    the retested original lands in history with retested=True.
    """
    svc = AnalysisService(
        title="Endotoxin", keyword="ENDO-LAL",
        result_type="numeric", result_options=None,
    )
    db_session.add(svc)
    db_session.flush()
    parent = LimsSample(sample_id="CH-0001", external_lims_uid="uid-CH-0001")
    db_session.add(parent)
    db_session.flush()
    sub = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://ch",
                        sample_id="CH-0001-S01", vial_sequence=1)
    db_session.add(sub)
    db_session.flush()

    # Original row — will be marked retested
    old = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                       keyword="ENDO-LAL", title="Endotoxin",
                       review_state="to_be_verified", result_value="6.1",
                       retested=True)
    db_session.add(old)
    db_session.flush()

    # Retest row — points back at old, starts fresh
    new_row = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
                           keyword="ENDO-LAL", title="Endotoxin",
                           review_state="unassigned", result_value=None,
                           retest_of_id=old.id, retested=False)
    db_session.add(new_row)
    db_session.commit()

    # include_retests=False: only the original (retest_of_id IS NULL) comes back
    rows_no_retests = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id, include_retests=False,
    )
    assert len(rows_no_retests) == 1
    assert rows_no_retests[0].uid == f"mk1:{old.id}"

    # include_retests=True: both rows returned, oldest first (old.id < new_row.id)
    rows_with_retests = list_analyses_in_senaite_shape(
        db_session, host_kind="sub_sample", host_pk=sub.id, include_retests=True,
    )
    assert len(rows_with_retests) == 2

    # Oldest row first: the original (retested=True) is at index 0
    assert rows_with_retests[0].uid == f"mk1:{old.id}"
    assert rows_with_retests[0].retested is True
    assert rows_with_retests[0].result == "6.1"

    # Newest row last: the fresh retest (retested=False) is at index 1 — this
    # is what groupAnalysesByTitle selects as 'current'
    assert rows_with_retests[1].uid == f"mk1:{new_row.id}"
    assert rows_with_retests[1].retested is False
    assert rows_with_retests[1].result is None
