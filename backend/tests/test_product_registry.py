from sub_samples.product_registry import build_ordered_products, PRODUCT_REGISTRY, ProductDef
from lims_analyses.seeder import ROLE_TO_WP_KEYS


def labels(products):
    return [p["label"] for p in products]


def test_core_package_maps_and_suppresses_redundant_hplc():
    out = build_ordered_products({"hplcpurity_identity": True}, "core")
    assert labels(out) == ["Core HPLC"]  # no separate "HPLC" chip when packaged


def test_accushield_plus_addons_order_and_flags():
    out = build_ordered_products(
        {"hplcpurity_identity": True, "endotoxin": True, "sterility_pcr": True}, "accushield"
    )
    assert labels(out) == ["AccuShield", "Endotoxin", "Sterility"]
    addon = {p["key"]: p for p in out}
    assert addon["endotoxin"]["is_addon"] and addon["endotoxin"]["fulfillment_role"] == "endo"
    assert addon["sterility_pcr"]["fulfillment_role"] == "ster"
    assert addon["sterility_pcr"]["fulfillment_dim"] == "role"


def test_standalone_hplc_without_package_shows_hplc_chip():
    out = build_ordered_products({"hplcpurity_identity": True}, None)
    assert labels(out) == ["HPLC"]


def test_variance_uses_normalized_entitlement():
    # raw map present but below the >=2 floor -> NOT purchased
    out = build_ordered_products({"variance": {"hplcpurity_identity": 1}}, "core")
    assert "Variance HPLC" not in labels(out)
    # >=2 -> purchased, single chip, kind-dimension fulfillment
    out2 = build_ordered_products({"variance": {"hplcpurity_identity": 2}}, "core")
    v = [p for p in out2 if p["key"] == "variance"][0]
    assert v["label"] == "Variance HPLC" and v["is_addon"]
    assert v["fulfillment_dim"] == "kind" and v["fulfillment_role"] == "variance"


def test_samplevariance_flag_does_not_double_render_variance():
    # WordPress sends BOTH the `samplevariance` buy-flag (bool) and the
    # `variance` data-points dict for one purchase. Only the modelled
    # "Variance HPLC" chip should render — never a duplicate fail-open
    # "Samplevariance" chip from the raw buy-flag key.
    out = build_ordered_products(
        {"variance": {"hplcpurity_identity": 2}, "samplevariance": True}, "core"
    )
    assert "Samplevariance" not in labels(out)
    assert "Variance HPLC" in labels(out)
    # Exactly one variance-flavoured chip.
    assert sum("ariance" in lbl for lbl in labels(out)) == 1


def test_samplevariance_flag_alone_renders_no_stray_chip():
    # The buy-flag without a purchased `variance` dict still must not produce a
    # stray "Samplevariance" chip — it is an alias of `variance`, not a product.
    out = build_ordered_products({"samplevariance": True}, "core")
    assert "Samplevariance" not in labels(out)


def test_bac_water_panel_is_base():
    out = build_ordered_products({"bac_water_panel": True}, None)
    v = [p for p in out if p["key"] == "bac_water_panel"][0]
    assert v["label"] == "Bac Water" and v["is_addon"] is False


def test_unknown_key_fails_open(caplog):
    out = build_ordered_products({"glycan_mapping": True}, None)
    v = [p for p in out if p["key"] == "glycan_mapping"][0]
    assert v["label"] == "Glycan Mapping"  # derived Title-Case
    assert v["fulfillment_role"] is None    # no alert for unknown
    assert "unregistered_product_key" in caplog.text


def test_extensibility_one_entry_adds_chip_and_fulfillment(monkeypatch):
    """Executable proof of D0: a single ProductDef gives a new product a chip
    and an alert with no other change. TEST-ONLY fixture — not the live registry."""
    monkeypatch.setitem(
        PRODUCT_REGISTRY, "sterility_usp71",
        ProductDef("sterility_usp71", "Sterility (USP<71>)", True, "ster", "role"),
    )
    out = build_ordered_products({"sterility_usp71": True}, "core")
    v = [p for p in out if p["key"] == "sterility_usp71"][0]
    assert v["label"] == "Sterility (USP<71>)" and v["is_addon"] and v["fulfillment_role"] == "ster"


def test_addon_fulfillment_roles_match_seeder():
    """Parity: registry role-dimension addons agree with the seeder's authoritative map."""
    service_to_role = {svc: role for role, keys in ROLE_TO_WP_KEYS.items() for svc in keys}
    for key, pdef in PRODUCT_REGISTRY.items():
        if pdef.is_addon and pdef.fulfillment_dim == "role":
            assert pdef.fulfillment_role == service_to_role.get(key), key
