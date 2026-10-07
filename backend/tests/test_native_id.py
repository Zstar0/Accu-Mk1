"""Native-ID minting: prefix derivation, zero-padding, sequence isolation."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import LimsNativeIdSequence
from sub_samples.native_id import mint_native_id


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


def test_prefix_derived_from_senaite_id(db):
    assert mint_native_id(db, senaite_sample_id="P-1234") == "aP-0001"
    assert mint_native_id(db, senaite_sample_id="PB-0007") == "aPB-0001"
    assert mint_native_id(db, senaite_sample_id="BW-0013") == "aBW-0001"


def test_sequences_are_per_prefix_and_monotonic(db):
    assert mint_native_id(db, senaite_sample_id="P-0001") == "aP-0001"
    assert mint_native_id(db, senaite_sample_id="P-0002") == "aP-0002"
    assert mint_native_id(db, senaite_sample_id="PB-0001") == "aPB-0001"
    assert mint_native_id(db, senaite_sample_id="P-0003") == "aP-0003"


def test_senaite_free_uses_sample_type_map(db):
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0001"
    assert mint_native_id(db, sample_type_title="Peptide Blend") == "aPB-0001"
    assert mint_native_id(db, sample_type_title="Bacteriostatic Water") == "aBW-0001"
    # unknown type falls back to the generic prefix
    assert mint_native_id(db, sample_type_title="Mystery Goo") == "aS-0001"


def test_padding_grows_past_9999(db):
    db.add(LimsNativeIdSequence(prefix="aP", next_value=10000))
    db.commit()
    assert mint_native_id(db, senaite_sample_id="P-9999") == "aP-10000"


def test_requires_some_identity_source(db):
    with pytest.raises(ValueError):
        mint_native_id(db)


from sub_samples.native_id import mint_customer_sample_id, CUSTOMER_PREFIXES
from catalog.bw_keys import NATIVE_BW_KEY


def _seed_customer_counters(db, p=5000, pb=1000, bw=1000):
    db.add(LimsNativeIdSequence(prefix="P", next_value=p))
    db.add(LimsNativeIdSequence(prefix="PB", next_value=pb))
    db.add(LimsNativeIdSequence(prefix="BW", next_value=bw))
    db.commit()


def test_customer_prefix_map_is_peptide_and_blend_only():
    # BW keys on the ordered PROFILE KEY (Handler ruling 2026-10-07), not title.
    assert CUSTOMER_PREFIXES == {"peptide": "P", "peptide blend": "PB"}


def test_customer_id_mints_from_seeded_counter(db):
    _seed_customer_counters(db)
    assert mint_customer_sample_id(db, "Peptide") == "P-5000"
    assert mint_customer_sample_id(db, "Peptide") == "P-5001"
    assert mint_customer_sample_id(db, "Peptide Blend") == "PB-1000"


def test_customer_id_skips_ids_already_taken(db):
    """SENAITE may still mint P- ids after the flip (legacy retests, transfers);
    a taken id is skipped forward, never reused."""
    from models import LimsSample
    _seed_customer_counters(db)
    db.add(LimsSample(sample_id="P-5000"))
    db.add(LimsSample(sample_id="P-5001"))
    db.commit()
    assert mint_customer_sample_id(db, "Peptide") == "P-5002"


def test_customer_id_refuses_unseeded_prefix(db):
    with pytest.raises(ValueError, match="not seeded"):
        mint_customer_sample_id(db, "Peptide")


def test_customer_id_refuses_unknown_type(db):
    _seed_customer_counters(db)
    with pytest.raises(ValueError):
        mint_customer_sample_id(db, "Mystery Goo")


def test_customer_id_mints_bac_water_from_1000_and_skips_taken(db):
    from models import LimsSample
    _seed_customer_counters(db)
    k = [NATIVE_BW_KEY]
    assert mint_customer_sample_id(db, "Bacteriostatic Water", ordered_service_keys=k) == "BW-1000"
    db.add(LimsSample(sample_id="BW-1001"))
    db.commit()
    assert mint_customer_sample_id(db, "Bacteriostatic Water", ordered_service_keys=k) == "BW-1002"
    # P / PB untouched by the BW counter.
    assert mint_customer_sample_id(db, "Peptide") == "P-5000"
    assert mint_customer_sample_id(db, "Peptide Blend") == "PB-1000"


def test_customer_id_refuses_unseeded_bw_prefix(db):
    with pytest.raises(ValueError, match="not seeded"):
        mint_customer_sample_id(db, "Bacteriostatic Water", ordered_service_keys=[NATIVE_BW_KEY])


@pytest.mark.parametrize("title", [None, "Peptide", "Peptide Blend", "Mystery Goo"])
def test_bw_key_mints_bw_regardless_of_title(db, title):
    _seed_customer_counters(db)
    keys = ["endotoxin-usp85-lal", NATIVE_BW_KEY]
    assert mint_customer_sample_id(db, title, ordered_service_keys=keys) == "BW-1000"
    # P / PB counters untouched.
    assert mint_customer_sample_id(db, "Peptide") == "P-5000"


def test_bw_title_without_bw_key_raises(db):
    _seed_customer_counters(db)
    for keys in (None, [], ["endotoxin-usp85-lal"]):
        with pytest.raises(ValueError, match="BW key"):
            mint_customer_sample_id(db, "Bacteriostatic Water", ordered_service_keys=keys)


def test_internal_native_id_unchanged_for_customer_ids(db):
    """The aP- internal id still derives from the P- id (existing contract)."""
    assert mint_native_id(db, senaite_sample_id="P-5000") == "aP-0001"
