"""S3 identity-convergence guard -- every keyword-identity COMPARISON in the
native-analysis path is classified, and stays classified.

Native (mk1-origin) analysis rows key identity on `analysis_service_id`; a
row's `keyword` is a denormalized display echo that drifts when the catalog is
renamed. Comparing that echo is the drift class this slice retires. What
survives is either **debt with a named retirement condition** (SHRINKING) or
**keyword-by-ruling** (PERMANENT) -- a SENAITE boundary whose wire speaks
keyword, a catalog resolve whose input contract IS a string, or a site where
the keyword is the datum rather than the key.

The guard sweeps the seven files that carry the native path and requires every
matched site to appear in exactly one list. Both lists are also asserted
PRESENT: a listed site that stops matching fails, because an entry that no
longer names anything is a stale green -- the list stops describing the code and
a genuinely new violation can hide behind a passing test.

Matcher scope: COMPARISONS only. `ast.Compare` with a `.keyword` attribute on
either side, and `.keyword.in_(...)` / `.notin_(...)` / `.not_in(...)` calls.
Projections (`select(X.keyword)`), `.order_by(X.keyword)`, dict/set
construction and audit-detail payloads are NOT identity decisions and are
deliberately out of scope -- see test_matcher_ignores_projections_and_payloads,
which pins that boundary against a synthetic source.

Keys are `(relative_path, enclosing_function, compared_attribute_owner)` --
never line numbers, which rot on every edit above them. The owner component
splits functions that carry several legs with DIFFERENT dispositions (notably
`_find_active_parent_row`, whose LimsAnalysis leg is debt and whose
AnalysisService leg is sanctioned). Each entry also carries the number of sites
it covers, so deleting one leg of a two-leg site fails instead of passing on
set membership. The owner is a source-level name: renaming the local also fails
the guard, which is intended -- the classification is re-confirmed by hand.
"""
import ast
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]

# The native-analysis path. native_sections.py currently matches nothing; it
# stays in the sweep so a keyword comparison added there is caught on arrival.
SWEPT_FILES = (
    "lims_analyses/service.py",
    "lims_analyses/seeder.py",
    "lims_analyses/parent_mirror.py",
    "workflow/observer.py",
    "coa/source_resolver.py",
    "coa/native_sections.py",
    "main.py",
)

_MEMBERSHIP_METHODS = ("in_", "notin_", "not_in")


# ── SHRINKING: keyword identity that RETIRES. Reason names the condition ─────
# that removes the site. When one goes away, delete its entry in the same PR.
SHRINKING: dict[tuple[str, str, str], tuple[int, str]] = {
    ("lims_analyses/service.py", "_find_active_parent_row", "LimsAnalysis"): (
        1,
        "Leg 2 of the resolve ladder: selects a parent ANALYSIS row by the "
        "caller's keyword string. Retires when every retest sender (the SENAITE "
        "cascade and parent_retest callers) carries analysis_service_id -- leg 1 "
        "already short-circuits on it. Leg 3 below is a different disposition.",
    ),
    ("lims_analyses/service.py", "delete_pristine_analysis", "LimsAnalysis"): (
        1,
        "The keyword arm of the exactly-one-identifier contract: selects the "
        "ANALYSIS row to hard-delete by string, so a drifted stored keyword "
        "makes a live row unreachable. Retires when "
        "DELETE /explorer/samples/{id}/analyses/{keyword} stops taking the "
        "keyword as a path param (Task 5 added analysis_service_id as a query "
        "param; the string arm is the compatibility path).",
    ),
    ("main.py", "list_worksheets", "AnalysisService"): (
        1,
        "Department fallback for worksheet items whose analyses_json first entry "
        "carries only a keyword. Retires when worksheet items resolve their "
        "department through service-group membership (S2's subject) and the "
        "keyword fallback becomes dead. Classified as debt rather than a SENAITE "
        "boundary precisely because a parallel slice is converging on it.",
    ),
}


# ── PERMANENT: keyword by RULING. Never 'clean these up'. ────────────────────
PERMANENT: dict[tuple[str, str, str], tuple[int, str]] = {
    # --- SENAITE boundary translators: the wire itself speaks keyword ---
    ("lims_analyses/parent_mirror.py", "resolve_shadow_target", "AnalysisService"): (
        1,
        "SENAITE wire speaks keyword: the mirror is handed a keyword string and "
        "must resolve it to a service, deterministically to the lowest id when "
        "the catalog holds duplicates. There is no service id to key on.",
    ),
    ("workflow/observer.py", "_live_shadow", "LimsAnalysis"): (
        1,
        "Hook-site payloads carry only keyword -- it is the sole identifier both "
        "call sites supply (see the function's own docstring). Shadow rows are "
        "SENAITE-provenance; keyword is their identity contract.",
    ),
    ("main.py", "lookup_senaite_sample", "AnalysisService"): (
        1,
        "Service-group enrichment of a SENAITE-shaped payload: the analyses come "
        "off the SENAITE lookup keyed by keyword, with no local row to join on.",
    ),
    ("main.py", "lookup_senaite_sample", "a"): (
        1,
        "Same SENAITE payload, consumer half -- the map is keyed by the payload's "
        "own identifier, so the membership test must use it too.",
    ),
    ("main.py", "_build_analysis_debug_rows", "AnalysisService"): (
        1,
        "The registry-debug panel diffs a keyword-keyed SENAITE payload against "
        "local rows; keying the title backfill by service id would not join.",
    ),
    # --- The sanctioned _ident_clause idiom: senaite arm of an origin ternary --
    ("lims_analyses/service.py", "promote_to_parent", "row"): (
        1,
        "senaite arm of promote's source-identity validation. The native branch "
        "immediately above compares analysis_service_id; this elif only runs for "
        "senaite-origin sources, whose keyword IS their identity contract.",
    ),
    ("lims_analyses/service.py", "promote_to_parent", "LimsAnalysis"): (
        1,
        "The `else` arm of the _ident_clause ternary in retest-source "
        "supersession -- the sanctioned grandfathering shape this slice "
        "propagates, not a site it converts.",
    ),
    ("lims_analyses/service.py", "add_analysis_to_native_vial", "LimsAnalysis"): (
        1,
        "The `else` arm of the duplicate guard's _ident_clause ternary; the mk1 "
        "arm keys on the service FK. Senaite services keep keyword identity.",
    ),
    # --- Catalog resolves: a keyword STRING is the input contract ---
    ("lims_analyses/service.py", "_find_active_parent_row", "AnalysisService"): (
        1,
        "Leg 3, the native rescue: resolves the caller's string against the "
        "CATALOG scoped origin='mk1', then re-queries by the resolved service "
        "id. Task-6-sanctioned catalog-resolve class -- it is what lets a "
        "keyword-speaking caller reach a row whose stored echo drifted.",
    ),
    ("lims_analyses/service.py", "add_analysis_to_native_vial", "AnalysisService"): (
        1,
        "Catalog resolve of the wire's keyword param (third in the "
        "service_id -> senaite_uid -> keyword order). Resolves a CATALOG row, "
        "whose keyword column is authoritative -- not an analysis row's echo. "
        "Task 5 RULED keyword a kept compatibility alias.",
    ),
    ("lims_analyses/seeder.py", "select_services_for_role", "AnalysisService"): (
        1,
        "Resolves the role's frozen ROLE_TO_KEYWORDS whitelist against the "
        "catalog. seeder.py's own ruling: the map is never extended, catalog "
        "roles seed from Analysis Profile membership instead, and endo/ster "
        "'stay pinned here' -- never re-routed onto the catalog path.",
    ),
    ("coa/source_resolver.py", "_pin_row_identity_matches", "AnalysisService"): (
        1,
        "Leg 2 of the Task-6 OR-form: resolves the requested keyword against the "
        "catalog scoped origin='mk1' and matches THIS row's service id. "
        "Monotone freshness -- it can only un-block a false stale.",
    ),
    ("coa/source_resolver.py", "_pin_row_identity_matches", "row"): (
        1,
        "Leg 1, byte-identical to the pre-S3 guard: the exact stored keyword, "
        "and the whole answer for senaite rows. Retained deliberately so the "
        "OR-form stays widening -- dropping it would newly stale a pin that "
        "generates a COA today (Task 6 report, section 2).",
    ),
    # --- ANALYTE-slot translation / degradation contract ---
    ("lims_analyses/service.py", "resolve_parent_analyte_target", "AnalysisService"): (
        2,
        "ANALYTE-slot translation: both legs resolve catalog rows by keyword "
        "because the SENAITE parent slot is addressed by the ANALYTE-{n}-{cat} "
        "keyword string the write-back uses. Duplicate keywords are tolerated "
        "deterministically; a cross-peptide duplicate fails loudly instead.",
    ),
    ("lims_analyses/service.py", "cascade_parent_reject_to_vials", "LimsAnalysis"): (
        1,
        "Consumes _candidate_vial_keywords -- the degradation contract that maps "
        "a parent ANALYTE slot back to the vial keywords that can satisfy it. "
        "The candidate set is a set of STRINGS by construction; there is no "
        "service id to widen to without changing that contract.",
    ),
    ("lims_analyses/service.py", "cascade_parent_remove_from_vials", "LimsAnalysis"): (
        1,
        "Second _candidate_vial_keywords consumer -- same degradation contract.",
    ),
    ("lims_analyses/service.py", "classify_removal_impact", "LimsAnalysis"): (
        1,
        "Third _candidate_vial_keywords consumer -- same degradation contract. "
        "Must stay identical to the two cascades above or the impact preview "
        "would disagree with what the cascade then does.",
    ),
    # --- Cross-provenance collapse ---
    ("lims_analyses/service.py", "list_parent_analyses_senaite_shape", "r"): (
        1,
        "P-0143 cross-provenance keyword collapse. Keyword -- NOT service id -- is "
        "the collapse key on purpose: the mirror resolves duplicate-keyword "
        "services to the lowest id, so canonical and shadow can legitimately "
        "hold different service ids for the same logical line. Converting this "
        "regresses the double-render.",
    ),
    # --- keyword is the DATUM, not the key ---
    ("lims_analyses/service.py", "parent_retest", "active"): (
        1,
        "Audit detail, not row selection: the row is already resolved, and this "
        "compare only decides whether to record the caller's requested_keyword "
        "alongside the resolved identity when the two diverge (commit c506e213).",
    ),
    ("main.py", "update_analysis_service", "svc"): (
        1,
        "Catalog administration -- keyword is the field being EDITED. The compare "
        "detects a genuine value change before locking a sync-owned field into "
        "local_overrides. Not an identity lookup.",
    ),
    ("main.py", "validate_new_keyword", "AnalysisService"): (
        1,
        "Catalog keyword uniqueness check -- keyword is the subject of the "
        "validation, not a key standing in for one.",
    ),
    ("main.py", "_find_adoptable_orphan", "AnalysisService"): (
        1,
        "SENAITE delete/recreate adoption: when SENAITE re-mints a service under "
        "a new id, the keyword is the ONLY stable handle across the id change -- "
        "a service-id match is exactly what is unavailable here. Scoped "
        "origin='senaite'; mk1 rows are never adoption candidates.",
    ),
    # --- Task-4 ruled union skip ---
    ("lims_analyses/seeder.py", "mirror_parent_hplc_analyses", "svc"): (
        1,
        "Task-4 ruled UNION skip (`svc.id in ... or svc.keyword in ...`): "
        "already-seeded is the union of BOTH live root indexes. Collision-"
        "correct while the keyword index is still live (its retirement is RULED "
        "deferred past mirror decommission) -- dropping the keyword leg would let "
        "a duplicate slip past the index and raise on insert.",
    ),
    ("lims_analyses/seeder.py", "_seed_rows_from_services", "svc"): (
        1,
        "Same Task-4 ruled union skip, shared row-construction path.",
    ),
}


# Below the real count (28) on purpose: the per-entry presence assertions do the
# precise work. This floor only catches a matcher that silently stops seeing the
# code at all (an import-shape or parse change emptying the sweep), and sitting
# under the true count keeps a legitimately-added SHRINKING site from failing
# here for the wrong reason.
MATCHED_SITE_FLOOR = 24


def _keyword_attr_owner(node: ast.AST) -> str | None:
    """`LimsAnalysis.keyword` -> 'LimsAnalysis'; anything else -> None."""
    if isinstance(node, ast.Attribute) and node.attr == "keyword":
        return ast.unparse(node.value)
    return None


def _enclosing_functions(tree: ast.AST) -> dict[ast.AST, str]:
    """Innermost enclosing function name for every node (nested defs report the
    inner name; module-level nodes report '<module>')."""
    mapping: dict[ast.AST, str] = {}
    stack: list[str] = []

    class Walker(ast.NodeVisitor):
        def visit_FunctionDef(self, node):  # noqa: N802
            stack.append(node.name)
            self.generic_visit(node)
            stack.pop()

        visit_AsyncFunctionDef = visit_FunctionDef  # noqa: N815

        def generic_visit(self, node):
            mapping[node] = stack[-1] if stack else "<module>"
            super().generic_visit(node)

    Walker().visit(tree)
    return mapping


def _matched_owner(node: ast.AST) -> str | None:
    """THE matcher. Returns the compared attribute's owner for a keyword-identity
    comparison, else None. Comparisons only -- a projection, an `.order_by`, a
    dict/set build or an audit payload reaches `.keyword` without deciding
    identity, and none of those produce a Compare or a membership call."""
    if isinstance(node, ast.Compare):
        # Either side: `row.keyword == x`, `x == row.keyword`,
        # `r.keyword not in kws`.
        for operand in [node.left, *node.comparators]:
            owner = _keyword_attr_owner(operand)
            if owner is not None:
                return owner
        return None
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in _MEMBERSHIP_METHODS:
            return _keyword_attr_owner(func.value)
    return None


def _collect_from_source(
    source: str, rel_path: str, filename: str
) -> list[tuple[tuple[str, str, str], int, str]]:
    """Every keyword-identity comparison in one source text.

    Returns (key, lineno, source_line) where key is
    (rel_path, enclosing_function, compared_attribute_owner).
    """
    tree = ast.parse(source, filename=filename)
    enclosing = _enclosing_functions(tree)
    lines = source.splitlines()

    found: list[tuple[tuple[str, str, str], int, str]] = []
    for node in ast.walk(tree):
        owner = _matched_owner(node)
        if owner is None:
            continue
        key = (rel_path, enclosing.get(node, "<module>"), owner)
        found.append((key, node.lineno, lines[node.lineno - 1].strip()))
    return found


def _collect_sites(rel_path: str) -> list[tuple[tuple[str, str, str], int, str]]:
    path = BACKEND.joinpath(*rel_path.split("/"))
    return _collect_from_source(
        path.read_text(encoding="utf-8"), rel_path, str(path)
    )


def _all_sites() -> list[tuple[tuple[str, str, str], int, str]]:
    sites: list[tuple[tuple[str, str, str], int, str]] = []
    for rel in SWEPT_FILES:
        sites.extend(_collect_sites(rel))
    return sites


def _counts_by_key(sites) -> dict[tuple[str, str, str], list[tuple[int, str]]]:
    by_key: dict[tuple[str, str, str], list[tuple[int, str]]] = {}
    for key, lineno, text in sites:
        by_key.setdefault(key, []).append((lineno, text))
    return by_key


def _fmt(key, hits) -> str:
    rel, func, owner = key
    return "\n".join(
        f"    {rel}:{ln}  in {func}()  [owner: {owner}]\n      | {text}"
        for ln, text in hits
    )


def test_every_swept_file_parses():
    """A file that vanished or stopped parsing would silently drop its sites
    from every assertion below."""
    for rel in SWEPT_FILES:
        path = BACKEND.joinpath(*rel.split("/"))
        assert path.is_file(), f"swept file missing: {rel}"
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def test_no_unclassified_keyword_identity_site():
    """Every keyword-identity comparison is on exactly one list."""
    by_key = _counts_by_key(_all_sites())
    unlisted = {
        key: hits for key, hits in by_key.items()
        if key not in SHRINKING and key not in PERMANENT
    }
    assert not unlisted, (
        "Unclassified keyword-identity comparison(s) in the native-analysis "
        "path:\n"
        + "\n".join(_fmt(k, h) for k, h in sorted(unlisted.items()))
        + "\n\n  Native rows key identity on analysis_service_id; keyword is a "
        "display echo that drifts on catalog rename. Either key this site by "
        "service id, or classify it in "
        "backend/tests/test_identity_convergence_guard.py: SHRINKING (keyword "
        "identity that retires -- the reason must name what removes it) or "
        "PERMANENT (keyword by ruling -- the reason must say why it can never "
        "be a service id).\n"
        "  Key the entry by (relative_path, enclosing_function, "
        "compared-attribute owner) exactly as printed above, with the number of "
        "sites it covers."
    )


def test_no_stale_shrinking_entry():
    """A SHRINKING entry that stops matching is a stale green -- the debt list
    would no longer describe the code, and a new violation could hide behind a
    passing test. Retiring a site means deleting its entry in the same PR."""
    by_key = _counts_by_key(_all_sites())
    problems = []
    for key, (expected, reason) in sorted(SHRINKING.items()):
        hits = by_key.get(key, [])
        if not hits:
            problems.append(
                f"  GONE: {key}\n    listed as shrinking debt but matches "
                f"nothing now.\n    reason on file: {reason}\n"
                "    -> If the site was converted, DELETE this entry. If it "
                "moved or a local was renamed, re-key it."
            )
        elif len(hits) != expected:
            problems.append(
                f"  COUNT: {key} expected {expected} site(s), found "
                f"{len(hits)}:\n{_fmt(key, hits)}\n"
                "    -> A leg was added or removed. Re-confirm the "
                "classification and update the count."
            )
    assert not problems, "Stale SHRINKING entries:\n" + "\n".join(problems)


def test_permanent_sites_all_present_with_reasons():
    """PERMANENT entries are asserted present too: these are rulings about code
    that must keep existing. One disappearing means someone 'cleaned up' a
    SENAITE boundary, a catalog resolve, or the P-0143 collapse."""
    by_key = _counts_by_key(_all_sites())
    problems = []
    for key, (expected, reason) in sorted(PERMANENT.items()):
        assert reason and reason.strip(), f"PERMANENT entry {key} has no reason"
        hits = by_key.get(key, [])
        if not hits:
            problems.append(
                f"  GONE: {key}\n    ruled PERMANENT but matches nothing now.\n"
                f"    ruling: {reason}\n"
                "    -> This site was NOT debt. Converting it to a service-id "
                "comparison is a behavior regression (see the ruling above). "
                "Restore it, or get the ruling overturned and remove the entry "
                "deliberately."
            )
        elif len(hits) != expected:
            problems.append(
                f"  COUNT: {key} expected {expected} site(s), found "
                f"{len(hits)}:\n{_fmt(key, hits)}\n"
                "    -> A leg of a multi-leg ruled site changed. Re-read the "
                "ruling before updating the count."
            )
    assert not problems, "PERMANENT ruling violations:\n" + "\n".join(problems)


def test_matched_site_floor():
    """Guards against a change that empties the sweep (a moved file, a renamed
    module, an import shape the matcher stops recognizing) -- which would make
    every assertion above pass vacuously."""
    total = len(_all_sites())
    assert total >= MATCHED_SITE_FLOOR, (
        f"the keyword-identity sweep matched only {total} site(s), below the "
        f"floor of {MATCHED_SITE_FLOOR} -- the scan has likely stopped seeing "
        "the code rather than the code having been cleaned up. Check "
        "SWEPT_FILES against the real paths before lowering this."
    )


@pytest.mark.parametrize(
    "snippet, expected",
    [
        # --- comparisons: MATCHED ---
        ("def f():\n    q(LimsAnalysis.keyword == kw)\n", 1),
        ("def f():\n    q(kw == LimsAnalysis.keyword)\n", 1),
        ("def f():\n    if row.keyword != kw:\n        pass\n", 1),
        ("def f():\n    if r.keyword not in kws:\n        pass\n", 1),
        ("def f():\n    q(LimsAnalysis.keyword.in_(kws))\n", 1),
        ("def f():\n    q(LimsAnalysis.keyword.notin_(kws))\n", 1),
        ("def f():\n    q(LimsAnalysis.keyword.not_in(kws))\n", 1),
        # --- projections / ordering / payloads: NOT matched ---
        ("def f():\n    q(select(AnalysisService.keyword, X.title))\n", 0),
        ("def f():\n    q(stmt.order_by(LimsAnalysis.keyword, LimsAnalysis.id))\n", 0),
        ("def f():\n    kws = {r.keyword for r in rows}\n", 0),
        ("def f():\n    m = {r.keyword: r for r in rows}\n", 0),
        ("def f():\n    details = {'keyword': row.keyword}\n", 0),
        ("def f():\n    q(AnalysisService.keyword.like('ID%'))\n", 0),
        # keyword-adjacent columns are not keyword identity
        ("def f():\n    q(LimsAnalysis.analysis_service_id == svc.id)\n", 0),
    ],
)
def test_matcher_ignores_projections_and_payloads(snippet, expected):
    """Pins the matcher's scope: comparisons in, projections/ordering/dict and
    set construction out. Runs the REAL collector (not a copy of its logic), so
    narrowing the matcher -- which would empty the unlisted-site assertion and
    look like a clean refactor -- fails here."""
    hits = _collect_from_source(snippet, "<probe>", "<probe>")
    assert len(hits) == expected, (
        f"matcher scope changed for {snippet!r}: expected {expected} match(es), "
        f"got {[(k, ln) for k, ln, _ in hits]}"
    )
    for (rel, func, _owner), _ln, _text in hits:
        assert (rel, func) == ("<probe>", "f")
