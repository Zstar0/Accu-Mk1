from sub_samples.service import derive_base_demand


def test_sterility_pcr_demands_one_vial():
    """PCR and USP<71> are separately sold, one vial each (ruling 2026-08-05)."""
    assert derive_base_demand({"sterility_pcr": True})["ster"] == 1


def test_no_sterility_demands_zero():
    assert derive_base_demand({"sterility_pcr": False})["ster"] == 0


def test_other_buckets_unchanged():
    d = derive_base_demand({"hplcpurity_identity": True, "endotoxin": True})
    assert d["hplc"] == 1
    assert d["endo"] == 1
