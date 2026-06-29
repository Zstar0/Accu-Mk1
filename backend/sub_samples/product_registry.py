"""Single source mapping a WP order's purchased services to display products +
their vial-fulfillment, for the sample-page PRODUCTS section.

Adding a product = add one ProductDef (see 2026-06-27 ordered-products spec, D0).
Fail-open: unknown purchased keys still render (no alert)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProductDef:
    key: str
    label: str
    is_addon: bool
    fulfillment_role: str | None   # vial value that fulfills it; None = base/always-run
    fulfillment_dim: str           # "role" (assignment_role) or "kind" (assignment_kind)


# Package tier — `package` is not part of the `services` dict, so it is keyed separately.
_PACKAGE_PRODUCTS: dict[str, ProductDef] = {
    "core": ProductDef("core", "Core HPLC", False, None, "role"),
    "accushield": ProductDef("accushield", "AccuShield", False, None, "role"),
}

# Service-key products. Addon fulfillment_role mirrors seeder.ROLE_TO_WP_KEYS.
PRODUCT_REGISTRY: dict[str, ProductDef] = {
    "hplcpurity_identity": ProductDef("hplcpurity_identity", "HPLC", False, None, "role"),
    "bac_water_panel": ProductDef("bac_water_panel", "Bac Water", False, None, "role"),
    "endotoxin": ProductDef("endotoxin", "Endotoxin", True, "endo", "role"),
    "sterility_pcr": ProductDef("sterility_pcr", "Sterility", True, "ster", "role"),
    "variance": ProductDef("variance", "Variance HPLC", True, "variance", "kind"),
}


def _as_dict(p: ProductDef) -> dict:
    return {
        "key": p.key, "label": p.label, "is_addon": p.is_addon,
        "fulfillment_role": p.fulfillment_role, "fulfillment_dim": p.fulfillment_dim,
    }


def _derive_label(key: str) -> str:
    return key.replace("_", " ").title()


def build_ordered_products(services: dict, package: str | None) -> list[dict]:
    # Lazy import: service.py imports nothing from here, but keep the edge one-way.
    from sub_samples.service import normalize_variance_entitlement

    services = services or {}
    out: list[dict] = []
    seen: set[str] = set()

    # 1) Base package chip first.
    if package:
        pdef = _PACKAGE_PRODUCTS.get(package)
        if pdef is None:
            log.warning("unregistered_product_key key=%s kind=package", package)
            pdef = ProductDef(package, _derive_label(package), False, None, "role")
        out.append(_as_dict(pdef))
        seen.add(pdef.key)

    has_package = bool(package)

    # 2) Service-key products.
    for key, val in services.items():
        if key == "variance":
            if normalize_variance_entitlement(services):  # >=2 floor; override already merged upstream
                out.append(_as_dict(PRODUCT_REGISTRY["variance"]))
                seen.add("variance")
            continue
        if key == "samplevariance":
            # WP buy-flag (bool) alias of the `variance` data-points dict handled
            # above. The variance product is rendered from `variance`; this raw
            # key must never render too, or it double-renders as a stray
            # fail-open "Samplevariance" chip (it isn't a distinct product).
            continue
        if not val:
            continue
        if key == "hplcpurity_identity" and has_package:
            continue  # implied by the package — avoid a redundant chip
        pdef = PRODUCT_REGISTRY.get(key)
        if pdef is None:
            log.warning("unregistered_product_key key=%s", key)
            pdef = ProductDef(key, _derive_label(key), True, None, "role")
        if pdef.key not in seen:
            out.append(_as_dict(pdef))
            seen.add(pdef.key)

    return out
