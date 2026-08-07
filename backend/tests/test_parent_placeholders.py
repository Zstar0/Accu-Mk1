from lims_analyses.parent_placeholders import PROVENANCE_ORDERED


def test_provenance_ordered_is_a_third_distinct_value():
    """Must not collide with the two existing provenances — every safety
    property (promote untouched, COA blind, workflow gates unperturbed)
    depends on it being neither."""
    assert PROVENANCE_ORDERED == "ordered"
    assert PROVENANCE_ORDERED not in ("canonical", "shadow")
