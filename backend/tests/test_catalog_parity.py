"""Parity: the catalog department mapping must reproduce the hardcoded routing
literals. If these fail, the catalog would disagree with current behavior."""
from catalog.departments import department_for_group_name, DEPARTMENT_NAMES
from sub_samples.service import _ROLE_DEPARTMENT_NAMES


def test_known_group_names_map_to_expected_departments():
    assert department_for_group_name("Analytics") == "Analytical"
    assert department_for_group_name("Microbiology") == "Microbiology"
    assert department_for_group_name("Endotoxin") == "Microbiology"


def test_unknown_group_name_returns_none():
    assert department_for_group_name("Nonsense") is None


def test_every_role_department_name_is_a_seeded_department():
    # Every department named in the role->department map must be a real seeded
    # department (post-conversion parity: the map holds department names now).
    for role, dept_names in _ROLE_DEPARTMENT_NAMES.items():
        for dname in dept_names:
            assert dname in DEPARTMENT_NAMES, f"role {role!r} dept {dname!r} not seeded"
