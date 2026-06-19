from sub_samples.service import variance_lock_required


def test_blocks_when_purchased_and_unlocked():
    services = {"variance": {"bac_water_panel": 4}}  # 3 paid replicates
    assert variance_lock_required(services, None) is True

def test_allows_when_locked():
    import datetime
    services = {"variance": {"bac_water_panel": 4}}
    assert variance_lock_required(services, datetime.datetime.utcnow()) is False

def test_allows_when_no_variance_purchased():
    assert variance_lock_required({}, None) is False
    assert variance_lock_required({"variance": {}}, None) is False

def test_peptide_variance_also_gated():
    assert variance_lock_required({"variance": {"hplcpurity_identity": 2}}, None) is True
