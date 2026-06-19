"""COA pre-flight blocker accumulation.

generate_sample_coa used to raise on the FIRST failing pre-flight gate
(unresolved sources, then missing attachments, then variance-not-locked), so a
lab clearing one blocker would immediately hit the next — whack-a-mole. These
cover the accumulator that collects EVERY applicable blocker so the COA console
can surface them all up front.
"""
from coa.preflight import collect_preflight_blockers, build_preflight_error


def test_collects_all_present_blockers_in_order():
    blockers = collect_preflight_blockers(
        unresolved=[{"analyte_name": "X", "reason": "no source"}],
        missing_attachments=[{"kind": "sample_image", "message": "Sample image — attach one"}],
        variance_locked_required=True,
    )
    assert [b["code"] for b in blockers] == [
        "unresolved_sources",
        "missing_attachments",
        "variance_not_locked",
    ]


def test_collects_the_two_the_user_hit():
    """Missing attachments AND variance-not-locked: BOTH returned, not just the
    first — this is the exact whack-a-mole the user reported."""
    blockers = collect_preflight_blockers(
        missing_attachments=[{"kind": "chromatogram", "message": "Chromatogram — attach one"}],
        variance_locked_required=True,
    )
    assert [b["code"] for b in blockers] == ["missing_attachments", "variance_not_locked"]


def test_empty_when_no_blockers():
    assert collect_preflight_blockers() == []


def test_single_blocker_keeps_specific_code_and_message():
    """One blocker => byte-compatible with the old single-gate 422 (specific
    code, the gate's own message) so nothing downstream regresses."""
    err = build_preflight_error(collect_preflight_blockers(variance_locked_required=True))
    assert err["code"] == "variance_not_locked"
    assert "Lock the variance set" in err["message"]
    assert len(err["blockers"]) == 1


def test_multi_blocker_message_lists_every_blocker():
    err = build_preflight_error(
        collect_preflight_blockers(
            missing_attachments=[{"kind": "sample_image", "message": "Sample image — attach one"}],
            variance_locked_required=True,
        )
    )
    assert err["code"] == "coa_preflight_blocked"
    msg = err["message"].lower()
    assert "variance set" in msg
    assert "attachment" in msg
    assert len(err["blockers"]) == 2
