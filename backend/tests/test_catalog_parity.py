"""Parity: the catalog department mapping must reproduce the hardcoded routing
literals. If these fail, the catalog would disagree with current behavior."""
from catalog.departments import department_for_group_name, DEPARTMENT_NAMES
from sub_samples.service import _ROLE_GROUP_NAMES


def test_known_group_names_map_to_expected_departments():
    assert department_for_group_name("Analytics") == "Analytical"
    assert department_for_group_name("Microbiology") == "Microbiology"
    assert department_for_group_name("Endotoxin") == "Microbiology"


def test_unknown_group_name_returns_none():
    assert department_for_group_name("Nonsense") is None


def test_every_role_group_name_resolves_to_a_seeded_department():
    # Every group named in the hardcoded role->group map must land in a real department.
    for role, group_names in _ROLE_GROUP_NAMES.items():
        for gname in group_names:
            dept = department_for_group_name(gname)
            assert dept in DEPARTMENT_NAMES, f"role {role!r} group {gname!r} -> {dept!r} not seeded"
