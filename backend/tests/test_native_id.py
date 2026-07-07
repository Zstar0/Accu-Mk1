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


from sub_samples.native_id import seed_native_id_counters
from models import LimsSample


def _sample(sid, nid):
    return LimsSample(sample_id=sid, native_id=nid)


def test_seed_sets_counter_past_max_per_prefix(db):
    db.add_all([_sample("P-0007", "aP-0007"), _sample("P-0003", "aP-0003"),
                _sample("PB-0100", "aPB-0100")])
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8
    assert db.get(LimsNativeIdSequence, "aPB").next_value == 101


def test_seed_strips_retest_suffix_before_parsing(db):
    db.add_all([_sample("PB-0216-R01", "aPB-0216-R01"), _sample("PB-0100", "aPB-0100")])
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    # base number 216 (retest suffix ignored) wins over 100
    assert db.get(LimsNativeIdSequence, "aPB").next_value == 217


def test_seed_never_regresses_an_advanced_counter(db):
    db.add(_sample("P-0002", "aP-0002"))
    db.add(LimsNativeIdSequence(prefix="aP", next_value=500))
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 500  # not regressed to 3


def test_seed_is_rerun_safe(db):
    db.add(_sample("P-0007", "aP-0007"))
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8  # stable across runs


def test_seed_ignores_rows_without_native_id(db):
    db.add_all([_sample("P-0007", "aP-0007"), LimsSample(sample_id="P-9999")])
    db.commit()
    seed_native_id_counters(db)
    db.commit()
    assert db.get(LimsNativeIdSequence, "aP").next_value == 8


def test_seed_returns_prefix_count(db):
    db.add_all([_sample("P-0007", "aP-0007"), _sample("PB-0100", "aPB-0100")])
    db.commit()
    assert seed_native_id_counters(db) == 2
