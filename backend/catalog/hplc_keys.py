"""The HPLC primary's order key(s).

`hplcpurity_identity` is the legacy WordPress wire key (SENAITE-routed by
the Integration Service). `hplc-purity-identity` is the native profile key
(spec 2026-09-10) that WordPress emits once `profile_key` is set on the HPLC
test-service row. Both mean "the customer bought HPLC purity + identity";
every place that keys demand, chips, or seeding on the primary reads THIS
set, never the literal. Bac Water keeps its own key (`bac_water_panel`).
"""
LEGACY_HPLC_KEY = "hplcpurity_identity"
NATIVE_HPLC_KEY = "hplc-purity-identity"
HPLC_PRIMARY_KEYS: frozenset[str] = frozenset({LEGACY_HPLC_KEY, NATIVE_HPLC_KEY})


def hplc_primary_selected(services: dict | None) -> bool:
    """True when any HPLC primary key is truthy in an order's services dict."""
    services = services or {}
    return any(bool(services.get(k)) for k in HPLC_PRIMARY_KEYS)


def hplc_primary_count(entitlement: dict | None) -> int:
    """Max entitlement across the primary keys (variance replicate count).

    Precondition: values are ints, as produced by normalize_variance_entitlement.
    """
    entitlement = entitlement or {}
    return max((int(entitlement.get(k, 0) or 0) for k in HPLC_PRIMARY_KEYS), default=0)
