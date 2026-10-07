"""The Bac Water primary's order key(s), and native keywords.

`bac_water_panel` is the legacy WordPress wire key (SENAITE-routed by the
Integration Service). `bacteriostatic-water-panel` is the native profile key
(spec 2026-10-05, R1) that WordPress emits once `profile_key` is set on the
"Bac Water Panel" test-service row. Both mean "the customer bought the Bac
Water panel"; every place that keys demand, chips, or seeding on the BW
primary reads THIS set, never the literal. Mirrors catalog/hplc_keys.py.

Deliberately import-free: seeder, throughput (a pure, DB-free module) and
coa/bw_shim all import from here, so it must never pull in models or coa.
"""
LEGACY_BW_KEY = "bac_water_panel"
NATIVE_BW_KEY = "bacteriostatic-water-panel"
BW_PRIMARY_KEYS: frozenset[str] = frozenset({LEGACY_BW_KEY, NATIVE_BW_KEY})

# Native (origin=mk1) panel keyword -> the SENAITE keyword COABuilder's
# GenericAssayEngine and baked_specs read (spec R2). coa/bw_shim re-exports.
NATIVE_TO_LEGACY_KEYWORD: dict[str, str] = {
    "PH-BW": "PH-DETERM",
    "BENZYL-ALCOHOL-BW": "Benzyl_Alcohol_Assay",
    "FILL-VOLUME-BW": "FILL-NET-CONTENT",
}
BW_NATIVE_KEYWORDS: frozenset[str] = frozenset(NATIVE_TO_LEGACY_KEYWORD)


def bw_primary_selected(services: dict | None) -> bool:
    """True when any BW primary key is truthy in an order's services dict."""
    services = services or {}
    return any(bool(services.get(k)) for k in BW_PRIMARY_KEYS)


def bw_primary_count(entitlement: dict | None) -> int:
    """Max entitlement across the BW primary keys (variance replicate count).

    Precondition: values are ints, as produced by normalize_variance_entitlement.
    """
    entitlement = entitlement or {}
    return max((int(entitlement.get(k, 0) or 0) for k in BW_PRIMARY_KEYS), default=0)
