"""AST guard for S4's catalog_change_log (Slice 4): every wired route
function across Wave A (analysis-services), Wave B (profiles/SLA), Wave C
(vial-roles/departments/service-groups/bench-stations), and Task 7's
snapshot reprovision route must route its mutation through catalog/
change_log.py's apply_and_log/log_create/log_delete/log_members — never a
bare setattr-loop, db.add(), or db.delete() with no corresponding log call.

Amendment-audit idiom (test_amendment_audit.py's
test_grep_guard_every_construction_passes_details): parse main.py's AST
rather than grep/char-scan it, so a docstring or string literal containing
"apply_and_log(" or unbalanced parens can't desync a text-based scan, and
both call shapes (`apply_and_log(...)` and `some_module.apply_and_log(...)`)
are recognized structurally.

Exemptions — deliberately NOT in WIRED_FUNCTIONS below, and why (mirrors
change_log.py's module docstring):
  - SENAITE sync writers (workflow/observer.py, workflow/
    parent_mirror_reconcile.py, sub_samples/senaite.py): different files —
    mirror external SENAITE state into local rows, not a deliberate catalog
    edit by a human actor.
  - Boot seeds (catalog/vial_roles_seed.py, catalog/service_spec_seed.py,
    catalog/departments.py seed helpers): different files — first-boot/
    self-heal provisioning, not a runtime admin action.
  - record_spec_change (catalog/service_spec_audit.py): different file —
    analysis_service_specs already has its own dedicated before/after
    AuditLog trail; not doubled here.
  - The vial_roles.frozen flip (sub_samples/service.py ~line 1717):
    different file — a system-derived side effect of vial assignment, not
    a deliberate catalog edit.
  - _demote_other_default_tiers (main.py, SLA tiers) and the analogous
    inline bulk `.update({"is_default": False})` in create_service_group /
    update_service_group (main.py): a promotion/creation's bulk demotion of
    every OTHER default row is a side effect of the write being made, not
    the deliberate edit itself. Converting either bulk UPDATE into a
    per-row loop purely to log it would be a behavior change outside this
    slice's scope (Wave B/C rulings, documented inline at each call site).
    The promoted/created row's OWN change is logged via that same
    function's regular apply_and_log/log_create call — which IS covered
    below, so the function still passes the floor check.
"""
import ast
from pathlib import Path

MAIN_PY = Path(__file__).resolve().parents[1] / "main.py"

# Every route function wired to catalog/change_log.py, across all three
# waves. Wave B's create_analysis_profile / update_analysis_profile also
# contain a VialRole mint side-door call (and, on update, a member-
# department backfill call via set_analysis_profile_members) — those don't
# get separate list entries: any one qualifying call inside the function
# body satisfies the floor check below, so their side-door coverage comes
# through their own single entry here.
WIRED_FUNCTIONS = [
    # Wave A — analysis-services (6)
    "create_analysis_service",
    "update_analysis_service",
    "delete_analysis_service",
    "update_analysis_service_peptide",
    "update_analysis_service_result_type",
    "update_analysis_service_variance_capable",
    # Wave B — profiles + SLA (10)
    "create_analysis_profile",
    "update_analysis_profile",
    "delete_analysis_profile",
    "set_analysis_profile_members",
    "set_analysis_profile_ride_hosts",
    "create_sla_tier",
    "update_sla_tier",
    "delete_sla_tier",
    "set_sla_priority_tier",
    "delete_sla_priority_tier",
    # Wave C — vial-roles, departments, service-groups, bench-stations (12)
    "create_vial_role",
    "update_vial_role",
    "delete_vial_role",
    "create_department",
    "update_department",
    "delete_department",
    "create_service_group",
    "update_service_group",
    "delete_service_group",
    "set_service_group_members",
    "create_bench_station",
    "update_bench_station",
    # Task 7 — audited snapshot reprovision (2 branches: log_create when the
    # stored snapshot was NULL, else apply_and_log; either satisfies the
    # floor check below since both call nodes are present in the source).
    "reprovision_catalog_snapshot",
]

LOG_CALL_NAMES = {"apply_and_log", "log_create", "log_delete", "log_members"}


def _is_log_call(node: ast.Call) -> bool:
    """True for both `apply_and_log(...)` (ast.Name) and
    `catalog.change_log.apply_and_log(...)` (ast.Attribute) call shapes."""
    func = node.func
    if isinstance(func, ast.Name):
        return func.id in LOG_CALL_NAMES
    if isinstance(func, ast.Attribute):
        return func.attr in LOG_CALL_NAMES
    return False


def test_every_wired_route_calls_a_change_log_writer():
    tree = ast.parse(MAIN_PY.read_text(encoding="utf-8"), filename=str(MAIN_PY))

    functions_by_name: dict[str, list[ast.AST]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in WIRED_FUNCTIONS:
            functions_by_name.setdefault(node.name, []).append(node)

    # Floor assertion: every listed function must be FOUND in the AST — a
    # rename in main.py can't silently drop a function out of this scan
    # without the guard itself failing loud instead of vacuously passing.
    missing = [name for name in WIRED_FUNCTIONS if name not in functions_by_name]
    assert not missing, (
        f"wired route function(s) not found in main.py's AST (renamed or "
        f"removed?): {missing}"
    )

    unlogged = []
    for name in WIRED_FUNCTIONS:
        for fn_node in functions_by_name[name]:
            has_log_call = any(
                isinstance(n, ast.Call) and _is_log_call(n) for n in ast.walk(fn_node)
            )
            if not has_log_call:
                unlogged.append(f"{name} (main.py:{fn_node.lineno})")

    assert not unlogged, (
        "route function(s) with no apply_and_log/log_create/log_delete/"
        f"log_members call — catalog_change_log regression: {unlogged}"
    )
