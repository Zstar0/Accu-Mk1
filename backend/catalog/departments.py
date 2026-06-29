"""Catalog department assignment.

Single source of truth for which top-level Department a service group belongs to.
Derived to match the existing hardcoded routing literals (sub_samples.service
._ROLE_GROUP_NAMES, lims_analyses.seeder._NON_HPLC_GROUPS): Analytics is the
Analytical bench; Microbiology and Endotoxin are both the Microbiology bench.
"""
from typing import Optional

DEPARTMENT_NAMES = ["Analytical", "Microbiology"]

# Group name -> department name. Endotoxin nests under Microbiology (the
# assignment UI already shows Endo + Sterility inside the Microbiology block).
_GROUP_NAME_TO_DEPARTMENT = {
    "Analytics": "Analytical",
    "Microbiology": "Microbiology",
    "Endotoxin": "Microbiology",
}


def department_for_group_name(group_name: str) -> Optional[str]:
    """Return the department name for a service group, or None if unknown."""
    return _GROUP_NAME_TO_DEPARTMENT.get(group_name)
