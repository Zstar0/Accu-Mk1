"""COA text macros (endo slice 4, spec
docs/superpowers/specs/2026-10-13-endo-slice4-coa-text-macros-design.md section 4)."""
import math

import pytest

from coa.text_macros import MACROS, format_lod, format_number, resolve, unknown_macros

LOD = {"lod": "0.05 EU/mL"}
NONE = {"lod": ""}
METHOD = "Results and limit are per vial (the whole vial as one dose). [LOD {lod}.]"


def test_only_lod_is_known():
    assert MACROS == ("lod",)


def test_a_segment_with_a_value_prints_without_its_brackets():
    assert resolve(METHOD, LOD) == (
        "Results and limit are per vial (the whole vial as one dose). LOD 0.05 EU/mL.")


def test_a_segment_without_a_value_disappears_with_its_space():
    assert resolve(METHOD, NONE) == "Results and limit are per vial (the whole vial as one dose)."


def test_a_missing_value_counts_as_empty():
    assert resolve(METHOD, {}) == "Results and limit are per vial (the whole vial as one dose)."


@pytest.mark.parametrize("text", [
    "See note [1].",
    "Limits per USP <232> [ICP-MS]  and  {see}",
    "An unmatched [ bracket",
    "An unmatched ] bracket",
    "",
    "   leading and trailing   ",
])
def test_text_with_no_known_macro_is_returned_exactly(text):
    assert resolve(text, LOD) == text
    assert resolve(text, NONE) == text


def test_none_stays_none():
    assert resolve(None, LOD) is None


def test_a_macro_outside_a_segment_resolves_in_place():
    assert resolve("LOD {lod}", LOD) == "LOD 0.05 EU/mL"
    assert resolve("LOD {lod}", NONE) == "LOD"


def test_an_unknown_macro_stays_as_typed():
    # A profile written by SQL can carry one; the certificate must still build.
    assert resolve("Lot {lot}. [LOD {lod}.]", LOD) == "Lot {lot}. LOD 0.05 EU/mL."
    assert resolve("[Lot {lot}.]", NONE) == "[Lot {lot}.]"


def test_a_bracket_pair_without_a_macro_keeps_its_brackets_beside_a_segment():
    assert resolve("See [1]. [LOD {lod}.]", NONE) == "See [1]."
    assert resolve("See [1]. [LOD {lod}.]", LOD) == "See [1]. LOD 0.05 EU/mL."


def test_only_text_with_a_macro_is_cleaned():
    assert resolve("  Method:  LAL.  [LOD {lod}.]  ", NONE) == "Method: LAL."


def test_text_that_resolves_to_nothing_becomes_none():
    assert resolve("[LOD {lod}.]", NONE) is None


def test_a_newline_is_kept():
    assert resolve("Line one.\n[LOD {lod}.]", LOD) == "Line one.\nLOD 0.05 EU/mL."


@pytest.mark.parametrize("v, expected", [
    (0.005, "0.005"), (0.05, "0.05"), (0.01, "0.01"), (0.1, "0.1"),
    (25.0, "25"), (0.000001, "0.000001"), (0.0, "0"),
])
def test_format_number(v, expected):
    assert format_number(v) == expected


def test_format_lod_joins_distinct_values_in_row_order():
    rows = [(0.05, "EU/mL"), (0.01, "EU/mL"), (0.05, "EU/mL"), (None, None),
            (math.nan, "EU/mL"), (math.inf, "EU/mL")]
    assert format_lod(rows) == "0.05 EU/mL, 0.01 EU/mL"


def test_format_lod_with_no_value_is_empty():
    assert format_lod([]) == ""
    assert format_lod([(None, "EU/mL")]) == ""


def test_format_lod_without_a_unit_prints_the_number():
    assert format_lod([(0.05, None)]) == "0.05"


def test_unknown_macros_lists_each_unknown_name_once():
    assert unknown_macros("Lot {lot} {lod} {lot} {batch_no}") == ["lot", "batch_no"]
    assert unknown_macros("{lod} [1] {Upper} {}") == []
    assert unknown_macros(None) == []


def test_unknown_macros_reports_near_misses_of_a_known_macro():
    # {LOD} and { lod } are typos of {lod}; save validation must refuse them.
    assert unknown_macros("[LOD {LOD}.]") == ["LOD"]
    assert unknown_macros("{ lod }") == [" lod "]
    assert unknown_macros("{Lod} {lod}") == ["Lod"]
    assert unknown_macros("{LOD} {Lod} {LOD} {lot}") == ["LOD", "Lod", "lot"]


def test_a_near_miss_prints_as_typed_at_build_time():
    # resolve is unchanged: only save validation refuses a near miss.
    assert resolve("[LOD {LOD}.]", {"lod": "0.05 EU/mL"}) == "[LOD {LOD}.]"
