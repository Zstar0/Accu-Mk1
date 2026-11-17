"""A promote from a page that no longer shows what the vial holds is refused.

The promote request carries the result the reviewer will see on the PARENT
(result_value, result_unit). Before this guard nothing compared the request
with the source vial row, so a page loaded before a correction could put the
old value, or the old unit, on the parent row that feeds the certificate while
the vial row moved to `promoted` holding the new one.

The parent value stays the caller's to choose (the single promote dialog lets
the reviewer edit it; the variance promote sends a mean), so the guard is on
what the page SAW: each source may carry seen_result_value / seen_result_unit,
and a source whose stored result differs is a 409 `source_changed`. A request
that sends neither is judged as before.

Fixtures (a native endotoxin service, one parent, two vials each holding a
to_be_verified 25 with no unit of its own, so it shows the service's EU/mL)
come from test_promote_flow.
"""
from __future__ import annotations

import pytest
from sqlalchemy.orm import sessionmaker

from lims_analyses.promote_flow import PromoteError, run_promote
from lims_analyses.schemas import PromoteRequest
from lims_analyses.service import apply_transition
from models import LimsAnalysis
from tests.test_promote_flow import (  # noqa: F401  (fixtures)
    USER,
    _parent_rows,
    cascade_calls,
    client,
    world,
)

KEYWORD = "ENDOTOXIN-USP85LAL"
SEEN = {"seen_result_value": "25", "seen_result_unit": "EU/mL"}


def _src(row, kind: str = "chosen", **seen) -> dict:
    return {"analysis_id": row.id, "contribution_kind": kind, **seen}


def _req(sources: list, value: str = "25") -> PromoteRequest:
    return PromoteRequest(keyword=KEYWORD, result_value=value, sources=sources)


def _changed(vial: str, now: str) -> dict:
    return {
        "code": "source_changed",
        "message": (
            f"{vial} Endotoxin USP85 LAL changed after this page loaded it: it now reads {now}. "
            "Reload the page, check the result, then promote again."
        ),
    }


def _refused(world, req: PromoteRequest) -> PromoteError:
    with pytest.raises(PromoteError) as e:
        run_promote(world.db, USER, req)
    assert _parent_rows(world) == []
    return e.value


def test_a_promote_that_saw_an_older_value_is_refused(world):
    row = world.rows[0]
    # corrected in place (the to_be_verified self-edge) after the page loaded 25
    apply_transition(world.db, analysis_id=row.id, kind="submit", result_value="27", user_id=None)

    e = _refused(world, _req([_src(row, **SEEN)]))

    assert (e.status, e.code) == (409, "source_changed")
    assert e.body == _changed("P-7101-S01", "27 EU/mL")
    world.db.refresh(row)
    assert (row.review_state, row.result_value) == ("to_be_verified", "27")


def test_a_promote_that_saw_an_older_unit_is_refused(world):
    row = world.rows[0]
    row.result_unit = "EU/mg"  # the same number, another unit: the unit alone was corrected
    world.db.commit()

    e = _refused(world, _req([_src(row, **SEEN)]))

    assert e.body == _changed("P-7101-S01", "25 EU/mg")


def test_a_promote_that_saw_the_row_as_it_is_goes_through(world):
    row = world.rows[0]
    # the row stores no unit, so the page showed the service's; spaces do not count
    seen = {"seen_result_value": " 25 ", "seen_result_unit": "EU/mL "}
    # the parent value is the reviewer's to edit in the dialog: 25.0 over a vial that reads 25
    resp = run_promote(world.db, USER, _req([_src(row, **seen)], value="25.0"))

    assert resp.parent.result_value == "25.0"
    world.db.refresh(row)
    assert row.review_state == "promoted"


def test_a_changed_source_of_a_mean_is_refused(world):
    one, two = world.rows
    apply_transition(world.db, analysis_id=two.id, kind="submit", result_value="31", user_id=None)

    # the page worked its mean out from 25 and 25
    e = _refused(world, _req([_src(one, "aggregated_in", **SEEN),
                              _src(two, "aggregated_in", **SEEN)], value="25.00"))

    assert e.body == _changed("P-7101-S02", "31 EU/mL")


def test_a_changed_reference_source_is_refused(world):
    one, two = world.rows
    apply_transition(world.db, analysis_id=two.id, kind="submit", result_value="31", user_id=None)

    e = _refused(world, _req([_src(one, **SEEN), _src(two, "reference", **SEEN)]))

    assert e.body == _changed("P-7101-S02", "31 EU/mL")


def test_a_value_seen_without_a_unit_is_compared_on_the_value_alone(world):
    """The variance promote knows each replicate's value, not its unit."""
    row = world.rows[0]
    row.result_unit = "EU/mg"
    world.db.commit()

    resp = run_promote(world.db, USER, _req([_src(row, seen_result_value="25")]))

    assert resp.parent.result_value == "25"


def test_a_source_retested_after_the_page_loaded_is_refused(world):
    row = world.rows[0]
    # the retest leaves the old row to_be_verified, marked retested, with a new row beside it
    apply_transition(world.db, analysis_id=row.id, kind="retest", user_id=None)

    e = _refused(world, _req([_src(row)]))  # with or without what the page saw

    assert (e.status, e.code) == (409, "source_changed")
    assert e.body == {
        "code": "source_changed",
        "message": (
            "P-7101-S01 Endotoxin USP85 LAL was retested after this page loaded it. "
            "Reload the page and promote the retest's result once it is entered."
        ),
    }


def test_the_route_answers_409_with_the_sentence(world, client):
    row = world.rows[0]
    apply_transition(world.db, analysis_id=row.id, kind="submit", result_value="27", user_id=None)

    r = client.post("/api/lims-analyses/promote", json={
        "keyword": KEYWORD, "result_value": "25", "sources": [_src(row, **SEEN)]})

    assert r.status_code == 409
    assert r.json() == {"detail": _changed("P-7101-S01", "27 EU/mL")}


def test_the_route_still_takes_a_body_that_says_nothing_of_what_it_saw(world, client):
    """Additive: an older page, or the worksheet promote, sends no seen fields."""
    row = world.rows[0]
    apply_transition(world.db, analysis_id=row.id, kind="submit", result_value="27", user_id=None)

    r = client.post("/api/lims-analyses/promote", json={
        "keyword": KEYWORD, "result_value": "27", "sources": [_src(row)]})

    assert r.status_code == 201


def test_a_callers_unflushed_change_to_the_row_survives_the_locked_re_read(world):
    """Production sessions do not autoflush (database.SessionLocal), and the
    transition re-reads its row under the lock: a change the caller made to
    that row and has not flushed must be written first, not dropped."""
    db = sessionmaker(bind=world.db.get_bind(), autoflush=False)()
    try:
        row = db.get(LimsAnalysis, world.rows[0].id)
        row.title = "Endotoxin, renamed by the caller"
        apply_transition(db, analysis_id=row.id, kind="submit", result_value="26",
                         user_id=None, commit=False)
        db.commit()
        db.refresh(row)
        assert (row.title, row.result_value) == ("Endotoxin, renamed by the caller", "26")
    finally:
        db.close()
