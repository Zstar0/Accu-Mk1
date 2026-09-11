"""Tests for the pure Ready-to-Publish engine (``backend/ready_to_publish.py``)."""
from datetime import datetime, time

from ready_to_publish import (
    ALL_VERIFIED,
    HOLD,
    READY_FULL,
    READY_PARTIAL,
    FlagIn,
    FlagTypeIn,
    GroupIn,
    SampleIn,
    TierIn,
    build_ready_rows,
    classify_lines,
    resolve_flag_kinds,
    resolve_hold_flag_slugs,
    resolve_ready_flag_kinds,
    sla_color,
    sort_rows,
    strip_identity_suffix,
)
from sla_engine import BusinessSchedule, sla_status_dict

SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone="America/Los_Angeles",
                            working_days=frozenset({0, 1, 2, 3, 4}))
NOW = datetime(2026, 9, 10, 18, 0)  # Thu 11:00 lab time
STANDARD = TierIn(id=1, name="Standard", target_minutes=1440, is_default=True, amber_threshold_percent=25)
USP71 = TierIn(id=3, name="USP71", target_minutes=6720, is_default=False)
MICRO = GroupIn(id=2, name="Microbiology", sla_tier_id=3, service_ids=frozenset({91}))
READY_T = FlagTypeIn(slug="new_type_3", label="Ready for Publish", color="#088000")
PARTIAL_T = FlagTypeIn(slug="new_type_4", label="Ready for Partial Publish", color="#7e8f00")
OTHER_T = FlagTypeIn(slug="blocker", label="Blocker", color="#e5484d")


def sample(pk, sid, status="verified", received=datetime(2026, 9, 8, 16, 0), **kw):
    return SampleIn(pk=pk, sample_id=sid, status=status, date_received=received, **kw)


def build(samples, line_states=None, flags=(), priorities=None, services_of=None, groups=(), **kw):
    return build_ready_rows(
        samples=samples, line_states_by_pk=line_states or {}, flags=flags,
        flag_types=(READY_T, PARTIAL_T, OTHER_T), priorities=priorities or {},
        services_of=services_of or {}, tiers=(STANDARD, USP71), groups=groups,
        schedule=SCHEDULE, holidays=frozenset(), now=NOW, **kw,
    )


# ── flag type resolution ────────────────────────────────────────────────────

def test_ready_flag_kinds_match_slug_then_label():
    kinds = resolve_ready_flag_kinds([
        READY_T, PARTIAL_T, OTHER_T,
        FlagTypeIn(slug="reseeded_x", label="Ready For Partial Publish"),
    ])
    assert kinds == {"new_type_3": READY_FULL, "new_type_4": READY_PARTIAL, "reseeded_x": READY_PARTIAL}


# ── line classification ─────────────────────────────────────────────────────

def test_classify_lines():
    assert classify_lines({}) == "no_lines"
    assert classify_lines({"HPLC-PUR": "verified", "ENDO-LAL": "published"}) == ALL_VERIFIED
    assert classify_lines({"HPLC-PUR": "verified", "ENDO-LAL": "to_be_verified"}) == "pending"


def test_strip_identity_suffix():
    assert strip_identity_suffix("Somatropin - Identity (HPLC)") == "Somatropin"
    assert strip_identity_suffix("BPC-157") == "BPC-157"


# ── selection rules ─────────────────────────────────────────────────────────

def test_all_verified_sample_qualifies_with_reason():
    rows = build([sample(1, "P-1")], {1: {"HPLC-PUR": "verified", "PEPT-Total": "verified"}})
    assert [r["sample_id"] for r in rows] == ["P-1"]
    assert rows[0]["reasons"] == [ALL_VERIFIED]
    assert rows[0]["lines"] == {"total": 2, "verified": 2, "pending": []}
    assert rows[0]["flags"] == []


def test_pending_line_without_flag_is_excluded():
    rows = build([sample(1, "P-1")], {1: {"HPLC-PUR": "verified", "ENDO-LAL": "to_be_verified"}})
    assert rows == []


def test_no_lines_without_flag_is_excluded():
    assert build([sample(1, "P-1")], {}) == []


def test_partial_flag_qualifies_despite_pending_lines():
    flags = [FlagIn(id=9, sample_id="P-2432", type_slug="new_type_4", status="in_progress", title="Waiting on USP 71")]
    rows = build([sample(1, "P-2432", status="waiting_for_addon_results")],
                 {1: {"HPLC-PUR": "published", "STERILITY_USP71": "to_be_verified"}}, flags)
    assert rows[0]["reasons"] == [READY_PARTIAL]
    assert rows[0]["lines"]["pending"] == ["STERILITY_USP71"]
    assert rows[0]["flags"] == [{
        "id": 9, "type": "new_type_4", "kind": READY_PARTIAL, "label": "Ready for Partial Publish",
        "color": "#7e8f00", "status": "in_progress", "title": "Waiting on USP 71",
    }]


def test_ready_flag_and_all_verified_both_listed():
    flags = [FlagIn(id=1, sample_id="P-1986", type_slug="new_type_3", status="open", title="Ready")]
    rows = build([sample(1, "P-1986")], {1: {"ID_Somatropin": "verified"}}, flags)
    assert rows[0]["reasons"] == [ALL_VERIFIED, READY_FULL]


def test_resolved_or_foreign_flags_do_not_qualify():
    flags = [
        FlagIn(id=1, sample_id="P-1", type_slug="new_type_3", status="resolved"),
        FlagIn(id=2, sample_id="P-1", type_slug="blocker", status="open"),
    ]
    assert build([sample(1, "P-1")], {1: {"HPLC-PUR": "to_be_verified"}}, flags) == []


def test_excluded_test_orders_dropped():
    rows = build([sample(1, "P-1")], {1: {"HPLC-PUR": "verified"}}, excluded_sample_ids=frozenset({"P-1"}))
    assert rows == []


def test_row_carries_order_customer_and_analytes():
    s = sample(1, "P-1", client="Acme", order="7001", email="a@b.c", lot="LOT-9",
               created_at=datetime(2026, 9, 1, 12, 0),
               analytes=("Somatropin - Identity (HPLC)", "", "BPC-157 - Identity (HPLC)"))
    row = build([s], {1: {"HPLC-PUR": "verified"}})[0]
    assert (row["client"], row["order"], row["email"], row["lot"]) == ("Acme", "7001", "a@b.c", "LOT-9")
    assert row["analytes"] == ["Somatropin", "BPC-157"]
    assert row["created_at"] == "2026-09-01T12:00:00"
    assert row["received_at"] == "2026-09-08T16:00:00"


# ── SLA ─────────────────────────────────────────────────────────────────────

def test_sla_uses_business_hours_and_default_tier():
    # Received Tue 09:00 lab (16:00 UTC), now Thu 11:00 lab → 8 + 8 + 2 = 18 business hours.
    row = build([sample(1, "P-1", received=datetime(2026, 9, 8, 16, 0))], {1: {"HPLC-PUR": "verified"}})[0]
    assert row["sla"]["tier"] == "Standard"
    assert row["sla"]["elapsed_minutes"] == 18 * 60
    assert row["sla"]["remaining_minutes"] == 1440 - 18 * 60
    assert row["sla"]["breached"] is False
    assert row["sla"]["color"] == "green"


def test_sla_group_tier_wins_over_default():
    row = build([sample(1, "P-1")], {1: {"STERILITY_USP71": "verified"}},
                services_of={1: {91}}, groups=(MICRO,))[0]
    assert row["sla"]["tier"] == "USP71" and row["sla"]["target_minutes"] == 6720


def test_sla_none_when_not_received():
    row = build([sample(1, "P-1", received=None)], {1: {"HPLC-PUR": "verified"}})[0]
    assert row["sla"] is None


def test_sla_color_mirrors_frontend_rule():
    assert sla_color(sla_status_dict(1440, 1500), STANDARD) == "red"
    assert sla_color(sla_status_dict(1440, 1440), STANDARD) == "green"   # at target, strict >
    assert sla_color(sla_status_dict(1440, 1200), STANDARD) == "amber"   # 16.7% left < 25%
    assert sla_color(sla_status_dict(1440, 600), STANDARD) == "green"


def test_priority_from_external_uid():
    s = sample(1, "P-1", external_uid="uid-1")
    row = build([s], {1: {"HPLC-PUR": "verified"}}, priorities={"uid-1": "expedited"})[0]
    assert row["priority"] == "expedited"


# ── sort ────────────────────────────────────────────────────────────────────

def _row(sid, color=None, remaining=0.0, priority="normal", received="2026-09-01"):
    sla = None if color is None else {"color": color, "remaining_minutes": remaining}
    return {"sample_id": sid, "sla": sla, "priority": priority, "received_at": received}


def test_sort_most_critical_first():
    rows = [
        _row("green-late", "green", 900, received="2026-09-05"),
        _row("nosla", None),
        _row("amber", "amber", 200),
        _row("red-recent", "red", -100),
        _row("red-old", "red", -600),
        _row("green-expedited", "green", 900, priority="expedited", received="2026-09-06"),
        _row("green-old", "green", 900, received="2026-09-01"),
    ]
    assert [r["sample_id"] for r in sort_rows(rows)] == [
        "red-old", "red-recent", "amber",
        "green-expedited", "green-old", "green-late",
        "nosla",
    ]


# ── On Hold ─────────────────────────────────────────────────────────────────

HOLD_T = FlagTypeIn(slug="new_type_7", label="On Hold", color="#64748b")


def build_h(samples, line_states, flags):
    return build_ready_rows(
        samples=samples, line_states_by_pk=line_states, flags=flags,
        flag_types=(READY_T, PARTIAL_T, HOLD_T), priorities={}, services_of={},
        tiers=(STANDARD,), groups=(), schedule=SCHEDULE, holidays=frozenset(), now=NOW,
    )


def test_hold_flag_type_matched_by_label_only():
    assert resolve_hold_flag_slugs([HOLD_T, READY_T, FlagTypeIn(slug="x", label="on-hold")]) == {"new_type_7", "x"}
    assert resolve_flag_kinds([HOLD_T, READY_T]) == {"new_type_3": READY_FULL, "new_type_7": HOLD}


def test_open_hold_flag_parks_row_without_dropping_it():
    flags = [FlagIn(id=77, sample_id="P-1", type_slug="new_type_7", status="open",
                    title="Customer paying invoice", created_at=datetime(2026, 9, 9, 12, 0))]
    rows = build_h([sample(1, "P-1")], {1: {"HPLC-PUR": "verified"}}, flags)
    assert rows[0]["reasons"] == [ALL_VERIFIED]
    assert rows[0]["hold"] == {
        "flag_id": 77, "type": "new_type_7", "label": "On Hold", "color": "#64748b",
        "status": "open", "title": "Customer paying invoice", "since": "2026-09-09T12:00:00",
    }


def test_resolved_hold_does_not_park_and_blocked_counts_as_open():
    flags = [
        FlagIn(id=1, sample_id="P-1", type_slug="new_type_7", status="resolved", title="old"),
        FlagIn(id=2, sample_id="P-2", type_slug="new_type_7", status="blocked", title="stuck"),
    ]
    rows = build_h([sample(1, "P-1"), sample(2, "P-2")],
                   {1: {"HPLC-PUR": "verified"}, 2: {"HPLC-PUR": "verified"}}, flags)
    by = {r["sample_id"]: r for r in rows}
    assert by["P-1"]["hold"] is None
    assert by["P-2"]["hold"]["title"] == "stuck"


def test_hold_alone_does_not_qualify_a_sample():
    flags = [FlagIn(id=1, sample_id="P-1", type_slug="new_type_7", status="open", title="hold")]
    assert build_h([sample(1, "P-1")], {1: {"HPLC-PUR": "to_be_verified"}}, flags) == []


def test_unheld_rows_have_hold_none():
    assert build_h([sample(1, "P-1")], {1: {"HPLC-PUR": "verified"}}, [])[0]["hold"] is None
