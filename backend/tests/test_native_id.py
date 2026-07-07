"""Native-ID minting: SENAITE-number mirror + SENAITE-free counter."""
import pytest
from sqlalchemy import create_engine, select
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


def test_senaite_linked_mirrors_the_whole_id(db):
    assert mint_native_id(db, senaite_sample_id="P-1234") == "aP-1234"
    assert mint_native_id(db, senaite_sample_id="PB-0007") == "aPB-0007"
    assert mint_native_id(db, senaite_sample_id="BW-0013") == "aBW-0013"


def test_mirror_includes_retest_suffix(db):
    assert mint_native_id(db, senaite_sample_id="PB-0216-R01") == "aPB-0216-R01"


def test_mirror_draws_no_counter(db):
    """The mirror path must never touch lims_native_id_sequences — it is
    deterministic. A counter row appearing would mean a wasted sequence
    value and a drift risk at SENAITE retirement."""
    mint_native_id(db, senaite_sample_id="P-1234")
    mint_native_id(db, senaite_sample_id="P-5678")
    assert db.execute(select(LimsNativeIdSequence)).scalars().all() == []


def test_mirror_is_pure_same_in_same_out(db):
    assert mint_native_id(db, senaite_sample_id="P-0001") == "aP-0001"
    assert mint_native_id(db, senaite_sample_id="P-0001") == "aP-0001"


def test_senaite_free_uses_sample_type_map(db):
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0001"
    assert mint_native_id(db, sample_type_title="Peptide Blend") == "aPB-0001"
    assert mint_native_id(db, sample_type_title="Bacteriostatic Water") == "aBW-0001"
    # unknown type falls back to the generic prefix
    assert mint_native_id(db, sample_type_title="Mystery Goo") == "aS-0001"


def test_senaite_free_counter_is_per_prefix_and_monotonic(db):
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0001"
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0002"
    assert mint_native_id(db, sample_type_title="Peptide Blend") == "aPB-0001"
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-0003"


def test_senaite_free_counter_grows_past_9999(db):
    db.add(LimsNativeIdSequence(prefix="aP", next_value=10000))
    db.commit()
    assert mint_native_id(db, sample_type_title="Peptide") == "aP-10000"


def test_requires_some_identity_source(db):
    with pytest.raises(ValueError):
        mint_native_id(db)
