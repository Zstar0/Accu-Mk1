"""COA wire vocabulary for NATIVE-BORN Bac Water rows (spec 2026-10-05 MB5).

Created minimal by the intake section (task M1) because the catalog seed
needs LEGACY_BW_ARCHETYPE before the COA section lands. The COA section
extends THIS file (is_native_bw_row, wire mapping); the keyword constants
live in catalog/bw_keys.py and are only re-exported here, never redefined.
"""
from catalog.bw_keys import BW_NATIVE_KEYWORDS, NATIVE_TO_LEGACY_KEYWORD  # noqa: F401

# The ONLY coa_archetype value that routes native BW rows onto page 1 via
# this shim. Imported by catalog/bw_native_seed.py.
LEGACY_BW_ARCHETYPE = "legacy_bw"
