"""lims_orders: table exists, upsert-friendly uniqueness on wp_order_id."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base
from models import LimsOrder


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def test_lims_order_roundtrip(db_session):
    o = LimsOrder(wp_order_id=6344, order_number="WP-6344", status="order-submitted",
                  customer_user_id=3181, customer_name="Jane Doe",
                  customer_email="j@x.com",
                  billing={"city": "Austin", "state": "TX", "country": "US"},
                  shipping=None)
    db_session.add(o)
    db_session.commit()
    row = db_session.query(LimsOrder).filter_by(wp_order_id=6344).one()
    assert row.order_number == "WP-6344"
    assert row.billing["city"] == "Austin"
    assert row.shipping is None


def test_wp_order_id_unique(db_session):
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-1"))
    db_session.commit()
    db_session.add(LimsOrder(wp_order_id=1, order_number="WP-1-dupe"))
    with pytest.raises(Exception):
        db_session.commit()
